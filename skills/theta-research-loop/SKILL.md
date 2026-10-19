---
name: theta-research-loop
description: Walks a research task through Theta's six-stage co-researcher loop — frame, search, hypothesize, design, execute, report — routes each stage into the skill library, and records each stage's output into the project notebook. Use when starting or structuring research. Literature reviews route to literature-review, searches and lookups on PubMed, arXiv, and Semantic Scholar route to theta-lit-search, hypothesis work routes to hypothesis-generation, and recording at any stage routes to theta-notebook, whose recorder appends dated provenance entries to the research project's notebook. Stages without a routed skill yet run inline and gain dedicated skills in later milestones.
license: MIT
metadata:
  version: "0.2.0"
  authorship: self-authored
---

# Theta research loop

This skill is Theta's own voice (the **orchestrator**, per ADR 0001): it turns a
scientist's request into a disciplined loop and routes each stage into the
skill library. It carries no domain methods of its own — the
library holds the methods; this skill holds the order and the provenance
discipline. Recording is part of that order: each stage appends its record to
the **project notebook** (ADR 0003) through `theta-notebook`, so the loop's
trace accumulates across sessions instead of dying with the transcript.

## The loop

| Stage | Question answered | Routed skill | Records |
|---|---|---|---|
| 1. Frame | What is being asked, and what counts as an answer? | — (inline for now) | — (scoping calls become decision entries) |
| 2. Search | What is already known? | `literature-review`, `theta-lit-search` | evidence items |
| 3. Hypothesize | Which candidate explanations survive? | `hypothesis-generation` | hypotheses |
| 4. Design | What test would discriminate? | — (inline for now) | methods |
| 5. Execute | What do the data say? | — (inline for now) | observations |
| 6. Report | What follows, with what uncertainty? | — (inline for now) | — (reports read what earlier stages recorded) |

Routing rule: at each stage, invoke the routed skill by name before
improvising, and record the stage's output through `theta-notebook` before
moving on — the Records column names what each stage appends to the project
notebook. Decision and confidence entries are cross-cutting: no stage owns
them, and any stage that sets a direction or moves a judgment records one.
Where no skill is routed yet, run the stage inline and keep its
artifacts (search strings, hypothesis records, analysis plans) so a later skill
can pick them up without rework.

## Stage discipline

1. **Frame** — restate the question in the scientist's terms. Name success
   criteria, constraints, and what would count as a negative result. Record the
   frame before any searching starts; a scoping call made here is a decision
   entry.
2. **Search** — route to `literature-review` for systematic or scoping
   reviews, and to `theta-lit-search` for searches and lookups on PubMed,
   arXiv, and Semantic Scholar (its doctrine keeps `paper-lookup` general for
   every other database). Track coverage and gaps; unreviewed web output never
   stands in for full-text assessment. Record what the search showed through
   `theta-notebook`: a claim read off a search output is an observation entry,
   and that output is its evidence item — content-addressed snapshot with its
   evidence grade.
3. **Hypothesize** — route to `hypothesis-generation`. A hypothesis is a
   proposal to challenge: demand discriminating predictions and named rivals.
   Record each hypothesis worth carrying forward, with the connector output
   that motivated it as its evidence.
4. **Design** — pick methods, data, and controls that could actually reject the
   hypothesis. State the analysis plan before looking at results. Record the
   chosen method and the discarded ones — the reason a design lost is
   provenance too; a motivating search rides along as evidence when one
   exists.
5. **Execute** — run the code and analyses. Record provenance at every step:
   inputs, versions, commands, outputs. Each result read off an output is an
   observation; when it backs a recorded hypothesis, link its evidence to that
   hypothesis.
6. **Report** — results with uncertainty, limitations, and citations. Separate
   what the data show from what the scientist should decide. Every claim in
   the report traces to a recorded entry; a direction set here is a decision
   entry, a judgment on a hypothesis a confidence entry.

## Provenance discipline

Every stage output names its inputs: which skill ran, which sources and files
entered, which scripts produced which artifact. Every stage also appends its
record to the project notebook through `theta-notebook` — dated provenance
entries written by the recorder script, never hand-edited; a failed append is
a failure, never silently skipped. Recording is not loop-bound: a standalone
literature search outside this loop leaves the same trace, because any session
that finds evidence records it. The loop's value to a scientist is an
auditable record that outlives the session, not only an answer.

## Boundaries

- The orchestrator sequences the library; it does not replace it.
- The orchestrator never writes the notebook itself: every entry routes
  through `theta-notebook`'s recorder script.
- No stage may skip the human gates the routed skills define (ethics, safety,
  data governance).
- Inline stages are explicit placeholders: they improve as the library grows at
  re-syncs and later milestones, and they are not reinvented here.
