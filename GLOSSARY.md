# theta-agent

Language for the theta-agent repo: the pi package that grows into Theta, the science co-researcher agent. Campaign-level vocabulary lives in the vault's `CONTEXT.md`; this file covers the terms this repo owns.

## Language

**Skill tiers**:
The role classes Theta inherits from the K-Dense skill library: Tier-1 research-loop core, Tier-2 compute infrastructure, Tier-3 domain modules. M1 imports Tier-1 only.
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
The disposable Linux container a dogfood or adversarial session runs in: the checkout is a fresh clone of the pinned HEAD in the container's ephemeral home, the evidence dir mounts in from the host, and the provider key is the one credential it receives. ADR 0005 ships it.
_Avoid_: dev server, test server

**Codemode**:
pi's built-in tool for scripted tool use (shipped 0.99.0): the model writes a JavaScript script, pi runs it in a QuickJS sandbox, and the script calls pi's other tools — bash and MCP tools included — as async functions, with only the script's output reaching the model. Nested calls still cross the tool-call pipeline (`parentToolCallId` links the layers), so permission gates see them exactly like direct calls; a session whose MCP server exposure includes it runs the tool auto-activated.
_Avoid_: code mode, sandbox mode

**Durable run**:
A run that outlives its process — turns committed to storage before they are shown, an interrupted run resumed from storage after a crash. The pi coding agent has durable session files but no durable runs (a run dies with its process; resume is transcript replay in a new process); true durable runs live only in the separate experimental pi-durable harness, a watch item under the floor-review cadence — M7's session/run broker stays Theta-built, and long-horizon durability rides theta-compute (cluster jobs outlive the laptop).
_Avoid_: persistent session, background run
