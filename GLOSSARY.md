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
The self-authored `theta-research-loop` skill; it walks frame, search, hypothesize, design, execute, report and routes work into the vendored library.
_Avoid_: umbrella skill, router, meta-skill

**Re-sync**:
The milestone-boundary re-vendor of changed upstream skills, updating provenance headers.
_Avoid_: upgrade, sync, upstream pull

**Tracer ticket**:
The first ticket of a batch, taken end-to-end to prove the pattern the remaining tickets then repeat mechanically; M1's tracer vendored two skills plus the orchestrator.
_Avoid_: pilot, spike
