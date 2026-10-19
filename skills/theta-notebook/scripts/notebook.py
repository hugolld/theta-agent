#!/usr/bin/env python3
"""Project notebook recorder: one dated provenance entry per call (ADR 0003).

The notebook lives in the research project's workspace -- a `.theta/`
directory holding `notebook.jsonl` (one JSON entry per line, append-only)
and `evidence/` (sha256-addressed snapshots). Each call records one of the
five entry types -- hypothesis, method, observation, decision, confidence --
with ids sequenced per type so later entries can link to them. An entry that
carries evidence stores the theta-lit-search `--json` output (the connector's
final structured output -- already redacted, already dated; raw HTTP bodies
are never kept) verbatim as its content-addressed snapshot. A grade is
required exactly when evidence is recorded, and the observation entry
carries it as its own field: a grade rates the source, never the
researcher's judgment -- that judgment is the confidence entry type, and the
two never merge.

Exit codes -- the documented contract (see SKILL.md):
  0  success; the entry is appended and named on stdout
  1  usage error (bad arguments, malformed or shape-invalid evidence input,
     or a link that names no hypothesis in the notebook)
  2  notebook failure (the notebook cannot be read or written)

Usage:
  python3 notebook.py --hypothesis "TEXT" --evidence <connector-output.json|->
      --grade {asserted,cross-checked,re-executed} [--json]
  python3 notebook.py --method "TEXT" [--evidence <...> --grade <...>] [--json]
  python3 notebook.py --observation "TEXT" --evidence <...> --grade <...>
      [--supports hyp-NNNN] [--json]
  python3 notebook.py --decision "TEXT" [--evidence <...> --grade <...>] [--json]
  python3 notebook.py --confidence "TEXT" --on hyp-NNNN [--json]

`--evidence` is required for hypothesis and observation entries, optional
for method and decision, and rejected for confidence (a judgment is not a
source claim). `--on` and `--supports` must name a hypothesis entry already
in the notebook.

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

#: The five entry types (ADR 0003) and the id prefix each sequences under.
TYPE_PREFIX = {
	"hypothesis": "hyp",
	"method": "mth",
	"observation": "obs",
	"decision": "dec",
	"confidence": "cnf",
}

#: A link target or confidence subject: an existing hypothesis entry's id.
REF_RE = re.compile(r"^hyp-\d+$")

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

	Same treatment the connectors give API text, applied to the entry text so
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
		description="Append one dated provenance entry to the project notebook in "
		".theta/, storing the connector's structured output as a content-addressed "
		"evidence item when the entry carries evidence.",
	)
	types = parser.add_mutually_exclusive_group(required=True)
	types.add_argument(
		"--hypothesis", help="the hypothesis text to record (evidence required)",
	)
	types.add_argument(
		"--method", help="the chosen method to record (evidence optional)",
	)
	types.add_argument(
		"--observation",
		help="the observation text to record (evidence required; the entry "
		"itself carries the grade)",
	)
	types.add_argument(
		"--decision", help="the decision text to record (evidence optional)",
	)
	types.add_argument(
		"--confidence",
		help="the judgment text on a hypothesis (no evidence: judgment is not "
		"a source claim)",
	)
	parser.add_argument(
		"--on",
		metavar="hyp-NNNN",
		help="the hypothesis entry a confidence entry judges; required with "
		"--confidence, rejected without it",
	)
	parser.add_argument(
		"--evidence",
		help="path to a theta-lit-search --json output, or - to read it from "
		"stdin; required for hypothesis and observation, optional for method "
		"and decision, rejected for confidence",
	)
	parser.add_argument(
		"--grade",
		choices=GRADES,
		help="the evidence grade carried by the recorded evidence item -- and "
		"by the observation entry itself; required exactly when --evidence is "
		"given (a trust mark on a source is a decision, never an accident)",
	)
	parser.add_argument(
		"--supports",
		metavar="hyp-NNNN",
		help="mark the recorded evidence as supporting this existing "
		"hypothesis; observation entries only",
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


def next_id(entry_type: str, entries: list[dict]) -> str:
	"""Sequence past the highest existing id of this entry's type."""
	prefix = TYPE_PREFIX[entry_type]
	id_re = re.compile(rf"^{prefix}-(\d+)$")
	highest = 0
	for entry in entries:
		match = id_re.match(str(entry.get("id", "")))
		if match:
			highest = max(highest, int(match.group(1)))
	return f"{prefix}-{highest + 1:04d}"


def resolve_ref(entries: list[dict], ref: str | None, flag: str) -> None:
	"""A --on/--supports reference must name an existing hypothesis entry.

	The id shape is checked at argument-parse time; here the reference must
	resolve against the notebook's hypothesis entries -- a link that points
	nowhere is a usage error, never a recorded entry.
	"""
	if ref is None:
		return
	known = [
		str(entry.get("id"))
		for entry in entries
		if entry.get("type") == "hypothesis"
	]
	if ref not in known:
		raise RecorderError(
			f"notebook.py: {flag} names no hypothesis in the notebook: {ref} "
			f"(hypotheses recorded: {', '.join(known) or 'none'})",
			1,
		)


