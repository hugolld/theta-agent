// Pins the checked-in benchmark task list (spec #135): the tracer's
// one task stays deliberate — prompt doctrine (ASCII, neutral, one
// plain call, read headroom), the named judge slot, declarative
// objective checks, and exactly one classify check whose `on` names an
// objective check. The list is the only source of what a benchmark
// leg runs, prompt for prompt.

import assert from "node:assert/strict";
import { test } from "node:test";
import { BENCH_TASKS, benchTaskById } from "./bench-tasks.mjs";
import { READ_HEADROOM } from "./scenarios.mjs";

test("the tracer task is single-session and its prompt keeps the capture doctrine", () => {
	const task = benchTaskById("provenance-decision");
	assert.equal(task.sessions.length, 1, "the tracer is single-session (spec #135)");
	const prompt = task.sessions[0];
	assert.match(prompt, /^[ -~]*$/, "the prompt must be pure ASCII");
	assert.ok(prompt.includes(READ_HEADROOM), "the prompt carries the read-headroom phrasing verbatim");
	assert.ok(
		!/(theta-[a-z-]+|SKILL\.md|scripts\/|notebook\.py)/.test(prompt),
		"the prompt is neutral — it names no skill and no file",
	);
	assert.ok(prompt.includes("one plain call"), "the prompt steers one plain command per call");
});

test("every task's judge slot is complete and its tier vocabulary is closed", () => {
	for (const task of BENCH_TASKS) {
		const { tier, provider, model } = task.judge ?? {};
		assert.ok(tier && provider && model, `${task.id}: the judge slot needs tier, provider, model`);
		assert.ok(
			["iteration", "independent"].includes(tier),
			`${task.id}: judge tier must be iteration or independent, not ${tier}`,
		);
	}
});

test("objective checks are declarative and complete; exactly one classify check names its input", () => {
	for (const task of BENCH_TASKS) {
		assert.ok(task.checks.length > 0, `${task.id}: workspace-as-oracle needs at least one objective check`);
		for (const check of task.checks) {
			if (check.kind === "file") {
				assert.ok(typeof check.path === "string" && check.path !== "", `${task.id}: file check ${check.id} needs a path`);
			} else if (check.kind === "notebook-entry") {
				assert.ok(check.path && check.type && check.idPrefix, `${task.id}: entry check ${check.id} needs path, type, idPrefix`);
				assert.ok(
					Array.isArray(check.textIncludes) && check.textIncludes.length > 0,
					`${task.id}: entry check ${check.id} needs text needles`,
				);
			} else {
				assert.fail(`${task.id}: unknown objective check kind ${check.kind}`);
			}
		}
		assert.ok(task.classify?.id && task.classify?.question, `${task.id} carries exactly one classify check`);
		assert.ok(
			typeof task.classify.question.instructions === "string" && task.classify.question.instructions.length > 0,
			`${task.id}: the judge question needs instructions`,
		);
		assert.ok(
			task.checks.some((check) => check.id === task.classify.on),
			`${task.id}: the classify check's \`on\` must name one of its objective checks`,
		);
		assert.equal(task.classify.question.type, "bool", `${task.id}: the tracer's judge question is a bool`);
		assert.ok(
			task.classify.question.criteria?.true && task.classify.question.criteria?.false,
			`${task.id}: the judge question needs both criteria`,
		);
	}
});

test("benchTaskById refuses an unknown id by name", () => {
	assert.throws(() => benchTaskById("no-such-task"), /unknown benchmark task id: no-such-task/);
});
