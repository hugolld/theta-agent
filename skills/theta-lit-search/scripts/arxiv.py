#!/usr/bin/env python3
"""arXiv connector: one Atom query endpoint with the arXiv contract enforced.

Everything on arXiv's API answers from one endpoint in Atom 1.0 XML,
"including errors" (the API User's Manual): the documented failure channel is
a feed whose single entry is titled Error, inside an otherwise normal HTTP
200. The observed throttle signal is different again -- the bare plain-text
body "Rate exceeded." (vendored-library observation 2026-07-27, not in the
docs). The pace is one request every three seconds, single connection, and
the Terms of Use apply it fleet-wide ("all of the machines under your
control as a whole"); circumvention is a prohibited use. This script enforces
the pace in code, detects both in-200 failure shapes, and keeps the
provenance it echoes repeatable. There are no credentials to redact -- arXiv
has no key mechanism at all.

Exit codes -- the documented contract (see SKILL.md):
  0  success; zero results included (an unknown ID in id_list is a genuine
     no-match, reported, not failed)
  1  usage error
  2  transport failure (network error, non-200 HTTP status)
  3  API error inside an HTTP 200 body (an Error entry, or a body that is
     not an Atom feed)
  4  throttled (the plain-text rate-limit body, whatever the status)

Usage:
  python3 arxiv.py --query 'ti:attention AND cat:cs.CL' [--retmax 8] [--sort submittedDate] [--order ascending] [--json]
  python3 arxiv.py --arxiv-id 1706.03762 [--json]

Contract basis: docs/research/2026-10-11-m2-literature-api-contracts.md
(arXiv API User's Manual + Terms of Use, live-probed 2026-10-11).
"""

from __future__ import annotations

import argparse
import re
import sys
import xml.etree.ElementTree as ET
from datetime import date
from pathlib import Path
from typing import NoReturn
from urllib.parse import urlencode, urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parent))
# Keep the checkout pure: importing _common would otherwise drop a __pycache__
# directory into the skill tree, which ships in the package and dirties the
# git-status proofs the dogfood gate runs on.
sys.dont_write_bytecode = True

from _common import (  # noqa: E402
	ApiError,
	collapse_ws,
	emit,
	fail,
	make_transport,
	redact_params,
	redact_url,
	require_python,
)

BASE = "https://export.arxiv.org/api/"
SORTS = ("relevance", "submittedDate", "lastUpdatedDate")
ORDERS = ("ascending", "descending")

#: Just over 3 s: the TOU ceiling is "no more than one request every three
#: seconds" -- never equaled, and single-connection by the same clause.
INTERVAL = 3.1

#: The bounded list the CLI serves. The API itself allows slices of at most
#: 2,000 (30,000 per query); a Theta search needs the first page, not the
#: corpus -- deeper walks are paper-lookup's paginate pattern.
MAX_RESULTS = 200

NS = {
	"atom": "http://www.w3.org/2005/Atom",
	"arxiv": "http://arxiv.org/schemas/atom",
	"opensearch": "http://a9.com/-/spec/opensearch/1.1/",
}

#: Modern `2401.01234v2` and legacy `hep-th/9901001`, `math.GT/0309136v1`
#: -- the two identifier generations, version suffix optional.
ID_RE = re.compile(
	r"^(?:\d{4}\.\d{4,5}(?:v\d+)?|[a-z]+(?:-[a-z]+)?(?:\.[A-Za-z0-9-]+)?/\d{7}(?:v\d+)?)$"
)

#: The throttle body is plain text, not XML: "Rate exceeded." (observed
#: 2026-07-27; the docs document no throttle response at all).
THROTTLE_MARK = "Rate exceeded"

ZERO_NOTE_SEARCH = (
	"zero results is arXiv's genuine no-match answer for this query; report it "
	"as 'not found in arXiv', not as a failure"
)
ZERO_NOTE_ID = (
	"zero entries for an identifier lookup means arXiv has no record for it; "
	"report it as 'not found in arXiv', not as a failure"
)

