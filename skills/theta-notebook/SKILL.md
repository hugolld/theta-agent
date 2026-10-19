---
name: theta-notebook
description: Theta's project notebook recorder - appends a dated hypothesis provenance entry to the research project's .theta/notebook.jsonl and stores a theta-lit-search structured output as a content-addressed evidence item under .theta/evidence/, graded asserted, cross-checked, or re-executed. Use when a session forms a hypothesis worth keeping and holds connector output behind it, inside the theta-research-loop or after a standalone literature search. Recording runs only through the bundled recorder script, which validates the connector output, never keeps raw HTTP bodies, and reports its exit-code contract. Bibliography and reference management route to citation-management; the remaining entry types (method, observation, decision, confidence) arrive in the M3 batch.
allowed-tools: Read Bash
license: MIT
metadata:
  version: "0.1.0"
  authorship: self-authored
---

# Theta project notebook

The third Theta-owned skill: the recorder for the **project notebook** (ADR
0003) — the durable record of a research effort, accumulating across
sessions and tools in the research project's workspace. A session transcript
dies with the session; the notebook belongs to the project.

## Where the notebook lives

Plain files under `.theta/` in the workspace the session runs in:

- `notebook.jsonl` — one JSON entry per line, **append-only**. Inspect, diff,
  back up, version — no pi runtime needed.
- `evidence/` — sha256-addressed snapshots, one file per evidence item. Same
  bytes, same name: identical evidence stored twice is one file.

## What one call records

The tracer slice records the **hypothesis** entry type, end to end. One
recorder call appends one entry shaped like:

```json
{
  "id": "hyp-0001",
  "type": "hypothesis",
  "date": "2026-10-19",
  "text": "CRISPR-based gene editing can restore immune cell function in aged organisms",
  "evidence": [
    {
      "source": "pubmed",
      "endpoints": ["esearch.fcgi", "esummary.fcgi"],
      "query": "CRISPR gene therapy",
      "retrieved": "2026-10-18",
      "grade": "asserted",
      "snapshot": "evidence/<sha256>.json"
    }
  ]
}
```

- `id` sequences per type (`hyp-0001`, `hyp-0002`, …) so later entries can
  link to this one.
- `date` is the day the entry was recorded; `retrieved` is the day the
  connector made its call (the connector's `provenance.accessed`, carried
  through). Two different claims, both kept.
- The evidence item carries the source, the endpoints called, the query, the
  retrieval date, the grade, and the snapshot address. `query` is the search
  term, or null for an identifier lookup (whose identifiers ride in the
  snapshot itself).
- The snapshot is the connector's `--json` output byte-for-byte — already
  credential-redacted and already dated by the connector's own code. Raw
  HTTP bodies are never kept.

## When to record

- The loop's hypothesize moment: a hypothesis has survived framing and
  search, and the connector output that motivated it is in hand.
- A standalone literature search outside the orchestrator loop that lands a
  claim worth keeping — any session that finds evidence leaves its trace.
- Record only through this skill's script. Never edit `notebook.jsonl` by
  hand; the recorder refuses to append to a notebook it cannot parse, and
  append-only is the format's contract.

## Operations

The recorder writes `.theta/` under the **current directory**, so run it with
the research project's workspace as the cwd — never from inside the skill
tree, which would land the notebook in the package checkout. Resolve the
script path against the skill directory (pi's rule for skill-relative paths)
and pass it absolute:

```bash
cd /path/to/research-project

# Record from a saved connector output:
python3 <theta-notebook-skill-dir>/scripts/notebook.py \
  --hypothesis "TEXT" --evidence search.json --grade asserted

# The real flow — pipe the connector's structured output straight in:
python3 <theta-lit-search-skill-dir>/scripts/pubmed.py --query "CRISPR gene therapy" --json | \
  python3 <theta-notebook-skill-dir>/scripts/notebook.py \
  --hypothesis "TEXT" --evidence - --grade asserted
```

`--evidence` takes the path of a saved `--json` output, or `-` to read it
from stdin.

Requires Python 3.11+ (standard library only). If `python3` is older, run
`python3.13`, `python3.12`, or `python3.11` — the script names them when the
gate trips. Default output is three lines — what was recorded, the evidence
item's source and retrieval date with its grade, and the snapshot address;
`--json` prints the appended entry itself instead.

## Grades

The grade marks how much the evidence item can be trusted. It grades the
source, never the researcher's judgment — judgment is the confidence entry
type, which arrives in the M3 batch and never merges with the grade.

- `asserted` — a single retrieval, not independently verified. The honest
  grade for one literature snapshot; use it unless another genuinely applies.
- `cross-checked` — two independent retrievals were actually compared and
  agree (say, the same record from PubMed and from Semantic Scholar).
- `re-executed` — machinery recomputed the result (M4 job records). A
  session cannot honestly claim it for a literature snapshot.

`--grade` is required rather than defaulted: the trust mark on a source is a
decision, never an accident.

## Exit codes

The exit code is the contract — branch on it, never on the presence of
output. Codes 0 and 1 are the connector scripts' shared meanings; 2 is this
recorder's own failure domain (it makes no requests, so there is no
transport to fail):

| Code | Meaning |
|---|---|
| 0 | Success — the entry is appended and named on stdout. |
| 1 | Usage error — bad arguments, or evidence input that is not a valid connector output. |
| 2 | Notebook failure — the notebook cannot be read (corrupt, or `.theta` is not a directory) or written. |

## Output discipline

- Relay the entry id, the grade, and the snapshot address — the researcher
  can find all of it under `.theta/`.
- A failed append is never silently skipped: a non-zero exit reaches the
  user as a failure.
- The snapshot must be the connector's final structured output — not a
  hand-composed file, not a raw HTTP body the connector never emitted.
- If an entry turns out wrong, the correction is a later entry (the decision
  type arrives in the M3 batch), never a rewrite of history.

## Boundaries

- This slice records hypothesis entries only. Method, observation, decision,
  and confidence entries, and evidence-to-hypothesis links, arrive in the M3
  batch on the same recorder.
- The recorder consumes connector output; it never calls a source itself,
  and the theta-lit-search scripts are untouched by this skill.
- `.theta/` belongs to the research project. In the theta-agent repo's own
  dogfood runs it is gitignored so clean-tree proofs hold; in a research
  project, versioning the notebook is the researcher's choice.
