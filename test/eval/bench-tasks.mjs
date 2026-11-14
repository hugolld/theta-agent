// The benchmark task list (spec #135, ADR 0007): the eval suite's live
// layer is graded task suites, and every benchmark run is deliberate —
// the task's prompts, its workspace-oracle checks, and its judge slot
// are checked in here, read by the rig's eval mode
// (`node test/rig/run.mjs eval <task-id>`) when it drives the leg. The
// list is to the benchmark layer what test/eval/scenarios.mjs is to the
// replay net: the only source of what runs, prompt for prompt.
//
// Grading doctrine (GLOSSARY, "Workspace-as-oracle"): the workspace is
// the oracle — model prose proves nothing. Objective checks are
// declarative (`checks`, executed by test/eval/bench-grade.mjs against
// the task workspace the session ran in); exactly one subjective check
// rides `models.classify()` per task, judged host-side by the named
// judge slot. The judge is config, never a hard-coded identity in code:
// `tier: "iteration"` is the campaign-iteration tier (per-strike
// checks, never public-destined numbers); the independent tier that
// judges numbers for public surfaces is a later strike's slot.
//
// Prompts keep the capture doctrine: pure ASCII, neutral (names no
// skill and no file), one turn per session, one plain command per
// call, and the read-headroom phrasing shared with the scenario list.
// `sessions` is the multi-session shape: each entry is one print-mode
// session in the same task workspace; entries after the first resume
// with `--continue` (resume-keeps-tools, ADR 0007). The tracer task
// is single-session.

import { READ_HEADROOM } from "./scenarios.mjs";

export const BENCH_TASKS = Object.freeze([
	{
		id: "provenance-decision",
		// The named judge slot (ADR 0007: the judge's identity is the
		// owner's choice at the benchmark strike, never hard-coded). The
		// iteration tier rides OpenRouter's Jev — the campaign's chat
		// provider cannot serve classify() (pi's classifier catalog is
		// closed to the Jev/Clef/Decisions families; probed 2026-11-14,
		// zero classifiers reachable through the campaign entry), so the
		// iteration slot names the owner-picked classifier host. Its key
		// lives host-side only; the judge never runs in the rig.
		judge: { tier: "iteration", provider: "openrouter", model: "typesafe/jev-1.14" },
		sessions: [
			`Our team has decided to sequence the confirmatory cohort with long-read sequencing instead of short reads, starting with the March batch. Record this decision for the project so a later session can find it, using whatever provenance recording this environment provides, and tell me exactly what was written and where. Run each command as one plain call -- no trailing status echoes; ${READ_HEADROOM}`,
		],
		// Objective, workspace-as-oracle: the notebook the recorder owns,
		// checked as files — never the session's prose about them.
		checks: [
			{ id: "notebook-written", kind: "file", path: ".theta/notebook.jsonl" },
			{
				id: "decision-entry",
				kind: "notebook-entry",
				path: ".theta/notebook.jsonl",
				type: "decision",
				idPrefix: "dec-",
				textIncludes: ["long-read", "sequenc"],
			},
		],
		// The one subjective check: classify() judges the recorded entry
		// against the task statement. `on` names the objective check whose
		// matched workspace artifact is the judge's state input (never
		// model prose); the session's own prompt is the other half.
		classify: {
			id: "entry-faithful",
			on: "decision-entry",
			question: {
				type: "bool",
				instructions:
					"A lab team asked a research assistant to record a decision in the project notebook. Reading the task prompt and the recorded notebook entry, does the entry capture the decision with enough of its specifics (what was decided and the scope it applies to) that a later session could find it and act on it without asking again?",
				criteria: {
					true: "The entry records the decision with retrievable specifics",
					false: "The entry is missing, vague, or does not capture the decision",
				},
			},
		},
	},
]);

// One home for the id lookup (the benchmark CLI and the tests share it):
// throws — the CLI maps the message to its refusal, a test import fails
// its assertion instead of exiting the runner.
export function benchTaskById(id) {
	const task = BENCH_TASKS.find((t) => t.id === id);
	if (task === undefined) {
		throw new Error(`unknown benchmark task id: ${id} (the checked-in list is the source)`);
	}
	return task;
}
