---
name: theta-lit-search
description: PubMed connector for Theta - searches biomedical literature through NCBI E-utilities and fetches exact metadata by PMID, returning title, authors, year, journal, and identifiers with repeat-the-call provenance. Request pacing (3 per second anonymous, 10 with NCBI_API_KEY), detection of API errors that arrive inside HTTP 200 bodies, and credential redaction are enforced by the bundled script, not left to doctrine. Use for biomedical literature searches by topic or query and for PMID metadata lookups; arXiv and Semantic Scholar arrive in later slices. Other scholarly databases, full text, and citation graphs route to paper-lookup.
allowed-tools: Read Bash
license: MIT
metadata:
  version: "0.1.0"
  authorship: self-authored
---

# Theta literature search

A Theta-owned connector skill: one script per scholarly source, with the
API's contract enforced in code the model calls. PubMed ships first; the
arXiv and Semantic Scholar connectors arrive as the following slices. This
skill owns **search** and **get-by-identifier** for its sources — read-only
metadata with provenance, never full text or citation graphs.

## Division of labor with paper-lookup

The vendored `paper-lookup` skill stays the general scholarly interface for
its 18 databases. This skill takes over only the sources it connects:

| Intent | Route to |
|---|---|
| Search biomedical literature by topic or query | `theta-lit-search` (PubMed) |
| Exact metadata for a PMID you already hold | `theta-lit-search` (PubMed) |
| arXiv or Semantic Scholar (until their slices land) | `paper-lookup` |
| Full text, citation graphs, preprint servers, Crossref, OpenAlex, Europe PMC, everything else | `paper-lookup` |

Routing is stable by design: as later slices land, they extend this skill's
table; the general interface never loses coverage to it.

## Why the script, not curl

E-utilities fail *inside* HTTP 200 bodies, pace by IP, and take the API key
in the query string. The bundled script enforces all three:

- **Pacing**: at most 3 requests/second anonymous, 10 with a key, enforced
  with a monotonic-clock floor between calls — not a suggestion in prose.
- **In-200 errors**: a 200 body carrying `{"error": ...}` (including the
  documented rate-limit error) surfaces as a non-zero exit, never as a
  confident empty result.
- **Redaction**: `api_key`, `email`, and `tool` values never appear in the
  provenance the script echoes; parameter names survive so a reader can
  repeat the call with their own key.

Calling NCBI directly with curl re-introduces every hazard the script
exists to remove. Do not.

## Operations

```bash
# Search: query -> bounded list of records with provenance
python3 scripts/pubmed.py --query "CRISPR gene therapy" [--retmax 8] [--sort pub_date] [--json]

# Get by identifier: PMID -> exact metadata summary
python3 scripts/pubmed.py --pmid 34567890 [--json]
```

Requires Python 3.11+ (standard library only). If `python3` is older, run
`python3.13`, `python3.12`, or `python3.11` — the script names them when the
gate trips. `--retmax` caps results at 1..200 (default 8); `--sort` accepts
`relevance` (default), `pub_date`, `Author`, `JournalName`. `--pmid` accepts
a comma-separated list, also capped at 200.

Default output is one line per paper —
`title | authors | year | journal | PMID x | DOI y` — then a count line and
a provenance line (endpoint URLs with credentials redacted, access date).
`--json` prints the structured records and provenance instead.

## Exit codes

The exit code is the contract — branch on it, never on the presence of
output:

| Code | Meaning |
|---|---|
| 0 | Success. Zero results included: reported as an explicit empty answer, not an error. |
| 1 | Usage error — bad arguments, out-of-range values. |
| 2 | Transport failure — network error or non-200 HTTP status. |
| 3 | API error inside an HTTP 200 body — the response lied about succeeding. |
| 4 | Throttled — NCBI's rate-limit error. Wait before retrying; do not hammer. |

## Credentials

`NCBI_API_KEY` is optional and read from the environment. Without it the
script runs at the anonymous 3 requests/second and still works — a fresh
install with no keys is useful immediately. A key raises the pace to 10
requests/second (self-service: https://www.ncbi.nlm.nih.gov/account/settings/).
Never echo the key; the script already keeps it out of provenance.

## Output discipline

- Report the total match count alongside the bounded list you show — 8 of
  4,532 is a different claim than 8.
- Carry provenance into the answer: endpoint, parameters, access date.
- A zero-result query is an answer ("not in PubMed"), not a failure — say it
  plainly rather than widening the query silently.
- Retain the exit-code meaning when relaying: an in-200 error (3) must reach
  the user as an error, not as an empty result set.

## Boundaries

- Read-only metadata: no full text, no abstracts beyond what eSummary
  returns, no citation graphs, no export. Route those intents to
  `paper-lookup`.
- Pacing is per-invocation: two shells running the script in parallel can
  in principle burst past the limit. A stateless script cannot fix this;
  serialize PubMed work instead.
- Endpoint facts, parameter details, and the documented failure shapes live
  in `references/pubmed.md` — read it before non-trivial query construction
  (date ranges, field tags, sort semantics).
