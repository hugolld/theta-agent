// One home for the suites' hand-built notebook lines — the recorder's own
// shapes, one entry per type (ADR 0003) — per the tree-wide shared-helper
// rule: the notebook-cards suite (#178) built them locally, and the
// notebook-command suite (#182) is the second caller, so the shapes move
// here and both suites consume this module. The write helper moves with
// them: both suites stage a notebook the same way.
import fs from "node:fs";
import path from "node:path";

export const hypLine = JSON.stringify({
	id: "hyp-0001",
	type: "hypothesis",
	date: "2026-11-18",
	text: "CRISPR base editing restores immune function in aged organisms",
	evidence: [
		{
			source: "pubmed",
			endpoints: ["esearch.fcgi", "esummary.fcgi"],
			query: "CRISPR gene therapy",
			retrieved: "2026-11-17",
			grade: "asserted",
			snapshot: "evidence/aa11.json",
		},
	],
});

export const obsLine = JSON.stringify({
	id: "obs-0001",
	type: "observation",
	date: "2026-11-18",
	text: "Two independent retrievals agree that HDR-mediated repair is rare in HSCs",
	grade: "cross-checked",
	evidence: [
		{
			source: "pubmed",
			endpoints: ["esearch.fcgi"],
			query: null,
			retrieved: "2026-11-17",
			grade: "cross-checked",
			snapshot: "evidence/bb22.json",
			supports: "hyp-0001",
		},
	],
});

export const mthJobLine = JSON.stringify({
	id: "mth-0001",
	type: "method",
	date: "2026-11-18",
	text: "AF3 structure prediction run for lysozyme",
	evidence: [
		{
			source: "theta-compute",
			job_id: "12347",
			template: "alphafold3",
			arguments_digest: "a".repeat(64),
			state: "COMPLETED",
			observed: "2026-11-18",
			retrieved: "2026-11-18",
			grade: "re-executed",
			snapshot: "evidence/cc33.json",
		},
	],
});

export const decLine = JSON.stringify({
	id: "dec-0001",
	type: "decision",
	date: "2026-11-18",
	text: "Run the antibody screen as a two-stage cascade",
});

export const cnfLine = JSON.stringify({
	id: "cnf-0001",
	type: "confidence",
	date: "2026-11-18",
	text: "Raised: both strands now agree",
	hypothesis: "hyp-0001",
});

/** Append lines to a project's notebook, terminating each — the recorder's own write shape. */
export function writeNotebook(project, lines) {
	fs.mkdirSync(path.join(project, ".theta"), { recursive: true });
	fs.appendFileSync(path.join(project, ".theta", "notebook.jsonl"), lines.join("\n") + "\n");
}
