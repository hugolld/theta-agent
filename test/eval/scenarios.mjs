// The eval scenario list (spec #133, one fixture per model-visible surface
// by #134, ADR 0007): every replay-net capture is deliberate — one entry
// per model-visible surface, its prompt and expected shape checked in
// here, prompt for prompt. A capture never reuses dogfood evidence (the
// eval-capture doctrine): test/eval/capture.mjs reads the prompt from this
// list when it drives the rig, so the recorded session and the checked-in
// prompt cannot drift apart, and the net reads the expected shape from the
// same entry when it pins the landed fixture.
//
// The prompt keeps the capture doctrine docs/agents/dogfood.md owns: pure
// ASCII, neutral (it names no skill and no file — the auditor's
// prompt-neutrality gate refuses a routed prompt that names what its leg
// attests), one turn, and the read-headroom phrasing that survives pi's
// whole-file read trailer — a limit larger than the line count, never an
// exact-count or fragmented read.
//
// Surfaces are honest to what the session saw (the digest-scope decision,
// test/eval/surfaces.mjs): the advertisement and project context every
// session carries, the scenario's own skill tree once its shape pins the
// open, and the extensions surface. The orchestrator fixture binds one
// vendored tree (skill:hypothesis-generation, the skill its doctrine
// routes the hypothesize stage to) — a body-only vendored re-sync, the
// drift class ADR 0007 names, reds that fixture's pin. A scenario whose
// session proves to open a further skill tree gains that binding at land
// time (a test-tree-only edit, never a recapture).
//
// `gateway: true` marks the one capture the rig runs with the gateway
// admitted (capture.mjs passes --gateway): the gate only judges gateway
// calls, so the extension's user-facing strings — the refusal reasons —
// are model-visible only in a gateway-bearing session. The forward must be
// up for that leg; no job is created (print mode answers no confirms, so
// the submit gate refuses before any server call).

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
	{
		id: "orchestrator",
		prompt:
			"An early experiment in our lab suggests a CRISPR base-editing treatment partially restored immune function in aged mice. Turn this into a disciplined research effort: state the question you would pursue first, the competing explanations worth testing, and what evidence could discriminate between them, and say which direction you are setting and why. Before you rely on any instruction or reference file, read it whole in a single call, with a limit larger than its line count -- never an exact-count or fragmented read.",
		// The orchestrator doctrine (the surface) plus the vendored skill its
		// hypothesize stage routes to — the re-sync drift binding. If the
		// capture's session also records through the project notebook, that
		// tree joins this list at land time.
		surfaces: [
			"advertisement",
			"skill:theta-research-loop",
			"skill:hypothesis-generation",
			"extensions",
			"project-context",
		],
		// One auditor leg: the rig attests the orchestrator SKILL.md read.
		// The routed vendored open is shape-pinned net-side only (the rig
		// attests one skill read).
		legs: ["skills/theta-research-loop/SKILL.md"],
		shape: {
			advertisesSkill: "theta-research-loop",
			opensSkill: "skills/theta-research-loop/SKILL.md",
			opensSkillsToo: ["skills/hypothesis-generation/SKILL.md"],
		},
	},
	{
		id: "notebook",
		prompt:
			"Our team has decided to run the next antibody screen as a two-stage cascade instead of one large pass. Record that decision for the project so a later session can find it, using whatever provenance recording this environment provides, and tell me exactly what was written and where. Before you rely on any instruction or reference file, read it whole in a single call, with a limit larger than its line count -- never an exact-count or fragmented read.",
		surfaces: ["advertisement", "skill:theta-notebook", "extensions", "project-context"],
		// All three auditor slots, the M3 notebook dogfood shape: the skill
		// read, the recorder executed, the notebook written (the notebook leg
		// requires the recorder as the script leg).
		legs: [
			"skills/theta-notebook/SKILL.md",
			"skills/theta-notebook/scripts/notebook.py",
			".theta",
		],
		shape: {
			advertisesSkill: "theta-notebook",
			opensSkill: "skills/theta-notebook/SKILL.md",
			runsScript: "skills/theta-notebook/scripts/notebook.py",
		},
	},
	{
		id: "gateway-skill",
		prompt:
			"An AlphaFold3 structure prediction job we submitted to our compute cluster yesterday seems stuck in the queue. Following the guidance this environment provides for cluster work, lay out how we should check its status and, once it finishes, retrieve the finished model files, including the cautions at each step. Do not run any cluster work in this reply -- I want the plan only. Before you rely on any instruction or reference file, read it whole in a single call, with a limit larger than its line count -- never an exact-count or fragmented read.",
		surfaces: ["advertisement", "skill:theta-compute", "extensions", "project-context"],
		// Doctrine read, plan written: no script (the gateway skill carries
		// no helper scripts), no gateway leg — the capture stays cluster-free.
		legs: ["skills/theta-compute/SKILL.md"],
		shape: {
			advertisesSkill: "theta-compute",
			opensSkill: "skills/theta-compute/SKILL.md",
		},
	},
	{
		id: "extension-strings",
		prompt:
			"A small validation run named smoke-check is already staged on our compute cluster. Submit it through the cluster gateway now, following the guidance this environment provides for cluster work, and tell me exactly what happened -- including anything that stopped it. Before you rely on any instruction or reference file, read it whole in a single call, with a limit larger than its line count -- never an exact-count or fragmented read.",
		surfaces: ["advertisement", "skill:theta-compute", "extensions", "project-context"],
		// The one gateway-bearing capture: the rig preflight needs the
		// host-side forward up. The submit is refused by the submit gate
		// (print mode answers no confirms) before any server call — the
		// extension's user-facing refusal is what the fixture pins, and no
		// job is created.
		gateway: true,
		legs: ["skills/theta-compute/SKILL.md"],
		shape: {
			advertisesSkill: "theta-compute",
			opensSkill: "skills/theta-compute/SKILL.md",
			gateRefusal: "submit_job",
		},
	},
]);
