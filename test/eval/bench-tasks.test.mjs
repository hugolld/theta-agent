// Pins the checked-in benchmark task list (spec #136, on the #135
// tracer's shape): the suite is the four proposed classes, one task per
// class, single-digit count — each task deliberate, prompt for prompt.
// The pins: prompt doctrine (ASCII, neutral, one plain call, read
// headroom), the named judge slots with the two-tier vocabulary (the
// dual-tier task is the independent judge's only seat), declarative
// objective checks of the closed kinds, exactly one classify entry
// naming an objective check, the image input available but not required
// (one committed asset, first session only), and the multi-session
// resume path exercised. The list is the only source of what a
// benchmark leg runs — and `eval --suite` reads the whole list.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { BENCH_TASKS } from "./bench-tasks.mjs";
import { READ_HEADROOM } from "./scenarios.mjs";

// The four proposed classes (spec #136), drawn from Theta's own
// surfaces. The task list carries them as data so the suite report and
// the later performance doc trace grades to a class, not just a task id.
const CLASSES = ["compute-staging", "literature-triage", "method-selection", "provenance-recording"];

test("the suite is the four proposed classes, one task each, single-digit count", () => {
	assert.equal(BENCH_TASKS.length, 4, "the first suite is four tasks (spec #136: one per class, single-digit)");
	assert.deepEqual(
		[...BENCH_TASKS.map((t) => t.class)].sort(),
		CLASSES,
		"the classes are covered exactly once each",
	);
});

test("every task keeps the capture doctrine in every session prompt", () => {
	for (const task of BENCH_TASKS) {
		assert.ok(task.sessions.length > 0, `${task.id}: at least one session`);
		for (const prompt of task.sessions) {
			assert.match(prompt, /^[ -~]*$/, `${task.id}: the prompt must be pure ASCII`);
			assert.ok(prompt.includes(READ_HEADROOM), `${task.id}: the prompt carries the read-headroom phrasing verbatim`);
			assert.ok(
				!/(theta-[a-z-]+|SKILL\.md|scripts\/|notebook\.py)/.test(prompt),
				`${task.id}: the prompt is neutral — it names no skill and no file`,
			);
			assert.ok(prompt.includes("one plain call"), `${task.id}: the prompt steers one plain command per call`);
		}
	}
});

test("the two-tier judging shape: iteration-first slots, exactly the dual-tier task judges both", () => {
	// The judge is config, never code (ADR 0007); the independent tier is
	// the seat for public-destined numbers, and its identity is the
	// owner's pick recorded in the slot (spec #136). Iteration leads in
	// every slot list: the campaign-iteration verdict is the first number
	// a strike reads.
	for (const task of BENCH_TASKS) {
		assert.ok(Array.isArray(task.judges) && task.judges.length > 0, `${task.id}: judges is a non-empty array`);
		assert.equal(task.judges[0].tier, "iteration", `${task.id}: the iteration tier leads every judge list`);
		for (const slot of task.judges) {
			assert.ok(
				["iteration", "independent"].includes(slot.tier),
				`${task.id}: judge tier must be iteration or independent, not ${slot.tier}`,
			);
			assert.ok(slot.provider && slot.model, `${task.id}: the judge slot needs provider and model`);
		}
	}
	const dual = BENCH_TASKS.filter((t) => t.judges.some((slot) => slot.tier === "independent"));
	assert.ok(dual.length >= 1, "at least one task is graded by both tiers (spec #136)");
	for (const task of dual) {
		assert.deepEqual(
			task.judges.map((s) => s.tier),
			["iteration", "independent"],
			`${task.id}: both tiers, iteration leading`,
		);
	}
	assert.ok(
		dual.every((t) => t.class === "literature-triage"),
		"the dual-tier seat is the literature-triage task — the suite's most subjective grade",
	);
});

test("every judge slot resolves in the installed pi catalog — keyless", async () => {
	// A slot id the installed pi does not carry sails green through every
	// offline test and dies only at the live preflight: the S2 slot named
	// the docs' jev-1.14 while the installed 1.4.0 catalog carries 1.13
	// (caught by the preflight before a leg was spent). This pin resolves
	// each slot through the installed package's own catalog — keyless and
	// configless (ModelRuntime.create() needs no host pi config; verified
	// against an empty HOME, the CI shape) — so a wrong id reds at commit
	// time, naming the slot.
	const { ModelRuntime, ModelRegistry } = await import("@earendil-works/pi-coding-agent");
	const registry = new ModelRegistry(await ModelRuntime.create());
	for (const task of BENCH_TASKS) {
		for (const slot of task.judges) {
			const model = registry.getModelOfType("classifier", slot.provider, slot.model);
			assert.ok(
				model,
				`${task.id}: judge ${slot.provider}/${slot.model} is not in the installed catalog — pin the id the catalog carries, not the docs'`,
			);
		}
	}
});