PACE_HINT = (
	"its pace is one request every three seconds with a single connection; "
	"wait before retrying and serialize arXiv work rather than running calls "
	"in parallel"
)


class Parser(argparse.ArgumentParser):
	"""argparse exits 2 on usage errors, which the contract reserves for
	transport failures -- usage errors exit 1 uniformly."""

	def error(self, message: str) -> NoReturn:
		self.print_usage(sys.stderr)
		sys.stderr.write(f"arxiv.py: error: {message}\n")
		raise SystemExit(1)


def throttle_error(endpoint: str, status: int, text: str) -> ApiError:
	"""The one throttle message, whatever status the body arrived with."""
	return ApiError(
		f"arxiv.py: {endpoint}: throttled by arXiv (HTTP {status}): "
		f"{text[:100]!r} -- {PACE_HINT}",
		4,
	)


def classify(status: int, body: str, endpoint: str) -> ET.Element:
	"""Turn one HTTP response into an Atom feed element or an ApiError.

	The order matters: the throttle body is plain text and arrives with or
	without an error status, so it is checked on the raw bytes first; and the
	error channel of record is the feed itself, so a 200 that is not a feed
	is an error, never a sparse success.
	"""
	if body.strip().startswith(THROTTLE_MARK):
		raise throttle_error(endpoint, status, body.strip())
	try:
		feed = ET.fromstring(body)
	except ET.ParseError:
		code = 3 if status == 200 else 2
		raise ApiError(
			f"arxiv.py: {endpoint}: HTTP {status} with a non-XML body: {body[:200]!r}",
			code,
		) from None
	if status != 200:
		raise ApiError(
			f"arxiv.py: {endpoint}: HTTP {status}: {body[:200]!r}", 2
		) from None
	if feed.tag != f"{{{NS['atom']}}}feed":
		raise ApiError(
			f"arxiv.py: {endpoint}: HTTP 200 body is not an Atom feed: "
			f"root element <{feed.tag}>",
			3,
		)
	return feed


class ArxivApi:
	"""One paced arXiv session: transport and provenance, mirroring Eutils.

	There are no credentials to hold private -- arXiv has no key mechanism --
	so this class is the provenance collection site and nothing else.
	"""

	def __init__(self, transport) -> None:
		self._transport = transport
		self.calls: list[dict] = []

	def call(self, path: str, params: dict[str, str]) -> ET.Element:
		"""One paced call; records redacted provenance; classifies the body."""
		# Commas and slashes stay literal (id_list, legacy IDs) to match the
		# manual's canonical form; everything else is percent-encoded.
		url = BASE + path + "?" + urlencode(params, safe=",/")
		status, body = self._transport.get(url)
		feed = classify(status, body, path)
		self.calls.append(
			{
				"endpoint": path,
				"params": redact_params(params),
				"url": redact_url(url),
			}
		)
		return feed


def split_version(arxiv_id: str) -> tuple[str, str | None]:
	"""`1706.03762v7` -> `("1706.03762", "7")`.

	The bare ID is what a user supplies, what a DOI carries, and what other
	APIs' `ARXIV:` prefixes expect, so comparing the versioned form against
	any of them fails. Both are returned rather than choosing one.
	"""
	base, separator, version = arxiv_id.rpartition("v")
	if separator and version.isdigit() and base:
		return base, version
	return arxiv_id, None


def id_from_url(url: str) -> str:
	"""The arXiv ID from an entry `<id>` URL, scheme-agnostically.

	Preserve the entire path after `/abs/`: legacy identifiers such as
	`hep-th/9901001` contain a slash, and the element itself arrives with an
	`http://` scheme and a version suffix while the entry's links are https.
	"""
	path = urlsplit(url).path.rstrip("/")
	return path.split("/abs/", 1)[1] if "/abs/" in path else path.rsplit("/", 1)[-1]


