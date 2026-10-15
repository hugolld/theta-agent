---
name: theta-lit-search
description: PubMed, arXiv, and Semantic Scholar connector - searches biomedical literature through NCBI E-utilities (by query or PMID), quantitative-bio, math, and CS methods work through the arXiv API (by query or ID), and cross-field literature with citation counts through the Semantic Scholar API (by query or DOI), returning title, authors, year, venue, identifiers, and citation counts with repeat-the-call provenance. Pacing to each API's contract (PubMed 3 per second anonymous, 10 with NCBI_API_KEY; arXiv one per three seconds; Semantic Scholar 1 per second with S2_API_KEY), detection of API errors inside HTTP 200 bodies (NCBI error JSON, arXiv error feeds, Semantic Scholar error JSON), and credential redaction are enforced by the bundled scripts, not left to doctrine. Use for literature search and PMID, arXiv-ID, or DOI lookups on these sources; Semantic Scholar requires S2_API_KEY and fails fast with the key-request URL when missing. Other scholarly databases, full text, and citation graphs route to paper-lookup.
allowed-tools: Read Bash
license: MIT
metadata:
  version: "0.1.0"
  authorship: self-authored
---

# Theta literature search

A Theta-owned connector skill: one script per scholarly source, with the
API's contract enforced in code the model calls. PubMed, arXiv, and
Semantic Scholar ship in this slice set. This skill owns **search** and
**get-by-identifier** for its sources — read-only metadata with
provenance, never full text or citation graphs.

## Division of labor with paper-lookup

The vendored `paper-lookup` skill stays the general scholarly interface for
its 18 databases. This skill takes over only the sources it connects:

| Intent | Route to |
|---|---|
| Search biomedical literature by topic or query | `theta-lit-search` (PubMed) |
| Exact metadata for a PMID you already hold | `theta-lit-search` (PubMed) |
| Search arXiv for quantitative-bio, math, or CS methods work | `theta-lit-search` (arXiv) |
| Exact metadata for an arXiv ID you already hold | `theta-lit-search` (arXiv) |
| Search across fields with citation counts (Semantic Scholar) | `theta-lit-search` (Semantic Scholar) |
| Exact metadata for a DOI you already hold | `theta-lit-search` (Semantic Scholar) |
| Full text, citation graphs, preprint servers, Crossref, OpenAlex, Europe PMC, everything else | `paper-lookup` |

Routing is stable by design: as later milestones add sources, they extend
this skill's table; the general interface never loses coverage to it.

## Why the script, not curl

All three connected APIs fail *inside* HTTP 200 bodies and pace their
callers (neither failure is visible on the status line); PubMed takes its
API key in the query string and Semantic Scholar in a request header. The
bundled scripts enforce all of it in code:

- **Pacing**: a monotonic-clock floor between calls — PubMed at most 3
  requests/second anonymous, 10 with a key; arXiv one request every three
  seconds, single connection (a Terms-of-Use ceiling that applies to every
  machine you control, not to one process); Semantic Scholar one
  request/second with a key (the introductory keyed rate).
- **In-200 errors**: a PubMed 200 body carrying `{"error": ...}`, an arXiv
  200 feed whose single entry is titled `Error` (a shape that reads as a
  successful one-hit search), and a Semantic Scholar 200 body carrying
  `{"error": ...}` each surface as a non-zero exit, never as a confident
  result. arXiv's throttle is a bare plain-text body, not XML, and
  Semantic Scholar's is a `{"message", "code"}` body; each script
  recognizes its throttle whatever the HTTP status.
- **Redaction**: `api_key`, `email`, and `tool` values never appear in the
  provenance the scripts echo; the Semantic Scholar key rides in the
  `x-api-key` header and only the header name survives into provenance.
  Parameter names survive so a reader can repeat the call with their own
  key.

Calling NCBI, export.arxiv.org, or api.semanticscholar.org directly with
curl re-introduces every hazard the scripts exist to remove. Do not.

## Operations

```bash
# PubMed search: query -> bounded list of records with provenance
python3 scripts/pubmed.py --query "CRISPR gene therapy" [--retmax 8] [--sort pub_date] [--json]

# Get by identifier: PMID -> exact metadata summary
python3 scripts/pubmed.py --pmid 34567890 [--json]

# arXiv search: query -> bounded list of records with provenance
python3 scripts/arxiv.py --query "ti:attention AND cat:cs.CL" [--retmax 8] [--sort submittedDate] [--order ascending] [--json]

# Get by identifier: arXiv ID -> exact metadata summary
python3 scripts/arxiv.py --arxiv-id 1706.03762 [--json]

# Semantic Scholar search: query -> bounded list of records with citation counts
python3 scripts/semanticscholar.py --query "crispr off-target" [--retmax 8] [--json]

# Get by identifier: DOI -> exact metadata summary
python3 scripts/semanticscholar.py --doi 10.1038/s41587-024-02123-4 [--json]
```

