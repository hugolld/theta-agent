# Theta (θ)

**A science co-researcher agent for the [pi](https://pi.dev) coding-agent harness.**

> Theta is the fundamental parameter of the coalescent — the standard model of how
> genetic diversity arises — and the universal symbol for the parameters a model
> fits. One letter, both halves of "computational biology + AI."

## Status

**Very early development (0.0.2 — launcher release).** The architecture,
skill-selection plan, and milestones are being designed in the open. This package
currently reserves the name and lays out the pi package skeleton; functionality
arrives with the milestones below.

## What Theta will be

Describe a scientific task in plain language; Theta plans, searches literature,
writes and runs code, executes analyses, and reports results with a visible trace —
built as a [pi package](https://pi.dev) rather than a monolithic fork:

- **Skills**: curated science skills (literature review, hypothesis generation,
  experimental design, statistics, domain libraries) following the open
  [Agent Skills](https://agentskills.io) specification
- **Connectors**: literature and database tools (PubMed, arXiv, UniProt, …) as pi
  extensions
- **Compute**: remote Slurm-cluster jobs via an MCP compute gateway, with a
  light local sandbox for small tasks
- **Models**: any of pi's 48 providers — bring your own key

Theta ships today as a pi package. The staged plan (M7–M8) grows it into a
standalone `theta` application with pi embedded as the core engine — macOS and
Linux first, Windows later.

## Roadmap

- [ ] M1 — package skeleton, `theta` launcher (bin), Tier-1 research-loop skills
- [ ] M2 — literature connectors (PubMed, arXiv, Semantic Scholar)
- [ ] M3 — research prompt + provenance entries
- [ ] M4 — compute: Slurm MCP gateway + typed AlphaFold3 tool
- [ ] M5 — safety gates + containerized execution
- [ ] M6 — eval suite (MCP client is built into pi)
- [ ] M7 — standalone `theta` shell on pi's headless core (macOS/Linux)
- [ ] M8 — installers & release channel: Homebrew, deb/AUR, Windows

## Install (once functional)

```sh
pi install npm:theta-agent
```

## Try it

theta rides on the [pi](https://pi.dev) coding agent, and pi is a peer
dependency — a global install of theta-agent does not bring `pi` along. Install
pi first, then theta:

```sh
npm i -g @earendil-works/pi-coding-agent
npm i -g theta-agent
theta
```

That launches pi with the Theta package preloaded. `theta --dev` loads Theta from a local checkout — either the launcher's own repo, or the directory you name with `$THETA_DEV_ROOT` (theta never loads an arbitrary current directory this way). Theta targets pi ≥ 0.99; if `theta` reports `pi not found`, install pi with the command above and retry.

## Vendored skills

The research-loop skill library starts from the K-Dense
[`scientific-agent-skills`](https://github.com/K-Dense-AI/scientific-agent-skills)
library, vendored **verbatim** per [ADR 0001](docs/adr/0001-vendor-k-dense-skills-verbatim.md):
upstream names, directory shapes, and content unchanged except a provenance
header in each vendored `SKILL.md`. Re-syncs happen at milestone boundaries.

Currently vendored (upstream release `v2.72.0`, commit `526ebce`):

- `literature-review` — systematic, scoping, and narrative literature reviews
  with reproducible searches and citation checks
- `hypothesis-generation` — evidence-bounded candidate hypotheses, rival
  explanations, and preregistration-ready analysis plans

The `theta-research-loop` orchestrator that routes the research loop into the
library is Theta's own, self-authored work.

K-Dense's skills are MIT-licensed, © K-Dense Inc. If you use them in research,
please cite their paper:

> Kassis, T., Agarwal, V., He, Y., Patel, D., & Brueckner, A. M. (2026).
> *Scientific Agent Skills: A Library of Procedural Knowledge for Research
> Agents*. arXiv:2609.00065. https://doi.org/10.48550/arXiv.2609.00065

## License

MIT
