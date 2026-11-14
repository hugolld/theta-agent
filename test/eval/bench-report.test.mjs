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
import { BENCH_FILES, buildReport, resolveJudge, runJudge, sumEntries, sumSessionUsage } from "./bench-report.mjs";
import { benchTaskById } from "./bench-tasks.mjs";

const task = benchTaskById("provenance-decision");
const fixtureText = readFileSync(path.join(import.meta.dirname, "fixtures/connector/session.jsonl"), "utf8");

test("the usage ledger sums a real session's entries to the pinned totals", () => {
	const summed = sumEntries(parseSessionEntries(fixtureText));
	// Measured against the committed fixture (2026-11-15) and equal to
	// pi's own getUsageCostBreakdown over the same entries: same key,
	// same cost, same tokens. A pi bump that changes ledger semantics
	// or a fixture recapture reds here on purpose.
	assert.deepEqual(summed.byModel, {
		"zai-coding-cn/glm-5.3-flash": {
			input: 43126,
			output: 6294,
			cacheRead: 112384,
			cacheWrite: 0,
			cost: 0.012987419999999998,
			totalTokens: 161804,
		},
	});
	assert.deepEqual(summed.totals, {
		input: 43126,
		output: 6294,
		cacheRead: 112384,
		cacheWrite: 0,
		cost: 0.012987419999999998,
		totalTokens: 161804,
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
		assert.equal(summed.totals.totalTokens, 161804);
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
	// pi's real answer shape (pi-ai dist/types.d.ts ClassifierBoolAnswer):
	// { type: "bool", probability } — never a bare boolean. The stub
	// returns the real shape; an unwrap that reads the wrong type fails
	// here, not on the live leg.
	const registry = stubRegistry(async () => ({
		stopReason: "stop",
		answers: { [task.classify.id]: { type: "bool", probability: 0.87 } },
		usage: { totalTokens: 900, cost: { total: 0.001 } },
	}));
	const result = await runJudge(registry, judgeSlot, task.classify, { prompt: "p", artifact: {} });
	assert.equal(result.pass, true);
	assert.equal(result.probability, 0.87);
	assert.deepEqual(result.usage, { totalTokens: 900, cost: { total: 0.001 } });
});

test("a probability below the threshold is a failed measurement, not a judge error", async () => {
	const registry = stubRegistry(async () => ({
		stopReason: "stop",
		answers: { [task.classify.id]: { type: "bool", probability: 0.2 } },
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

test("the report carries task grade, judge tier, and usage totals; grade follows the checks", () => {
	const grades = {
		task: task.id,
		checks: [
			{ id: "notebook-written", kind: "file", pass: true, detail: "present" },
			{ id: "decision-entry", kind: "notebook-entry", pass: true, detail: "dec-0001" },
		],
		matched: {},
	};
	const passing = buildReport({
		task,
		grades,
		judgeSlot,
		judgeResult: { pass: true, probability: 0.9 },
		usage: usageStub,
		head: "abc1234",
		gradedAt: "2026-11-15T00:00:00.000Z",
	});
	assert.equal(passing.grade, "pass");
	assert.equal(passing.judge.tier, "iteration");
	assert.equal(passing.judge.provider, "stub");
	assert.equal(passing.usage.totals.totalTokens, 2);
	const classifyRow = passing.checks.find((c) => c.id === task.classify.id);
	assert.equal(classifyRow.probability, 0.9);
	assert.equal(classifyRow.judgeError, undefined);
	assert.equal(passing.checks.length, 3, "objective checks plus the classify check");

	const judgedFalse = buildReport({
		task,
		grades,
		judgeSlot,
		judgeResult: { pass: false, judgeError: "judge stopReason error" },
		usage: usageStub,
		head: "abc1234",
		gradedAt: "2026-11-15T00:00:00.000Z",
	});
	assert.equal(judgedFalse.grade, "fail");
	assert.equal(judgedFalse.checks.find((c) => c.id === task.classify.id).judgeError, "judge stopReason error");

	const objectiveMiss = buildReport({
		task,
		grades: { ...grades, checks: grades.checks.map((c) => ({ ...c, pass: false })) },
		judgeSlot,
		judgeResult: { pass: true, probability: 0.9 },
		usage: usageStub,
		head: "abc1234",
		gradedAt: "2026-11-15T00:00:00.000Z",
	});
	assert.equal(objectiveMiss.grade, "fail");
});

test("a skipped classify row fails the grade without a judge error — a missed objective check is a failed measurement, not a leg failure", () => {
	// The accepted behavior delta's pin: when the objective check matched
	// nothing, the classify row carries `skipped`, never `judgeError` —
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
		judgeSlot,
		judgeResult: { pass: false, skipped: "objective check decision-entry matched nothing to judge" },
		usage: usageStub,
		head: "abc1234",
		gradedAt: "2026-11-15T00:00:00.000Z",
	});
	assert.equal(report.grade, "fail");
	const classifyRow = report.checks.find((c) => c.id === task.classify.id);
	assert.equal(classifyRow.pass, false);
	assert.match(classifyRow.skipped, /matched nothing to judge/);
	assert.equal(classifyRow.judgeError, undefined, "a skipped row must not trip the leg-failure gate");
});

test("BENCH_FILES names the eval-mode artifacts beside the session-evidence bundle", () => {
	assert.deepEqual(BENCH_FILES, {
		grades: "bench-grades.json",
		report: "bench-report.json",
		answer: "answer.txt",
	});
});
