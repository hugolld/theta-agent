---
name: theta-notebook
description: Theta's project notebook recorder - appends dated provenance entries to the research project's .theta/notebook.jsonl in all five types (hypothesis, method, observation, decision, confidence), storing theta-lit-search structured outputs as content-addressed evidence items under .theta/evidence/, graded asserted, cross-checked, or re-executed. A grade rates the source; a confidence entry records the researcher's judgment. An observation can link its evidence to the hypothesis it supports. Use when a session forms a hypothesis worth keeping, chooses or discards a method, reads something off a search result, takes a decision, or updates its confidence, and holds connector output behind it, inside the theta-research-loop or after a standalone literature search. Recording runs only through the bundled recorder script, which validates the connector output, never keeps raw HTTP bodies, and reports its exit-code contract. Bibliography and reference management route to citation-management.
allowed-tools: Read Bash
license: MIT
metadata:
  version: "0.2.0"
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

## The five entry types

One recorder call appends one entry. Every entry carries its `id` (sequenced
per type), its `type`, the `date` it was recorded, and its `text`.

| Type | Ids | Text flag | Evidence | Also carries |
|---|---|---|---|---|
| hypothesis | `hyp-0001`… | `--hypothesis` | required | — |
| method | `mth-0001`… | `--method` | optional | — |
| observation | `obs-0001`… | `--observation` | required | its own `grade`; items may link |
| decision | `dec-0001`… | `--decision` | optional | — |
| confidence | `cnf-0001`… | `--confidence` | never | the `hypothesis` it judges (`--on`) |

- A hypothesis or an observation is a claim about what a source showed, so
  evidence is required. A method or a decision may stand on the researcher's
  reasoning; record the motivating search as its evidence when one exists.
- A confidence entry is judgment, not a source claim: it takes no evidence,
  and `--on` names the hypothesis entry it judges — recorded later, so the
  judgment history sits next to the evidence it weighs.
- **Evidence-to-hypothesis links**: an observation's evidence item may carry
  `supports: hyp-0001` (`--supports`), marking it as backing an existing
  hypothesis. The recorder refuses a link that names no recorded hypothesis.
  A hypothesis entry's own evidence needs no link — it backs that entry.

A hypothesis entry, and an observation linked to it, from the same notebook:

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

```json
{
  "id": "obs-0001",
  "type": "observation",
  "date": "2026-10-20",
  "text": "Two independent retrievals agree that HDR-mediated repair is rare in HSCs",
  "grade": "cross-checked",
  "evidence": [
    {
      "source": "pubmed",
      "endpoints": ["esearch.fcgi", "esummary.fcgi"],
      "query": "CRISPR gene therapy",
      "retrieved": "2026-10-18",
      "grade": "cross-checked",
      "snapshot": "evidence/<sha256>.json",
      "supports": "hyp-0001"
    }
  ]
}
```

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
- The design moment: a method is chosen or discarded — record the choice,
  with the search that motivated it as evidence when there is one.
- The execute moment: reading a result off a search output is an
  observation; when it backs an existing hypothesis, link the evidence.
- Any point a direction is set or cut: a decision, recorded as its own
  entry so the correction of an earlier entry is a later entry, never a
  rewrite of history.
- When judgment moves: a confidence entry on a named hypothesis — raised,
  lowered, or held, with the reasoning in the text.
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

# The real flow — a hypothesis off a live search, piped straight in:
python3 <theta-lit-search-skill-dir>/scripts/pubmed.py --query "CRISPR gene therapy" --json | \
  python3 <theta-notebook-skill-dir>/scripts/notebook.py \
  --hypothesis "TEXT" --evidence - --grade asserted

# The chosen method, with the search that motivated it:
python3 <theta-notebook-skill-dir>/scripts/notebook.py \
  --method "TEXT" --evidence search.json --grade asserted

# An observation, its evidence linked to the hypothesis it supports:
python3 <theta-notebook-skill-dir>/scripts/notebook.py \
  --observation "TEXT" --evidence search.json --grade cross-checked --supports hyp-0001

# A decision (no evidence needed), and a confidence judgment:
python3 <theta-notebook-skill-dir>/scripts/notebook.py --decision "TEXT"
python3 <theta-notebook-skill-dir>/scripts/notebook.py \
  --confidence "TEXT" --on hyp-0001
```

`--evidence` takes the path of a saved `--json` output, or `-` to read it
from stdin. `--on` and `--supports` must name a hypothesis entry already in
the notebook; a reference that names no recorded hypothesis is a usage
error, never an entry.

Requires Python 3.11+ (standard library only). If `python3` is older, run
`python3.13`, `python3.12`, or `python3.11` — the script names them when the
gate trips. Default output is the recorded line, then the entry's specifics
— the evidence item's source and retrieval date with its grade, and the
snapshot address; `--json` prints the appended entry itself instead.

## Grades

The grade marks how much the evidence can be trusted. It grades the source,
never the researcher's judgment — judgment is the confidence entry type, and
the two never merge: an entry that carries a grade is an observation (or an
evidence item inside any entry), and a confidence entry never carries one.

- `asserted` — a single retrieval, not independently verified. The honest
  grade for one literature snapshot; use it unless another genuinely applies.
- `cross-checked` — two independent retrievals were actually compared and
  agree (say, the same record from PubMed and from Semantic Scholar).
- `re-executed` — machinery recomputed the result (M4 job records). A
  session cannot honestly claim it for a literature snapshot.

`--grade` is required exactly when evidence is recorded — never defaulted,
never given without evidence: the trust mark on a source is a decision,
never an accident. On an observation the same flag also grades the entry
itself.

## Exit codes

The exit code is the contract — branch on it, never on the presence of
output. Codes 0 and 1 are the connector scripts' shared meanings; 2 is this
recorder's own failure domain (it makes no requests, so there is no
transport to fail):

| Code | Meaning |
|---|---|
| 0 | Success — the entry is appended and named on stdout. |
| 1 | Usage error — bad arguments, evidence input that is not a valid connector output, or a link naming no recorded hypothesis. |
| 2 | Notebook failure — the notebook cannot be read (corrupt, or `.theta` is not a directory) or written. |

## Output discipline

- Relay the entry id, the grade, and the snapshot address — the researcher
  can find all of it under `.theta/`.
- A failed append is never silently skipped: a non-zero exit reaches the
  user as a failure.
- The snapshot must be the connector's final structured output — not a
  hand-composed file, not a raw HTTP body the connector never emitted.
- If an entry turns out wrong, the correction is a later decision entry,
  never a rewrite of history.

## Boundaries

- The recorder consumes connector output; it never calls a source itself,
  and the theta-lit-search scripts are untouched by this skill.
- One evidence item per call; an entry synthesizing several retrievals is
  recorded per source, cross-checked claims included.
- `.theta/` belongs to the research project. In the theta-agent repo's own
  dogfood runs it is gitignored so clean-tree proofs hold; in a research
  project, versioning the notebook is the researcher's choice.
