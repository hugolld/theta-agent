#!/usr/bin/env python3
"""PubMed connector: esearch + esummary with the E-utilities contract enforced.

NCBI's documented error channel is the body inside HTTP 200 (the Bookshelf
chapters state no status code for E-utility errors), the pace is 3 requests
per second anonymous and 10 with an API key, and the key rides in the query
string. This script enforces all three in code and redacts credentials from
the provenance it echoes.

Exit codes -- the documented contract (see SKILL.md):
  0  success; a zero-result query included (reported, not failed)
  1  usage error
  2  transport failure (network error, non-200 HTTP status)
  3  API error inside an HTTP 200 body
  4  throttled (the rate-limit error body)

Usage:
  python3 pubmed.py --query "CRISPR gene therapy" [--retmax 8] [--sort relevance] [--json]
  python3 pubmed.py --pmid 34567890 [--json]

Contract basis: docs/research/2026-10-11-m2-literature-api-contracts.md
(NCBI Bookshelf NBK25497/NBK25499, live-probed 2026-10-11).
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
	ApiError,
	collapse_ws,
	emit,
	fail,
	make_transport,
	redact_params,
	redact_url,
	require_python,
)

BASE = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/"
SORTS = ("relevance", "pub_date", "Author", "JournalName")

#: Just under 1/3 s and 1/10 s: the published ceilings, never equaled.
ANONYMOUS_INTERVAL = 0.34
KEYED_INTERVAL = 0.11

#: esearch retmax ceiling, and the UID count above which NCBI asks for POST.
MAX_UIDS = 200

PMID_RE = re.compile(r"^\d{1,9}$")
THROTTLE_MARK = "rate limit exceeded"

ZERO_NOTE = (
	"zero results is PubMed's genuine no-match answer for this query; report "
	"it as 'not found in PubMed', not as a failure"
)


class Parser(argparse.ArgumentParser):
	"""argparse exits 2 on usage errors, which the contract reserves for
	transport failures -- usage errors exit 1 uniformly."""

	def error(self, message: str) -> NoReturn:
		self.print_usage(sys.stderr)
		sys.stderr.write(f"pubmed.py: error: {message}\n")
		raise SystemExit(1)


def is_throttle(payload: dict) -> bool:
	"""The documented rate-limit error body: {"error": "API rate limit exceeded", ...}."""
	error = payload.get("error")
	return isinstance(error, str) and THROTTLE_MARK in error.lower()


PACE_HINT = (
	"its pace is 3 requests/second anonymous, 10 with an NCBI_API_KEY; "
	"wait before retrying"
)


def throttle_error(endpoint: str, where: str, error_json: object) -> ApiError:
	"""The one throttle message, whether the body arrived with 200 or not."""
	return ApiError(
		f"pubmed.py: {endpoint}: throttled by NCBI {where}: "
		f"{json.dumps(error_json)} -- {PACE_HINT}",
		4,
	)


def classify(status: int, body: str, endpoint: str) -> dict:
	"""Turn one HTTP response into a parsed JSON object or an ApiError.

	The order matters: a non-200 body can still carry the throttle error, and
	the error channel of record is the body, so a 200 with an error key or an
	unexpected shape is an error, never a sparse success.
	"""
	try:
		parsed = json.loads(body)
	except json.JSONDecodeError:
		code = 3 if status == 200 else 2
		raise ApiError(
			f"pubmed.py: {endpoint}: HTTP {status} with a non-JSON body: {body[:200]!r}",
			code,
		) from None
	if status != 200:
		if isinstance(parsed, dict) and is_throttle(parsed):
			raise throttle_error(endpoint, f"(HTTP {status})", parsed["error"])
		raise ApiError(
			f"pubmed.py: {endpoint}: HTTP {status}: {body[:200]!r}", 2
		) from None
	if not isinstance(parsed, dict):
		raise ApiError(
			f"pubmed.py: {endpoint}: HTTP 200 body is not a JSON object: {body[:200]!r}",
			3,
		)
	if "error" in parsed:
		if is_throttle(parsed):
			raise throttle_error(endpoint, "inside HTTP 200", parsed["error"])
		raise ApiError(
			f"pubmed.py: {endpoint}: error inside HTTP 200: {json.dumps(parsed['error'])[:200]}",
			3,
		)
	return parsed


class Eutils:
	"""One paced E-utilities session: credentials, transport, provenance.

	The three travelled as loose parameters through every function before;
	they live here now, before the arXiv and Semantic Scholar slices clone
	the pattern. The API key stays private so nothing outside this class can
	echo it unredacted.
	"""

	def __init__(self, api_key: str, transport) -> None:
		self._api_key = api_key
		self._transport = transport
		self.calls: list[dict] = []

	def call(self, path: str, params: dict[str, str]) -> dict:
		"""One paced call; records redacted provenance; classifies the body."""
		fetch_params = dict(params)
		if self._api_key:
			fetch_params["api_key"] = self._api_key
		url = BASE + path + "?" + urlencode(fetch_params)
		status, body = self._transport.get(url)
		parsed = classify(status, body, path)
		self.calls.append(
			{
				"endpoint": path,
				"params": redact_params(fetch_params),
				"url": redact_url(url),
			}
		)
		return parsed


def extract_record(uid: str, doc: dict) -> dict:
	"""The bounded metadata set: title/authors/year/venue/identifiers."""
	pubdate = collapse_ws(doc.get("pubdate")) or collapse_ws(doc.get("epubdate"))
	year_match = re.search(r"\d{4}", pubdate)
	authors = [
		collapse_ws(author.get("name"))
		for author in doc.get("authors", [])
		if isinstance(author, dict) and author.get("name")
	]
	if not authors and doc.get("sortfirstauthor"):
		authors = [collapse_ws(doc["sortfirstauthor"])]
	doi = next(
		(
			article_id["value"]
			for article_id in doc.get("articleids", [])
			if isinstance(article_id, dict)
			and article_id.get("idtype") == "doi"
			and article_id.get("value")
		),
		None,
	)
	return {
		"title": collapse_ws(doc.get("title")),
		"authors": authors,
		"year": year_match.group(0) if year_match else None,
		"journal": collapse_ws(doc.get("fulljournalname")) or collapse_ws(doc.get("source")) or None,
		"pmid": uid,
		"doi": doi,
		"pubdate": pubdate or None,
	}


def summarize_uids(uids: list[str], client: Eutils) -> list[dict]:
	"""esummary for a bounded UID list, with per-UID in-200 errors caught."""
	payload = client.call(
		"esummary.fcgi",
		{"db": "pubmed", "id": ",".join(uids), "retmode": "json"},
	)
	result = payload.get("result")
	if not isinstance(result, dict) or "uids" not in result:
		raise ApiError(
			f"pubmed.py: esummary.fcgi: HTTP 200 without result.uids: "
			f"{json.dumps(payload)[:200]}",
			3,
		)
	records = []
	for uid in result["uids"]:
		doc = result.get(str(uid))
		if not isinstance(doc, dict):
			raise ApiError(
				f"pubmed.py: esummary.fcgi: no document summary for PMID {uid}", 3
			)
		if "error" in doc:  # per-UID errors also ride inside HTTP 200
			raise ApiError(
				f"pubmed.py: esummary.fcgi: error inside HTTP 200 for PMID {uid}: "
				f"{json.dumps(doc['error'])[:200]}",
				3,
			)
		records.append(extract_record(str(uid), doc))
	return records


def run_search(args: argparse.Namespace, client: Eutils) -> dict:
	params = {
		"db": "pubmed",
		"term": args.query,
		"retmode": "json",
		"retmax": str(args.retmax),
	}
	if args.sort != "relevance":
		params["sort"] = args.sort
	payload = client.call("esearch.fcgi", params)
	result = payload.get("esearchresult")
	if not isinstance(result, dict) or "idlist" not in result:
		raise ApiError(
			f"pubmed.py: esearch.fcgi: HTTP 200 without esearchresult.idlist: "
			f"{json.dumps(payload)[:200]}",
			3,
		)
	# esearch reports count as a string; tolerate a JSON number defensively.
	total_text = str(result.get("count", ""))
	uids = [str(uid) for uid in result["idlist"]][:MAX_UIDS]
	records = summarize_uids(uids, client) if uids else []
	return attach_provenance(
		{
			"source": "pubmed",
			"operation": "search",
			"query": args.query,
			"sort": args.sort,
			"retmax": args.retmax,
			"count": len(records),
			"total_matches": int(total_text) if total_text.isdigit() else None,
			"records": records,
			# A search that returns nothing is an answer; an identifier lookup
			# that returns nothing is an error (classify already raised).
			**({"note": ZERO_NOTE} if not records else {}),
		},
		client.calls,
	)


def run_summary(args: argparse.Namespace, client: Eutils) -> dict:
	records = summarize_uids(args.pmids, client)
	return attach_provenance(
		{
			"source": "pubmed",
			"operation": "summary",
			"pmids": args.pmids,
			"count": len(records),
			"records": records,
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
		print(
			f"{record['title']} | {author_line(record)} | {record['year'] or '-'} | "
			f"{record['journal'] or '-'} | PMID {record['pmid']} | DOI {doi}"
		)
	if payload["operation"] == "search":
		print(
			f"# {payload['count']} of {payload['total_matches']} matches "
			f"(retmax {payload['retmax']}, sort {payload['sort']})"
		)
	else:
		print(f"# {payload['count']} of {len(payload['pmids'])} requested PMID(s)")
	note = payload.get("note")
	if note:
		print(f"# {note}")
	urls = "; ".join(entry["url"] for entry in payload["provenance"]["calls"])
	print(f"# provenance: {urls}; accessed {payload['provenance']['accessed']}")


def build_parser() -> Parser:
	parser = Parser(
		prog="pubmed.py",
		description="Search PubMed and fetch exact PMID metadata through NCBI E-utilities, "
		"with pacing, in-200 error detection, and credential redaction enforced in code.",
	)
	group = parser.add_mutually_exclusive_group(required=True)
	group.add_argument("--query", help="PubMed search term")
	group.add_argument("--pmid", help="a PMID, or comma-separated PMIDs, to summarize")
	parser.add_argument("--retmax", type=int, default=8, help="max results (default 8, max 200)")
	parser.add_argument("--sort", choices=SORTS, default="relevance")
	parser.add_argument("--json", action="store_true", help="print structured records")
	return parser


def parse_args(argv: list[str] | None) -> argparse.Namespace:
	args = build_parser().parse_args(argv)
	if not 1 <= args.retmax <= MAX_UIDS:
		fail(f"pubmed.py: --retmax must be 1..{MAX_UIDS}", 1)
	if args.query is not None:
		args.query = args.query.strip()
		if not args.query:
			fail("pubmed.py: --query must be a non-empty term", 1)
	else:
		args.pmids = [pmid.strip() for pmid in args.pmid.split(",")]
		for pmid in args.pmids:
			if not PMID_RE.match(pmid):
				fail(f"pubmed.py: --pmid values must be numeric PMIDs, got {pmid!r}", 1)
		if not 1 <= len(args.pmids) <= MAX_UIDS:
			fail(f"pubmed.py: --pmid takes 1..{MAX_UIDS} identifiers", 1)
	return args


def main(argv: list[str] | None = None) -> int:
	require_python()
	args = parse_args(argv)
	api_key = os.environ.get("NCBI_API_KEY", "").strip()
	client = Eutils(
		api_key, make_transport(KEYED_INTERVAL if api_key else ANONYMOUS_INTERVAL)
	)
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