def parse_entry(entry: ET.Element) -> dict:
	"""The bounded metadata set: title/authors/year/category/identifiers."""
	raw_id = collapse_ws(entry.findtext("atom:id", namespaces=NS))
	versioned = id_from_url(raw_id) if raw_id else ""
	arxiv_id, version = split_version(versioned)
	published = collapse_ws(entry.findtext("atom:published", namespaces=NS)) or None
	year_match = re.search(r"\d{4}", published or "")
	primary = entry.find("arxiv:primary_category", NS)
	return {
		"title": collapse_ws(entry.findtext("atom:title", namespaces=NS)),
		"authors": [
			collapse_ws(name)
			for name in (
				author.findtext("atom:name", namespaces=NS)
				for author in entry.findall("atom:author", NS)
			)
			if collapse_ws(name)
		],
		"year": year_match.group(0) if year_match else None,
		"arxiv_id": arxiv_id,
		"arxiv_id_versioned": versioned or None,
		"version": version,
		"primary_category": primary.get("term") if primary is not None else None,
		"categories": [
			term
			for term in (
				category.get("term") for category in entry.findall("atom:category", NS)
			)
			if term
		],
		# The journal DOI, and only when the author registered one -- arXiv's
		# own 10.48550 DOI never appears in the feed.
		"doi": collapse_ws(entry.findtext("arxiv:doi", namespaces=NS)) or None,
		"journal_ref": collapse_ws(entry.findtext("arxiv:journal_ref", namespaces=NS))
		or None,
		"published": published,
		"updated": collapse_ws(entry.findtext("atom:updated", namespaces=NS)) or None,
	}


def read_feed(feed: ET.Element, endpoint: str) -> tuple[list[dict], str | None, int | None]:
	"""Feed element -> (records, echoed query, total), with error entries caught.

	The error check must precede any other interpretation: an Atom error feed
	is a structurally valid one-hit search result, and the reason rides in the
	error entry's <summary>.
	"""
	entries = feed.findall("atom:entry", NS)
	for entry in entries:
		if collapse_ws(entry.findtext("atom:title", namespaces=NS)) == "Error":
			reason = collapse_ws(entry.findtext("atom:summary", namespaces=NS))
			raise ApiError(
				f"arxiv.py: {endpoint}: error inside HTTP 200 (Atom error entry): "
				f"{reason or 'no reason given'}",
				3,
			)
	# The feed <title> echoes the query as arXiv actually ran it: an unknown
	# field prefix is silently rewritten to `all:`, and this is the only way
	# to see it.
	echoed = collapse_ws(feed.findtext("atom:title", namespaces=NS)) or None
	total = collapse_ws(feed.findtext("opensearch:totalResults", namespaces=NS))
	records = [parse_entry(entry) for entry in entries]
	return records, echoed, int(total) if total.isdigit() else None


def attach_provenance(payload: dict, calls: list[dict]) -> dict:
	"""Attach the repeat-the-call record: endpoints, parameters, access date."""
	payload["provenance"] = {
		"calls": calls,
		"accessed": date.today().isoformat(),
	}
	return payload


def run_search(args: argparse.Namespace, client: ArxivApi) -> dict:
	params = {"search_query": args.query, "max_results": str(args.retmax)}
	if args.sort != "relevance":
		params["sortBy"] = args.sort
	if args.order != "descending":
		params["sortOrder"] = args.order
	records, echoed, total = read_feed(client.call("query", params), "query")
	return attach_provenance(
		{
			"source": "arxiv",
			"operation": "search",
			"query": args.query,
			"sort": args.sort,
			"order": args.order,
			"retmax": args.retmax,
			"count": len(records),
			"total_matches": total,
			"query_as_executed": echoed,
			"records": records,
			# A search that returns nothing is an answer; an identifier lookup
			# that returns nothing is also an answer on arXiv (no record for
			# the ID), unlike PubMed, where the API raises per-UID errors.
			**({"note": ZERO_NOTE_SEARCH} if not records else {}),
		},
		client.calls,
	)