Requires Python 3.11+ (standard library only). If `python3` is older, run
`python3.13`, `python3.12`, or `python3.11` — the scripts name them when the
gate trips. `--retmax` caps results at 1..200 (default 8) on PubMed and
arXiv, and at 1..100 on Semantic Scholar (the API's relevance-search
ceiling). PubMed `--sort` accepts `relevance` (default), `pub_date`,
`Author`, `JournalName`; arXiv `--sort` accepts `relevance` (default),
`submittedDate`, `lastUpdatedDate`, with `--order` `ascending` or
`descending` (default `descending`). Semantic Scholar search takes no sort
— relevance is the endpoint's only order. `--pmid` and `--arxiv-id` accept
a comma-separated list, also capped at 200; `--doi` takes exactly one bare
DOI.

Default output is one line per paper —
`title | authors | year | journal | PMID x | DOI y` on PubMed,
`title | authors | year | cat c | arXiv id | DOI y` on arXiv,
`title | authors | year | venue v | cited by n | DOI y` on Semantic
Scholar — then a count line and a provenance line (endpoint URLs with
credentials redacted, access date). `--json` prints the structured records
and provenance instead.

## Exit codes

The exit code is the contract — branch on it, never on the presence of
output:

| Code | Meaning |
|---|---|
| 0 | Success. Zero results included: reported as an explicit empty answer, not an error. On arXiv an unknown identifier is also a zero-result answer; on Semantic Scholar an unknown DOI is too (its documented 404 not-found body). |
| 1 | Usage error — bad arguments, out-of-range values. |
| 2 | Transport failure — network error or non-200 HTTP status. |
| 3 | API error inside an HTTP 200 body — the response lied about succeeding. |
| 4 | Throttled — NCBI's rate-limit error body, arXiv's plain-text `Rate exceeded.`, Semantic Scholar's 429 message body. Wait before retrying; do not hammer. |
| 5 | Credentials unusable (Semantic Scholar only) — no `S2_API_KEY` in the environment, or the key was rejected with HTTP 403. The message carries the key-request URL; relay it so the user can unlock the source in minutes. |

## Credentials

`NCBI_API_KEY` is optional and read from the environment. Without it the
PubMed script runs at the anonymous 3 requests/second and still works — a
fresh install with no keys is useful immediately. A key raises the pace to
10 requests/second (self-service:
https://www.ncbi.nlm.nih.gov/account/settings/). Never echo the key; the
script already keeps it out of provenance.

arXiv takes no credentials at all: there is no key mechanism and no higher
tier to request. The one-request-per-three-seconds pace is the whole
contract, and the script enforces it.

`S2_API_KEY` is **required** for Semantic Scholar and read from the
environment. The anonymous tier is a rate pool shared among all
unauthenticated users — a first keyless request can already be refused — so
the script never attempts it: without the key it exits 5 before any
request, with the key-request URL in the message. The key is self-service
(https://www.semanticscholar.org/product/api#api-key-form) and arrives by
email; a key buys the deterministic 1 request/second pace. Never echo the
key; the script already keeps it out of provenance (only the `x-api-key`
header name appears, value redacted).

## Output discipline

- Report the total match count alongside the bounded list you show — 8 of
  4,532 is a different claim than 8.
- Carry Semantic Scholar citation counts into the answer — they are the
  source's distinctive free metadata (`influential_citation_count` rides
  along in `--json`).
- Semantic Scholar queries are plain text with no special syntax, and
  hyphenated terms yield no matches: replace hyphens with spaces when
  composing the query.
- Carry provenance into the answer: endpoint, parameters, access date.
- A zero-result query is an answer ("not in PubMed", "not in arXiv", "not
  in Semantic Scholar"), not a failure — say it plainly rather than
  widening the query silently.
- On arXiv, check `query_as_executed` against the query you sent: an
  unknown field prefix is silently rewritten to `all:` and the search still
  succeeds — wrong, not failed.
- arXiv results change only at midnight; the manual asks for one call per
  query per day. Do not repeat an identical arXiv query within a day.
- Retain the exit-code meaning when relaying: an in-200 error (3) must reach
  the user as an error, not as an empty result set.

## Boundaries

- Read-only metadata: no full text, no abstracts (beyond what PubMed
  eSummary returns; the arXiv records carry none of the abstract the feed
  provides), no citation graphs, no export. Route those intents to
  `paper-lookup`.
- Pacing is per-invocation: two shells running a connector script in
  parallel can in principle burst past the limit — and arXiv's ceiling is
  fleet-wide, so the burst costs the whole operator. A stateless script
  cannot fix this; serialize connector work instead.
- Endpoint facts, parameter details, and the documented failure shapes live
  in `references/pubmed.md`, `references/arxiv.md`, and
  `references/semantic-scholar.md` — read the source's note before
  non-trivial query construction (date ranges, field tags, sort semantics,
  key provisioning).
