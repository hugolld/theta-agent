# VERDICT - M2 shape contest: skill layer vs registered pi tool

Written 2026-10-12, from the two-way prototype contest the m1-closeout grilling
session handed off. Question: does M2's literature capability ship as
Theta-owned skill material (SKILL.md + helper scripts, arm A) or a registered
pi tool (pi.registerTool + TypeBox schema, arm B)?

**Pre-registered decision rule** (from the handoff, set before the contest): if
routing reliability, contract enforcement, and evidence quality are comparable
across arms, the skill layer wins by simplicity (owner lean + no packaging
change). A tool win requires a visible, repeatable advantage in at least one of
those three axes across the trial runs.

## The call

**The skill layer wins.** Routing, enforcement, and evidence quality came out
comparable across all six trials; the tool showed no advantage that is both
visible and repeatable on any of the three pre-registered axes.

## How the contest ran

- One capability both arms: PubMed esearch + esummary, identical behavior spec
  (>= 0.34 s pacing with x-ratelimit backoff, 200-body error detection,
  api_key/email/tool redaction, optional NCBI_API_KEY) and one shared
  description text.
- Six one-shot sessions, interleaved A,B,A,B,A,B, per the dogfood.md recipe:
  explicit provider zai-coding-cn / model glm-5.3-flash, stdin closed, 300 s
  watchdog, self-identifying session dirs, arm state as toggle commits so every
  run's advertised skill set is bound to a HEAD by `scripts/audit-dogfood.mjs`.
- One neutral ASCII prompt in all six runs, never naming a skill or tool:
  `Find recent papers on CRISPR base editing off-target effects and give me
  title, first author, year, journal, PMID, and DOI for each.`
- The vendored `paper-lookup` skill stayed present and untouched in both arms;
  every capability pick was recorded.
- Audits: 6/6 base audits passed (boot-clean, runtime floors, model binding,
  exact-set advertisement). 3/3 arm-A selected-file audits passed (the model
  opened `skills/theta-lit-probe/SKILL.md` unprompted). Suite green at every
  toggle commit.

## Scorecard

| Axis | Arm A (skill layer) | Arm B (registered tool) |
|---|---|---|
| Routing | 3/3 runs routed to the skill unprompted; SKILL.md read first in every run, then 3 script calls per run; paper-lookup picked 0/3; time to first use 26.5 s / 8.2 s / 8.7 s | 3/3 runs called `pubmed_probe_search` unprompted, 3 calls per run; paper-lookup picked 0/3; time to first use 8.2 s / 7.2 s / 7.3 s |
| Enforcement | 9/9 PubMed retrievals went through the script; 0 hand-rolled curl; pacing and 200-body detection live in the script (code the model must call, and did); no API errors occurred live, so 200-body detection is code-verified, not run-verified | 9/9 retrievals went through the tool; 0 hand-rolled curl; same enforcement in `execute()`; same caveat on 200-body detection |
| Call quality | Arguments well-formed 9/9; the model read the SKILL.md usage and used `--retmax` and `--sort pub_date` on its own in runs 2-3; queries refined PubMed-style across calls; no retries needed; no truncation | Arguments well-formed and schema-validated 9/9 (`retmax` 10-12, `sort: pub_date` from the first call); no retries; no truncation |
| Evidence | bash toolCall records carry the exact command line; toolResult records carry the full stdout incl. redacted provenance URLs; the repo auditor attests this shape (selected-file-opened 3/3) | toolCall records carry name + typed arguments; toolResult records carry `isError`, content, and structured `details` (query, count, pmids, records, provenance) - machine-checkable without parsing shell text |
| Cost | ~155 lines stdlib-only Python + a 30-line SKILL.md; no TS, no peer imports, no manifest change (skills dir is scanned) | ~215 lines TS extension importing `typebox` + peer types; typecheck/lint integrate cleanly; no manifest change (extensions dir is scanned) |

Run-by-run pointers (session dirs hold transcript, process files, and audit
attestations; per-run detail in `prototype/analysis-summary.txt`):

