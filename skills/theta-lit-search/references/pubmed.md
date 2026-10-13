# PubMed (NCBI E-utilities)

Endpoint contract facts for `scripts/pubmed.py`. Official sources reviewed
2026-10-11 (contract basis: the script docstring and the repo research note
`docs/research/2026-10-11-m2-literature-api-contracts.md`, which also holds
the delta review against the vendored paper-lookup reference).

## Base URL

All requests: `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/` (NBK25497).

## Authentication

- No key required: anonymous access works at 3 requests/second, so a fresh
  install with no credentials is useful immediately.
- `NCBI_API_KEY` in the environment raises the pace to 10 requests/second.
  Key provisioning is self-service from the NCBI account Settings page
  (https://www.ncbi.nlm.nih.gov/account/settings/); only one key per
  account, and requesting a new key invalidates the old one.
- The key is passed as the `api_key` query parameter. The script redacts its
  value from every URL and parameter map it echoes.
- `tool` and `email` parameters are deliberately not sent: NCBI states these
  values must be *registered* with them (by email) to satisfy the usage
  policy — merely sending unregistered values adds nothing.

## Endpoints in use

### esearch.fcgi — query to PMIDs

Parameters the script sets: `db=pubmed`, `term`, `retmode=json`,
`retmax` (1..200; API ceiling 10,000), optional `sort`.

- `sort` values: `relevance` (default, "Best Match"), `pub_date`
  (descending), `Author` (ascending first author), `JournalName`.
- Date limits (add to `term` yourself, or extend the script when needed):
  `mindate`/`maxdate` must be used together with `datetype`
  (`pdat`/`mdat`/`edat`); formats `YYYY/MM/DD`, `YYYY/MM`, `YYYY`;
  `reldate` = last n days.
- PubMed hard ceiling: ESearch can only retrieve the first 10,000 records
  matching a query; beyond that, NCBI's answer is date-partitioned queries
  or EDirect — not a bigger retmax.

### esummary.fcgi — document summaries

Parameters: `db=pubmed`, `id` (comma-separated UID list), `retmode=json`.
Returns `result.uids` plus one map per PMID. Record extraction: `title`,
`authors[].name`, `pubdate`/`epubdate`, `fulljournalname`/`source`,
`articleids` (`doi`, `pubmed`).

- Above about 200 UIDs NCBI asks for HTTP POST; the script caps at 200 and
  stays on GET.
- A per-UID error (`{"error": "cannot get document summary", "uid": ...}`)
  arrives inside an otherwise successful HTTP 200 body. The script exits 3.

## Rate limits and pacing

- 3 requests/second anonymous (per IP), 10 with an API key (per key).
- The script enforces a monotonic-clock floor between calls: 0.34 s
  anonymous, 0.11 s keyed — just under the published ceilings, never equal.
- NCBI's timing guidance: large jobs belong on weekends or 9 PM–5 AM
  Eastern on weekdays; violations can get an IP blocked.
- Anonymous responses carry `x-ratelimit-limit` / `x-ratelimit-remaining`
  headers (live-observed 2026-10-11, absent from the Bookshelf; semantics
  unverified). The transport treats a reported `remaining: 0` as an
  advisory 1-second pause — never a skipped call.

## Error format

- **The documented error channel is the body, not the status line.** The
  Bookshelf chapters state no HTTP status for E-utility errors; the
  documented rate-limit failure is
  `{"error": "API rate limit exceeded", "count": "11"}` inside an otherwise
  normal response. Do not branch on status codes for E-utility errors.
- The script classifies every response body: a top-level `error` key, a
  per-UID error, a non-JSON body, or a missing `esearchresult`/`result`
  shape each surface as an error exit — never as a sparse success.

## The connector script

```bash
python3 scripts/pubmed.py --query "CRISPR gene therapy" [--retmax 8] [--sort pub_date] [--json]
python3 scripts/pubmed.py --pmid 34567890 [--json]
```

Exit codes: 0 success (zero results included), 1 usage, 2 transport
(non-200 status or network), 3 API error inside HTTP 200, 4 throttled.

Offline testing: set `THETA_LIT_SEARCH_FIXTURES` to a directory of recorded
bodies consumed in call order (a first line `# status: NNN` encodes a
non-200 status); the transport swap is the whole difference between test
and live. Contract tests: `test/lit-search-pubmed.test.mjs` in the repo.

## Residual

Pacing is per-invocation: parallel shells running the script can in
principle burst past the limit. Serialize PubMed work; a stateless script
cannot fix this.

## Official sources reviewed 2026-10-11

- NCBI Bookshelf, Entrez Programming Utilities Help — "A General
  Introduction to the E-utilities" (NBK25497): base URL, rate limits, API
  key policy, tool/email registration, error message.
- NCBI Bookshelf — "The E-utilities In-Depth: Parameters, Syntax and More"
  (NBK25499): JSON retmode, retmax ceiling, sort values, date parameters,
  POST guidance.
