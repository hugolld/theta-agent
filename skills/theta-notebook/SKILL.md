---
name: theta-notebook
description: Theta's project notebook recorder - appends dated provenance entries (hypothesis, method, observation, decision, confidence) to the research project's .theta/notebook.jsonl, with theta-lit-search outputs and gateway job records as graded, content-addressed evidence under .theta/evidence/ - asserted, cross-checked, or re-executed. A grade rates the source; judgment is the confidence entry type. Also writes the project's plan files (.theta/plans/) - the plan object stated before execution, with its 12-hex revision digest reported on every call. Use when a session forms a hypothesis, chooses or discards a method, reads off a search result, takes a decision, updates its confidence, states or revises a plan before compute, or closes out a compute run, in the theta-research-loop or standalone. Recording and planning run only through the bundled recorder script, which validates inputs, keeps no raw payloads, and reports its exit-code contract. Bibliography and reference management route to citation-management.
allowed-tools: Read Bash
license: MIT
metadata:
  version: "0.5.0"
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
- `plans/` — the project's **plan files**, one Markdown document per plan
  (`<date>-<slug>.md`), written, revised, and re-digested by the recorder's
  plan operations.

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
- A **job record** (ADR 0004) is the evidence item of the method entry that
  records a compute run: the gateway as its `source`, the job ID, the
  template (null for a raw submit), the argument digest, the final state,
  and the artifact manifest when the artifacts were fetched. Its `retrieved`
  is the day the record's state was observed. The recorder accepts the grade
  `re-executed` only when the manifest is present.
- The snapshot is the evidence source's structured output byte-for-byte —
  the connector's `--json` output (already credential-redacted and already
  dated by the connector's own code) or the assembled job record. Raw HTTP
  bodies are never kept.

## When to record

- The loop's hypothesize moment: a hypothesis has survived framing and
  search, and the connector output that motivated it is in hand.
- The design moment: a method is chosen or discarded — record the choice,
  with the search that motivated it as evidence when there is one, and
  state the run's plan itself as a plan file before any compute
  (`--plan-write`; the plan-operations section below).
- The execute moment: reading a result off a search output is an
  observation; when it backs an existing hypothesis, link the evidence. A
  compute run that closes out records its job record as a method entry —
  the theta-compute doctrine walks the lifecycle.
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
tree, which would land the notebook in the package checkout. On a fresh
project, create `.theta/` before the first record: the recorder refuses
an evidence-free first record (exit 2, notebook failure) when the
directory is absent — an evidenced record creates it itself. Resolve the
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

# A compute run closes out: the assembled job record rides a method entry
# (theta-compute's doctrine assembles it from the gateway answers):
python3 <theta-notebook-skill-dir>/scripts/notebook.py \
  --method "TEXT" --job-record job-record.json --grade re-executed

# State the run's plan before compute, then present it with its revision:
python3 <theta-notebook-skill-dir>/scripts/notebook.py \
  --plan-write af3-benchmark --plan-file plan.md
python3 <theta-notebook-skill-dir>/scripts/notebook.py \
  --plan-read 2026-11-22-af3-benchmark
