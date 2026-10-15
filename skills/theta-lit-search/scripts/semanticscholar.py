#!/usr/bin/env python3
"""Semantic Scholar connector: the keyed Graph API, with the S2 contract enforced.

The anonymous tier is a rate pool shared among all unauthenticated users,
throttled further under load -- the M2 research note's single live probe was
refused with 429 on its first request. So this script never goes keyless: it
checks for S2_API_KEY before any transport exists and fails visible and fast
(exit 5, one line, the key-request URL in the message), turning "the source
is unusable" into a self-service step measured in minutes. The keyed pace is
the documented introductory rate, 1 request per second on all endpoints,
enforced as a monotonic-clock floor. Failures ride in structured JSON bodies:
the documented Graph API errors are {"error": "..."} shapes, the throttle
body is {"message": ..., "code": "429"} (live-observed; no Retry-After, no
x-ratelimit headers, so backoff is local, never header-driven), and 403
means the key itself was rejected. The key travels in the case-sensitive
x-api-key header; provenance records the header name with the value
redacted, so the call stays repeatable with the reader's own key.

Exit codes -- the documented contract (see SKILL.md):
  0  success; zero results included (an unknown DOI is a genuine no-match,
     reported, not failed)
  1  usage error
  2  transport failure (network error, non-200 HTTP status)
  3  API error inside an HTTP 200 body
  4  throttled (HTTP 429, or the message+code body, whatever the status)
  5  credentials unusable (no S2_API_KEY, or the key was rejected: 403)

Usage:
  python3 semanticscholar.py --query "crispr off-target" [--retmax 8] [--json]
  python3 semanticscholar.py --doi 10.1038/s41587-024-02123-4 [--json]

Contract basis: docs/research/2026-10-11-m2-literature-api-contracts.md
(Semantic Scholar product page, tutorial, Graph API OpenAPI spec, s2-folks
FAQ; live-probed 2026-10-11).
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from datetime import date
from pathlib import Path
from typing import NoReturn
from urllib.parse import urlencode

sys.path.insert(0, str(Path(__file__).resolve().parent))
# Keep the checkout pure: importing _common would otherwise drop a __pycache__
# directory into the skill tree, which ships in the package and dirties the
# git-status proofs the dogfood gate runs on.
sys.dont_write_bytecode = True

from _common import (  # noqa: E402
	REDACTION,
	ApiError,
	collapse_ws,
	emit,
	fail,
	make_transport,
	redact_params,
	redact_url,
	require_python,
)

BASE = "https://api.semanticscholar.org/graph/v1"
KEY_ENV = "S2_API_KEY"
KEY_REQUEST_URL = "https://www.semanticscholar.org/product/api#api-key-form"

#: Just over 1 s: the introductory keyed rate is 1 request/second on all
#: endpoints -- never equaled.
INTERVAL = 1.1

#: The relevance search's documented limit ceiling ("Must be <= 100"). The
#: CLI caps --retmax here, lower than the other two connectors' 200, because
#: the API allows no more on this endpoint.
MAX_RESULTS = 100

#: The bounded field set: the metadata the research loop cites, plus the two
#: citation counts S2 returns for free (no citation-graph endpoint needed).
FIELDS = (
	"title,authors,year,venue,citationCount,influentialCitationCount,"
	"externalIds,publicationDate"
)

#: `?` and `#` never appear inside a DOI suffix -- they are URL delimiters.
#: The suffix rides in the request path verbatim, so a DOI pasted from a URL
#: must fail here as a usage error, not silently build a different request.
DOI_RE = re.compile(r"^10\.\d{4,9}/[^?#\s]+$")

ZERO_NOTE_SEARCH = (
	"zero results is Semantic Scholar's genuine no-match answer for this "
	"query; report it as 'not found in Semantic Scholar', not as a failure"
)
ZERO_NOTE_DOI = (
	"Semantic Scholar has no record for this DOI (its documented 404 "
	"not-found answer); report it as 'not found in Semantic Scholar', not as "
	"a failure"
)

PACE_HINT = (
	"the keyed pace is 1 request/second on all endpoints; wait before "
	"retrying"
)

KEYLESS_MESSAGE = (
	f"semanticscholar.py: no API key found in {KEY_ENV}; the anonymous tier "
	"is a shared pool that is throttled under load (a first request can "
	f"already be refused) -- request a key at {KEY_REQUEST_URL} (it arrives "
	f"by email), export it as {KEY_ENV}, then retry"
)


class Parser(argparse.ArgumentParser):
	"""argparse exits 2 on usage errors, which the contract reserves for
	transport failures -- usage errors exit 1 uniformly."""

	def error(self, message: str) -> NoReturn:
		self.print_usage(sys.stderr)
		sys.stderr.write(f"semanticscholar.py: error: {message}\n")
		raise SystemExit(1)


def is_throttle(payload: dict) -> bool:
	"""The live-observed throttle body: {"message": "... Too Many Requests
	...", "code": "429"} -- checked whatever the HTTP status, like arXiv's
	plain-text body."""
	if str(payload.get("code", "")) == "429":
		return True
	message = payload.get("message")
	return isinstance(message, str) and "too many requests" in message.lower()


def throttle_error(endpoint: str, status: int, payload: dict, body: str) -> ApiError:
	"""The one throttle message, whether the body arrived with 429 or not."""
	message = payload.get("message")
	text = message if isinstance(message, str) else body.strip()[:160]
	return ApiError(
		f"semanticscholar.py: {endpoint}: throttled by Semantic Scholar "
		f"(HTTP {status}): {text[:160]} -- {PACE_HINT}",
		4,
	)


def classify(status: int, body: str, endpoint: str) -> dict:
	"""Turn one HTTP response into a parsed JSON object or an ApiError.

	The order matters: the 429 and 403 verdicts are status-driven, so they
	survive an unparseable body (a gateway error page with HTTP 429 is still
	a throttle); the throttle body shape is checked on the parsed payload
	whatever the status; 403 is a credential verdict, not a transport
	failure. A 200 with an error key or an unexpected shape is an error,
	never a sparse success.
	"""
	try:
		parsed = json.loads(body)
	except json.JSONDecodeError:
		parsed = None
	dict_body = parsed if isinstance(parsed, dict) else {}
	if status == 429 or is_throttle(dict_body):
		raise throttle_error(endpoint, status, dict_body, body)
	if status == 403:
		raise ApiError(
			f"semanticscholar.py: {endpoint}: API key rejected (HTTP 403) -- "
			f"check {KEY_ENV}; if it keeps failing, request a fresh key at "
			f"{KEY_REQUEST_URL}: {body[:120]!r}",
			5,
		)
	if parsed is None:
		code = 3 if status == 200 else 2
		raise ApiError(
			f"semanticscholar.py: {endpoint}: HTTP {status} with a non-JSON body: {body[:200]!r}",
			code,
		) from None
	if status != 200:
		raise ApiError(
			f"semanticscholar.py: {endpoint}: HTTP {status}: {body[:200]!r}", 2
		) from None
	if not isinstance(parsed, dict):
		raise ApiError(
			f"semanticscholar.py: {endpoint}: HTTP 200 body is not a JSON object: {body[:200]!r}",
			3,
		)
	if "error" in parsed:
		raise ApiError(
			f"semanticscholar.py: {endpoint}: error inside HTTP 200: "
			f"{json.dumps(parsed['error'])[:200]}",
			3,
		)
	return parsed


def classify_lookup(status: int, body: str, endpoint: str) -> dict | None:
	"""classify(), but the paper endpoints' documented not-found answer --
	404 with {"error": "Paper with id ... not found"} -- is a genuine empty
	answer (None), never an error. Any other 404 stays one."""
	if status == 404:
		try:
			parsed = json.loads(body)
		except json.JSONDecodeError:
			parsed = None
		error = parsed.get("error") if isinstance(parsed, dict) else None
		if isinstance(error, str) and "not found" in error.lower():
			return None
	return classify(status, body, endpoint)


class SemanticScholar:
	"""One paced, keyed Graph API session: key, transport, provenance.

	Mirrors Eutils/ArxivApi. The key rides in the x-api-key header (never in
	the URL), so the provenance record keeps the header *name* with the value
	redacted -- the call stays repeatable with the reader's own key.
	"""

	def __init__(self, api_key: str, transport) -> None:
		self._api_key = api_key
		self._transport = transport
		self.calls: list[dict] = []

	def _record(self, path: str, params: dict[str, str], url: str) -> None:
		"""Append the redacted repeat-the-call record for one request."""
		self.calls.append(
			{
				"endpoint": path,
				"params": redact_params(params),
				"url": redact_url(url),
				"headers": {"x-api-key": REDACTION},
			}
		)

	def call(self, path: str, params: dict[str, str]) -> dict:
		"""One paced call; records redacted provenance; classifies the body.

		urllib normalizes header names via capitalize(), so the key travels
		as `X-api-key` on the wire; HTTP field names are case-insensitive by
		protocol, which the first live dogfood run confirms against S2.
		"""
		# Commas stay literal in `fields` to match the documented form; the
		# paper-id path carries the `DOI:` prefix and the DOI verbatim.
		url = f"{BASE}/{path}?" + urlencode(params, safe=",")
		status, body = self._transport.get(url, {"x-api-key": self._api_key})
		parsed = classify(status, body, path)
		self._record(path, params, url)
		return parsed

	def get_paper(self, doi: str) -> dict | None:
		"""The DOI lookup -- the one call whose documented 404 not-found body
		is a genuine empty answer (None), never an error."""
		path = f"paper/DOI:{doi}"
		url = f"{BASE}/{path}?" + urlencode({"fields": FIELDS}, safe=",")
		status, body = self._transport.get(url, {"x-api-key": self._api_key})
		parsed = classify_lookup(status, body, path)
		self._record(path, {"fields": FIELDS}, url)
		return parsed


def extract_record(paper: dict) -> dict:
	"""The bounded metadata set plus the citation counts S2 returns free."""
	authors = [
		collapse_ws(author.get("name"))
		for author in paper.get("authors") or []
		if isinstance(author, dict) and author.get("name")
	]
	external = paper.get("externalIds")
	doi = external.get("DOI") if isinstance(external, dict) else None
	year = paper.get("year")

	def count(field: str) -> int | None:
		value = paper.get(field)
		return value if isinstance(value, int) else None

	return {
		"title": collapse_ws(paper.get("title")),
		"authors": authors,
		"year": str(year) if isinstance(year, int) else None,
		"venue": collapse_ws(paper.get("venue")) or None,
		"citation_count": count("citationCount"),
		"influential_citation_count": count("influentialCitationCount"),
		"doi": collapse_ws(doi) or None,
		"publication_date": collapse_ws(paper.get("publicationDate")) or None,
		"paper_id": collapse_ws(paper.get("paperId")) or None,
	}


def run_search(args: argparse.Namespace, client: SemanticScholar) -> dict:
	params = {"query": args.query, "limit": str(args.retmax), "fields": FIELDS}
	payload = client.call("paper/search", params)
	data = payload.get("data")
	if not isinstance(data, list):
		raise ApiError(
			f"semanticscholar.py: paper/search: HTTP 200 without a data list: "
			f"{json.dumps(payload)[:200]}",
			3,
		)
	for paper in data:
		# paperId is the one field the API documents as always returned, so it
		# is the paper-object test: an empty or paperId-less dict is a
		# malformed 200, never a blank record.
		if not isinstance(paper, dict) or not collapse_ws(paper.get("paperId")):
			raise ApiError(
				f"semanticscholar.py: paper/search: HTTP 200 data entry is not "
				f"a paper object (paperId missing): {json.dumps(paper)[:120]}",
				3,
			)
	total = payload.get("total")
	records = [extract_record(paper) for paper in data]
	return attach_provenance(
		{
			"source": "semanticscholar",
			"operation": "search",
			"query": args.query,
			"retmax": args.retmax,
			"count": len(records),
			"total_matches": total if isinstance(total, int) else None,
			"records": records,
			# A search that returns nothing is an answer; a DOI lookup that
			# returns the documented 404 is one too (classify returned None).
			**({"note": ZERO_NOTE_SEARCH} if not records else {}),
		},
		client.calls,
	)


def run_summary(args: argparse.Namespace, client: SemanticScholar) -> dict:
	payload = client.get_paper(args.doi)
	if payload is not None and not collapse_ws(payload.get("paperId")):
		# Same paper-object test as the search path: a 200 dict without the
		# always-present paperId is a wrong-shape body, not a blank paper.
		raise ApiError(
			f"semanticscholar.py: paper/DOI:{args.doi}: HTTP 200 paper object "
			f"without the always-present paperId: {json.dumps(payload)[:200]}",
			3,
		)
	records = [extract_record(payload)] if payload is not None else []
	return attach_provenance(
		{
			"source": "semanticscholar",
			"operation": "summary",
			"doi": args.doi,
			"count": len(records),
			"records": records,
			**({"note": ZERO_NOTE_DOI} if not records else {}),
		},
		client.calls,
	)


def attach_provenance(payload: dict, calls: list[dict]) -> dict:
	"""Attach the repeat-the-call record: endpoints, parameters, access date."""
	payload["provenance"] = {
		"calls": calls,
		"accessed": date.today().isoformat(),
	}
	return payload


def author_line(record: dict) -> str:
	authors = record["authors"]
	if not authors:
		return "-"
	shown = ", ".join(authors[:3])
	return f"{shown} et al." if len(authors) > 3 else shown


def print_text(payload: dict) -> None:
	for record in payload["records"]:
		doi = record["doi"] or "-"
		citations = (
			record["citation_count"]
			if record["citation_count"] is not None
			else "unknown"
		)
		print(
			f"{record['title']} | {author_line(record)} | {record['year'] or '-'} | "
			f"{record['venue'] or '-'} | cited by {citations} | DOI {doi}"
		)
	if payload["operation"] == "search":
		print(
			f"# {payload['count']} of {payload['total_matches']} matches "
			f"(retmax {payload['retmax']})"
		)
	else:
		print(f"# {payload['count']} of 1 requested DOI")
	note = payload.get("note")
	if note:
		print(f"# {note}")
	urls = "; ".join(entry["url"] for entry in payload["provenance"]["calls"])
	print(f"# provenance: {urls}; accessed {payload['provenance']['accessed']}")


def build_parser() -> Parser:
	parser = Parser(
		prog="semanticscholar.py",
		description="Search Semantic Scholar and fetch exact DOI metadata through the "
		"keyed Graph API, with pacing, in-200 error detection, and credential "
		"redaction enforced in code.",
	)
	group = parser.add_mutually_exclusive_group(required=True)
	group.add_argument(
		"--query",
		help="Semantic Scholar search query; plain text only (no special query "
		"syntax -- the API documents none)",
	)
	group.add_argument(
		"--doi",
		help="a bare DOI (10.1038/s41587-024-02123-4) to summarize; the script "
		"adds the API's DOI: prefix",
	)
	parser.add_argument(
		"--retmax", type=int, default=8, help="max results (default 8, max 100)"
	)
	parser.add_argument("--json", action="store_true", help="print structured records")
	return parser


def parse_args(argv: list[str] | None) -> argparse.Namespace:
	args = build_parser().parse_args(argv)
	if not 1 <= args.retmax <= MAX_RESULTS:
		fail(f"semanticscholar.py: --retmax must be 1..{MAX_RESULTS}", 1)
	if args.query is not None:
		args.query = args.query.strip()
		if not args.query:
			fail("semanticscholar.py: --query must be a non-empty term", 1)
	else:
		args.doi = args.doi.strip()
		if not DOI_RE.match(args.doi):
			fail(
				f"semanticscholar.py: --doi must be a bare DOI like "
				f"10.1038/s41587-024-02123-4 (no '?' or '#' -- URL delimiters "
				f"never appear in a DOI suffix), got {args.doi!r}",
				1,
			)
	return args


def main(argv: list[str] | None = None) -> int:
	require_python()
	args = parse_args(argv)
	api_key = os.environ.get(KEY_ENV, "").strip()
	if not api_key:
		# Visible and fast: before any transport exists, so a keyless run
		# never spends a request against the shared pool it lacks the key
		# to escape.
		fail(KEYLESS_MESSAGE, 5)
	client = SemanticScholar(api_key, make_transport(INTERVAL))
	try:
		payload = (
			run_search(args, client)
			if args.query is not None
			else run_summary(args, client)
		)
	except ApiError as error:
		fail(str(error), error.exit_code)
	if args.json:
		emit(payload)
	else:
		print_text(payload)
	return 0


if __name__ == "__main__":
	raise SystemExit(main())
