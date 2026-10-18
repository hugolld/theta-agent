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
The self-authored `theta-research-loop` skill; it walks frame, search, hypothesize, design, execute, report and routes work into the skill library.
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