```

`--evidence` takes the path of a saved `--json` output, or `-` to read it
from stdin; `--job-record` takes an assembled gateway job record the same
way. The two are mutually exclusive — one evidence item per call — and
`--grade` is required exactly when either is given. `--on` and `--supports`
must name a hypothesis entry already in the notebook; a reference that names
no recorded hypothesis is a usage error, never an entry.

Requires Python 3.11+ (standard library only). If `python3` is older, run
`python3.13`, `python3.12`, or `python3.11` — the script names them when the
gate trips. Default output is the recorded line, then the entry's specifics
— the evidence item's source and retrieval date with its grade, and the
snapshot address; `--json` prints the appended entry itself instead.

### The job record's shape

The session assembles the record from the theta-compute answers for one run
and passes it to `--job-record` as JSON (path or `-`):

```json
{
  "gateway": "theta-compute",
  "job_id": "12347",
  "run_name": "af3-lysozyme",
  "template": "alphafold3",
  "arguments_digest": "<sha256 of the job's canonical input>",
  "state": "COMPLETED",
  "observed": "2026-10-25",
  "artifacts": {"run_name": "af3-lysozyme", "total_bytes": 49414,
                "files": [{"path": "alphafold3_output/model.cif", "size": 48211}]}
}
```

- Required: `gateway`, `job_id` (digits), `run_name`, `template` (null for a
  raw submit), `arguments_digest` (a 64-hex sha256), `state`, `observed` —
  the day the state was read, carried through as the item's `retrieved`.
  `artifacts` is present exactly when `fetch_artifacts` answered, and holds
  paths and sizes, never file contents: the recorder refuses a manifest
  that carries `content_b64`. Extra keys (directives, script path) ride in
  the snapshot.
- The evidence item carries the job's fields, the grade, and the snapshot
  address; the snapshot is the assembled record byte-for-byte.
- `re-executed` claims the machinery recomputed the result, so it is honest
  only once the artifacts were fetched — the recorder refuses it without
  the manifest. Until then, `asserted`. Those are the record's two grades:
  `cross-checked` is a retrieval's mark, and the recorder refuses it on a
  job record.

## Plan files

The **plan object** is a file, not an entry: `.theta/plans/<plan-id>.md`,
plain Markdown stating what a run will compute, on which hypothesis, with
which method. It carries plan text only — no evidence, no grade: a plan is
a document, not a graded claim — and the plan operations never touch
`notebook.jsonl`. The recorder is the loop's writer, not the file's owner:
a researcher's hand edit is not an error, it is a new revision that a
later approval must name.

| Operation | Flags | Does |
|---|---|---|
| write | `--plan-write <slug> --plan-file <plan.md\|->` | creates `.theta/plans/<today>-<slug>.md`; reports the path and the revision |
| update | `--plan-update <plan-id> --plan-file <plan.md\|->` | overwrites the named plan's file; reports the new revision and the one it replaces |
| read | `--plan-read <plan-id>` | reports the path and the current revision — the file's own bytes decide, so a hand edit reads as the new revision |

- **Plan-id grammar**: the recording date plus a short kebab slug —
  `2026-11-22-af3-benchmark.md`. The slug is 1–48 characters of lowercase
  letters, digits, and single hyphens; anything else — uppercase,
  underscores, dots, slashes, a leading, trailing, or doubled hyphen — is
  refused as a usage error. Sortable, grep-able, no UUID noise. The id is
  immutable: an update keeps the file's name and date.
- **Same-day collision**: `--plan-write` refuses a slug that already names
  a plan today — a collision never clobbers. Write a different slug, or
  `--plan-update` the recorded plan. The same slug on a later day is a
  different plan-id, and allowed.
- **Plan revision**: the first 12 hex of sha256 over the file's bytes —
  the plan's revision, distinct from evidence snapshots' full sha256
  content addressing. A changed digest is a new revision, an update's
  change and a hand edit alike. The recipe is a cross-language contract,
  pinned by a committed test vector both this script and the TS side of
  the plan object pass, so every reader computes one revision.
- Like an evidence-free first record, the first plan write needs the
  project's `.theta/` to exist (`mkdir .theta`); the write creates
  `plans/` itself. Plan text is written as read — no reformatting, no
  added newline — with line endings landing as LF (a CRLF input's endings
  do not survive the read); the revision digest is computed over exactly
  the bytes on disk.

```bash
cd /path/to/research-project

# Revise the plan — same plan-id, new revision, the report names both:
python3 <theta-notebook-skill-dir>/scripts/notebook.py \
  --plan-update 2026-11-22-af3-benchmark --plan-file plan-v2.md
```

`--plan-file` takes the plan's Markdown the way `--evidence` takes its
input: a path, or `-` for stdin. Default output names the plan and its
revision — `wrote plan .theta/plans/2026-11-22-af3-benchmark.md revision
<12-hex>` (an update adds `(was <old-revision>)`; a read reports `plan
<path> revision <12-hex>`); `--json` prints the plan result object
(`plan`, `path`, `revision`, plus `previous_revision` on an update).

## Grades

The grade marks how much the evidence can be trusted. It grades the source,
never the researcher's judgment — judgment is the confidence entry type, and
the two never merge: an entry that carries a grade is an observation (or an
evidence item inside any entry), and a confidence entry never carries one.

- `asserted` — a single retrieval, not independently verified. The honest
  grade for one literature snapshot; use it unless another genuinely applies.
- `cross-checked` — two independent retrievals were actually compared and
  agree (say, the same record from PubMed and from Semantic Scholar).
- `re-executed` — machinery recomputed the result: a gateway job whose
  artifacts were fetched. The recorder refuses it for a job record without
  the artifact manifest, and a session cannot honestly claim it for a
  literature snapshot.

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
| 0 | Success — the entry is appended and named on stdout, or the plan operation reports the plan's path and revision. |
| 1 | Usage error — bad arguments, evidence input that is not a valid connector output or gateway job record, a link naming no recorded hypothesis, a malformed plan slug or plan-id, a same-day plan collision, or a plan-id naming no written plan. |
| 2 | Notebook failure — the notebook or a plan file cannot be read (corrupt, `.theta` is not a directory, or absent for a first plan write) or written. |

## Output discipline

- Relay the entry id, the grade, and the snapshot address — the researcher
  can find all of it under `.theta/`.
- A failed append is never silently skipped: a non-zero exit reaches the
  user as a failure.
- The snapshot must be the evidence source's final structured output — not a
  hand-composed file, not a raw HTTP body the connector never emitted, not a
  job record padded with file payloads.
- If an entry turns out wrong, the correction is a later decision entry,
  never a rewrite of history.

## Boundaries

- The recorder consumes connector output and assembled job records; it
  never calls a source or a gateway itself, and the theta-lit-search scripts
  are untouched by this skill.
- One evidence item per call; an entry synthesizing several retrievals is
  recorded per source, cross-checked claims included.
- Plan operations carry plan text only — no `--evidence`, `--grade`,
  `--on`, `--supports`, or `--job-record` — and never touch
  `notebook.jsonl`; one operation per call, an entry or a plan op, never
  both.
- `.theta/` belongs to the research project. In the theta-agent repo's own
  dogfood runs it is gitignored so clean-tree proofs hold; in a research
  project, versioning the notebook is the researcher's choice.
