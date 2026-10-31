# Theta (θ)

**A science co-researcher agent for the [pi](https://pi.dev) coding-agent harness.**

> Theta is the fundamental parameter of the coalescent — the standard model of how
> genetic diversity arises — and the universal symbol for the parameters a model
> fits. One letter, both halves of "computational biology + AI."

## Status

**Very early development (0.5.0).** The architecture, skill-selection plan, and
milestones are being designed in the open. M1 through M5 are built: the `theta`
launcher plus the Tier-1 research-loop skill library — K-Dense skills vendored
verbatim plus the self-authored `theta-research-loop` orchestrator (see
[Vendored skills](#vendored-skills)) — the first connector skill,
`theta-lit-search` (PubMed, arXiv, Semantic Scholar; connectors are skills per
[ADR 0002](docs/adr/0002-connectors-are-skills-not-registered-tools.md)), the
project notebook, `theta-notebook` (dated provenance entries carrying
content-addressed, graded evidence snapshots, recorded inside the research
loop and after standalone searches per
[ADR 0003](docs/adr/0003-provenance-is-a-project-notebook.md)), and the
compute gateway, `theta-compute` — remote Slurm jobs through an MCP gateway
with bearer auth, a command guard, and an audit trail
([ADR 0004](docs/adr/0004-compute-is-a-native-mcp-server.md),
`gateway/README.md`) — and the M5 safety gates stacked on it: the deploy-time
submit capability and per-principal submit ceiling server-side
([ADR 0006](docs/adr/0006-a-server-held-capability-bounds-submits.md)), the
stacked submit gate with its session gate log on the theta side, and the
clean-room rig's gateway legs. The milestones below continue from there.

## What Theta will be

Describe a scientific task in plain language; Theta plans, searches literature,
writes and runs code, executes analyses, and reports results with a visible trace —
built as a [pi package](https://pi.dev) rather than a monolithic fork:

- **Skills**: curated science skills (literature review, hypothesis generation,
  experimental design, statistics, domain libraries) following the open
  [Agent Skills](https://agentskills.io) specification
- **Connectors**: literature and database tools (PubMed, arXiv, UniProt, …) as
  Theta-owned connector skills
- **Compute**: remote Slurm-cluster jobs via an MCP compute gateway, with a
  light local sandbox for small tasks
- **Models**: any of pi's available providers — bring your own key

Theta works today as a pi package from a checkout. The staged plan (M7–M8)
grows it into a standalone `theta` application with pi embedded as the core
engine — macOS and Linux first, Windows later.

## Roadmap

- [x] M1 — package skeleton, `theta` launcher (bin), Tier-1 research-loop skills
- [x] M2 — literature connectors (PubMed, arXiv, Semantic Scholar)
- [x] M3 — project notebook: provenance entries with graded evidence
- [x] M4 — compute: Slurm MCP gateway + typed AlphaFold3 tool
- [x] M5 — safety gates + containerized execution
- [ ] M6 — eval suite (MCP client is built into pi)
- [ ] M7 — standalone `theta` shell on pi's headless core (macOS/Linux)
- [ ] M8 — installers & release channel: Homebrew, deb/AUR, Windows

## Install

```sh
pi install npm:theta-agent@0.5.0
```

Requires theta-agent ≥ 0.5.0 on the registry — 0.3.0 and earlier predate the
compute gateway, 0.4.0 predates the M5 safety gates, and a version-pinned
install fails loudly until 0.5.0 is visible. If the registry is not there
yet, run Theta from a checkout instead — see [Try it](#try-it).

## Try it

theta rides on the [pi](https://pi.dev) coding agent, and pi is a peer
dependency — install it first. The zero-registry path is a checkout:

```sh
git clone https://github.com/hugolld/theta-agent
cd theta-agent
npm i -g @earendil-works/pi-coding-agent
node bin/theta.mjs --dev
```

`node bin/theta.mjs --dev` launches pi with this checkout preloaded;
from a checkout you can also name another directory with
`$THETA_DEV_ROOT` (theta never loads an arbitrary current directory
this way). Theta targets pi ≥ 1.4.0; if the launcher reports
`pi not found`, install pi with the command above and retry.

Once theta-agent ≥ 0.5.0 is on the registry (0.3.0 and earlier predate
the compute gateway, and 0.4.0 predates the M5 safety gates — until
0.5.0 is visible, stay on the checkout path above), the installed form
is:

```sh
npm i -g theta-agent@0.5.0
theta
```

That launches pi with the Theta package preloaded.

## Compute gateway setup

Cluster compute rides the `theta-compute` compute gateway — an MCP server on
your institution's Slurm login node (see
[gateway/README.md](gateway/README.md)). Setup is two steps, both one-time;
the cluster-side deploy of the gateway itself is the owner's, per the
phase-0 recipe in the gateway README.

1. **Register the server with pi, user-level** — direct exposure, the model
   calls the gateway's tools themselves; the bearer token lives only in
   your own `~/.pi/agent/mcp.json`, never in any repo:

   ```sh
   pi mcp add theta-compute --url http://127.0.0.1:8421/mcp \
     --header "Authorization=Bearer <token>"
   ```

2. **Open the port-forward while you work** (phase-0 runs the gateway bound
   to loopback on the login node; your machine reaches it through the
   tunnel):

   ```sh
   ssh -N -L 8421:127.0.0.1:8421 <login-node-alias>
   ```

With the forward up, a session's compute tasks run through the gateway's
tools — staging inputs, submitting, polling status, fetching artifacts —
under the doctrine of the `theta-compute` skill. Destructive calls
(`submit_job`, `cancel_job`, `run_alphafold3`) prompt you for confirmation
before they reach the cluster; read-only monitoring runs without prompts.
If a call cannot connect, the forward is down — restart it and carry on.

## Vendored skills

The research-loop skill library starts from the K-Dense
[`scientific-agent-skills`](https://github.com/K-Dense-AI/scientific-agent-skills)
library, vendored **verbatim** per [ADR 0001](docs/adr/0001-vendor-k-dense-skills-verbatim.md):
upstream names, directory shapes, and content unchanged except a provenance
header in each vendored `SKILL.md`. Re-syncs happen at milestone boundaries.

Currently vendored (upstream release `v2.72.0`, commit `526ebce`) — the
Tier-1 research-loop set:

- `literature-review` — systematic, scoping, and narrative literature reviews
  with reproducible searches and citation checks
- `paper-lookup` — searches 18 scholarly APIs for papers, citations, abstracts,
  and open-access full text with reproducible provenance
- `paperzilla` — reads Paperzilla projects, searches project feeds, and
  retrieves recommendations and canonical papers
- `bgpt-paper-search` — searches BGPT scientific papers by topic or DOI and
  retrieves claim-level evidence from full text
- `research-lookup` — compiles current scholarly evidence for manuscripts and
  research briefs via Parallel Search, Extract, and Research
- `citation-management` — citation search, metadata validation, and BibTeX
  generation across OpenAlex, PubMed, and Google Scholar
- `pyzotero` — manages Zotero reference libraries through the pyzotero Python
  client and the Zotero Web API
- `peer-review` — evidence-bounded, constructive peer-review drafts and
  structured manuscript assessments
- `scholar-evaluation` — qualitative-first, evidence-traceable developmental
  review of scholarly works and research-assessment rubrics
- `scientific-writing` — drafts, revises, and audits manuscripts with explicit
  evidence provenance and reporting-guideline coverage
- `scientific-critical-thinking` — evaluates scientific claims and evidence
  quality: validity, bias, confounders, and evidence grading
- `scientific-brainstorming` — evidence-aware scientific ideation with
  structured discussion, adversarial review, and decision logs
- `hypothesis-generation` — evidence-bounded candidate hypotheses, rival
  explanations, and preregistration-ready analysis plans
- `hypogenic` — plans and audits LLM-assisted hypothesis generation from
  labeled text datasets with HypoGeniC/HypoRefine
- `experimental-design` — designs experiments before data collection:
  randomization, blocking, factorial designs, and treatment layouts
- `statistical-analysis` — guided test selection, assumption checking, effect
  sizes, power analysis, and APA-formatted reporting
- `statistical-power` — sample-size and power calculation, closed-form and
  simulation-based, for study planning
- `uncertainty-and-units` — unit tracking and measurement-uncertainty
  propagation in scientific calculations
- `exploratory-data-analysis` — bounded, local first-pass analysis profiles of
  supported scientific file formats

The `theta-research-loop` orchestrator that routes the research loop into the
library is Theta's own, self-authored work.

One deliberate omission: `pi-agent`, a Tier-1 candidate that documents the pi
harness itself. It would duplicate pi's own documentation, drift against
installed pi releases, and add nothing to the research loop. The skip is
recorded on [issue #5](https://github.com/hugolld/theta-agent/issues/5).

K-Dense's skills are MIT-licensed, © K-Dense Inc. If you use them in research,
please cite their paper:

> Kassis, T., Agarwal, V., He, Y., Patel, D., & Brueckner, A. M. (2026).
> *Scientific Agent Skills: A Library of Procedural Knowledge for Research
> Agents*. arXiv:2609.00065. https://doi.org/10.48550/arXiv.2609.00065

## License

MIT