def write_entry(entry: dict, snapshot: tuple[str, str] | None) -> None:
	"""Store the snapshot, then append the entry; everything after the scan.

	`snapshot` is the evidence's (file name, text) pair, or None for an entry
	that carries no evidence. Order matters: an entry is never appended
	unless its snapshot is already stored, so a crash between the two leaves
	an orphan snapshot, never an entry pointing at nothing.
	"""
	try:
		if snapshot is not None:
			snapshot_name, evidence_text = snapshot
			EVIDENCE_DIR.mkdir(parents=True, exist_ok=True)
			snapshot_path = EVIDENCE_DIR / snapshot_name
			if snapshot_path.exists():
				try:
					existing = snapshot_path.read_text(encoding="utf-8")
				except UnicodeDecodeError:
					existing = None  # undecodable bytes differ from any text
				if existing != evidence_text:
					raise RecorderError(
						f"notebook.py: snapshot collision: {snapshot_name} already "
						"exists with different content",
						2,
					)
			else:
				snapshot_path.write_text(evidence_text, encoding="utf-8")
		with NOTEBOOK_PATH.open("a", encoding="utf-8") as handle:
			handle.write(json.dumps(entry, ensure_ascii=False) + "\n")
	except OSError as error:
		raise RecorderError(
			f"notebook.py: cannot write the notebook: {error}", 2
		) from None


def parse_args(argv: list[str] | None) -> argparse.Namespace:
	args = build_parser().parse_args(argv)
	args.type = next(t for t in TYPE_PREFIX if getattr(args, t) is not None)
	args.text = collapse_ws(getattr(args, args.type))
	if not args.text:
		fail(f"notebook.py: --{args.type} must be non-empty text", 1)
	# Confidence is judgment, not a source claim: no evidence, a named subject.
	if args.type == "confidence":
		if args.evidence is not None:
			fail(
				"notebook.py: --evidence is not accepted with --confidence; "
				"a judgment is not a source claim",
				1,
			)
		if args.on is None:
			fail(
				"notebook.py: --confidence requires --on naming the hypothesis "
				"it judges",
				1,
			)
	elif args.on is not None:
		fail("notebook.py: --on is only accepted with --confidence", 1)
	if args.type in ("hypothesis", "observation") and args.evidence is None:
		fail(
			f"notebook.py: --{args.type} requires --evidence -- a hypothesis or "
			"an observation is a claim about what a source showed",
			1,
		)
	if (args.evidence is None) != (args.grade is None):
		fail(
			"notebook.py: --grade is required exactly when --evidence is given",
			1,
		)
	if args.supports is not None and args.type != "observation":
		fail(
			"notebook.py: --supports is only accepted with --observation -- an "
			"evidence-to-hypothesis link rides an observation's evidence",
			1,
		)
	for flag, value in (("--on", args.on), ("--supports", args.supports)):
		if value is not None and not REF_RE.match(value):
			fail(
				f"notebook.py: {flag} must name a hypothesis id (hyp-NNNN), "
				f"got: {value}",
				1,
			)
	return args


def main(argv: list[str] | None = None) -> int:
	require_python()
	args = parse_args(argv)
	if THETA_DIR.exists() and not THETA_DIR.is_dir():
		fail("notebook.py: .theta exists but is not a directory", 2)
	try:
		item = None
		snapshot = None
		if args.evidence is not None:
			evidence_text = read_evidence(args.evidence)
			item = parse_evidence(evidence_text)
			item["grade"] = args.grade
			digest = hashlib.sha256(evidence_text.encode("utf-8")).hexdigest()
			item["snapshot"] = f"evidence/{digest}.json"
			if args.supports is not None:
				item["supports"] = args.supports
			snapshot = (f"{digest}.json", evidence_text)
		entries = load_notebook()
		resolve_ref(entries, args.on, "--on")
		resolve_ref(entries, args.supports, "--supports")
		entry = {
			"id": next_id(args.type, entries),
			"type": args.type,
			"date": date.today().isoformat(),
		}
		if args.type == "confidence":
			entry["hypothesis"] = args.on
		entry["text"] = args.text
		if args.type == "observation":
			entry["grade"] = args.grade
		if item is not None:
			entry["evidence"] = [item]
		write_entry(entry, snapshot)
	except RecorderError as error:
		fail(str(error), error.exit_code)
	if args.json:
		emit(entry)
	else:
		print_text(entry)
	return 0


def print_text(entry: dict) -> None:
	print(f"recorded {entry['id']} ({entry['type']}) in {NOTEBOOK_PATH}")
	if entry["type"] == "confidence":
		print(f"# judgment on {entry['hypothesis']}")
	if entry["type"] == "observation":
		print(f"# grade: {entry['grade']}")
		supports = entry["evidence"][0].get("supports")
		if supports is not None:
			print(f"# supports: {supports}")
	if "evidence" in entry:
		item = entry["evidence"][0]
		print(
			f"# evidence: {item['source']} via {', '.join(item['endpoints'])}; "
			f"retrieved {item['retrieved']}; grade {item['grade']}"
		)
		print(f"# snapshot: {item['snapshot']}")


if __name__ == "__main__":
	raise SystemExit(main())
