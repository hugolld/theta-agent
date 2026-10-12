#!/usr/bin/env python3
"""PubMed search probe - M2 shape contest, arm A (PROTOTYPE, never ships).

esearch + esummary against NCBI E-utilities with contest-mandated semantics:
>= 0.34 s pacing between calls (0.11 s with NCBI_API_KEY), advisory backoff on
x-ratelimit-remaining: 0, errors inside HTTP 200 bodies detected, and
api_key/email/tool values redacted from echoed URLs. Stdlib only, 3.11+.
"""

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date

BASE = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/"
SORTS = ("relevance", "pub_date", "Author", "JournalName")
REDACT_RE = re.compile(r"(api_key|email|tool)=[^&]*")


class ApiError(Exception):
	pass


def redact(url: str) -> str:
	return REDACT_RE.sub(r"\1=REDACTED", url)


def request(path: str, params: dict, api_key: str, state: dict) -> tuple[str, str]:
	"""One paced GET; returns (body, redacted url). Raises ApiError on failure."""
	interval = 0.11 if api_key else 0.34
	wait = state["next_ok"] - time.monotonic()
	if wait > 0:
		time.sleep(wait)
	if api_key:
		params = dict(params, api_key=api_key)
	url = BASE + path + "?" + urllib.parse.urlencode(params)
	req = urllib.request.Request(url, headers={"User-Agent": "theta-lit-probe/0.1"})
	try:
		with urllib.request.urlopen(req, timeout=60) as resp:
			body = resp.read().decode("utf-8", "replace")
			remaining = resp.headers.get("x-ratelimit-remaining")
	except urllib.error.HTTPError as exc:
		detail = exc.read().decode("utf-8", "replace")[:200]
		raise ApiError(f"HTTP {exc.code} from {path}: {detail}") from None
	except (urllib.error.URLError, OSError) as exc:
		raise ApiError(f"request to {path} failed: {exc}") from None
	state["next_ok"] = time.monotonic() + interval
	# Advisory only: the header semantics are unverified (live-observed
	# 2026-10-11); a reported empty budget earns a 1 s backoff, never a skip.
	if remaining is not None and remaining.strip() == "0":
		state["next_ok"] = max(state["next_ok"], time.monotonic() + 1.0)
	return body, redact(url)


def parse_json(body: str, path: str) -> dict:
	try:
		parsed = json.loads(body)
	except json.JSONDecodeError as exc:
		raise ApiError(f"{path} returned a non-JSON body: {body[:200]}") from None
	if not isinstance(parsed, dict):
		raise ApiError(f"{path} returned a non-object JSON body: {body[:200]}")
	if "error" in parsed:  # E-utilities errors arrive inside HTTP 200
		raise ApiError(f"{path} error inside HTTP 200: {json.dumps(parsed['error'])[:200]}")
	return parsed


def extract_record(uid: str, doc: dict) -> dict:
	pubdate = doc.get("pubdate", "") or doc.get("epubdate", "")
	year_match = re.search(r"\d{4}", pubdate)
	doi = "-"
	for artid in doc.get("articleids", []):
		if artid.get("idtype") == "doi" and artid.get("value"):
			doi = artid["value"]
			break
	return {
		"title": doc.get("title", ""),
		"first_author": doc.get("sortfirstauthor", ""),
		"year": year_match.group(0) if year_match else "",
		"journal": doc.get("fulljournalname", "") or doc.get("source", ""),
		"pmid": uid,
		"doi": doi,
	}


def main() -> int:
	if sys.version_info < (3, 11):
		print("theta-lit-probe: Python 3.11+ required", file=sys.stderr)
		return 1
	parser = argparse.ArgumentParser(prog="pubmed_search.py")
	parser.add_argument("--query", required=True, help="PubMed search term")
	parser.add_argument("--retmax", type=int, default=8, help="max results (default 8, max 200)")
	parser.add_argument("--sort", choices=SORTS, default="relevance")
	parser.add_argument("--json", action="store_true", help="print structured records")
	args = parser.parse_args()
	if not 1 <= args.retmax <= 200:
		print("pubmed_search.py: --retmax must be 1..200", file=sys.stderr)
		return 1

	api_key = os.environ.get("NCBI_API_KEY", "")
	state = {"next_ok": 0.0}
	try:
		esearch_params = {"db": "pubmed", "term": args.query, "retmode": "json", "retmax": args.retmax}
		if args.sort != "relevance":
			esearch_params["sort"] = args.sort
		body, url_esearch = request("esearch.fcgi", esearch_params, api_key, state)
		esearch = parse_json(body, "esearch")
		result = esearch.get("esearchresult")
		if not isinstance(result, dict) or "idlist" not in result:
			raise ApiError(f"esearch body has no esearchresult.idlist: {body[:200]}")
		ids = [str(i) for i in result["idlist"][: args.retmax]]
		urls = [url_esearch]
		records = []
		if ids:
			body, url_esummary = request(
				"esummary.fcgi",
				{"db": "pubmed", "id": ",".join(ids), "retmode": "json"},
				api_key,
				state,
			)
			urls.append(url_esummary)
			esummary = parse_json(body, "esummary")
			sresult = esummary.get("result")
			if not isinstance(sresult, dict) or "uids" not in sresult:
				raise ApiError(f"esummary error or malformed body: {body[:200]}")
			for uid in sresult["uids"]:
				doc = sresult.get(str(uid), {})
				if "error" in doc:  # per-UID errors also ride inside HTTP 200
					raise ApiError(f"esummary error for PMID {uid}: {json.dumps(doc['error'])[:200]}")
				records.append(extract_record(str(uid), doc))
	except ApiError as exc:
		print(f"pubmed_search.py: {exc}", file=sys.stderr)
		return 1

	accessed = date.today().isoformat()
	provenance = {"urls": urls, "accessed": accessed}
	if args.json:
		print(json.dumps({
			"query": args.query,
			"sort": args.sort,
			"count": len(records),
			"records": records,
			"provenance": provenance,
		}, indent=2))
	else:
		for r in records:
			print(f"{r['title']} | {r['first_author']} | {r['year']} | {r['journal']} | PMID {r['pmid']} | DOI {r['doi']}")
		print(f"# provenance: {'; '.join(urls)}; accessed {accessed}")
	return 0


if __name__ == "__main__":
	sys.exit(main())
