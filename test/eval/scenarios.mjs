// The eval scenario list (spec #133, ADR 0007): every replay-net capture
// is deliberate — one entry per model-visible surface, its prompt and
// expected shape checked in here, prompt for prompt. A capture never
// reuses dogfood evidence (the eval-capture doctrine): test/eval/capture.mjs
// reads the prompt from this list when it drives the rig, so the recorded
// session and the checked-in prompt cannot drift apart, and the net reads
// the expected shape from the same entry when it pins the landed fixture.
//
// The prompt keeps the capture doctrine docs/agents/dogfood.md owns: pure
// ASCII, neutral (it names no skill and no file), one turn, and the
// read-headroom phrasing that survives pi's whole-file read trailer — a
// limit larger than the line count, never an exact-count or fragmented
// read.

export const SCENARIOS = Object.freeze([
	{
		id: "connector",
		prompt:
			"Survey the recent literature on off-target effects of CRISPR base editors. Find three primary research papers from 2025 or 2026, each with a DOI, using the scholarly search tooling this environment provides. Before you rely on any instruction or reference file, read it whole in a single call, with a limit larger than its line count -- never an exact-count or fragmented read. Run the search through the command-line helper that tooling ships, and report for each paper the title, first author, journal, year, and DOI, quoting the structured search output you relied on.",
		// The model-visible surface classes this capture binds — one digest
		// per class, the digest-scope decision (test/eval/surfaces.mjs):
		// the advertisement and project context every session carries, the
		// connector's own tree, and the extension tool declarations.
		surfaces: ["advertisement", "skill:theta-lit-search", "extensions", "project-context"],
		// Capture-time expectation: the auditor legs the rig run passes.
		legs: [
			"skills/theta-lit-search/SKILL.md",
			"skills/theta-lit-search/scripts/pubmed.py",
		],
		// Net-time expectation: the structural shape of the recording.
		shape: {
			advertisesSkill: "theta-lit-search",
			opensSkill: "skills/theta-lit-search/SKILL.md",
			runsScript: "skills/theta-lit-search/scripts/pubmed.py",
		},
	},
]);
