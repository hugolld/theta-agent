# M2 literature API contracts: PubMed E-utilities, arXiv API, Semantic Scholar Graph API

Date: 2026-10-11

Scope note: this note records the current, primary-sourced API contracts for the three literature
sources planned for M2 (PubMed/NCBI E-utilities, arXiv API, Semantic Scholar Graph API) and the
deltas against the vendored `skills/paper-lookup` reference files, whose endpoint contracts were
last reviewed 2026-09-30. It feeds the M2 design grilling, whose deliverable shape (skill-layer
scripts vs. registered pi tools) is not yet decided, so every fact below is stated shape-neutral:
what the API's official contract is, who owns the claim, and which enforcement-relevant behaviors
differ between "model discipline + script rails" and "code-enforced tool". Official documentation
was fetched on 2026-10-11; one tiny live probe per API confirmed reachability and response shape.
NCBI Bookshelf blocks plain curl with a reCAPTCHA challenge page (observed 2026-10-11), so those
chapters were read through a real browser session; the same content is served to any browser.
Quotations are transcribed to plain ASCII.

Source ids used inline (all accessed 2026-10-11):

- [S1] NCBI Bookshelf, "A General Introduction to the E-utilities" (Entrez Programming Utilities
  Help). Last Update: November 17, 2022. https://www.ncbi.nlm.nih.gov/books/NBK25497/
- [S2] NCBI Bookshelf, "The E-utilities In-Depth: Parameters, Syntax and More" (Entrez Programming
  Utilities Help). Last Update: March 4, 2026. https://www.ncbi.nlm.nih.gov/books/NBK25499/
- [S3] NCBI Bookshelf, "E-utilities Quick Start" (Entrez Programming Utilities Help). Last Update:
  October 24, 2018. https://www.ncbi.nlm.nih.gov/books/NBK25500/
- [S4] arXiv API User's Manual. https://info.arxiv.org/help/api/user-manual.html
- [S5] arXiv API Terms of Use. https://info.arxiv.org/help/api/tou.html
- [S6] Semantic Scholar API product page. https://www.semanticscholar.org/product/api
- [S7] Semantic Scholar API tutorial. https://www.semanticscholar.org/product/api/tutorial
- [S8] Semantic Scholar Academic Graph API OpenAPI 2.0 spec.
  https://api.semanticscholar.org/graph/v1/swagger.json (rendered by
  https://api.semanticscholar.org/api-docs/graph)
- [S9] Semantic Scholar Recommendations API OpenAPI 2.0 spec.
  https://api.semanticscholar.org/recommendations/v1/swagger.json
- [S10] Allen Institute for AI, s2-folks repository FAQ (first-party, corroborating).
  https://github.com/allenai/s2-folks/blob/main/FAQ.md
- Live probes: one HTTP request per API, issued 2026-10-11, logged below.

## 1. PubMed / NCBI E-utilities

### 1.1 Current contract (primary sources)

Base URL and protocol:

- "All E-utility requests should be made to URLs beginning with the following string:
  https://eutils.ncbi.nlm.nih.gov/entrez/eutils/" [S1]

Rate limits and API key:

- "Without an API key, any site (IP address) posting more than 3 requests per second to the
  E-utilities will receive an error message. By including an API key, a site can post up to 10
  requests per second by default. Higher rates are available by request." [S1]
