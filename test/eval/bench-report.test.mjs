// Pins the host-side report step (spec #135): the usage ledger mirrors
// pi's own aggregation — totals pinned as literals against the
// committed connector fixture (a real session's entries, verified
// against pi's internal getUsageCostBreakdown when the mirror was
// written) — the judge wrapper maps classify() outcomes onto check
// rows without ever crashing the leg, and the report carries task
// grade, judge tier, and usage totals.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { parseSessionEntries } from "@earendil-works/pi-coding-agent";
import { BOOL_ANSWER_SAMPLE } from "./bench-answer-shape.mjs";
import { BENCH_FILES, buildReport, buildSuiteReport, resolveJudge, runJudge, spawnJudgeChild, sumEntries, sumSessionUsage } from "./bench-report.mjs";
import { benchTaskById } from "./bench-tasks.mjs";

const task = benchTaskById("provenance-decision");
const fixtureText = readFileSync(path.join(import.meta.dirname, "fixtures/connector/session.jsonl"), "utf8");

test("the usage ledger sums a real session's entries to the pinned totals", () => {
	const summed = sumEntries(parseSessionEntries(fixtureText));
	// Measured against the committed fixture (2026-11-16 recapture, spec
	// #162) and equal to pi's own getUsageCostBreakdown over the same
	// entries: same key, same cost, same tokens. A pi bump that changes
	// ledger semantics or a fixture recapture reds here on purpose.
	assert.deepEqual(summed.byModel, {
		"zai-coding-cn/glm-5.3-flash": {
			input: 22785,
			output: 5173,
			cacheRead: 55872,
			cacheWrite: 0,
			cost: 0.007680409999999999,
			totalTokens: 83830,
		},
	});
	assert.deepEqual(summed.totals, {
		input: 22785,
		output: 5173,
		cacheRead: 55872,
		cacheWrite: 0,
		cost: 0.007680409999999999,
		totalTokens: 83830,
	});
});

test("the ledger counts standalone usage entries and compaction usage the way pi does", () => {
	// Synthetic entries in the shapes pi writes: a usage entry (cache
	// warm), a compaction entry with usage (the "Tools/summaries"
	// bucket), and an assistant message.
	const summed = sumEntries([
		{ type: "usage", provider: "p", model: "m", usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: { total: 0.5 } } },
		{ type: "compaction", usage: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0.25 } } },
		{
			type: "message",
			message: { role: "assistant", provider: "zai-coding-cn", model: "glm-5.3-flash", usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: { total: 1 } } },
		},
	]);
	assert.deepEqual(Object.keys(summed.byModel), ["Tools/summaries", "p/m", "zai-coding-cn/glm-5.3-flash"]);
	assert.equal(summed.totals.cost, 1.75);
	assert.equal(summed.totals.totalTokens, 170);
});