test("the two tiers never share a model family — independence is structural, not aspirational", () => {
	// The independent tier exists so judge errors cannot correlate with
	// the iteration tier's (spec #132 story 15). Same family on both
	// tiers would make the second verdict an echo. The families are the
	// catalog ids' vendor segments; Jev is the iteration family.
	const slots = BENCH_TASKS.flatMap((t) => t.judges);
	const iteration = slots.filter((s) => s.tier === "iteration");
	const independent = slots.filter((s) => s.tier === "independent");
	assert.ok(iteration.length > 0 && independent.length > 0);
	for (const slot of independent) {
		assert.notEqual(
			slot.model.split("/")[0],
			iteration[0].model.split("/")[0],
			"the independent judge must be a different model family than the iteration judge",
		);
	}
});

test("objective checks are declarative and complete of the closed kinds; exactly one classify entry names its input", () => {
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
				if (check.evidenceSnapshot !== undefined) {
					assert.equal(
						typeof check.evidenceSnapshot,
						"boolean",
						`${task.id}: entry check ${check.id} evidenceSnapshot is a boolean clause`,
					);
				}
			} else if (check.kind === "file-match") {
				assert.ok(
					Array.isArray(check.globs) && check.globs.length > 0,
					`${task.id}: file-match check ${check.id} needs globs`,
				);
				assert.ok(
					Array.isArray(check.textIncludes) && check.textIncludes.length > 0,
					`${task.id}: file-match check ${check.id} needs text needles`,
				);
			} else {
				assert.fail(`${task.id}: unknown objective check kind ${check.kind}`);
			}
		}
		assert.ok(task.classify?.id && task.classify?.question, `${task.id} carries exactly one classify entry`);
		assert.ok(
			typeof task.classify.question.instructions === "string" && task.classify.question.instructions.length > 0,
			`${task.id}: the judge question needs instructions`,
		);
		assert.ok(
			task.checks.some((check) => check.id === task.classify.on),
			`${task.id}: the classify entry's \`on\` must name one of its objective checks`,
		);
		assert.equal(task.classify.question.type, "bool", `${task.id}: the judge question is a bool`);
		assert.ok(
			task.classify.question.criteria?.true && task.classify.question.criteria?.false,
			`${task.id}: the judge question needs both criteria`,
		);
	}
});

test("the image input is available but not required: one committed asset, first session only", () => {
	// Image input rides pi's @path argv (print mode's first-prompt
	// attachment), so a task that carries an image must be single-session
	// — sessions after the first resume with --continue, and @path is a
	// first-prompt argument. The asset is committed under the eval tree
	// and regenerated by the checked-in generator, never hand-edited.
	const carrying = BENCH_TASKS.filter((t) => t.image !== undefined);
	assert.ok(carrying.length >= 1, "at least one task carries the image input (the path must be proven live)");
	for (const task of carrying) {
		assert.match(task.image, /^test\/eval\/assets\//, `${task.id}: the image lives under the eval assets`);
		assert.ok(existsSync(path.join(import.meta.dirname, "..", "..", task.image)), `${task.id}: the image asset is committed`);
		assert.equal(task.sessions.length, 1, `${task.id}: an image task is single-session — @path is a first-prompt argument`);
	}
	assert.ok(
		BENCH_TASKS.some((t) => t.image === undefined),
		"the image input is not required — at least one task runs without it",
	);
});

test("the committed figure equals a regeneration — an edit to it is deliberate, never silent", async () => {
	const { renderFigure } = await import("./assets/make-figure.mjs");
	const committed = readFileSync(path.join(import.meta.dirname, "assets", "method-choice-fig.png"));
	assert.deepEqual(committed, renderFigure(), "the asset drifted from its generator — regenerate and re-land, disclosed");
});

test("the multi-session resume path is exercised by the suite", () => {
	const multi = BENCH_TASKS.filter((t) => t.sessions.length > 1);
	assert.ok(multi.length >= 1, "at least one task resumes (resume-keeps-tools is structure the suite must exercise)");
	for (const task of multi) {
		assert.ok(task.image === undefined, `${task.id}: a multi-session task cannot carry an image (first-prompt only)`);
	}
});
