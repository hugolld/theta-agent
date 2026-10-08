---
name: theta-research-loop
description: Walks a research task through Theta's six-stage co-researcher loop — frame, search, hypothesize, design, execute, report — and routes each stage into the vendored science skill library. Use when starting or structuring research. Literature questions route to literature-review, hypothesis work routes to hypothesis-generation. Stages without a routed skill yet run inline and gain dedicated skills in later milestones.
license: MIT
metadata:
  version: "0.1.0"
  authorship: self-authored
---

# Theta research loop

This skill is Theta's own voice (the **orchestrator**, per ADR 0001): it turns a
scientist's request into a disciplined loop and routes each stage into the
vendored K-Dense skill library. It carries no domain methods of its own — the
library holds the methods; this skill holds the order and the provenance
discipline.

## The loop

| Stage | Question answered | Routed skill |
|---|---|---|
| 1. Frame | What is being asked, and what counts as an answer? | — (inline for now) |
| 2. Search | What is already known? | `literature-review` |
| 3. Hypothesize | Which candidate explanations survive? | `hypothesis-generation` |
| 4. Design | What test would discriminate? | — (inline for now) |
| 5. Execute | What do the data say? | — (inline for now) |
| 6. Report | What follows, with what uncertainty? | — (inline for now) |

Routing rule: at each stage, invoke the routed skill by name before
improvising. Where no skill is routed yet, run the stage inline and keep its
artifacts (search strings, hypothesis records, analysis plans) so a later skill
can pick them up without rework.

## Stage discipline

1. **Frame** — restate the question in the scientist's terms. Name success
   criteria, constraints, and what would count as a negative result. Record the
   frame before any searching starts.
2. **Search** — route to `literature-review` for systematic or scoping
   searches. Track coverage and gaps; unreviewed web output never stands in for
   full-text assessment.
3. **Hypothesize** — route to `hypothesis-generation`. A hypothesis is a
   proposal to challenge: demand discriminating predictions and named rivals.
4. **Design** — pick methods, data, and controls that could actually reject the
   hypothesis. State the analysis plan before looking at results.
5. **Execute** — run the code and analyses. Record provenance at every step:
   inputs, versions, commands, outputs.
6. **Report** — results with uncertainty, limitations, and citations. Separate
   what the data show from what the scientist should decide.

## Provenance discipline

Every stage output names its inputs: which skill ran, which sources and files
entered, which scripts produced which artifact. The loop's value to a scientist
is an auditable trace, not only an answer.

## Boundaries

- The orchestrator sequences the library; it does not replace it.
- No stage may skip the human gates the routed skills define (ethics, safety,
  data governance).
- Inline stages are explicit placeholders: they improve as the library grows at
  re-syncs and later milestones, and they are not reinvented here.