test("sumSessionUsage walks the transcript name grammar and counts sessions", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "bench-usage-"));
	try {
		// The grammar's shape (session-evidence.mjs TRANSCRIPT_NAME): an
		// ISO instant, a dash-joined time, and a uuid, .jsonl.
		const name = "2026-11-15T10-30-00-000Z_01234567-89ab-cdef-0123-456789abcdef.jsonl";
		writeFileSync(path.join(dir, name), fixtureText);
		writeFileSync(path.join(dir, "gate.jsonl"), "{}\n"); // not a transcript
		const summed = sumSessionUsage(dir);
		assert.equal(summed.sessions, 1);
		assert.equal(summed.totals.totalTokens, 83830);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("sumSessionUsage refuses a dir with no transcript", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "bench-usage-"));
	try {
		assert.throws(() => sumSessionUsage(dir), /no session transcript/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// The judge seam: runJudge drives one fresh child process per call
// (test/eval/bench-judge.mjs). Measured live (2026-11-15, five suite
// runs): every judge failure rode the long-lived runner process's pooled
// connection state, and every fresh-process probe passed — so these
// tests mock the child runner at the seam the parent owns, and the
// child's own spawn protocol gets real-process pins with throwaway
// children that never touch pi or the network.
const judgeSlot = { tier: "iteration", provider: "stub", model: "stub-jev" };
const SETTLED_ANSWER = () => ({
	stopReason: "stop",
	answers: { [task.classify.id]: { ...BOOL_ANSWER_SAMPLE } },
	usage: { totalTokens: 900, cost: { total: 0.001 } },
});

function mockChild(results) {
	const calls = [];
	const spawnChild = async (slot, classify, state) => {
		calls.push({ slot, classify, state });
		return results[Math.min(calls.length - 1, results.length - 1)];
	};
	return { spawnChild, calls };
}

test("a settled bool answer becomes the check row, and the child gets slot, classify, and state", async () => {
	const { spawnChild, calls } = mockChild([{ kind: "settled", settled: SETTLED_ANSWER() }]);
	const state = { prompts: ["p"], artifact: {} };
	const result = await runJudge(judgeSlot, task.classify, state, { spawnChild, retryDelayMs: 1 });
	assert.equal(result.pass, true);
	assert.equal(result.probability, BOOL_ANSWER_SAMPLE.probability);
	assert.deepEqual(result.usage, { totalTokens: 900, cost: { total: 0.001 } });
	assert.deepEqual(calls[0].slot, judgeSlot);
	assert.deepEqual(calls[0].classify, task.classify);
	assert.deepEqual(calls[0].state, state);
});

test("a probability below the threshold is a failed measurement, not a judge error", async () => {
	const settled = SETTLED_ANSWER();
	settled.answers[task.classify.id].probability = 0.2;
	const { spawnChild } = mockChild([{ kind: "settled", settled }]);
	const result = await runJudge(judgeSlot, task.classify, {}, { spawnChild, retryDelayMs: 1 });
	assert.equal(result.pass, false);
	assert.equal(result.judgeError, undefined, "a low-probability verdict must not fail the leg");
});

test("a judge answer in another shape fails the check loudly", async () => {
	for (const answer of [{ type: "choice", choice: "true", probabilities: {}, confidence: 1 }, true]) {
		const settled = { stopReason: "stop", answers: { [task.classify.id]: answer } };
		const { spawnChild } = mockChild([{ kind: "settled", settled }]);
		const result = await runJudge(judgeSlot, task.classify, {}, { spawnChild, retryDelayMs: 1 });
		assert.equal(result.pass, false);
		assert.match(result.judgeError, /not a bool probability/);
	}
});

test("a stopReason error is an answer, not a transport failure — no retry", async () => {
	const { spawnChild, calls } = mockChild([
		{ kind: "settled", settled: { stopReason: "error", errorMessage: "System One API error (404)" } },
	]);
	const result = await runJudge(judgeSlot, task.classify, {}, { spawnChild, retryDelayMs: 1 });
	assert.equal(result.pass, false);
	assert.equal(result.judgeError, "System One API error (404)");
	assert.equal(calls.length, 1, "an API-level answer is deterministic — no retry");
});

test("a child-reported transport failure retries once and rides through", async () => {
	const { spawnChild, calls } = mockChild([
		{ kind: "judge-failure", transport: true, detail: "fetch failed (ECONNRESET)" },
		{ kind: "settled", settled: SETTLED_ANSWER() },
	]);
	const result = await runJudge(judgeSlot, task.classify, {}, { spawnChild, retryDelayMs: 1 });
	assert.equal(result.pass, true, "the retry lands the verdict");
	assert.equal(calls.length, 2, "exactly one retry");
});

test("a second transport failure records the judge error without a third child", async () => {
	const { spawnChild, calls } = mockChild([
		{ kind: "judge-failure", transport: true, detail: "fetch failed (ECONNRESET)" },
		{ kind: "judge-failure", transport: true, detail: "fetch failed (ECONNRESET)" },
	]);
	const result = await runJudge(judgeSlot, task.classify, {}, { spawnChild, retryDelayMs: 1 });
	assert.equal(result.pass, false);
	assert.equal(result.judgeError, "fetch failed (ECONNRESET)");
	assert.equal(calls.length, 2, "one retry, then out");
});

test("a non-transport child failure never retries", async () => {
	const { spawnChild, calls } = mockChild([
		{ kind: "judge-failure", transport: false, detail: "judge stub/stub-jev is not in the catalog" },
	]);
	const result = await runJudge(judgeSlot, task.classify, {}, { spawnChild, retryDelayMs: 1 });
	assert.equal(result.pass, false);
	assert.match(result.judgeError, /not in the catalog/);
	assert.equal(calls.length, 1);
});

test("a child timeout is the transport class — one retry, then the judge error", async () => {
	const { spawnChild, calls } = mockChild([
		{ kind: "timeout", detail: "judge child timed out after 120000ms" },
		{ kind: "timeout", detail: "judge child timed out after 120000ms" },
	]);
	const result = await runJudge(judgeSlot, task.classify, {}, { spawnChild, retryDelayMs: 1 });
	assert.equal(result.pass, false);
	assert.match(result.judgeError, /timed out/);
	assert.equal(calls.length, 2);
});

test("a killed, malformed, or spawn-error child never retries", async () => {
	// The three kinds outside the measured transport class: each lands as
	// the judgeError row on the first child, with its own detail — a
	// retry would only hide the observed cause.
	for (const kind of ["killed", "malformed", "spawn-error"]) {
		const detail = `${kind}: the observed detail`;
		const { spawnChild, calls } = mockChild([{ kind, detail }]);
		const result = await runJudge(judgeSlot, task.classify, {}, { spawnChild, retryDelayMs: 1 });
		assert.equal(result.pass, false, kind);
		assert.equal(result.judgeError, detail, kind);
		assert.equal(calls.length, 1, `${kind} must not retry`);
	}
});

// The real-child pins share one scaffolding: a throwaway script file in
// a temp dir, the child run through spawnJudgeChild, the dir removed
// whichever way the pin ends.
async function withTempChild(script, fn) {
	const dir = mkdtempSync(path.join(tmpdir(), "bench-child-"));
	try {
		const childPath = path.join(dir, "child.mjs");
		writeFileSync(childPath, script);
		return await fn(childPath);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

const ECHO_VERDICT_CHILD = [
	"const chunks = [];",
	"for await (const c of process.stdin) chunks.push(c);",
	'const input = JSON.parse(chunks.join(""));',
	'process.stdout.write(JSON.stringify({ ok: true, settled: { stopReason: "stop", argv: process.argv.slice(2), classifyId: input.classify.id, runnerMarker: process.env.NODE_TEST_CONTEXT ?? null } }));',
].join("\n");

test("spawnJudgeChild delivers argv and stdin, strips the runner marker, and parses the verdict JSON", async () => {
	await withTempChild(ECHO_VERDICT_CHILD, async (childPath) => {
		const child = await spawnJudgeChild(judgeSlot, task.classify, { prompts: ["p"] }, { childPath, timeoutMs: 5000 });
		assert.equal(child.kind, "settled");
		assert.deepEqual(child.settled.argv, [judgeSlot.provider, judgeSlot.model]);
		assert.equal(child.settled.classifyId, task.classify.id);
		// This test process runs under node:test, so the marker is set in
		// its env — the child seeing null proves spawnJudgeChild strips it
		// (a leak would silence the real child's main block, landing every
		// tier malformed).
		assert.equal(child.settled.runnerMarker, null);
	});
});

test("a child that answers no verdict JSON lands as malformed with the output tails", async () => {
	await withTempChild('process.stdout.write("garbage");process.stderr.write("boom stack");process.exit(1);', async (childPath) => {
		const child = await spawnJudgeChild(judgeSlot, task.classify, {}, { childPath, timeoutMs: 5000 });
		assert.equal(child.kind, "malformed");
		assert.match(child.detail, /exited 1/);
		assert.match(child.detail, /garbage/);
		assert.match(child.detail, /boom stack/);
	});
});

test("a child that hangs past the timeout lands as timeout", async () => {
	await withTempChild("setTimeout(() => {}, 60000);", async (childPath) => {
		const child = await spawnJudgeChild(judgeSlot, task.classify, {}, { childPath, timeoutMs: 300 });
		assert.equal(child.kind, "timeout");
		assert.match(child.detail, /timed out after 300ms/);
	});
});

test("a child that dies on a signal without the timeout lands as killed, not timeout", async () => {
	// The SIGKILL stands in for an OOM kill or an external signal: not
	// this harness's timeout, so not the retryable transport class —
	// the detail names what was observed, nothing else.
	await withTempChild('process.kill(process.pid, "SIGKILL");', async (childPath) => {
		const child = await spawnJudgeChild(judgeSlot, task.classify, {}, { childPath, timeoutMs: 5000 });
		assert.equal(child.kind, "killed");
		assert.match(child.detail, /SIGKILL/);
	});
});

test("the judge child module exposes the protocol surface the parent drives", async () => {
	const child = await import("./bench-judge.mjs");
	assert.equal(typeof child.judgeMain, "function");
	assert.equal(typeof child.isTransportError, "function");
	assert.equal(typeof child.transportMessage, "function");
});

test("the judge child loaded under the test runner does nothing, promptly", async () => {
	// The regression this pins: the runner discovers every .mjs under
	// test/ and loads it in a child with stdin held open; the old main
	// guard read stdin there and hung the suite's commit hook for 36
	// minutes. With the runner's marker set, the child must exit at once.
	// A regressed child would read the finite stdin to EOF and actually
	// run its main block — answering a verdict JSON (which fails the
	// parse assertion below) or stalling on the network call (which rides
	// the 5s spawn timeout). Either mechanism reds this pin fast.
	const run = spawnSync(
		process.execPath,
		[fileURLToPath(new URL("./bench-judge.mjs", import.meta.url)), judgeSlot.provider, judgeSlot.model],
		{
			input: JSON.stringify({ state: {}, classify: task.classify }),
			encoding: "utf8",
			timeout: 5000,
			env: { ...process.env, NODE_TEST_CONTEXT: "child-v8" },
		},
	);
	assert.equal(run.error, undefined, "the child must exit, not ride the spawn timeout");
	assert.equal(run.signal, null);
	assert.throws(() => JSON.parse(run.stdout), SyntaxError, "a loaded-not-invoked child answers no verdict");
});

test("resolveJudge names the fix for a missing model and for a missing credential", () => {
	assert.throws(
		() => resolveJudge({ getModelOfType: () => undefined, hasConfiguredAuth: () => true }, judgeSlot),
		/not in the catalog/,
	);
	assert.throws(
		() =>
			resolveJudge(
				{ getModelOfType: () => ({ provider: "stub", id: "stub-jev" }), hasConfiguredAuth: () => false },
				judgeSlot,
			),
		/no working credential host-side/,
	);
});

const usageStub = { sessions: 1, byModel: {}, totals: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, totalTokens: 2 } };

test("the report carries task grade, judge tiers, and usage totals; grade follows checks and every tier", () => {
	// Two-tier judging (spec #136): each judge slot produces its own row,
	// and the task grade passes only when every objective check and every
	// tier's verdict pass — a tier disagreement is a failed grade, loud
	// in the report, never silently averaged away.
	const grades = {
		task: task.id,
		checks: [
			{ id: "notebook-written", kind: "file", pass: true, detail: "present" },
			{ id: "decision-entry", kind: "notebook-entry", pass: true, detail: "dec-0001" },
		],
		matched: {},
	};
	const slots = [task.judges[0], { tier: "independent", provider: "stub2", model: "stub-solar" }];
	const results = [
		{ pass: true, probability: 0.9 },
		{ pass: true, probability: 0.8 },
	];
	const passing = buildReport({
		task,
		grades,
		judgeCalls: slots.map((slot, index) => ({ slot, result: results[index] })),
		usage: usageStub,
		head: "abc1234",
		gradedAt: "2026-11-15T00:00:00.000Z",
	});
	assert.equal(passing.grade, "pass");
	assert.equal(passing.class, task.class, "the report traces the grade to the task's class");
	assert.deepEqual(
		passing.judges.map((j) => [j.tier, j.provider, j.pass]),
		[
			["iteration", "openrouter", true],
			["independent", "stub2", true],
		],
		"each tier carries its own verdict row",
	);
	assert.equal(passing.judges[0].probability, 0.9);
	assert.equal(passing.usage.totals.totalTokens, 2);
	assert.equal(passing.checks.length, 2, "objective checks only — judge rows live under judges");

	const judgedFalse = buildReport({
		task,
		grades,
		judgeCalls: [
			{ slot: slots[0], result: { pass: true, probability: 0.9 } },
			{ slot: slots[1], result: { pass: false, judgeError: "judge stopReason error" } },
		],
		usage: usageStub,
		head: "abc1234",
		gradedAt: "2026-11-15T00:00:00.000Z",
	});
	assert.equal(judgedFalse.grade, "fail", "a tier disagreement fails the task grade");
	assert.equal(judgedFalse.judges[1].judgeError, "judge stopReason error");

	const objectiveMiss = buildReport({
		task,
		grades: { ...grades, checks: grades.checks.map((c) => ({ ...c, pass: false })) },
		judgeCalls: slots.map((slot) => ({ slot, result: { pass: true, probability: 0.9 } })),
		usage: usageStub,
		head: "abc1234",
		gradedAt: "2026-11-15T00:00:00.000Z",
	});
	assert.equal(objectiveMiss.grade, "fail");
});

test("a skipped judge row fails the grade without a judge error — a missed objective check is a failed measurement, not a leg failure", () => {
	// The accepted behavior delta's pin: when the objective check matched
	// nothing, the judge rows carry `skipped`, never `judgeError` —
	// runEval's leg-failure gate keys on judgeError alone, so the leg
	// exits zero and the grade rides the report (docs/agents/eval.md).
	const report = buildReport({
		task,
		grades: {
			task: task.id,
			checks: [
				{ id: "notebook-written", kind: "file", pass: false, detail: "missing" },
				{ id: "decision-entry", kind: "notebook-entry", pass: false, detail: "missing" },
			],
			matched: {},
		},
		judgeCalls: task.judges.map((slot) => ({
			slot,
			result: { pass: false, skipped: `objective check ${task.classify.on} matched nothing to judge` },
		})),
		usage: usageStub,
		head: "abc1234",
		gradedAt: "2026-11-15T00:00:00.000Z",
	});
	assert.equal(report.grade, "fail");
	for (const judgeRow of report.judges) {
		assert.equal(judgeRow.pass, false);
		assert.match(judgeRow.skipped, /matched nothing to judge/);
		assert.equal(judgeRow.judgeError, undefined, "a skipped row must not trip the leg-failure gate");
	}
});

test("buildSuiteReport aggregates per-task grades, judge tiers, and costs into the run artifact", () => {
	const litTask = benchTaskById("lit-triage");
	const reportOf = (t, grade, cost, totalTokens) => ({
		task: t.id,
		class: t.class,
		grade,
		sessions: t.sessions.length,
		landedHead: "abc1234",
		gradedAt: "2026-11-15T00:00:00.000Z",
		judges: t.judges.map((slot, i) => ({
			id: t.classify.id,
			tier: slot.tier,
			provider: slot.provider,
			model: slot.model,
			pass: grade === "pass",
			...(i === 0 ? { usage: { totalTokens: 10, cost: { total: 0.001 } } } : {}),
		})),
		checks: t.checks.map((c) => ({ id: c.id, kind: c.kind, pass: grade === "pass", detail: "x" })),
		usage: { byModel: {}, totals: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost, totalTokens } },
	});
	const reports = [
		reportOf(litTask, "pass", 0.01, 1000),
		reportOf(task, "fail", 0.02, 2000),
	];
	const suite = buildSuiteReport({
		reports,
		provider: "zai-coding-cn",
		model: "glm-5.3-flash",
		head: "abc1234",
		gradedAt: "2026-11-15T00:00:00.000Z",
	});
	assert.equal(suite.landedHead, "abc1234");
	assert.deepEqual(
		suite.tasks.map((t) => [t.task, t.grade, t.judges.length]),
		[
			["lit-triage", "pass", 2],
			["provenance-decision", "fail", 1],
		],
		"per-task rows carry the grade and each tier's verdict",
	);
	assert.deepEqual(
		suite.tasks.map((t) => t.judges.map((j) => j.tier)),
		[
			["iteration", "independent"],
			["iteration"],
		],
	);
	assert.deepEqual(suite.tasks[0].checks, { passed: 2, total: 2 });
	assert.deepEqual(suite.tasks[1].checks, { passed: 0, total: 2 });
	assert.equal(suite.totals.tasks, 2);
	assert.equal(suite.totals.passed, 1);
	assert.equal(suite.totals.failed, 1);
	assert.equal(suite.totals.sessions, 2);
	assert.equal(suite.totals.tokens, 3000);
	assert.equal(suite.totals.cost, 0.03);
});

test("BENCH_FILES names the eval-mode artifacts beside the session-evidence bundle", () => {
	assert.deepEqual(BENCH_FILES, {
		grades: "bench-grades.json",
		report: "bench-report.json",
		suite: "bench-suite.json",
		answer: "answer.txt",
	});
});