- Key provisioning is self-service: "Users can obtain an API key now from the Settings page of
  their NCBI account (to create an account, visit http://www.ncbi.nlm.nih.gov/account/). After
  creating the key, users should include it in each E-utility request by assigning it to the
  api_key parameter." Also: "Only one API key is allowed per NCBI account; however, a user may
  request a new key at any time. Such a request will invalidate any existing API key associated
  with that NCBI account." [S1]
- Timing guidance: "NCBI recommends that users post no more than three URL requests per second and
  limit large jobs to either weekends or between 9:00 PM and 5:00 AM Eastern time during
  weekdays. Failure to comply with this policy may result in an IP address being blocked from
  accessing NCBI." [S1]
- tool and email: "Requests from any IP that lack registered values for tool and email and that
  violate the above usage policies may be blocked." And critically: "merely providing values for
  tool and email in requests is not sufficient to comply with this policy; these values must be
  registered with NCBI" (registration is an email to NCBI, not a web form) [S1].

Error behavior:

- The documented failure mode for exceeding the rate is a body-level error, not a documented
  status code: "Example error message if rates are exceeded:
  {"error":"API rate limit exceeded","count":"11"}" [S1]. The Bookshelf chapters consulted state
  no HTTP status code for this error, and neither "429" nor "400" appears anywhere in [S1], [S2],
  or [S3].

JSON and endpoints:

- ESearch, ESummary, and EInfo all support JSON: "The default value is 'xml' ... but 'json' is
  also supported to return output in JSON format." [S2]
- ESearch `retmax` is capped: "Increasing retmax allows more of the retrieved UIDs to be included
  in the XML output, up to a maximum of 10,000 records." [S2]
- The PubMed/PMC hard ceiling: "For PubMed and PMC, ESearch can only retrieve the first 10,000
  records matching the query. To obtain more than 10,000 PubMed records, consider using EDirect
  ... Alternatively, consider adding terms to your query (such as date limitations) to segment
  the desired set into batches of less than 10,000 records each." [S2]
- POST for large UID lists: "There is no set maximum for the number of UIDs that can be passed to
  ESummary, but if more than about 200 UIDs are to be provided, the request should be made using
  the HTTP POST method." The same "about 200" guidance is given for EFetch and EPost [S2].
- `usehistory=y` posts the result UIDs on the History server and returns `WebEnv` and `query_key`
  for follow-up calls [S2].
- `sort` values for PubMed: `pub_date` (descending publication date), `Author` (ascending first
  author), `JournalName` (ascending journal name), `relevance` (default, "Best Match" on web
  PubMed) [S2].
- Date limits: `datetype` common values `mdat`/`pdat`/`edat`; `mindate`/`maxdate` "must be used
  together", "general date format is YYYY/MM/DD, and these variants are also allowed: YYYY,
  YYYY/MM"; `reldate` = last n days [S2].
- ESearch `rettype`: `uilist` (default) or `count` [S2].
- ELink `cmd=neighbor_score`: "ELink returns a set of UIDs within the same database as the input
  UIDs along with computed similarity scores." [S2]
- EDirect is NCBI's recommended route for retrieving more than 10,000 PubMed records [S2].

Live probe (2026-10-11, one anonymous GET):

```
GET https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=CRISPR+gene+therapy&retmode=json&retmax=1&tool=theta-m2-api-review
```

- Result: HTTP 200, `content-type: application/json; charset=UTF-8`, valid `esearchresult` JSON
  (`count`, `retmax`, `retstart`, `idlist`, plus a large `translationset` array).
- The response exposed rate-budget headers: `x-ratelimit-limit: 3` and
  `x-ratelimit-remaining: 2`, with `access-control-expose-headers:
  X-RateLimit-Limit,X-RateLimit-Remaining`. These headers are not mentioned in [S1]/[S2]/[S3];
  they are recorded here as a live observation of the official endpoint, one anonymous request,
  on 2026-10-11. Their exact semantics (per-second window vs. rolling budget) are UNVERIFIED.

### 1.2 Delta vs. `skills/paper-lookup/references/pubmed.md`

| # | Skill claim | Verdict | Current primary-source finding |
|---|-------------|---------|-------------------------------|
| 1 | Base URL `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/` | CONFIRMED | Verbatim in [S1]. |
| 2 | 3 req/s without key, 10 req/s with key; `&api_key=` | CONFIRMED | [S1] states exactly this; `api_key` parameter also documented in [S2]. |
| 3 | "Include tool and email on all requests" | CONFIRMED, plus NEW gap | [S1] asks for both, but adds that the values "must be registered with NCBI" by email for the policy to be satisfied and for blocks to be lifted. The skill omits the registration step (NEW for M2). |
| 4 | Key registration at `https://www.ncbi.nlm.nih.gov/account/settings/` (SKILL.md table) | CONFIRMED | [S1]: key obtained "from the Settings page of their NCBI account". One key per account; a new key invalidates the old [S1] (skill omits this invalidation rule). |
| 5 | esearch: `retmax` max 10,000; `retstart` paginates within first 10,000; `usehistory` does not bypass the cap | CONFIRMED | [S2]: retmax "up to a maximum of 10,000 records"; "For PubMed and PMC, ESearch can only retrieve the first 10,000 records matching the query"; usehistory only posts UIDs to the History server. |
| 6 | Large searches: split into disjoint date intervals or use EDirect | CONFIRMED | [S2]: segment "into batches of less than 10,000 records each" or use EDirect. |
| 7 | esearch `retmode` json/xml; `rettype` uilist/count; sort values relevance, pub_date, Author, JournalName | CONFIRMED | All in [S2]; `relevance` is the default ("Best Match"). |
| 8 | datetype pdat/mdat/edat; mindate/maxdate `YYYY/MM/DD`; reldate | CONFIRMED, plus NEW nuance | [S2] also allows `YYYY` and `YYYY/MM` variants for mindate/maxdate (skill lists only full dates). |
| 9 | esummary/efetch: prefer POST above about 200 IDs | CONFIRMED | [S2]: "if more than about 200 UIDs are to be provided, the request should be made using the HTTP POST method" (ESummary, EFetch, EPost). |
| 10 | efetch rettype/retmode combos (xml default, medline, abstract, uilist) | CONFIRMED | [S2] Table 1 and examples (`retmode=text&rettype=abstract`, `retmode=xml`). |
| 11 | elink `cmd=neighbor_score` is the documented scored-neighbor command; not a citation edge | CONFIRMED | [S2] documents the command and "computed similarity scores"; the "not a citation edge" caveat is the skill's editorial, consistent with the doc's wording. |
| 12 | Rate-limit error body `{"error": "API rate limit exceeded", "count": "11"}` | CONFIRMED | Verbatim in [S1]. |
| 13 | "HTTP 400 for bad requests, 429 for rate limiting" | UNVERIFIABLE | No HTTP status for E-utility errors is documented in [S1]/[S2]/[S3] (zero occurrences of "429"/"400" there). The documented contract is the error body in 1.1. M2 code should not branch on status codes for E-utility errors without its own probe; treat the body as the error channel. |
| 14 | Peak hours Mon-Fri 5AM-9PM ET; big jobs outside them | CONFIRMED | [S1]: limit large jobs "to either weekends or between 9:00 PM and 5:00 AM Eastern time during weekdays" (same window, inverse phrasing). |
| 15 | (omission) | NEW | Live 2026-10-11: anonymous responses carry `x-ratelimit-limit` / `x-ratelimit-remaining` headers (observed `3` / `2`). Not in the skill, not in the Bookshelf. A tool could self-throttle off these headers; semantics UNVERIFIED. |
| 16 | (omission) | NEW | tool/email registration with NCBI (email-based, developer-facing) exists as an unblock/compliance path [S1]; only relevant if Theta's IP ever gets blocked. |
| 17 | "37M+ biomedical ... articles" (corpus size) | UNVERIFIABLE | Not stated in [S1]/[S2]/[S3]; not re-verified against a primary page on 2026-10-11. |
| 18 | Official source cited: only NBK25499 | CHANGED (sourcing) | Skill: "Official sources reviewed 2026-09-30 - https://www.ncbi.nlm.nih.gov/books/NBK25499/". The rate/key/error text the skill reproduces is owned by NBK25497 ("A General Introduction to the E-utilities", the book's usage-policy chapter) [S1]; NBK25499 defers to it ("Please see Chapter 2 for a detailed discussion of E-utility usage policy"). A resync should cite both. |

Note on chapter IDs: the task brief's mapping ("Quick Start = NBK25499", "Usage Policies =
NBK25497") does not match the live book on 2026-10-11: NBK25499 is the In-Depth chapter (Last
Update 2026-03-04), NBK25500 is the Quick Start (Last Update 2018-10-24), and the usage policies
(rate limits, API keys, tool/email) live inside NBK25497 (Last Update 2022-11-17). The rate
policy text itself is unchanged from what the skill reproduces.

## 2. arXiv API

### 2.1 Current contract (primary sources)

Endpoint and response format:

- The manual's canonical syntax is `http://export.arxiv.org/api/{method_name}?{parameters}` [S4];
  31 of 32 example URLs in the manual use `http://`, one uses `https://`. A live GET to
  `https://export.arxiv.org/api/query` returned HTTP 200 with Atom XML on 2026-10-11 (probe
  below), so both schemes are served; the manual itself does not mandate one.
- "Everything returned by the API in the body of the HTTP responses is Atom 1.0, including
  errors." [S4] There is no JSON output mode.

Query parameters [S4]:

- `search_query` (optional), `id_list` (optional, comma-delimited), `start` (default 0),
  `max_results` (default 10). At least one of search_query/id_list must be supplied in practice;
  the manual's table marks both "required: No".
- `sortBy`: `relevance` (Lucene default), `lastUpdatedDate`, `submittedDate`; `sortOrder`:
  `ascending` or `descending` [S4].
- Field prefixes: `ti`, `au`, `abs`, `co`, `jr`, `cat`, `rn`, `id` (with the note "use id_list
  instead"), `all` [S4]. Boolean operators: `AND`, `OR`, `ANDNOT`; parentheses and quoting require
  URL encoding [S4].
- Date filter: "The API provides one date filter, submittedDate ... The expected format is
  [YYYYMMDDTTTT+TO+YYYYMMDDTTTT] were the TTTT is provided in 24 hour time to the minute, in
  GMT." [S4]

Result-size limits [S4]:

- "the maximum number of results returned from a single call (max_results) is limited to 30000 in
  slices of at most 2000 at a time, using the max_results and start query parameters."
- "We recommend to refine queries which return more than 1,000 results, or at least request
  smaller slices. For bulk metadata harvesting or set information, etc., the OAI-PMH interface is
  more suitable. A request with max_results >30,000 will result in an HTTP 400 error code with
  appropriate explanation."

Errors:

- "Errors are returned as Atom feeds with a single entry representing the error. The <summary>
  for the error contains a helpful error message, and the <link> element contains a url to a more
  detailed explanation of the message." [S4, section 3.4]
- The feed `<title>` "contains a canonicalized version of the query used to call the API",
  parameter order `search_query,id_list,start,max_results`; "It is a good idea to look at <title>
  to see if you have escaped your url correctly." [S4] (This is the officially documented basis
  for the skill's "check the feed title" rule.)

Rate limits and terms [S5]:

- "Please note that the following rate limits apply to all of the machines under your control as
  a whole. You should not attempt to overcome these limits by increasing the number of machines
  used to make requests. If your use-case requires a higher request rate, please contact our
  support team. When using the legacy APIs (including OAI-PMH, RSS, and the arXiv API), make no
  more than one request every three seconds, and limit requests to a single connection at a
  time. These limits may change in the future."
- Circumvention is a listed prohibited use: "Attempt to circumvent rate limits." [S5]
- The arXiv API is described as "the legacy arXiv API" within arXiv's own API family ("OAI-PMH
  interface, RSS feeds, the legacy arXiv API, bulk data downloads, and SWORD bulk deposit API")
  [S5]. No deprecation date is stated anywhere in [S4]/[S5]; the "legacy" framing is NEW context
  for M2, not a retirement notice.
- The manual adds the courtesy form of the same rule: "we encourage you to play nice and
  incorporate a 3 second delay in your code" [S4].
- Caching/freshness: "articles are only available to the API on the midnight after the articles
  were processed ... search results do not change until new articles are added. Therefore there
  is no need to call the API more than once in a day for the same query. Please cache your
  results." [S4]

Live probe (2026-10-11, one GET):

```
GET https://export.arxiv.org/api/query?id_list=1706.03762&max_results=1
```

- HTTP 200, `content-type: application/atom+xml; charset=utf-8`. `opensearch:totalResults` 1,
  one `<entry>`.
- Confirms the skill's parsing traps on today's wire format: entry `<id>` is
  `http://arxiv.org/abs/1706.03762v7` (http scheme, version suffix) while the entry's `<link>`
  hrefs are `https://arxiv.org/abs/...`; the feed-level `<id>` is `https://arxiv.org/api/...`;
  the feed `<title>` is the canonicalized query
  (`search_query=&id_list=1706.03762&start=0&max_results=1`).
- Served from CDN caches (`x-cache: MISS, HIT, HIT`, `age: 1722`), corroborating [S4]'s caching
  guidance at the transport layer.

### 2.2 Delta vs. `skills/paper-lookup/references/arxiv.md`

| # | Skill claim | Verdict | Current primary-source finding |
|---|-------------|---------|-------------------------------|
| 1 | Base URL `https://export.arxiv.org/api/query` | CONFIRMED | Live 200 over https (probe above); manual's canonical examples are `http://` with one https example [S4]. Both work; https is the safe default. |
| 2 | No authentication; fully public | CONFIRMED | No key mechanism exists anywhere in [S4]/[S5]. |
| 3 | "At least 3 seconds between requests"; single connection | CONFIRMED | [S5]: "no more than one request every three seconds, and limit requests to a single connection at a time"; [S4]: "incorporate a 3 second delay". |
| 4 | (omission) | NEW | The limit is fleet-wide: "rate limits apply to all of the machines under your control as a whole" and overcoming them by adding machines is prohibited [S5]. Higher rates require contacting arXiv support [S5]. "These limits may change in the future" [S5]. |
| 5 | Field prefixes ti/au/abs/co/jr/cat/rn/all | CONFIRMED, plus NEW row | [S4] table lists the same plus `id` with "use id_list instead"; the skill omits `id`. |
| 6 | Booleans AND/OR/ANDNOT; encode parentheses and quotes | CONFIRMED | [S4] operator table and URL-encoding guidance. |
| 7 | Date range `[YYYYMMDDHHMM TO YYYYMMDDHHMM]`, percent-encode brackets, UTC, inclusive | CONFIRMED | [S4]: format `[YYYYMMDDTTTT+TO+YYYYMMDDTTTT]`, "24 hour time to the minute, in GMT". The manual's own example uses literal brackets in a browser URL; the curl-globbing trap (skill, verified 2026-07-27) is client-side, still valid curl behavior. |
| 8 | max_results default 10; slices of at most 2,000; refine beyond 1,000; 30,000 query limit | CONFIRMED | [S4]: default 10; "limited to 30000 in slices of at most 2000"; "recommend to refine queries which return more than 1,000 results"; "max_results >30,000 will result in an HTTP 400 error code". |
| 9 | sortBy relevance/lastUpdatedDate/submittedDate; sortOrder ascending/descending | CONFIRMED | [S4] verbatim. |
| 10 | Errors come as a normal feed with a single Error entry (HTTP 200) | PARTLY CONFIRMED / status UNVERIFIABLE | [S4] 3.4: "Errors are returned as Atom feeds with a single entry representing the error." The specific "HTTP 200" for malformed `start` is the skill's own 2026-07-27 observation; the manual documents no status code for error feeds. The one documented status is 400 for max_results > 30,000 [S4]. |
| 11 | Unknown field prefix silently rewritten to `all:`; check feed `<title>` | CONFIRMED (mechanism documented) | [S4] documents title canonicalization and advises reading `<title>` to verify escaping; the live probe shows the title echoing the executed query. The all:-rewriting itself is the skill's verified observation, consistent with the manual, not spelled out in [S4]. |
| 12 | Omitting both search_query and id_list returns HTTP 400 | UNVERIFIABLE | [S4]'s parameter table marks both optional and states no 400 for omission; the skill's 400 observation (2026-07-27) is not contradicted, just not documented. |
| 13 | Throttle = plain-text `Rate exceeded.` with HTTP 429, connection drops, malformed-request penalty | UNVERIFIABLE | No official page documents the throttle response. [S5] only says limits exist, are fleet-wide, may change, and circumvention can be blocked. Keep the skill's 2026-07-27 observation as the operational assumption; treat as UNVERIFIED against today's docs. |
| 14 | "Search results are cached daily -- same query won't show new results within 24 hours" | CHANGED (wording) | Skill: "cached daily ... won't show new results within 24 hours". [S4]: articles become available "on the midnight after the articles were processed"; "search results do not change until new articles are added"; "no need to call the API more than once in a day for the same query. Please cache your results." Same operational rule (query once per day), different mechanism: a midnight refresh cycle, not a 24-hour TTL from your query time. Live CDN `age` header (probe) corroborates response caching. |
| 15 | For bulk data use OAI-PMH | CONFIRMED | [S4]: "For bulk metadata harvesting or set information, etc., the OAI-PMH interface is more suitable." |
| 16 | Atom entry shape: id/title/summary/published/updated/author/category/links/arxiv: extensions; `<arxiv:doi>` is the journal DOI and conditionally present | CONFIRMED | [S4] sections 3.3.x describe these elements; live probe matches (http `<id>`, https links, v7 suffix). The doi semantics are the skill's verified observations; the manual documents `<arxiv:doi>` as optional author-registered data [S4]. |
| 17 | (omission) | NEW | arXiv's own TOU calls this "the legacy arXiv API" [S5]. No replacement or deprecation date is published; M2 should not build on any assumed new endpoint, but the framing is worth knowing for longevity risk. |

## 3. Semantic Scholar

### 3.1 Current contract (primary sources)

Services and base URLs [S7]:

- "Academic Graph API ... Base URL: https://api.semanticscholar.org/graph/v1";
  "Recommendations API ... Base URL: https://api.semanticscholar.org/recommendations/v1";
  "Datasets API ... Base URL: https://api.semanticscholar.org/datasets/v1".

Authentication and rate limits:

- "If you are using an API key, it must be set in the header `x-api-key` (case-sensitive)." [S8]
- "Most Semantic Scholar endpoints are available to the public without authentication, but they
  are rate-limited to 1000 requests per second shared among all unauthenticated users. Requests
  may also be further throttled during periods of heavy use. Certain endpoints require
  authentication via an API key, and authenticated users have access to higher rate limits. As a
  best practice, we recommend including your API key with every request." [S6]
- "The introductory rate limit for an API key is 1 RPS on all endpoints. You will receive your
  private API key via email." [S6] The tutorial adds: "using an individual API key automatically
  gives a user a 1 request per second rate across all endpoints. In some cases, users may be
  granted a slightly higher rate following a review." [S7]
- Key request path: the "Request an API key" form on the product page, anchor `#api-key-form`
  (anchor present in the live HTML, 2026-10-11) [S6]. Approval latency is not documented
  anywhere on [S6]/[S7]/[S8] (UNVERIFIED).
- 403 means a bad key: "`403` - the API key you've sent is incorrect" [S10].
- 429: "Too Many Requests. You've hit the rate limit, slow down your requests." [S7]; FAQ: "`429`
  - you're sending too many requests, please slow down" [S10].

Graph API endpoints (from the OpenAPI spec) [S8]:

- Paper: `GET /paper/search` (relevance), `GET /paper/search/bulk`, `GET /paper/search/match`,
  `GET /paper/{paper_id}`, `GET /paper/{paper_id}/authors`, `GET /paper/{paper_id}/citations`,
  `GET /paper/{paper_id}/references`, `POST /paper/batch`, `GET /paper/autocomplete`.
- Author: `GET /author/search`, `GET /author/{author_id}`, `GET /author/{author_id}/papers`,
  `POST /author/batch`.
- Other: `GET /snippet/search`.

Key parameter contracts [S8]:

- `fields`: comma-separated; "The paperId field is always returned. If the fields parameter is
  omitted, only the paperId and title will be returned." Paper fields in the spec include
  `abstract, authors, citationCount, citationStyles, corpusId, embedding, externalIds,
  fieldsOfStudy, influentialCitationCount, isOpenAccess, journal, openAccessPdf, paperId,
  publicationDate, publicationTypes, publicationVenue, referenceCount, references, citations,
  s2FieldsOfStudy, textAvailability, tldr, title, url, venue, year`. Author detail fields:
  `affiliations, authorId, citationCount, externalIds, hIndex, homepage, name, paperCount,
  papers, url`.
- Paper ID formats: `<sha>`, `CorpusId:`, `DOI:`, `ARXIV:`, `MAG:`, `ACL:`, `PMID:`, `PMCID:`,
  and `URL:<url>` (URLs recognized from semanticscholar.org, arxiv.org, aclweb.org, acm.org,
  biorxiv.org) [S8].
- Relevance search: `query` required, plain text, "No special query syntax is supported";
  "Hyphenated query terms yield no matches (replace it with space to find matches)"; `limit`
  default 100, "Must be <= 100"; `offset` default 0; filters `year` (`2019`, `2016-2020`,
  `2010-`, `-2015`), `publicationDateOrYear` (`YYYY-MM-DD:YYYY-MM-DD`, open-ended allowed,
  `2020-06` prefix shorthand), `fieldsOfStudy`, `publicationTypes`, `openAccessPdf` (valueless),
  `minCitationCount`, `venue`. Limitations: "Can only return up to 1,000 relevance-ranked
  results. For larger queries, see '/search/bulk' or the Datasets API." and "Can only return up
  to 10 MB of data at a time." [S8]
- Bulk search: boolean syntax `+` (AND), `|` (OR), `-` (negation), `"..."` (phrase), `*`
  (prefix), `(` `)` (precedence), `~N` (edit distance, default 2); "Up to 1,000 papers will be
  returned in each call"; continuation `token`; "Up to 10,000,000 papers can be fetched via this
  method"; "Nested paper data, such as citations, references, etc, is not available via this
  method"; returned `total` is "an estimated total"; `sort` on `paperId`, `publicationDate`,
  `citationCount` as `field:order`, default `paperId:asc`, "Ties are broken by paperId", records
  with undefined sort values sort last [S8].
- Title match: "Will only return the single highest match result"; a no-match "Returns with a 404
  error and a 'Title match not found' message"; result carries `matchScore` [S8].
- Citations/references: `limit` default 100, "Must be <= 1000"; `offset` pagination; nested paper
  fields requested through the same `fields` parameter; citation-edge fields `contexts`,
  `intents`, `isInfluential` [S8].
- Batch: POST body `{"ids": [...]}`; "Can only process 500 paper ids at a time. Can only return
  up to 10 MB of data at a time. Can only return up to 9999 citations at a time." And: "Fields
  is a single-value string parameter, not a multi-value one. It is a query parameter, not to be
  submitted in the POST request's body." [S8]
- Recommendations [S9]: `GET /recommendations/v1/papers/forpaper/{paper_id}` with `from` enum
  `recent` (default) / `all-cs`, `limit` default 100, "Maximum 500"; `POST
  /recommendations/v1/papers/` with `positivePaperIds` / `negativePaperIds`, same limit rule.
- Documented error bodies for the Graph API are `{"error": "..."}` shapes (`Error400`,
  `Error404` definitions), e.g. 404 "Paper/Author/Object with id ### not found" [S8].

Efficiency guidance [S7]: "Paper bulk search should be used in most cases because paper relevance
search is more resource intensive." Also: use batch/bulk endpoints, avoid requesting unneeded
fields, and download datasets when a higher rate than keyed 1 RPS is needed.

Live probe (2026-10-11, one anonymous GET):

```
GET https://api.semanticscholar.org/graph/v1/paper/search?query=crispr&limit=1&fields=title
```

- Result: HTTP 429 on the very first request from this network. Body:
  `{"message": "Too Many Requests. Please wait and try again or apply for a key for higher rate limits. https://www.semanticscholar.org/product/api#api-key-form", "code": "429"}`
- The 429 response carried no `Retry-After` and no `x-ratelimit-*` headers (full header set
  logged: content-type, content-length, date, x-amz-apigw-id, x-amzn-requestid,
  x-amzn-errortype: TooManyRequestsException, x-cache, via, x-amz-cf-pop, x-amz-cf-id).
- This single observation is direct evidence for the skill's "shared pool frequently hits 429"
  claim: with no key, even a lone, first request can be refused.

### 3.2 Delta vs. `skills/paper-lookup/references/semantic-scholar.md`

| # | Skill claim | Verdict | Current primary-source finding |
|---|-------------|---------|-------------------------------|
| 1 | Base URLs `.../graph/v1` and `.../recommendations/v1` | CONFIRMED | [S7], [S8], [S9]. NEW: a third service exists, Datasets API at `.../datasets/v1` [S7]. |
| 2 | Without key: shared rate pool, frequently 429 | CONFIRMED | [S6]: pool "shared among all unauthenticated users" with further throttling under load. Live probe: first anonymous request got 429 (2026-10-11). |
| 3 | With key: 1 req/sec, higher on request; `x-api-key` header | CONFIRMED | [S6]: "introductory rate limit for an API key is 1 RPS on all endpoints"; [S7]: "may be granted a slightly higher rate following a review"; [S8]: header `x-api-key`, case-sensitive. |
| 4 | Key form at `.../product/api#api-key-form`; key arrives by email | CONFIRMED | Anchor present in live HTML 2026-10-11 [S6]; "You will receive your private API key via email" [S6]. Approval latency: UNVERIFIED (not documented). |
| 5 | `fields` behavior and defaults (paperId+title; authorId+name) | CONFIRMED | [S8] field descriptions. |
| 6 | Paper fields list | CONFIRMED, plus NEW | All skill-listed fields present in [S8] schemas; spec additionally exposes `citationStyles` and `textAvailability`. |
| 7 | Author fields list | CONFIRMED | Exactly the `AuthorWithPapers` properties in [S8]. |
| 8 | Paper ID formats (hash, CorpusId, DOI, ARXIV, PMID, PMCID, ACL) | CONFIRMED, plus NEW | [S8] also supports `MAG:<id>` and `URL:<url>` (five recognized URL sites). |
| 9 | Relevance search: limit default 100 max 100, offset, filters, 1,000-result cap | CONFIRMED, plus NEW | [S8]. NEW details: 10 MB per-call cap; "No special query syntax is supported"; "Hyphenated query terms yield no matches"; `year` accepts open-ended `2010-` / `-2015`; `publicationDateOrYear` accepts `2020-06` prefixes and open ranges. |
| 10 | Bulk search: boolean ops, token pagination, 10M cap, 1,000/call, estimated total, no nested citations, sortable fields | CONFIRMED, plus NEW | [S8]. NEW details: `~N` fuzzy operator (default 2); sort ties broken by paperId, undefined sort values last; sort order is `field:asc|desc` on three fields, not three fixed orders; [S7]: "bulk search should be used in most cases because paper relevance search is more resource intensive". |
| 11 | Citations/references: limit max 1000, offset/next, edge fields contexts/intents/isInfluential | CONFIRMED | [S8]. |
| 12 | Title match: best match in `data[]` with matchScore; 404 when no match | CONFIRMED | [S8]: "Will only return the single highest match result"; 404 "Title match not found". |
| 13 | Author search / author papers: limit max 1000 | CONFIRMED | [S8]: default 100, "Must be <= 1000" on both. |
| 14 | Recommendations: from recent/all-cs, limit default 100 max 500, POST positive/negative | CONFIRMED | [S9] verbatim (from enum, "Maximum 500"). |
| 15 | Batch: POST, max 500 IDs, fields in URL not body, nulls possible | CONFIRMED, plus NEW | [S8]: "Can only process 500 paper ids at a time"; "It is a query parameter, not to be submitted in the POST request's body". NEW caps: 10 MB per call, 9,999 citations per call. |
| 16 | Error format `{"message": "Too Many Requests", "code": "429"}`; 404 for not found | CONFIRMED for 429 (live); NEW for 4xx | Live 429 body matches the message+code shape (probe above). NEW: the documented 400/404 bodies use `{"error": "..."}` (`Error400`/`Error404` in [S8]). |
| 17 | (omission) | NEW | 403 = invalid API key [S10]; datasets route for above-key-rate needs [S7]; corpus today: "214 Million Papers, 2.49 Billion Citations, 79 Million Authors" [S6] (skill's "200M+" remains true). |
| 18 | (omission) | NEW | Four endpoints the skill does not list: `GET /paper/autocomplete`, `GET /paper/{paper_id}/authors`, `POST /author/batch`, `GET /snippet/search` [S8]. |
| 19 | `x-ratelimit-*` response headers; Retry-After semantics | UNVERIFIED | No first-party page fetched on 2026-10-11 documents these headers ([S6]/[S7]/[S8]/[S10] contain no mention), and the live 429 response carried neither. A successful 200's headers were not observed because the probe budget was one request and it was refused. Treat header-driven throttling for S2 as unconfirmed; plan for body-driven 429 handling instead. |

## 4. Facts that bear on the M2 shape decision

These are the enforcement-relevant behaviors, stated shape-neutral. "Script rails" below means a
skill-level script the model invokes; "code-enforced tool" means a registered pi tool where
pacing, retries, and parsing are in code the model cannot skip.

PubMed / E-utilities:

- Rate enforcement is per site/IP (anonymous) or per key (keyed): 3 rps vs. 10 rps [S1]. Both are
  mechanically enforceable with a token bucket in code; equally enforceable by a script that
  sleeps, but only if the model always goes through the script.
- The documented error channel is the body (`{"error":"API rate limit exceeded",...}`), with no
  documented HTTP status [S1]. Whatever shape M2 takes, error detection must parse the body, not
  the status line. Live anonymous responses expose `x-ratelimit-limit`/`x-ratelimit-remaining`
  (observed 2026-10-11, semantics UNVERIFIED), which would let a tool adapt its pacing, but a
  script-only layer can ignore them safely.
- Key provisioning is zero-friction and self-service (NCBI account settings page) [S1]; higher
  rates and tool/email registration are human email steps [S1]. A keyed deployment is realistic
  for M2 with no owner approval loop.
- The 10,000-ID ESearch ceiling for PubMed/PMC forces date-partitioned query splitting or EDirect
  [S2]. That is deterministic algorithmic work (count, partition, reconcile), a natural fit for a
  script/tool of either shape; the model only supplies the query and the intent.
- Batching levers exist in-protocol: `usehistory` + `WebEnv`/`query_key` and POST for >200 IDs
  [S2] reduce request counts directly, which is the cleanest way to stay under the rate cap.

arXiv:

- There is no key, no per-client budget, and no opt-in higher tier: one request per three
  seconds, single connection, applied "to all of the machines under your control as a whole",
  changeable unilaterally [S5]. Pacing is therefore the only compliance lever, and it is purely
  client-side; a code-enforced tool can guarantee it, a script rail only nudges it.
- Officially, errors are Atom feeds inside normal responses ("including errors") [S4]; the
  real-world throttle signal (`Rate exceeded.` plain text) is undocumented. Both are
  parse-the-bytes problems: whatever wraps arXiv must never feed a parser output that has not
  been shape-checked (the skill's `arxiv_atom.py` exit codes already encode this).
- Compliance risk is account-level, not request-level: circumvention can cost access outright
  [S5], and the API is officially "legacy" [S5] with no published successor endpoint. That
  argues for isolating arXiv access behind one component with a serial queue and a 3-second
  floor, whichever shape wins.
- Result freshness changes only at midnight [S4]; caching identical queries for 24 hours is
  officially encouraged and removes most pacing pressure in practice.

Semantic Scholar:

- The keyless tier is governed by a global shared pool with documented additional throttling
  under load [S6]; the single live probe was refused with 429. No client-side pacing, in any
  shape, can make keyless S2 reliable; what a tool can add is bounded retry with backoff and an
  honest "get a key" report, which is exactly the skill's current guidance.
- The 429 body is structured JSON (`message` + `code` + key-form URL, live 2026-10-11) but the
  response carries no Retry-After and no documented x-ratelimit headers, so backoff policy must
  be local, not header-driven.
- The keyed tier is deterministic (1 RPS introductory, review for more) [S6][S7] and the key
  arrives by email after a web form [S6] -- low friction, but an owner step with undocumented
  latency; M2 planning should not assume same-hour key availability.
- Hard per-call caps are first-class: 100/page relevance (1,000 total), 1,000/page bulk
  (10M total, token), 1,000/page citations, 500 IDs/batch, 10 MB/call, 9,999 citations/call
  [S8]. Batch/bulk endpoints are the officially recommended efficiency route [S7]. These caps
  make request-shaping logic (fields minimization, batching, token walks) valuable enough that
  either shape should ship it as code, not prose.

Cross-cutting:

- All three APIs can fail inside HTTP 200 (NCBI error bodies, arXiv error feeds) or refuse
  before any client pacing helps (S2 shared pool). Shape-checking the payload is mandatory in
  both candidate shapes; the difference is only whether the check runs in code the model must
  call or code the model may bypass.
- Two APIs have self-service, no-approval keys that raise limits 3x-10x (NCBI) or convert a
  probabilistic pool into a deterministic rate (S2); arXiv has none. A keyed deployment removes
  most of the rate-pressure differences between the shapes for NCBI and S2, but changes nothing
  for arXiv, where pacing discipline is the whole contract.

## 5. Sources

Primary (official documentation and first-party pages, all accessed 2026-10-11):

1. NCBI Bookshelf, Entrez Programming Utilities Help, "A General Introduction to the
   E-utilities" (rate limits, API keys, tool/email policy, error message).
   https://www.ncbi.nlm.nih.gov/books/NBK25497/
2. NCBI Bookshelf, Entrez Programming Utilities Help, "The E-utilities In-Depth: Parameters,
   Syntax and More" (all E-utility parameters, 10,000 cap, POST guidance, JSON retmode, ELink
   commands). https://www.ncbi.nlm.nih.gov/books/NBK25499/
3. NCBI Bookshelf, Entrez Programming Utilities Help, "E-utilities Quick Start".
   https://www.ncbi.nlm.nih.gov/books/NBK25500/
4. arXiv API User's Manual. https://info.arxiv.org/help/api/user-manual.html
5. arXiv API Terms of Use. https://info.arxiv.org/help/api/tou.html
6. Semantic Scholar API product page (rate tiers, key form, key delivery).
   https://www.semanticscholar.org/product/api
7. Semantic Scholar API tutorial (status codes, base URLs, efficiency guidance).
   https://www.semanticscholar.org/product/api/tutorial
8. Semantic Scholar Academic Graph API OpenAPI spec.
   https://api.semanticscholar.org/graph/v1/swagger.json
9. Semantic Scholar Recommendations API OpenAPI spec.
   https://api.semanticscholar.org/recommendations/v1/swagger.json
10. Ai2 s2-folks FAQ (first-party; 403/429 meanings). https://github.com/allenai/s2-folks/blob/main/FAQ.md

Live probes (one request per API, 2026-10-11, from this machine):

- PubMed: `esearch.fcgi?db=pubmed&term=CRISPR+gene+therapy&retmode=json&retmax=1` -- HTTP 200,
  JSON, `x-ratelimit-limit: 3`, `x-ratelimit-remaining: 2`.
- arXiv: `https://export.arxiv.org/api/query?id_list=1706.03762&max_results=1` -- HTTP 200 Atom;
  entry id `http://arxiv.org/abs/1706.03762v7` vs https links; CDN `age: 1722`.
- Semantic Scholar: `graph/v1/paper/search?query=crispr&limit=1&fields=title` -- HTTP 429,
  body `{"message": "...", "code": "429"}`, no Retry-After, no x-ratelimit headers.

Baseline under review (repo, read-only): `skills/paper-lookup/SKILL.md` (endpoint contracts
reviewed 2026-09-30), `skills/paper-lookup/references/pubmed.md`,
`skills/paper-lookup/references/arxiv.md`, `skills/paper-lookup/references/semantic-scholar.md`.
