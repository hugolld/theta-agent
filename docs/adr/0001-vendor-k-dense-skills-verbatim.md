# 0001 — Vendor K-Dense science skills verbatim, re-sync at milestone boundaries

- **Status**: accepted (2026-10-05)
- **Context**: M1 needs a science skill library. Authoring one fresh is slow and discards proven MIT-licensed work. The campaign's reference implementation (T10; see the vault's K-Dense BYOK study) points at `K-Dense-AI/scientific-agent-skills`: MIT, 166 QA'd skills with full Agent Skills frontmatter that pi ≥ 0.99 loads natively.
- **Decision**: Vendor the Tier-1 research-loop-core set (~20 skills, vault handoff §A4) **verbatim** — upstream names, directory shapes, and content unchanged except a `metadata.provenance` header per `SKILL.md`. Theta identity lives in the self-authored `theta-research-loop` orchestrator, which routes the loop into the library. Tier-2 infra skills are excluded: Modal/GPU infra is K-Dense's compute stack, and theta-compute (T3/T4) replaces it in M4. Attribution: provenance headers plus a README "Vendored skills" section carrying the MIT notice and the CITATION.cff citation request. Re-sync: manual, at milestone boundaries, driven by upstream release notes.

## Considered options

- **Fresh authoring** — perfect fit, too slow for M1. Revisit per skill (via K-Dense's mimeo method) where dogfooding shows mismatch.
- **Best-of-breed multi-vendor** (Orchestra-Research, OpenScience) — more licensing stories (Apache-2.0 NOTICE) and styles to manage for no proven need.
- **Light adaptation at import** — better first-fit, but every edit is a merge conflict at re-sync. Deferred until dogfooding proves friction.

## Consequences

- Re-syncs stay clean diffs; upstream fixes arrive only at milestone cadence, and drift between boundaries is accepted.
- The library keeps K-Dense's voice; user-facing Theta-ness concentrates in the orchestrator skill.
- The earlier "six foundation skills" description (stub, CLAUDE.md) is superseded by the ~20-skill Tier-1 set.
