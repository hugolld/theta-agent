// Pins the host-side report step (spec #135): the usage ledger mirrors
// pi's own aggregation — totals pinned as literals against the
// committed connector fixture (a real session's entries, verified
// against pi's internal getUsageCostBreakdown when the mirror was
// written) — the judge wrapper maps classify() outcomes onto check
// rows without ever crashing the leg, and the report carries task
// grade, judge tier, and usage totals.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parseSessionEntries } from "@earendil-works/pi-coding-agent";
import { BOOL_ANSWER_SAMPLE } from "./bench-answer-shape.mjs";
import { BENCH_FILES, buildReport, buildSuiteReport, resolveJudge, runJudge, sumEntries, sumSessionUsage } from "./bench-report.mjs";
import { benchTaskById } from "./bench-tasks.mjs";

const task = benchTaskById("provenance-decision");
const fixtureText = readFileSync(path.join(import.meta.dirname, "fixtures/connector/session.jsonl"), "utf8");

test("the usage ledger sums a real session's entries to the pinned totals", () => {
	const summed = sumEntries(parseSessionEntries(fixtureText));
	// Measured against the committed fixture (2026-11-15 recapture) and
	// equal to pi's own getUsageCostBreakdown over the same entries:
	// same key, same cost, same tokens. A pi bump that changes ledger
	// semantics or a fixture recapture reds here on purpose.
	assert.deepEqual(summed.byModel, {
		"zai-coding-cn/glm-5.3-flash": {
			input: 30464,
			output: 6264,
			cacheRead: 85952,
			cacheWrite: 0,
			cost: 0.01028016,
			totalTokens: 122680,
		},
	});
	assert.deepEqual(summed.totals, {
		input: 30464,
		output: 6264,
		cacheRead: 85952,
		cacheWrite: 0,
		cost: 0.01028016,
		totalTokens: 122680,
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
		assert.equal(summed.totals.totalTokens, 122680);
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

// A stub registry drives the judge wrapper without a key.
function stubRegistry(classifyImpl) {
	return { classify: classifyImpl };
}
const judgeSlot = { tier: "iteration", provider: "stub", model: "stub-jev" };

test("a judge that stops cleanly turns its bool probability into the check row", async () => {
	// The stub answers through BOOL_ANSWER_SAMPLE, the shape anchored to
	// pi-ai's declared ClassifierBoolAnswer (test/eval/bench-answer-shape.mjs,
	// checked by tsc) — a stub shape pi never produces reds typecheck, not
	// the live leg.
	const registry = stubRegistry(async () => ({
		stopReason: "stop",
		answers: { [task.classify.id]: { ...BOOL_ANSWER_SAMPLE } },
		usage: { totalTokens: 900, cost: { total: 0.001 } },
	}));
	const result = await runJudge(registry, judgeSlot, task.classify, { prompt: "p", artifact: {} });
	assert.equal(result.pass, true);
	assert.equal(result.probability, BOOL_ANSWER_SAMPLE.probability);
	assert.deepEqual(result.usage, { totalTokens: 900, cost: { total: 0.001 } });
});

test("a probability below the threshold is a failed measurement, not a judge error", async () => {
	const registry = stubRegistry(async () => ({
		stopReason: "stop",
		answers: { [task.classify.id]: { ...BOOL_ANSWER_SAMPLE, probability: 0.2 } },
	}));
	const result = await runJudge(registry, judgeSlot, task.classify, { prompt: "p", artifact: {} });
	assert.equal(result.pass, false);
	assert.equal(result.judgeError, undefined, "a low-probability verdict must not fail the leg");
});

test("a judge answer in another shape fails the check loudly", async () => {
	const choiceShaped = stubRegistry(async () => ({
		stopReason: "stop",
		answers: { [task.classify.id]: { type: "choice", choice: "true", probabilities: {}, confidence: 1 } },
	}));
	const bareBoolean = stubRegistry(async () => ({ stopReason: "stop", answers: { [task.classify.id]: true } }));
	for (const registry of [choiceShaped, bareBoolean]) {
		const result = await runJudge(registry, judgeSlot, task.classify, { prompt: "p", artifact: {} });
		assert.equal(result.pass, false);
		assert.match(result.judgeError, /not a bool probability/);
	}
});

test("a judge error is a failed check with the error recorded, never a crash", async () => {
	const errored = stubRegistry(async () => ({ stopReason: "error", errorMessage: "boom" }));
	const rejected = stubRegistry(async () => {
		throw new Error("network gone");
	});
	for (const registry of [errored, rejected]) {
		const result = await runJudge(registry, judgeSlot, task.classify, { prompt: "p", artifact: {} });
		assert.equal(result.pass, false);
		assert.ok(result.judgeError);
	}
});

test("a transport-level fetch failure retries once and rides through", async () => {
	// Measured live (2026-11-15, the first suite run): the pooled
	// keep-alive socket dies between the suite's long tasks and fetch
	// answers TypeError "fetch failed" — one retry opens a fresh socket.
	// API-level outcomes never retry (the next test pins that side).
	let calls = 0;
	const registry = stubRegistry(async () => {
		calls += 1;
		if (calls === 1) throw new TypeError("fetch failed");
		return {
			stopReason: "stop",
			answers: { [task.classify.id]: { ...BOOL_ANSWER_SAMPLE } },
			usage: { totalTokens: 10, cost: { total: 0 } },
		};
	});
	const result = await runJudge(registry, judgeSlot, task.classify, { prompt: "p", artifact: {} });
	assert.equal(result.pass, true, "the retry lands the verdict");
	assert.equal(calls, 2, "exactly one retry");
});

test("a second transport failure records the judge error without a third call", async () => {
	let calls = 0;
	const registry = stubRegistry(async () => {
		calls += 1;
		throw new TypeError("fetch failed");
	});
	const result = await runJudge(registry, judgeSlot, task.classify, { prompt: "p", artifact: {} });
	assert.equal(result.pass, false);
	assert.equal(result.judgeError, "fetch failed");
	assert.equal(calls, 2, "one retry, then out");
});

test("API-level and non-transport throws never retry", async () => {
	let apiCalls = 0;
	const apiError = stubRegistry(async () => {
		apiCalls += 1;
		return { stopReason: "error", errorMessage: "System One API error (404)" };
	});
	const apiResult = await runJudge(apiError, judgeSlot, task.classify, { prompt: "p", artifact: {} });
	assert.equal(apiResult.judgeError, "System One API error (404)");
	assert.equal(apiCalls, 1, "an API-level answer is deterministic — no retry");

	let throwCalls = 0;
	const otherThrow = stubRegistry(async () => {
		throwCalls += 1;
		throw new Error("network gone");
	});
	const throwResult = await runJudge(otherThrow, judgeSlot, task.classify, { prompt: "p", artifact: {} });
	assert.match(throwResult.judgeError, /network gone/);
	assert.equal(throwCalls, 1, "only the fetch-failed class retries");
});

test("a judge answer that is not a bool shape fails the check", async () => {
	const registry = stubRegistry(async () => ({ stopReason: "stop", answers: { [task.classify.id]: "yes" } }));
	const result = await runJudge(registry, judgeSlot, task.classify, { prompt: "p", artifact: {} });
	assert.equal(result.pass, false);
	assert.match(result.judgeError, /not a bool probability/);
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
