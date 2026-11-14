// Pins the rig's eval mode at its offline seams (spec #135): the
// benchmark flag refusals (no gateway token path exists on a benchmark
// leg — the refusal fires before Docker), the per-session command
// shape (task-workspace cwd, launcher without --dev, print mode,
// resume with --continue only from the second session on, exit-status
// contract), and the in-container grading command. The container flow
// itself is live-only — its evidence doctrine is docs/agents/eval.md.

import assert from "node:assert/strict";
import { test } from "node:test";
import { assertBenchmarkFlags, evalGradeCommand, evalSessionCommand, parseFlags } from "../rig/run.mjs";
import { benchTaskById } from "./bench-tasks.mjs";

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

test("the grading step runs the committed grader from the clone against the task workspace", () => {
	const command = evalGradeCommand(task.id);
	assert.match(command, /^cd "\$HOME\/theta" && node test\/eval\/bench-grade\.mjs provenance-decision "\$HOME\/task" \/session\/bench-grades\.json$/);
});

test("the tracer task's judge slot is the owner-picked iteration tier", () => {
	// The judge is config, never code (ADR 0007); the slot pins what the
	// first live leg judged with, and the PR body discloses the bend —
	// the campaign chat provider cannot serve classify().
	assert.deepEqual(task.judge, { tier: "iteration", provider: "openrouter", model: "typesafe/jev-1.14" });
});