def run_summary(args: argparse.Namespace, client: ArxivApi) -> dict:
	# max_results must ride along: the API default page size is 10, and it
	# applies to id_list responses too -- without this, an 11-ID lookup would
	# return a confident truncated 10.
	records, echoed, total = read_feed(
		client.call(
			"query",
			{"id_list": ",".join(args.arxiv_ids), "max_results": str(len(args.arxiv_ids))},
		),
		"query",
	)
	return attach_provenance(
		{
			"source": "arxiv",
			"operation": "summary",
			"arxiv_ids": args.arxiv_ids,
			"count": len(records),
			"total_matches": total,
			"query_as_executed": echoed,
			"records": records,
			**({"note": ZERO_NOTE_ID} if not records else {}),
		},
		client.calls,
	)


def author_line(record: dict) -> str:
	authors = record["authors"]
	if not authors:
		return "-"
	shown = ", ".join(authors[:3])
	return f"{shown} et al." if len(authors) > 3 else shown


def print_text(payload: dict) -> None:
	for record in payload["records"]:
		shown_id = record["arxiv_id_versioned"] or record["arxiv_id"]
		doi = record["doi"] or "-"
		print(
			f"{record['title']} | {author_line(record)} | {record['year'] or '-'} | "
			f"cat {record['primary_category'] or '-'} | arXiv {shown_id} | DOI {doi}"
		)
	if payload["operation"] == "search":
		print(
			f"# {payload['count']} of {payload['total_matches']} matches "
			f"(retmax {payload['retmax']}, sortBy {payload['sort']}, "
			f"sortOrder {payload['order']})"
		)
	else:
		print(
			f"# {payload['count']} of {len(payload['arxiv_ids'])} requested "
			f"arXiv ID(s)"
		)
	note = payload.get("note")
	if note:
		print(f"# {note}")
	urls = "; ".join(entry["url"] for entry in payload["provenance"]["calls"])
	print(f"# provenance: {urls}; accessed {payload['provenance']['accessed']}")


def build_parser() -> Parser:
	parser = Parser(
		prog="arxiv.py",
		description="Search arXiv and fetch exact metadata by arXiv ID through the Atom "
		"query API, with pacing, in-200 error detection, and a bounded record "
		"set enforced in code.",
	)
	group = parser.add_mutually_exclusive_group(required=True)
	group.add_argument(
		"--query",
		help="arXiv search query; field prefixes (ti, au, abs, cat, all, ...) and "
		"booleans (AND, OR, ANDNOT) pass through to the API",
	)
	group.add_argument(
		"--arxiv-id",
		help="an arXiv ID (2401.01234, hep-th/9901001, optional vN), or a "
		"comma-separated list, to summarize",
	)
	parser.add_argument(
		"--retmax", type=int, default=8, help="max results (default 8, max 200)"
	)
	parser.add_argument(
		"--sort", choices=SORTS, default="relevance", help="API sortBy (default relevance)"
	)
	parser.add_argument(
		"--order",
		choices=ORDERS,
		default="descending",
		help="API sortOrder (default descending)",
	)
	parser.add_argument("--json", action="store_true", help="print structured records")
	return parser


def parse_args(argv: list[str] | None) -> argparse.Namespace:
	args = build_parser().parse_args(argv)
	if args.query is not None:
		args.query = args.query.strip()
		if not args.query:
			fail("arxiv.py: --query must be a non-empty term", 1)
		if not 1 <= args.retmax <= MAX_RESULTS:
			fail(f"arxiv.py: --retmax must be 1..{MAX_RESULTS}", 1)
	else:
		args.arxiv_ids = [identifier.strip() for identifier in args.arxiv_id.split(",")]
		for identifier in args.arxiv_ids:
			if not ID_RE.match(identifier):
				fail(
					f"arxiv.py: --arxiv-id values must look like 2401.01234, "
					f"2401.01234v2, or hep-th/9901001, got {identifier!r}",
					1,
				)
		if not 1 <= len(args.arxiv_ids) <= MAX_RESULTS:
			fail(f"arxiv.py: --arxiv-id takes 1..{MAX_RESULTS} identifiers", 1)
	return args


def main(argv: list[str] | None = None) -> int:
	require_python()
	args = parse_args(argv)
	client = ArxivApi(make_transport(INTERVAL))
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
