# arXiv API

Endpoint contract facts for `scripts/arxiv.py`. Official sources reviewed
2026-10-11 (contract basis: the script docstring and the repo research note
`docs/research/2026-10-11-m2-literature-api-contracts.md`, which also holds
the delta review against the vendored paper-lookup reference; the vendored
library's 2026-07-27 observations are cited where the docs stay silent).

## Base URL

All requests: `https://export.arxiv.org/api/query` (API User's Manual; the
manual's canonical examples are `http://`, both schemes are served, https is
the safe default — live-confirmed 2026-10-11).

## Authentication

None. Fully public — there is no key mechanism anywhere in the manual or the
Terms of Use, and no higher tier to request. Nothing to configure, nothing
to redact.

## Response format

Atom 1.0 XML only — "Everything returned by the API in the body of the HTTP
responses is Atom 1.0, including errors." There is no JSON output mode.

Parsing traps (all confirmed on the live wire format):

- The feed carries its own `<link>` before the first `<entry>`, so "the
  first link" is the query URL, not a paper. Select links by `rel`/`type`.
- The entry `<id>` arrives as `http://arxiv.org/abs/1706.03762v7` (http
  scheme, version suffix) while the entry's `<link>` hrefs are `https://`.
  Never string-match on the scheme; take the whole path after `/abs/`
  (legacy IDs such as `hep-th/9901001` contain a slash) and strip the `vN`.
- `<title>` and `<summary>` arrive hard-wrapped mid-sentence; collapse
  whitespace before display or comparison.
- `<arxiv:doi>` is the **journal** DOI, present only when the author
  registered one (verified: `1706.03762` returns no `<arxiv:doi>` at all).
  arXiv's own `10.48550/arXiv.{id}` DOI never appears in the feed.

## Endpoint in use

### query — search and id_list lookup (one endpoint for everything)

Parameters: `search_query` (optional), `id_list` (optional, comma-delimited;
at least one of the two in practice), `start` (default 0), `max_results`
(default 10), `sortBy` (`relevance` / `submittedDate` / `lastUpdatedDate`,
default `relevance`), `sortOrder` (`ascending` / `descending`, default
`descending`).

- Field prefixes: `ti`, `au`, `abs`, `co`, `jr`, `cat`, `rn`, `all` (the
  manual also lists `id` with "use id_list instead"). Booleans: `AND`, `OR`,
  `ANDNOT`; parentheses and quotes require URL encoding.
- One date filter only: `submittedDate:[YYYYMMDDHHMM TO YYYYMMDDHHMM]`, GMT,
  to the minute; percent-encode the brackets (passing literal `[`/`]` to
  curl fails client-side on globbing before any request is sent).
- Result-size ceilings: `max_results` serves at most 2,000 per slice,
  30,000 per query (`max_results > 30,000` is a documented HTTP 400);
  arXiv recommends refining queries beyond 1,000 results. Bulk harvesting
  belongs to OAI-PMH. The script caps `--retmax` at 200 — a bounded list
  for the research loop; deeper walks are paper-lookup's paginate pattern.
- The script omits `start` (always 0) — no pagination surface in v1.

## Rate limits and pacing

- "When using the legacy APIs (including ... the arXiv API), make no more
  than one request every three seconds, and limit requests to a single
  connection at a time" (Terms of Use). The limit is fleet-wide — "all of
  the machines under your control as a whole" — and circumvention is a
  listed prohibited use. There is no key and no higher tier to buy.
- The script enforces a monotonic-clock floor of 3.1 s between calls —
  just over the published ceiling, never at or under it.
- Results change only at the midnight after articles are processed; the
  manual states there is "no need to call the API more than once in a day
  for the same query. Please cache your results." Repeating an identical
  query within a day buys nothing.
- arXiv's own TOU calls this "the legacy arXiv API"; no deprecation date
  is published anywhere. Longevity risk, not a retirement notice.

## Error format

- **The documented error channel is an Atom feed inside a normal response.**
  "Errors are returned as Atom feeds with a single entry representing the
  error" — the entry is titled `Error`, the reason rides in its
  `<summary>`. A malformed parameter (observed: `start=notanumber`) returns
  HTTP 200 with `totalResults` 1 and exactly that one entry, which reads as
  a successful one-hit search. The script checks for the Error entry before
  interpreting anything else and exits 3.
- The feed `<title>` echoes the query as arXiv actually ran it (canonical
  order `search_query,id_list,start,max_results`). An unknown field prefix
  is silently rewritten to `all:` — a typo like `author:` degrades a
  targeted search into a full-text one with no warning. The manual itself
  advises reading `<title>`; the script surfaces it as `query_as_executed`.
- Throttling is not XML: the bare plain-text body `Rate exceeded.`
  (observed 2026-07-27 with HTTP 429 and connection drops; undocumented —
  no status or shape is promised). The script recognizes the body whatever
  the status and exits 4. Under sustained throttling the fix is to wait,
  not to retry harder; observed once: malformed requests stayed throttled
  for 30+ minutes while valid queries were served.
- The one documented non-200 status: HTTP 400 with an explanation for
  `max_results > 30,000`. The script treats any non-200 as a transport
  failure (exit 2) unless the body is the throttle text.

## The connector script

```bash
python3 scripts/arxiv.py --query 'ti:attention AND cat:cs.CL' [--retmax 8] [--sort submittedDate] [--order ascending] [--json]
python3 scripts/arxiv.py --arxiv-id 1706.03762 [--json]
```

Exit codes: 0 success (zero results and unknown IDs included — an explicit
empty answer), 1 usage, 2 transport (non-200 status or network), 3 API
error inside an HTTP 200 body (Atom error entry, non-XML or non-feed body),
4 throttled (the plain-text body).

Offline testing: set `THETA_LIT_SEARCH_FIXTURES` to a directory of recorded
bodies consumed in call order (a first line `# status: NNN` encodes a
non-200 status); the transport swap is the whole difference between test
and live. Contract tests: `test/lit-search-arxiv.test.mjs` in the repo.

## Residual

Pacing is per-invocation: parallel shells running the script can in
principle burst past the limit — and on arXiv the limit is fleet-wide, so
the burst costs the whole operator, not one process. Serialize arXiv work;
a stateless script cannot fix this.

## Official sources reviewed 2026-10-11

- arXiv API User's Manual (https://info.arxiv.org/help/api/user-manual.html):
  Atom-only responses, parameters, field prefixes, result-size ceilings,
  error feeds, feed-title canonicalization, caching guidance.
- arXiv API Terms of Use (https://info.arxiv.org/help/api/tou.html): the
  one-request-per-three-seconds fleet-wide pace, single connection,
  circumvention as a prohibited use, "legacy API" framing.
