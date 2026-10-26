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
A recorded source with its retrieval details and content-addressed snapshot; M3 stores the connector's structured output as the snapshot.
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
The permission extension that confirms the compute gateway's destructive calls — `submit_job`, `cancel_job`, and `run_alphafold3`, the calls the gateway's own MCP annotations mark destructive — before they reach the gateway; read-only gateway tools run ungated. M4 ships the minimal form; M5's gate framework extends it.
_Avoid_: approval gate, consent prompt

**Clean-room rig**:
The disposable Linux container a dogfood or adversarial session runs in: the checkout is a fresh clone of the pinned HEAD in the container's ephemeral home, the evidence dir mounts in from the host, and the provider key is the one credential it receives. ADR 0005 ships it.
_Avoid_: dev server, test server
