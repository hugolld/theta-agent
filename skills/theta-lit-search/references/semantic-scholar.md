# Semantic Scholar (Academic Graph API)

Endpoint contract facts for `scripts/semanticscholar.py`. Official sources
reviewed 2026-10-11 (contract basis: the script docstring and the repo
research note `docs/research/2026-10-11-m2-literature-api-contracts.md`,
which also holds the delta review against the vendored paper-lookup
reference; the s2-folks FAQ is first-party corroboration for the 403/429
meanings).

## Base URL

Academic Graph API: `https://api.semanticscholar.org/graph/v1` (the API
tutorial). Sibling services exist — Recommendations `.../recommendations/v1`,
Datasets `.../datasets/v1` — and are out of scope for this connector.

## Authentication — keyed only, by design

- **The script requires a key and never attempts the anonymous tier.** The
  anonymous tier is rate-limited to 1000 requests per second *shared among
  all unauthenticated users*, with further throttling under load — the
  research note's single live probe (2026-10-11) was refused with 429 on its
  first request. No client-side pacing can make keyless Semantic Scholar
  reliable, so a keyless run fails before any request: exit 5, one line,
  the key-request URL in the message.
- **Key self-service, in minutes**: request a key at the form on the product
  page — `https://www.semanticscholar.org/product/api#api-key-form` — and it
  arrives **by email**. Approval latency is undocumented; do not plan on
  same-hour availability. Export it as `S2_API_KEY`.
- The keyed introductory rate is **1 request per second on all endpoints**
  (a review can grant slightly more; ask, don't assume). The script paces to
  this floor regardless.
- The key is sent in the `x-api-key` header — **case-sensitive** header
  name, per the OpenAPI spec — never in the URL. Python's urllib normalizes
  header names via `capitalize()`, so the wire form is `X-api-key`; HTTP
  field names are case-insensitive by protocol (RFC 9110), so the two
  spellings are the same header — the first live dogfood run closes this
  empirically. provenance.calls records the header name with the value
  redacted.
- **403 means the key is wrong** (s2-folks FAQ): the script exits 5, not 2,
  so a rejected credential never reads as a network failure.

## Endpoints in use

### paper/search — relevance search

Parameters the script sets: `query`, `limit` (1..100), `fields`.

- `query` is plain text: **no special query syntax is supported**. Hyphenated
  query terms yield no matches — replace hyphens with spaces when composing
  the query. Don't send arXiv-style `ti:` prefixes here; they are literal
  text to this API.
- `limit` "Must be <= 100" (default 100); the script caps `--retmax` at 100,
  lower than the other connectors' 200, because the API allows no more.
- `fields`: comma-separated; `paperId` is always returned, and if `fields`
  is omitted only `paperId` and `title` come back. The script requests
  `title,authors,year,venue,citationCount,influentialCitationCount,
  externalIds,publicationDate` — the two citation counts ride along free
  (no citation-graph endpoint needed).
- Caps: up to 1,000 relevance-ranked results per query, up to 10 MB per
  call. Larger needs belong to `paper/search/bulk` or the Datasets API
  (out of scope; the tutorial itself says bulk search "should be used in
  most cases" — relevance search is the more resource-intensive route, and
  this connector's bounded lists stay well inside it).
- Filters exist (`year` `2016-2020`/`2010-`/`-2015`,
  `publicationDateOrYear`, `fieldsOfStudy`, `minCitationCount`, ...); v1 of
  the script passes none. Extend here before adding them ad hoc.

### paper/{paper_id} — get by identifier

- The script looks up DOIs: path `paper/DOI:10.1038/...` with the DOI
  verbatim (slash included) after the `DOI:` prefix. Other accepted ID
  formats (unused here): S2 `<sha>`, `CorpusId:`, `ARXIV:`, `MAG:`, `ACL:`,
  `PMID:`, `PMCID:`, `URL:<url>`.
- The documented not-found answer is **404 with
  `{"error": "Paper with id ... not found"}`**. The script reports it as an
  explicit empty answer (exit 0, count 0), the same honest no-match the
  other connectors give for unknown identifiers.

## Rate limits and pacing

- Keyed: 1 request/second introductory, all endpoints; possibly more after
  a review. The script enforces a monotonic-clock floor of 1.1 s between
  calls — just over the ceiling, never at or under it.
- 429 is "Too Many Requests. You've hit the rate limit, slow down your
  requests" (tutorial). The live 429 response carried **no `Retry-After`
  and no `x-ratelimit-*` headers** — first-party pages document none — so
  backoff is a local decision, never header-driven. The script's contract:
  exit 4, state the pace, let the caller wait.

## Error format

- Documented Graph API error bodies are `{"error": "..."}` shapes (OpenAPI
  `Error400`/`Error404`), e.g. 404 "Paper with id ### not found".
- The throttle body is different: `{"message": "Too Many Requests. ...",
  "code": "429"}` (live-observed 2026-10-11, message includes the
  key-request URL). The script classifies it as throttled whatever the HTTP
  status, like the other connectors' body-driven throttle checks.
- A 200 body carrying an `error` key, a non-JSON body, or a missing or
  wrong-type `data`/object shape (a paper object without the always-present
  `paperId` included) surfaces as exit 3 — never as a sparse success.
- 403 = bad key → exit 5. 429 = throttle → exit 4. Other non-200 → exit 2.

## The connector script

```bash
python3 scripts/semanticscholar.py --query "crispr off-target" [--retmax 8] [--json]
python3 scripts/semanticscholar.py --doi 10.1038/s41587-024-02123-4 [--json]
```

Exit codes: 0 success (zero results and unknown DOIs included — an explicit
empty answer), 1 usage, 2 transport (non-200 status or network), 3 API
error inside an HTTP 200 body, 4 throttled, 5 credentials unusable (no
`S2_API_KEY`, or the key was rejected with 403).

Offline testing: set `THETA_LIT_SEARCH_FIXTURES` to a directory of recorded
bodies consumed in call order (a first line `# status: NNN` encodes a
non-200 status); the transport swap is the whole difference between test
and live. Contract tests: `test/lit-search-semanticscholar.test.mjs` in the
repo.

## Residual

- Pacing is per-invocation: parallel shells running the script can in
  principle burst past the limit. Serialize Semantic Scholar work; a
  stateless script cannot fix this.
- Key approval latency is undocumented — a first run after requesting the
  key may still wait on email delivery.

## Official sources reviewed 2026-10-11

- Semantic Scholar API product page (rate tiers, shared anonymous pool, key
  form and email delivery, corpus size). https://www.semanticscholar.org/product/api
- Semantic Scholar API tutorial (base URLs, status-code meanings, efficiency
  guidance). https://www.semanticscholar.org/product/api/tutorial
- Academic Graph API OpenAPI 2.0 spec (endpoints, parameters, field lists,
  ID formats, documented error bodies).
  https://api.semanticscholar.org/graph/v1/swagger.json
- Allen Institute for AI, s2-folks FAQ (first-party; 403/429 meanings).
  https://github.com/allenai/s2-folks/blob/main/FAQ.md
