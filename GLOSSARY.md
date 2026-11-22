# theta-agent

Language for the theta-agent repo: the pi package that grows into Theta, the science co-researcher agent. Campaign-level vocabulary lives in the vault's `CONTEXT.md`; this file covers the terms this repo owns.

## Language

**Skill tiers**:
The role classes Theta inherits from the K-Dense skill library: Tier-1 research-loop core (vendored in M1, ships in every session), Tier-2 compute infrastructure (excluded — theta-compute replaces it), Tier-3 domain modules (the skill pool, loaded per research project). Every tier has landed or found its replacement.
_Avoid_: source tiers (the survey's literature-matrix meaning), levels

**Vendored skill**:
A skill copied verbatim from `K-Dense-AI/scientific-agent-skills`, changed only by its provenance header.
_Avoid_: imported skill, third-party skill

**Provenance header**:
The metadata block in a vendored `SKILL.md` recording upstream repo, release tag, commit, date, and license.
_Avoid_: attribution header, source note

**Orchestrator**:
The self-authored `theta-research-loop` skill; it walks frame, search, hypothesize, design, execute, report, routes work into the skill library, and records each stage's output into the project notebook.
_Avoid_: umbrella skill, router, meta-skill

**Connector skill**:
A Theta-owned skill wrapping scholarly APIs with helper scripts; search and metadata with enforcement in code. M2 ships `theta-lit-search`. Shape may differ at later milestones.
_Avoid_: plugin, API binding, registered tool

**Re-sync**:
The milestone-boundary re-vendor of changed upstream skills, updating provenance headers.
_Avoid_: upgrade, sync, upstream pull

**Tracer**:
The first slice of a batch, taken end-to-end to prove the pattern the remaining slices then repeat mechanically; M1's tracer vendored two K-Dense skills and shipped them alongside the self-authored orchestrator.
_Avoid_: pilot, spike

**Project notebook**:
The durable, project-scoped record of a research effort — provenance entries with their evidence — accumulating across sessions and tools in the research project's workspace. M3 ships it.
_Avoid_: lab notebook, session receipts

**Provenance entry**:
One dated append to the project notebook; one of five types — hypothesis, method, observation, decision, confidence — carrying evidence-to-hypothesis links.
_Avoid_: provenance record, run receipt

**Evidence item**:
A recorded source with its retrieval details and content-addressed snapshot; the snapshot is the connector's structured output or, since M4, the compute gateway's assembled job record.
_Avoid_: evidence package, citation record

**Evidence grade**:
The Ehrlich-line trust mark on an evidence item or an observation — re-executed, cross-checked, or asserted; it grades sources, never the researcher's judgment.
_Avoid_: trust score, confidence level

**Attestation leg**:
One spot-check module of the dogfood auditor — skill read, script executed, notebook written — registered in one ordered array and run through one shared interface against the session's transcript.
_Avoid_: spot-check block, inline check

**Session evidence**:
The artifact bundle a dogfood or adversarial run leaves in its session dir — the process facts (`exit-status`, `stderr.txt`, `pi-version`, `node-version`, `prompt.txt`, `expected-model`, `pre-head`, `manifest-sha256`, the `watchdog` sentinel) plus the transcript its ISO-instant name grammar picks out — which the dogfood auditor binds to the checkout and attests. `scripts/session-evidence.mjs` owns the artifact list, the grammar, the audit's floor constants, and the read-once discipline; the rig runner, the RPC driver, and the test fixtures import the names.
_Avoid_: evidence folder, session bundle

**Compute gateway**:
The MCP server (theta-compute) on the cluster's login node wrapping the Slurm CLI; enforcement — path sandbox, command guard, audit line — stays server-side. M4 ships it.
_Avoid_: compute daemon, job server

**Command guard**:
The compute gateway's allow-list over `submit_job` directives — partition, time, mem, ntasks, cpus-per-task, gres — each value one safe token under its ceiling; the client shapes directives only, never commands.
_Avoid_: directive guard

**Staging root**:
The one cluster-side directory that holds every run directory; the boundary the gateway's path sandbox enforces and the target the over-cap error names for the out-of-band scp move.
_Avoid_: staging area, staging directory, staging folder

**Template registry**:
The deploy-time directory the compute gateway loads its typed tools' job templates from: each template's script plus a `registry.json` manifest naming its free variables, input file, and output directory. Template bytes are institutional and never enter git.
_Avoid_: template cache, template store

**Gateway skill**:
The Theta-owned skill carrying the compute doctrine — when to stage, submit, poll, fetch, and record — while the model calls the compute gateway's tools directly; no wrapper scripts.
_Avoid_: compute connector, wrapper skill

**Job record**:
The evidence item a compute job appends to the project notebook as a method entry: job ID, gateway, template, argument digest, artifact manifest, final state.
_Avoid_: run receipt, job receipt

**Submit gate**:
The permission extension that confirms the compute gateway's destructive calls — `submit_job`, `cancel_job`, and `run_alphafold3`, the confirm set the gateway's own MCP annotations must agree with (a disagreement is drift and refuses loudly) — before they reach the gateway; read-only gateway tools run ungated. A stacked gate framework since M5 S2: confirms from interleaved calls stay safe (pi 1.4.0's concurrent-dialog fix is the floor), and a nested (codemode) call carries its `parentToolCallId` into the prompt, the refusal, and the gate log — one JSONL line per gated decision, written beside the session transcript.
_Avoid_: approval gate, consent prompt

**Submit capability**:
The compute gateway's deploy-time hold on job creation — `on` by default; while `off`, `submit_job` and `run_alphafold3` answer a hard refusal (a HOLD audit line) and `cancel_job` with the read-only tools stay in service. The state rides the deploy env (`theta-compute.env` on the cluster), so restarts keep it by construction. ADR 0006 ships it.
_Avoid_: kill switch, maintenance mode, feature flag

**Submit ceiling**:
The compute gateway's per-principal rolling bound on job creation — the deploy env names how many submits (`submit_job`, `run_alphafold3`) one principal may spend per rolling window (20 an hour by default); the count derives from the audit log itself, and past the bound the call answers a throttled refusal (a THROTTLE audit line) naming principal, count, and window. M5 ships it.
_Avoid_: quota, spend cap

**Clean-room rig**:
The disposable Linux container a dogfood, adversarial, eval-capture, or benchmark session runs in: the checkout is a fresh clone of the pinned HEAD in the container's ephemeral home, the evidence dir mounts in from the host, and it receives at most two credentials — the provider key always, plus the gateway token on a gateway leg (a benchmark leg never takes it), reached through the host-side port-forward (the cluster SSH key never enters). ADR 0005 ships it; M5 S3 admits the second credential.
_Avoid_: dev server, test server

**Codemode**:
pi's built-in tool for scripted tool use (shipped 0.99.0): the model writes a JavaScript script, pi runs it in a QuickJS sandbox, and the script calls pi's other tools — bash and MCP tools included — as async functions, with only the script's output reaching the model. Nested calls still cross the tool-call pipeline (`parentToolCallId` links the layers), so permission gates see them exactly like direct calls; a session whose MCP server exposure includes it runs the tool auto-activated.
_Avoid_: code mode, sandbox mode

**Durable run**:
A run that outlives its process — turns committed to storage before they are shown, an interrupted run resumed from storage after a crash. The pi coding agent has durable session files but no durable runs (a run dies with its process; resume is transcript replay in a new process); true durable runs live only in the separate experimental pi-durable harness, a watch item under the floor-review cadence — M7's session/run broker stays Theta-built, and long-horizon durability rides theta-compute (cluster jobs outlive the laptop).
_Avoid_: persistent session, background run

**Tool policy**:
The compute gateway's per-tool enforcement record — annotations, job-creating, guard — co-located with each tool's definition and read by the audit middleware, the hold and throttle bounds, and the boundary tests; a mismatch between policy and registered surface refuses at boot. Spec #116 ships it.
_Avoid_: tool set, policy table, tool registry

**Eval suite**:
The umbrella for Theta's measurement at M6: the keyless, deterministic replay net plus the live-model benchmark suite — a custom harness built on pi primitives (session files, `models.classify()`, the UsageEntry cost ledger), decided because pi ships no eval tooling of its own. ADR 0007 decides it.
_Avoid_: eval harness, evaluation framework

**Replay net**:
The eval suite's base layer: a keyless, deterministic regression net over recorded sessions, run host-side in the standard test suite. Its replay is the durable-run entry's transcript replay, applied offline to fixtures — no model, no key — and the net compares normalized recordings against committed snapshots to catch skill-edit and vendored re-sync drift. Fixtures stay in pi's session-file format; the normalization layer is Theta-built. ADR 0007 decides it.
_Avoid_: regression suite, replay suite

**Benchmark suite**:
The eval suite's live layer: graded task suites run against the model, as a mode of the clean-room rig, carrying only the provider key. Single-model first (provider is config); two-tier judging — iteration and independent tiers through named config slots that never share a model family (a disclosed bend from ADR 0007's campaign-provider letter: pi's classifier catalog is closed to its families, so both tiers ride OpenRouter); costs ride pi's native UsageEntry ledger. ADR 0007 decides it.
_Avoid_: benchmark harness, live eval

**Workspace-as-oracle**:
The benchmark suite's grading doctrine: the workspace is the oracle — model prose and tool-result text do not prove an external effect; the graded evidence is the state the run left behind. Subjective tasks are judged by `models.classify()`, adopted under the standing adoption rule. ADR 0007 decides it.
_Avoid_: transcript grading, output grading

**Eval capture**:
A session recording taken deliberately for the eval suite — an eval-shaped scenario run in the clean-room rig — never evidence derived from a dogfood run. A model-visible change (skill text, connector script, orchestrator doctrine, extension code, the project context) lands only with a fresh capture. Distinct from session evidence, the dogfood run's artifact bundle. ADR 0007 decides it.
_Avoid_: evidence reuse, recycled transcript

**Surface class**:
One of the model-visible byte classes an eval capture binds, one digest per class in the fixture's provenance manifest: the advertisement, a skill tree, the extension sources, the project context, and a skill pool's pack tree with its class map. The registry is `test/eval/surfaces.mjs`, pinned by `test/eval/surfaces.test.mjs`. Spec #133 ships it; spec #167 adds the pool class.
_Avoid_: surface kind, scope class

**Skill pool**:
The versioned in-repo library of vendored domain skills at `pool/` — verbatim K-Dense trees under the ADR 0001 rules, outside the npm tarball — loaded per research project through `.theta/skills.json` instead of shipping in every session. Distinct from the Tier-1 library, which ships in the tarball and loads always. ADR 0008 decides it.
_Avoid_: skill catalog, skill marketplace

**Domain pack**:
One pack per research domain inside the skill pool — protein-engineering, bioinformatics, cheminformatics — the unit a research project loads and a pack re-sync vendors. First wave owner-decided 2026-11-15: 48 skills, zero robots, zero PHI. ADR 0008 decides it.
_Avoid_: skill bundle, skill collection

**Jev gate**:
The skill pool's class-allowance judgment: a one-call `models.classify()` over the project notebook's recent entries and the enabled pack names, deciding which credential classes a project's `skills.json` may load beyond `local`. Fires automatically once per project at a keyed session start — a session is keyed when its pi config resolves the classifier slot — and thereafter only as an explicit owner act; a human-widened allow set outranks the automatic fire, and the metered-spend `cloud` class never enters without the owner's explicit run. The decision and its composed rationale land in the state file; the classifier's key never leaves the host. ADR 0008 decides it.
_Avoid_: classifier gate, model gate

**Class map**:
The skill pool's per-skill credential class map, `pool/classes.json`: one `<pack>/<skill>` → `local` | `key` | `cloud` entry per pool skill — the machine-readable twin of `pool/index.md`'s class column, which the loader reads to gate what a project's state may load. Rides every `pool:<pack>` surface digest, so a reclass is model-visible exactly like a body edit. Spec #160 decides it.
_Avoid_: class list, class table

**Web workbench**:
The browser face of Theta's research loop — one core, two faces: the terminal face (pi's interactive TUI) ships today; the Web workbench is the M7b build, not started yet. The campaign's workbench design note decides the two-face shape beside the cloud feasibility record, and the term goes public on the shipped `/roadmap` card — Spec #186 ships it.
_Avoid_: web frontend, browser dashboard

**Plan object**:
The `.theta/plans/<plan-id>.md` Markdown file stating what a run will compute before Execute — a document, not a graded claim: no evidence, no grade. Its plan-id is the recording date plus a short kebab slug; the researcher may hand-edit it, and every reader names the file by the plan revision its bytes carry. Spec #201 ships it.
_Avoid_: plan mode, planning file

**Plan revision**:
The first 12 hex of a plan object's sha256 over its file bytes — the version a decision entry or a review confirm names. A changed digest is a new revision: an update's change and a researcher's hand edit alike. The recipe is pinned by a committed test vector the TS side passes too, so both languages compute one revision. Spec #201 ships it.
_Avoid_: version number, content version
