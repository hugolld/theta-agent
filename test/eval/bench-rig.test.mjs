// Pins the rig's eval mode at its offline seams (spec #136, on the #135
// tracer's pins): the benchmark flag refusals (no gateway token path
// exists on a benchmark leg — the refusal fires before Docker), the
// task selection (one id, or --suite for the whole checked-in list —
// never both), the per-session command shape (task-workspace cwd,
// launcher without --dev, print mode, resume with --continue only from
// the second session on, exit-status contract, the image input riding
// @path on the first session only), the image staging command, and the
// in-container grading command under both session layouts. The
// container flow itself is live-only — its evidence doctrine is
// docs/agents/eval.md.

import assert from "node:assert/strict";
import { test } from "node:test";
import { assertBenchmarkFlags, evalGradeCommand, evalSessionCommand, parseFlags, selectEvalTasks, stageImageCommand, suiteTaskDirName } from "../rig/run.mjs";
import { BENCH_TASKS, benchTaskById } from "./bench-tasks.mjs";

const task = benchTaskById("provenance-decision");

function flagsFor(argv) {
	const { flags } = parseFlags(argv);
	return flags;
}

test("a benchmark leg refuses --gateway and --rpc before Docker is needed", () => {
	assert.throws(
		() => assertBenchmarkFlags(flagsFor(["--gateway"])),
		/--gateway is a dogfood-leg flag/,
	);
	assert.throws(
		() => assertBenchmarkFlags(flagsFor(["--gateway", "--rpc"])),
		/--gateway is a dogfood-leg flag/,
	);
	assert.throws(
		() => assertBenchmarkFlags(flagsFor(["--rpc"])),
		/--rpc is a dogfood-leg flag/,
	);
	assert.doesNotThrow(() => assertBenchmarkFlags(flagsFor([])));
});

test("selectEvalTasks: one id runs that task; --suite runs the whole checked-in list; never both", () => {
	assert.deepEqual(selectEvalTasks(flagsFor(["provenance-decision"]), ["provenance-decision"]), [task]);
	assert.deepEqual(selectEvalTasks(flagsFor(["--suite"]), []), BENCH_TASKS, "--suite is the whole list, in checked-in order");
	assert.throws(
		() => selectEvalTasks(flagsFor(["--suite"]), ["provenance-decision"]),
		/--suite runs the whole checked-in list/,
	);
	assert.throws(() => selectEvalTasks(flagsFor([]), []), /eval needs a benchmark task id/);
});

test("selectEvalTasks refuses a non-ASCII prompt before anything is spent", () => {
	const tainted = [{ id: "x", sessions: ["café"] }];
	assert.throws(() => selectEvalTasks({ suite: false }, ["x"], tainted), /pure ASCII/);
	assert.throws(() => selectEvalTasks({ suite: true }, [], tainted), /pure ASCII/);
});

test("the session command runs print-mode theta from the task workspace", () => {
	const command = evalSessionCommand({ index: 0, timeout: 600, provider: "zai-coding-cn", model: "glm-5.3-flash" });
	assert.match(command, /^cd "\$HOME\/task" && timeout --signal=TERM --kill-after=15 600 /);
	// The launcher rides the clone's own path WITHOUT --dev: the launcher
	// loads its own package root as the -e source, and --dev would refuse
	// the workspace cwd for not being the checkout.
	assert.match(command, /node "\$HOME\/theta\/bin\/theta\.mjs"/);
	assert.doesNotMatch(command, /--dev/);
	assert.match(command, /--provider zai-coding-cn --model glm-5\.3-flash --session-dir \/session /);
	assert.match(command, /--print "\$RIG_PROMPT" < \/dev\/null > \/session\/answer\.txt 2> \/session\/stderr\.txt/);
	assert.match(command, /; echo \$\? > \/session\/exit-status$/);
	assert.doesNotMatch(command, /--continue/);
	assert.doesNotMatch(command, /@/, "a task without an image carries no @path argument");
});

test("sessions after the first resume with --continue under suffixed artifacts — including the exit status", () => {
	const second = evalSessionCommand({ index: 1, timeout: 600, provider: "p", model: "m" });
	assert.match(second, /--session-dir \/session --continue --print/);
	assert.match(second, /> \/session\/answer-2\.txt 2> \/session\/stderr-2\.txt/);
	// Every session records its own exit status — a multi-session leg's
	// evidence holds each code, not only the last session's (the review
	// round's finding).
	assert.match(second, /; echo \$\? > \/session\/exit-status-2$/);
	const third = evalSessionCommand({ index: 2, timeout: 600, provider: "p", model: "m" });
	assert.match(third, /--continue --print/);
	assert.match(third, /> \/session\/answer-3\.txt 2> \/session\/stderr-3\.txt/);
	assert.match(third, /; echo \$\? > \/session\/exit-status-3$/);
});

test("the image input rides the @path argv on the first session only", () => {
	// pi's @path is a first-prompt argument (resolved from the cwd), so
	// the attachment lands on session one and nowhere else — a resumed
	// session's prompt is not a first prompt.
	const first = evalSessionCommand({
		index: 0,
		timeout: 600,
		provider: "p",
		model: "m",
		image: "test/eval/assets/method-choice-fig.png",
	});
	assert.match(first, /--print "\$RIG_PROMPT" "@method-choice-fig\.png" </);
	const resumed = evalSessionCommand({
		index: 1,
		timeout: 600,
		provider: "p",
		model: "m",
		image: "test/eval/assets/method-choice-fig.png",
	});
	assert.doesNotMatch(resumed, /@method-choice-fig/, "no image argument past the first session");
});

test("suite sessions write under their per-task session path", () => {
	const command = evalSessionCommand({
		index: 0,
		timeout: 600,
		provider: "p",
		model: "m",
		sessionPath: "/session/task-lit-triage",
	});
	assert.match(command, /> \/session\/task-lit-triage\/answer\.txt 2> \/session\/task-lit-triage\/stderr\.txt/);
	assert.match(command, /; echo \$\? > \/session\/task-lit-triage\/exit-status$/);
});

test("the image staging command copies the committed asset into the fresh workspace under its basename", () => {
	assert.equal(
		stageImageCommand("test/eval/assets/method-choice-fig.png"),
		'cp "$HOME/theta/test/eval/assets/method-choice-fig.png" "$HOME/task/method-choice-fig.png"',
	);
});

test("the grading step runs the committed grader from the clone against the task workspace", () => {
	const command = evalGradeCommand(task.id);
	assert.match(command, /^cd "\$HOME\/theta" && node test\/eval\/bench-grade\.mjs provenance-decision "\$HOME\/task" \/session\/bench-grades\.json$/);
	const suiteGrades = evalGradeCommand(task.id, "/session/task-compute-staging");
	assert.match(suiteGrades, /\/session\/task-compute-staging\/bench-grades\.json$/);
});

test("suite evidence layout: one subdir per task, named by the task id", () => {
	assert.equal(suiteTaskDirName("lit-triage"), "task-lit-triage");
});

test("the tracer task's leading judge slot is the owner-picked iteration tier", () => {
	// The judge is config, never code (ADR 0007); the slot pins what the
	// first live leg judged with, and the PR body discloses the bend —
	// the campaign chat provider cannot serve classify(). The id is the
	// one the installed pi 1.4.0 catalog carries (the docs' jev-1.14
	// names a newer catalog than the pin; probed 2026-11-15).
	assert.deepEqual(task.judges[0], { tier: "iteration", provider: "openrouter", model: "typesafe/jev-1.13" });
});
