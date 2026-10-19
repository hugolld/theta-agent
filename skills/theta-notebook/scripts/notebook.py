#!/usr/bin/env python3
"""Project notebook recorder: one dated provenance entry per call (ADR 0003).

The notebook lives in the research project's workspace -- a `.theta/`
directory holding `notebook.jsonl` (one JSON entry per line, append-only)
and `evidence/` (sha256-addressed snapshots). This tracer slice records the
hypothesis entry type: it validates a theta-lit-search `--json` output (the
connector's final structured output -- already redacted, already dated; raw
HTTP bodies are never kept), stores it verbatim as the content-addressed
snapshot, and appends the entry carrying the evidence item with its grade.
The M3 batch adds the remaining entry types (method, observation, decision,
confidence) and evidence-to-hypothesis links.

Exit codes -- the documented contract (see SKILL.md):
  0  success; the entry is appended and named on stdout
  1  usage error (bad arguments, malformed or shape-invalid evidence input)
  2  notebook failure (the notebook cannot be read or written)

Usage:
  python3 notebook.py --hypothesis "TEXT" --evidence <connector-output.json|->
      --grade {asserted,cross-checked,re-executed} [--json]

Contract basis: docs/adr/0003-provenance-is-a-project-notebook.md and the
connector-script invariants (docs/agents/connector-scripts.md).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from datetime import date
from pathlib import Path
from typing import NoReturn

#: Notebook paths, relative to the research project's workspace (the current
#: directory) -- also the form every message and stdout line names them by.
THETA_DIR = Path(".theta")
NOTEBOOK_PATH = THETA_DIR / "notebook.jsonl"
EVIDENCE_DIR = THETA_DIR / "evidence"

GRADES = ("asserted", "cross-checked", "re-executed")

#: Hypothesis ids sequence per type so later entries can link to them.
ID_RE = re.compile(r"^hyp-(\d+)$")

#: The connector stamps `provenance.accessed`; the recorder carries it
#: through as the evidence item's retrieval date.
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

_CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
_WHITESPACE = re.compile(r"\s+")


class RecorderError(Exception):
	"""A failure the recorder reported.

	`exit_code` is the script's documented contract code, so callers translate
	an exception directly into a process exit -- no re-classification at the
	top level. (Same idiom as the connector scripts' ApiError.)
	"""

	def __init__(self, message: str, exit_code: int) -> None:
		super().__init__(message)
		self.exit_code = exit_code


# The small helpers from here through fail() are deliberate copies from
# theta-lit-search/scripts/_common.py, not an import: each skill ships as an
# independent tree, so a cross-skill import would couple separately shipped
# code. Keep the copies small.
def require_python() -> None:
	"""Refuse to run below 3.11, naming the versioned fallbacks."""
	if sys.version_info < (3, 11):
		version = ".".join(str(part) for part in sys.version_info[:3])
		fail(
			f"notebook.py: Python 3.11+ required (this interpreter is {version}); "
			"retry with python3.13, python3.12, or python3.11",
			code=1,
		)


def collapse_ws(text: str | None) -> str:
	"""Collapse whitespace runs and drop control characters.

	Same treatment the connectors give API text, applied to the hypothesis so
	an entry stays one clean line whatever the shell handed in.
	"""
	if not text:
		return ""
	return _WHITESPACE.sub(" ", _CONTROL.sub("", text)).strip()


def emit(payload: object) -> None:
	"""Write `payload` as UTF-8 JSON to stdout."""
	sys.stdout.write(json.dumps(payload, indent=2, ensure_ascii=False) + "\n")


def fail(message: str, code: int) -> NoReturn:
	"""Write `message` to stderr and exit with a contract code."""
	sys.stderr.write(f"{message}\n")
	raise SystemExit(code)


class Parser(argparse.ArgumentParser):
	"""argparse exits 2 on usage errors, which the contract reserves for
	notebook failures -- usage errors exit 1 uniformly."""

	def error(self, message: str) -> NoReturn:
		self.print_usage(sys.stderr)
		sys.stderr.write(f"notebook.py: error: {message}\n")
		raise SystemExit(1)


def build_parser() -> Parser:
	parser = Parser(
		prog="notebook.py",
		description="Append a dated hypothesis provenance entry, with the connector's "
		"structured output stored as a content-addressed evidence item, to the "
		"project notebook in .theta/.",
	)
	parser.add_argument(
		"--hypothesis", required=True, help="the hypothesis text to record"
	)
	parser.add_argument(
		"--evidence",
		required=True,
		help="path to a theta-lit-search --json output, or - to read it from stdin",
	)
	parser.add_argument(
		"--grade",
		required=True,
		choices=GRADES,
		help="evidence grade carried by the evidence item",
	)
	parser.add_argument(
		"--json", action="store_true", help="print the appended entry as JSON"
	)
	return parser


def read_evidence(spec: str) -> str:
	"""The connector's `--json` output text, from a file or stdin (`-`)."""
	if spec == "-":
		text = sys.stdin.read()
		origin = "stdin"
	else:
		origin = spec
		try:
			text = Path(spec).read_text(encoding="utf-8")
		except OSError as error:
			raise RecorderError(
				f"notebook.py: --evidence unreadable: {origin}: {error}", 1
			) from None
	if not text.strip():
		raise RecorderError(f"notebook.py: --evidence is empty: {origin}", 1)
	return text


def parse_evidence(text: str) -> dict:
	"""Validate the connector output and extract the evidence item fields.

	Typed shape checks, not presence-only (the connector-script invariant): a
	`provenance.calls` of any other type, or an `accessed` that is not a date
	string, is a malformed input, never a sparse evidence item.
	"""
	try:
		payload = json.loads(text)
	except json.JSONDecodeError as error:
		raise RecorderError(
			f"notebook.py: --evidence is not valid JSON: {error}", 1
		) from None
	if not isinstance(payload, dict):
		raise RecorderError(
			"notebook.py: --evidence must be a JSON object -- a connector's "
			"structured output (--json)",
			1,
		)
	source = payload.get("source")
	if not isinstance(source, str) or not source:
		raise RecorderError(
			"notebook.py: --evidence lacks a non-empty string 'source'", 1
		)
	provenance = payload.get("provenance")
	if not isinstance(provenance, dict):
		raise RecorderError(
			"notebook.py: --evidence lacks a 'provenance' object", 1
		)
	calls = provenance.get("calls")
	if not isinstance(calls, list) or not calls:
		raise RecorderError(
			"notebook.py: --evidence provenance.calls must be a non-empty list", 1
		)
	endpoints: list[str] = []
	for call in calls:
		if not isinstance(call, dict):
			raise RecorderError(
				"notebook.py: every provenance call must be an object", 1
			)
		endpoint = call.get("endpoint")
		if not isinstance(endpoint, str) or not endpoint:
			raise RecorderError(
				"notebook.py: every provenance call needs a non-empty string "
				"'endpoint'",
				1,
			)
		url = call.get("url")
		if not isinstance(url, str) or not url:
			raise RecorderError(
				"notebook.py: every provenance call needs a non-empty string 'url'", 1
			)
		if endpoint not in endpoints:
			endpoints.append(endpoint)
	accessed = provenance.get("accessed")
	if not isinstance(accessed, str) or not DATE_RE.match(accessed):
		raise RecorderError(
			"notebook.py: --evidence provenance.accessed must be a YYYY-MM-DD "
			"date string",
			1,
		)
	query = payload.get("query")
	if query is not None and not isinstance(query, str):
		raise RecorderError(
			"notebook.py: --evidence 'query', when present, must be a string", 1
		)
	return {
		"source": source,
		"endpoints": endpoints,
		"query": query,
		"retrieved": accessed,
	}


def load_notebook() -> list[dict]:
	"""Every entry in the existing notebook, parsed.

	The recorder never appends to a notebook it cannot parse: a malformed line
	is a notebook failure, found before anything is written.
	"""
	if not NOTEBOOK_PATH.exists():
		return []
	try:
		raw = NOTEBOOK_PATH.read_text(encoding="utf-8")
	except (OSError, UnicodeDecodeError) as error:
		raise RecorderError(
			f"notebook.py: cannot read {NOTEBOOK_PATH}: {error}", 2
		) from None
	entries = []
	for number, line in enumerate(raw.splitlines(), start=1):
		if not line.strip():
			continue
		try:
			entry = json.loads(line)
		except json.JSONDecodeError:
			raise RecorderError(
				f"notebook.py: {NOTEBOOK_PATH} line {number} is not JSON; the "
				"recorder never appends to a notebook it cannot parse",
				2,
			) from None
		if not isinstance(entry, dict):
			raise RecorderError(
				f"notebook.py: {NOTEBOOK_PATH} line {number} is not a JSON object", 2
			)
		entries.append(entry)
	return entries


def next_hypothesis_id(entries: list[dict]) -> str:
	"""Sequence past the highest existing hyp-NNNN id."""
	highest = 0
	for entry in entries:
		match = ID_RE.match(str(entry.get("id", "")))
		if match:
			highest = max(highest, int(match.group(1)))
	return f"hyp-{highest + 1:04d}"


def write_entry(entry: dict, snapshot_name: str, evidence_text: str) -> None:
	"""Store the snapshot, then append the entry; everything after the scan.

	Order matters: an entry is never appended unless its snapshot is already
	stored, so a crash between the two leaves an orphan snapshot, never an
	entry pointing at nothing.
	"""
	try:
		EVIDENCE_DIR.mkdir(parents=True, exist_ok=True)
		snapshot = EVIDENCE_DIR / snapshot_name
		if snapshot.exists():
			try:
				existing = snapshot.read_text(encoding="utf-8")
			except UnicodeDecodeError:
				existing = None  # undecodable bytes differ from any text
			if existing != evidence_text:
				raise RecorderError(
					f"notebook.py: snapshot collision: {snapshot_name} already "
					"exists with different content",
					2,
				)
		else:
			snapshot.write_text(evidence_text, encoding="utf-8")
		with NOTEBOOK_PATH.open("a", encoding="utf-8") as handle:
			handle.write(json.dumps(entry, ensure_ascii=False) + "\n")
	except OSError as error:
		raise RecorderError(
			f"notebook.py: cannot write the notebook: {error}", 2
		) from None


def parse_args(argv: list[str] | None) -> argparse.Namespace:
	args = build_parser().parse_args(argv)
	args.hypothesis = collapse_ws(args.hypothesis)
	if not args.hypothesis:
		fail("notebook.py: --hypothesis must be non-empty text", 1)
	return args


def main(argv: list[str] | None = None) -> int:
	require_python()
	args = parse_args(argv)
	if THETA_DIR.exists() and not THETA_DIR.is_dir():
		fail("notebook.py: .theta exists but is not a directory", 2)
	try:
		evidence_text = read_evidence(args.evidence)
		item = parse_evidence(evidence_text)
		item["grade"] = args.grade
		entries = load_notebook()
		digest = hashlib.sha256(evidence_text.encode("utf-8")).hexdigest()
		item["snapshot"] = f"evidence/{digest}.json"
		entry = {
			"id": next_hypothesis_id(entries),
			"type": "hypothesis",
			"date": date.today().isoformat(),
			"text": args.hypothesis,
			"evidence": [item],
		}
		write_entry(entry, f"{digest}.json", evidence_text)
	except RecorderError as error:
		fail(str(error), error.exit_code)
	if args.json:
		emit(entry)
	else:
		print_text(entry)
	return 0


def print_text(entry: dict) -> None:
	item = entry["evidence"][0]
	print(f"recorded {entry['id']} ({entry['type']}) in {NOTEBOOK_PATH}")
	print(
		f"# evidence: {item['source']} via {', '.join(item['endpoints'])}; "
		f"retrieved {item['retrieved']}; grade {item['grade']}"
	)
	print(f"# snapshot: {item['snapshot']}")


if __name__ == "__main__":
	raise SystemExit(main())