| Run | Session dir | Span | Arm-code calls | Audits |
|---|---|---|---|---|
| A1 | `prototype/evidence/dogfood-protoA-1-74bbf53/` | 79.6 s | 3 | base ok, selected-file ok |
| B1 | `prototype/evidence/dogfood-protoB-1-99cf989/` | 51.6 s | 3 | base ok |
| A2 | `prototype/evidence/dogfood-protoA-2-fe3a2a6/` | 52.8 s | 3 | base ok, selected-file ok |
| B2 | `prototype/evidence/dogfood-protoB-2-089b85d/` | 50.1 s | 3 | base ok |
| A3 | `prototype/evidence/dogfood-protoA-3-27f287a/` | 79.0 s | 3 | base ok, selected-file ok |
| B3 | `prototype/evidence/dogfood-protoB-3-ef7537e/` | 59.6 s | 3 | base ok |

Why no tool advantage crosses the pre-registered bar:

- Routing reliability is equal (3/3 both, incumbent never picked). Arm B's
  faster first use (~7-8 s vs 8-26 s) is the saved SKILL.md read - a latency
  nicety, not a reliability gain.
- Enforcement is live-comparable (18/18 model-initiated retrievals through arm
  code, 0 bypasses). One structural nuance favors the tool: its pacing bucket
  spans the whole session, while the script's spans one invocation, so parallel
  bash calls could in principle burst past 3 req/s. This never occurred (all
  calls were 7-16 s apart), and a stateless script cannot fix it; note it as a
  residual, not a repeatable observed advantage.
- Evidence is fully auditable both ways. Arm B's structured `details` records
  are nicer for machine audits, but the repo's own auditor already attests the
  skill shape end-to-end, so the campaign's evidence standard is met by both.

## Residual risks

1. n = 3 per arm, one model, one provider, one day. Routing was unanimous
   (6/6), which is strong for this setup but not proof at scale.
2. `paper-lookup` lost every run. The division-of-labor question is real: the
   new capability's specific description won routing in all six runs, but
   overlapping descriptions remain a routing risk for other phrasings, models,
   or sources (the incumbent covers 17 more databases).
3. The skill layer's build-time failure mode is silent: a YAML-invalid
   description (a colon-space inside the plain scalar) drops the skill with a
   clean boot and no stderr - observed live during scaffold. The tool layer
   fails loudly at extension load. This is fixable with a test guard and did
   not affect the audited runs, but it is the sharpest asymmetry found.
4. Per-invocation script pacing (above).
5. The dogfood recipe's own watchdog teardown can write a false `fired`
   sentinel on clean runs (`pkill -P $watchdog` before `kill $watchdog` lets
   the subshell advance to the sentinel write; observed live 2026-10-12). Fixed
   in this branch's harness by swapping the order; `docs/agents/dogfood.md` on
   main needs the same swap.

## What M2's spec must say either way

- Routing doctrine: theta-owned literature material carries descriptions
  specific enough to win routing over `paper-lookup` (won 6/6 here);
  `paper-lookup` remains the general scholarly interface for the other
  databases. State the division explicitly.
- Enforcement lives in code the model calls - script or `execute()` - never in
  prose: pacing, 200-body error detection, redaction. Both arms showed the
  model defers to provided code when it is reachable and described.
- Dogfood audit assertions for M2: exact-set skill advertisement (auditor
  already enforces), selected-file-opened for skill material (already works),
  plus a new test-seam guard: SKILL.md frontmatter must parse with a real YAML
  parser (the checked-in subset parser accepted the invalid description that
  pi silently dropped).
- Packaging: either shape needs no manifest change (both dirs are scanned);
  the skill shape keeps the package free of TS runtime surface for connectors.

## Harness findings for the repo (outside contest scope)

- The watchdog teardown ordering bug in `docs/agents/dogfood.md` (risk 5)
  deserves a main-branch fix with a regression note.
- pi delivers custom-tool declarations via the provider tool schema, not the
  system prompt's tools section (generic "other custom tools" boilerplate
  only); transcript toolResult records do persist structured `details`.
  `docs/agents/pi-transcript-schema.md` could state both.

The grilling session resumes from here: remaining frontier is where the
material lives, what it contains, tracer order, and the dogfood evidence
criterion.
