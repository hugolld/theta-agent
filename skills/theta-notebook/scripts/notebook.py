#!/usr/bin/env python3
"""Project notebook recorder: one dated provenance entry per call (ADR 0003).

The notebook lives in the research project's workspace -- a `.theta/`
directory holding `notebook.jsonl` (one JSON entry per line, append-only)
and `evidence/` (sha256-addressed snapshots). Each call records one of the
five entry types -- hypothesis, method, observation, decision, confidence --
with ids sequenced per type so later entries can link to them. An entry that
carries evidence stores the evidence source's structured output verbatim as
its content-addressed snapshot -- a theta-lit-search `--json` output (the
connector's final output: already redacted, already dated; raw HTTP bodies
are never kept) or an assembled theta-compute job record (M4, ADR 0004). A
grade is required exactly when evidence is recorded, and the observation
entry carries it as its own field: a grade rates the source, never the
researcher's judgment -- that judgment is the confidence entry type, and the
two never merge.

Exit codes -- the documented contract (see SKILL.md):
  0  success; the entry is appended and named on stdout, or the plan
     operation reports the plan's path and revision
  1  usage error (bad arguments, malformed or shape-invalid evidence input,
     a link that names no hypothesis in the notebook, a malformed plan slug
     or plan-id, a same-day plan collision, a malformed plan citation, a
     plan-id naming no written plan, or a citation revision stale against
     the plan on disk)
  2  notebook failure (the notebook or a stored plan file cannot be read
     or written)

Usage:
  python3 notebook.py --hypothesis "TEXT" --evidence <connector-output.json|->
      --grade {asserted,cross-checked,re-executed} [--json]
  python3 notebook.py --method "TEXT" [--evidence <...> --grade <...>] [--json]
  python3 notebook.py --observation "TEXT" --evidence <...> --grade <...>
      [--supports hyp-NNNN] [--json]
  python3 notebook.py --decision "TEXT" [--evidence <...> --grade <...>] [--json]
  python3 notebook.py --decision "TEXT" --plan-cite <date>-<slug> --revision <12-hex>
      --verdict {approved,refused} [--rationale "TEXT"] [--json]
  python3 notebook.py --confidence "TEXT" --on hyp-NNNN [--json]
  python3 notebook.py --method "TEXT" --job-record <job-record.json|->
      --grade {asserted,re-executed} [--json]
  python3 notebook.py --plan-write <slug> --plan-file <plan.md|-> [--json]
  python3 notebook.py --plan-update <date>-<slug> --plan-file <plan.md|-> [--json]
  python3 notebook.py --plan-read <date>-<slug> [--json]
  python3 notebook.py --plan-decision <date>-<slug> --revision <12-hex> [--json]

`--evidence` is required for hypothesis and observation entries, optional
for method and decision, and rejected for confidence (a judgment is not a
source claim). `--on` and `--supports` must name a hypothesis entry already
in the notebook.

`--job-record` records a compute run: the evidence item is the job record
the session assembles from the theta-compute answers -- job ID, gateway,
run name, template (null for a raw submit), argument digest, final state,
observed date, and the artifact manifest when the artifacts were fetched
(paths and sizes, never file contents). It is mutually exclusive with
`--evidence` -- one evidence item per call -- and shares the pairing rule:
`--grade` is required exactly when either is given, and the record's grades
are `asserted` and `re-executed` (cross-checked is a retrieval's mark). The
grade `re-executed` claims the machinery recomputed the result, so the
recorder accepts it only when the record carries the artifact manifest.

Plan operations (parent #200) carry no evidence semantics -- the plan is a
document, not a graded claim. `--plan-write` creates
`.theta/plans/<YYYY-MM-DD>-<slug>.md` (the slug: 1-48 characters of
lowercase letters, digits, and single hyphens) and refuses a slug that
already names a plan today -- a same-day collision never clobbers.
`--plan-update` overwrites the named plan-id with new Markdown: the
plan-id is immutable, and the new content is a new revision. `--plan-read`
reports the path and the current revision digest. The revision digest is
the first 12 hex of sha256 over the file bytes -- a changed digest is a
new revision, and a researcher's hand edit is a new revision, not an
error: the recorder is the loop's writer, not the file's owner. The
recipe is a cross-language contract (the committed test vector), so the
TS side of the plan object computes the same revision.

A decision entry may cite the plan it weighs (parent #200's T2):
`--decision "TEXT" --plan-cite <plan-id> --revision <12-hex> --verdict
approved` stores `planPath` (`.theta/plans/<plan-id>.md`, the path
`--plan-read` names), `planRevision` (the digest the decision weighs),
`decision` (approved or refused -- both verdicts record, a refusal cites
the plan the same way), and an optional `--rationale` as `rationale`.
The citation resolves against disk before anything is written: the
plan-id must name a written plan and the revision must be that file's
current digest -- missing or stale is exit 1, never an entry, so a
recorded decision always names a revision the plan carried when the
decision was made. `--plan-decision <plan-id> --revision <12-hex>` reads
the notebook back: the latest decision entry citing that plan path and
revision, or a clear no-decision report.

Contract basis: docs/adr/0003-provenance-is-a-project-notebook.md,
docs/adr/0004-compute-is-a-native-mcp-server.md, and the connector-script
invariants (docs/agents/connector-scripts.md).
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
PLANS_DIR = THETA_DIR / "plans"

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
#: through as the evidence item's retrieval date. `calendar_date` adds the
#: calendar check on top of this shape check.
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

#: A job record's identity shapes (ADR 0004): Slurm ids are digits, a run
#: name follows the gateway guard's own rule (1-64 of letters, digits, '-'
#: and '_'), and the argument digest is a sha256 hex string.
JOB_ID_RE = re.compile(r"^\d+$")
RUN_NAME_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
DIGEST_RE = re.compile(r"^[0-9a-f]{64}$")

#: The plan object's naming grammar (parent #200, spec #201): a plan-id is
#: the recording date plus a short kebab slug -- sortable, grep-able, no
#: UUID noise. The slug is lowercase letters, digits, and single hyphens
#: (a leading, trailing, or doubled hyphen is not a slug), capped at 48 so
#: the date-prefixed file name stays readable; the date half must name a
#: real calendar date, the same check `calendar_date` applies to entries.
PLAN_SLUG_MAX = 48
PLAN_SLUG_RE = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")
PLAN_ID_RE = re.compile(r"^(\d{4}-\d{2}-\d{2})-([a-z0-9]+(?:-[a-z0-9]+)*)$")

#: A plan citation's revision shape (spec #202): 12 lowercase hex digits,
#: the digest every plan operation reports as `revision` -- the revision a
#: decision entry weighs and a decision read takes.
PLAN_REV_RE = re.compile(r"^[0-9a-f]{12}$")

#: The two verdicts a plan-citing decision records (parent #200): both are
#: provenance -- an approval and a refusal cite the plan the same way.
VERDICTS = ("approved", "refused")

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


def calendar_date(text: str) -> bool:
	"""True when a YYYY-MM-DD string names a real calendar date.

	Shape alone is not enough: the dogfood auditor judges retrieval dates
	calendar-valid, and the recorder must refuse what the audit would --
	a written entry cannot be un-written from an append-only file.
	"""
	if not DATE_RE.match(text):
		return False
	try:
		date.fromisoformat(text)
	except ValueError:
		return False
	return True


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
		".theta/, storing the evidence source's structured output as a "
		"content-addressed evidence item when the entry carries evidence.",
	)
	# The entry types are one mutually exclusive family and the plan
	# operations another; neither family is required at the argparse layer,
	# because one call must carry exactly one operation across both --
	# checked below, where the refusal can name both families.
	types = parser.add_mutually_exclusive_group()
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
		"--job-record",
		metavar="PATH|-",
		help="path to an assembled theta-compute job record (one run's "
		"answers: job ID, gateway, template, argument digest, artifact "
		"manifest, final state), or - to read it from stdin; the evidence "
		"item recording a compute run; mutually exclusive with --evidence",
	)
	parser.add_argument(
		"--grade",
		choices=GRADES,
		help="the evidence grade carried by the recorded evidence item -- and "
		"by the observation entry itself; required exactly when --evidence or "
		"--job-record is given (a trust mark on a source is a decision, never "
		"an accident)",
	)
	parser.add_argument(
		"--supports",
		metavar="hyp-NNNN",
		help="mark the recorded evidence as supporting this existing "
		"hypothesis; observation entries only",
	)
	parser.add_argument(
		"--plan-cite",
		metavar="PLAN_ID",
		help="cite the named plan in the recorded decision entry -- decision "
		"entries only; requires --revision and --verdict, and stores "
		"planPath, planRevision, and decision on the entry",
	)
	parser.add_argument(
		"--revision",
		metavar="12-HEX",
		help="the plan revision the decision weighs -- required with "
		"--plan-cite and --plan-decision, refused elsewhere",
	)
	parser.add_argument(
		"--verdict",
		choices=VERDICTS,
		help="the verdict on the cited plan, stored as the entry's decision "
		"field -- approved or refused; required with --plan-cite",
	)
	parser.add_argument(
		"--rationale",
		help="free-text rationale on a plan-citing decision; optional, "
		"and only with --plan-cite",
	)
	plans = parser.add_mutually_exclusive_group()
	plans.add_argument(
		"--plan-write",
		metavar="SLUG",
		help="write a new plan file .theta/plans/<date>-<slug>.md from "
		"--plan-file's Markdown; refuses a slug that already names a plan "
		"today (a same-day collision never clobbers)",
	)
	plans.add_argument(
		"--plan-update",
		metavar="PLAN_ID",
		help="overwrite the named plan with --plan-file's Markdown -- the "
		"plan-id is immutable, the new content is a new revision; the report "
		"names the revision it replaces",
	)
	plans.add_argument(
		"--plan-read",
		metavar="PLAN_ID",
		help="report the named plan's path and its current revision digest "
		"-- the file's own bytes decide, so a hand edit reads as a new "
		"revision",
	)
	plans.add_argument(
		"--plan-decision",
		metavar="PLAN_ID",
		help="report the latest decision entry citing the named plan at "
		"--revision's digest -- a notebook read; the entry, or a clear "
		"no-decision report",
	)
	parser.add_argument(
		"--plan-file",
		metavar="PATH|-",
		help="path to the plan's Markdown, or - to read it from stdin; "
		"required with --plan-write and --plan-update, not accepted with "
		"--plan-read or an entry type",
	)
	parser.add_argument(
		"--json",
		action="store_true",
		help="print the appended entry (or the plan result) as JSON",
	)
	return parser


def read_text_input(spec: str, flag: str) -> str:
	"""A text input's bytes as UTF-8 text, file or stdin (`-`).

	Reads `--evidence`, `--job-record`, and `--plan-file` alike: an
	unreadable or empty input is a usage refusal naming the flag. The
	text-mode read carries no CRLF through -- line endings land as LF --
	which the plan write's as-read contract states.
	"""
	if spec == "-":
		text = sys.stdin.read()
		origin = "stdin"
	else:
		origin = spec
		try:
			text = Path(spec).read_text(encoding="utf-8")
		except OSError as error:
			raise RecorderError(
				f"notebook.py: {flag} unreadable: {origin}: {error}", 1
			) from None
	if not text.strip():
		raise RecorderError(f"notebook.py: {flag} is empty: {origin}", 1)
	return text


def read_payload(text: str, flag: str, what: str) -> dict:
	"""Parse the evidence text as a JSON object, or refuse it as usage."""
	try:
		payload = json.loads(text)
	except json.JSONDecodeError as error:
		raise RecorderError(
			f"notebook.py: {flag} is not valid JSON: {error}", 1
		) from None
	if not isinstance(payload, dict):
		raise RecorderError(
			f"notebook.py: {flag} must be a JSON object -- {what}",
			1,
		)
	return payload


def field_str(container: dict, key: str, message: str) -> str:
	"""One non-empty string field, or a usage refusal naming `message`."""
	value = container.get(key)
	if not isinstance(value, str) or not value:
		raise RecorderError(f"notebook.py: {message}", 1)
	return value


def field_date(container: dict, key: str, message: str) -> str:
	"""One calendar-date string field, or a usage refusal naming `message`."""
	value = container.get(key)
	if not isinstance(value, str) or not calendar_date(value):
		raise RecorderError(f"notebook.py: {message}", 1)
	return value


def field_uint(container: dict, key: str, message: str) -> int | None:
	"""One optional non-negative integer field, or a usage refusal.

	A JSON `true`/`false` is not an integer even though Python's bool
	subclasses int -- the manifest's counts refuse it like any other type.
	"""
	value = container.get(key)
	if value is not None and (
		isinstance(value, bool) or not isinstance(value, int) or value < 0
	):
		raise RecorderError(f"notebook.py: {message}", 1)
	return value


def parse_evidence(text: str) -> dict:
	"""Validate the connector output and extract the evidence item fields.

	Typed shape checks, not presence-only (the connector-script invariant): a
	`provenance.calls` of any other type, or an `accessed` that is not a date
	string, is a malformed input, never a sparse evidence item.
	"""
	payload = read_payload(
		text, "--evidence", "a connector's structured output (--json)"
	)
	source = field_str(
		payload, "source", "--evidence lacks a non-empty string 'source'"
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
		endpoint = field_str(
			call,
			"endpoint",
			"every provenance call needs a non-empty string 'endpoint'",
		)
		field_str(
			call,
			"url",
			"every provenance call needs a non-empty string 'url'",
		)
		if endpoint not in endpoints:
			endpoints.append(endpoint)
	accessed = field_date(
		provenance,
		"accessed",
		"--evidence provenance.accessed must be a real YYYY-MM-DD calendar date",
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


def refuse_manifest_contents(where: str) -> NoReturn:
	"""The job record holds the artifact manifest, never the payloads."""
	raise RecorderError(
		f"notebook.py: --job-record artifacts must not carry file contents "
		f"('content_b64' in {where}) -- the record holds paths and sizes; the "
		"bytes stay on the cluster and in the fetched workspace",
		1,
	)


def validate_manifest(artifacts: object, run_name: str) -> dict:
	"""The fetched-artifact manifest of a job record, validated.

	The gateway's fetch answer carries each file's bytes base64-encoded; the
	job record keeps the manifest shape only -- paths and sizes -- so a
	snapshot never re-stores payloads the cluster already holds. The
	manifest's run, when named, must be the record's own run.
	"""
	if not isinstance(artifacts, dict):
		raise RecorderError(
			"notebook.py: --job-record 'artifacts', when present, must be an object",
			1,
		)
	if "content_b64" in artifacts:
		refuse_manifest_contents("the artifacts object")
	files = artifacts.get("files")
	if not isinstance(files, list) or not files:
		raise RecorderError(
			"notebook.py: --job-record artifacts.files must be a non-empty list", 1
		)
	for entry in files:
		if not isinstance(entry, dict):
			raise RecorderError(
				"notebook.py: every artifacts.files entry must be an object", 1
			)
		if "content_b64" in entry:
			refuse_manifest_contents("a files entry")
		field_str(
			entry,
			"path",
			"every artifacts.files entry needs a non-empty string 'path'",
		)
		field_uint(
			entry,
			"size",
			"--job-record artifacts file 'size', when present, must be a "
			"non-negative integer",
		)
	field_uint(
		artifacts,
		"total_bytes",
		"--job-record artifacts 'total_bytes', when present, must be a "
		"non-negative integer",
	)
	fetched_run = artifacts.get("run_name")
	if fetched_run is not None and fetched_run != run_name:
		raise RecorderError(
			f"notebook.py: --job-record artifacts.run_name {fetched_run!r} does "
			f"not match the record's run_name {run_name!r}",
			1,
		)
	return artifacts


def parse_job_record(text: str) -> dict:
	"""Validate the assembled gateway job record and extract the item fields.

	The mirror of parse_evidence for the compute path (ADR 0004): the record
	the session assembles from the theta-compute answers must carry the job's
	identity in full -- job ID, gateway, run name, template (null for a raw
	submit), argument digest, final state -- and the day the state was
	observed, which rides through as the item's retrieval date. Typed shape
	checks, not presence-only; the artifact manifest, when fetched, is
	validated by validate_manifest.
	"""
	payload = read_payload(
		text, "--job-record", "an assembled theta-compute job record"
	)
	source = field_str(
		payload, "gateway", "--job-record lacks a non-empty string 'gateway'"
	)
	job_id = payload.get("job_id")
	if not isinstance(job_id, str) or not JOB_ID_RE.match(job_id):
		raise RecorderError(
			"notebook.py: --job-record 'job_id' must be a string of digits", 1
		)
	run_name = payload.get("run_name")
	if not isinstance(run_name, str) or not RUN_NAME_RE.match(run_name):
		raise RecorderError(
			"notebook.py: --job-record 'run_name' must be 1-64 characters of "
			"letters, digits, '-' and '_'",
			1,
		)
	if "template" not in payload:
		raise RecorderError(
			"notebook.py: --job-record must carry 'template' (null for a raw "
			"submit that runs no registered template)",
			1,
		)
	template = payload["template"]
	if template is not None and (not isinstance(template, str) or not template):
		raise RecorderError(
			"notebook.py: --job-record 'template' must be a non-empty name or "
			"null (a raw submit runs no template)",
			1,
		)
	digest = payload.get("arguments_digest")
	if not isinstance(digest, str) or not DIGEST_RE.match(digest):
		raise RecorderError(
			"notebook.py: --job-record 'arguments_digest' must be a 64-character "
			"sha256 hex digest",
			1,
		)
	state = payload.get("state")
	# A state copied from a gateway answer is never whitespace-only; unlike
	# entry text it is stored verbatim, so only the emptiness is checked.
	if not isinstance(state, str) or not state.strip():
		raise RecorderError(
			"notebook.py: --job-record lacks a non-empty string 'state'", 1
		)
	item = {
		"source": source,
		"job_id": job_id,
		"template": template,
		"arguments_digest": digest,
		"state": state,
	}
	artifacts = payload.get("artifacts")
	if artifacts is not None:
		item["artifacts"] = validate_manifest(artifacts, run_name)
	item["retrieved"] = field_date(
		payload,
		"observed",
		"--job-record 'observed' must be a real YYYY-MM-DD calendar date",
	)
	return item


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


#: The three plan operations, as the CLI spells them, with the value each
#: one carries (the slug a write coins, the plan-id the other two name).
PLAN_OPS = {
	"--plan-write": "plan_write",
	"--plan-update": "plan_update",
	"--plan-read": "plan_read",
	"--plan-decision": "plan_decision",
}


def plan_op_of(args: argparse.Namespace) -> str | None:
	"""The plan operation this call carries, if any (checked before types)."""
	for flag, dest in PLAN_OPS.items():
		if getattr(args, dest) is not None:
			return flag
	return None


def parse_plan_args(args: argparse.Namespace, plan_op: str) -> argparse.Namespace:
	"""Validate a plan operation's flags; plan ops carry plan text only.

	One operation per call: a plan flag beside an entry type refuses, and
	the entry-only flags (evidence, grades, links, the decision citation)
	refuse with every plan operation -- a plan is a document, not a graded
	claim. The slug, plan-id, and revision grammar checks sit in run_plan_op,
	where the shared RecorderError-to-exit translation already lives.
	"""
	if any(getattr(args, t) is not None for t in TYPE_PREFIX):
		fail(
			f"notebook.py: {plan_op} is not accepted with an entry type -- one "
			"operation per call",
			1,
		)
	for dest in (
		"evidence",
		"job_record",
		"grade",
		"on",
		"supports",
		"plan_cite",
		"verdict",
		"rationale",
	):
		if getattr(args, dest) is not None:
			flag = f"--{dest.replace('_', '-')}"
			fail(
				f"notebook.py: {flag} is not accepted with {plan_op}; plan "
				"operations carry plan text only",
				1,
			)
	if plan_op in ("--plan-read", "--plan-decision"):
		if args.plan_file is not None:
			fail(f"notebook.py: --plan-file is not accepted with {plan_op}", 1)
	else:
		if args.plan_file is None:
			fail(
				f"notebook.py: {plan_op} requires --plan-file (path or -) "
				"carrying the plan's Markdown",
				1,
			)
	if plan_op == "--plan-decision":
		if args.revision is None:
			fail(
				"notebook.py: --plan-decision requires --revision naming the "
				"revision whose decision it reports",
				1,
			)
	elif args.revision is not None:
		fail(
			"notebook.py: --revision is only accepted with --plan-cite or "
			"--plan-decision",
			1,
		)
	args.plan_op = plan_op
	return args


def parse_args(argv: list[str] | None) -> argparse.Namespace:
	args = build_parser().parse_args(argv)
	plan_op = plan_op_of(args)
	if plan_op is not None:
		return parse_plan_args(args, plan_op)
	if not any(getattr(args, t) is not None for t in TYPE_PREFIX):
		fail(
			"notebook.py: one entry type (--hypothesis, --method, "
			"--observation, --decision, --confidence) or plan operation "
			"(--plan-write, --plan-update, --plan-read) is required",
			1,
		)
	if args.plan_file is not None:
		fail(
			"notebook.py: --plan-file is only accepted with --plan-write or "
			"--plan-update",
			1,
		)
	args.type = next(t for t in TYPE_PREFIX if getattr(args, t) is not None)
	args.text = collapse_ws(getattr(args, args.type))
	if not args.text:
		fail(f"notebook.py: --{args.type} must be non-empty text", 1)
	# Confidence is judgment, not a source claim: no evidence, a named subject.
	if args.type == "confidence":
		if args.evidence is not None or args.job_record is not None:
			fail(
				"notebook.py: --evidence and --job-record are not accepted with "
				"--confidence; a judgment is not a source claim",
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
	if args.evidence is not None and args.job_record is not None:
		fail(
			"notebook.py: --evidence and --job-record are mutually exclusive -- "
			"one evidence item per call",
			1,
		)
	has_evidence = args.evidence is not None or args.job_record is not None
	if args.type in ("hypothesis", "observation") and not has_evidence:
		fail(
			f"notebook.py: --{args.type} requires --evidence or --job-record -- "
			"a hypothesis or an observation is a claim about what a source "
			"showed",
			1,
		)
	if has_evidence != (args.grade is not None):
		fail(
			"notebook.py: --grade is required exactly when --evidence or "
			"--job-record is given",
			1,
		)
	if args.job_record is not None and args.grade == "cross-checked":
		fail(
			"notebook.py: --grade cross-checked is not accepted with "
			"--job-record; a job record is graded asserted or re-executed",
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
	cite_touched = [
		dest
		for dest in ("plan_cite", "revision", "verdict", "rationale")
		if getattr(args, dest) is not None
	]
	if cite_touched:
		if args.type != "decision":
			flags = ", ".join(f"--{dest.replace('_', '-')}" for dest in cite_touched)
			fail(
				f"notebook.py: {flags} only accepted with --decision -- the "
				"plan citation rides a decision entry",
				1,
			)
		if args.plan_cite is None:
			fail(
				"notebook.py: --plan-cite is required with --revision, "
				"--verdict, and --rationale -- the citation is the "
				"decision's object",
				1,
			)
		if args.revision is None:
			fail(
				"notebook.py: --plan-cite requires --revision naming the "
				"revision the decision weighs",
				1,
			)
		if args.verdict is None:
			fail(
				"notebook.py: --plan-cite requires --verdict "
				"(approved or refused)",
				1,
			)
		if args.rationale is not None and not collapse_ws(args.rationale):
			fail("notebook.py: --rationale must be non-empty text", 1)
	return args


def plan_revision(data: bytes) -> str:
	"""The first 12 hex of sha256 over the plan file's bytes.

	The plan's revision -- distinct from evidence snapshots' full sha256
	content addressing -- and a cross-language contract: the TS side of the
	plan object passes the same committed test vector, so both languages
	compute one revision for one plan. A changed digest is a new revision.
	"""
	return hashlib.sha256(data).hexdigest()[:12]


def check_plan_slug(slug: str) -> None:
	"""The write path's slug grammar, or the usage refusal naming it."""
	if len(slug) > PLAN_SLUG_MAX or not PLAN_SLUG_RE.match(slug):
		raise RecorderError(
			f"notebook.py: --plan-write slug must be 1-{PLAN_SLUG_MAX} characters "
			"of lowercase letters, digits, and single hyphens (a leading, "
			f"trailing, or doubled hyphen is not a slug), got: {slug!r}",
			1,
		)


def check_plan_id(plan_id: str) -> None:
	"""The read/update path's plan-id grammar: a calendar date plus a slug."""
	match = PLAN_ID_RE.match(plan_id)
	if match is None or len(match.group(2)) > PLAN_SLUG_MAX or not calendar_date(
		match.group(1)
	):
		raise RecorderError(
			f"notebook.py: plan ids are <YYYY-MM-DD>-<slug> -- a real calendar "
			"date and a lowercase kebab slug, as --plan-write names it on "
			f"stdout, got: {plan_id!r}",
			1,
		)


def check_plan_revision(revision: str) -> None:
	"""The citation's revision shape: 12 lowercase hex digits, the digest
	every plan operation reports."""
	if not PLAN_REV_RE.match(revision):
		raise RecorderError(
			"notebook.py: --revision must be 12 lowercase hex digits -- the "
			"revision digest every plan operation reports, got: "
			f"{revision!r}",
			1,
		)


def resolve_plan_citation(args: argparse.Namespace) -> str:
	"""A decision's plan citation, resolved against disk before any write.

	Returns the planPath the entry stores. The honesty the citation stands
	on: the plan-id must name a written plan, and the cited revision must
	be that file's current digest -- a citation naming no plan, or a stale
	one naming a revision the plan no longer carries, would record a
	decision about a plan state that does not exist. Either is a usage
	refusal, never an entry. Both verdicts resolve the same way: a refusal
	cites the revision it refused, while that revision is current.
	"""
	check_plan_id(args.plan_cite)
	check_plan_revision(args.revision)
	plan_path = f"{PLANS_DIR}/{args.plan_cite}.md"
	current = plan_revision(read_plan(args.plan_cite))
	if args.revision != current:
		raise RecorderError(
			f"notebook.py: --revision {args.revision} is stale for {plan_path} "
			f"-- the plan's current revision is {current}; cite the revision "
			"--plan-read names",
			1,
		)
	return plan_path


def read_plan(plan_id: str) -> bytes:
	"""An existing plan file's bytes, or the refusal that names why not."""
	plan_path = PLANS_DIR / f"{plan_id}.md"
	try:
		return plan_path.read_bytes()
	except FileNotFoundError:
		raise RecorderError(
			f"notebook.py: no plan {plan_id} in {PLANS_DIR} -- the id a write "
			"names on stdout is the id a read or update takes",
			1,
		) from None
	except OSError as error:
		raise RecorderError(
			f"notebook.py: cannot read {plan_path}: {error}", 2
		) from None


def write_plan(plan_path: Path, text: str) -> None:
	"""Write the plan's text as exact UTF-8 bytes, creating the directory.

	Bytes, not text mode: no platform newline translation anywhere, so the
	revision digest's input is exactly what lands on disk.
	"""
	try:
		PLANS_DIR.mkdir(parents=True, exist_ok=True)
		plan_path.write_bytes(text.encode("utf-8"))
	except OSError as error:
		raise RecorderError(
			f"notebook.py: cannot write {plan_path}: {error}", 2
		) from None


def run_plan_op(args: argparse.Namespace) -> dict:
	"""One plan operation: write, update, read, or the decision read.

	The plan text is read and every grammar check fires before anything is
	touched, so a rejected input leaves no trace. The text is written as
	read -- no reformatting, no added newline; line endings land as LF (the
	text-mode read carries no CRLF through) -- and the revision digest is
	computed over exactly the bytes on disk. The decision read touches no
	plan bytes at all: it queries the notebook for the latest decision
	entry citing the named plan at the given revision, in file order --
	append-only, so file order is recording order.
	"""
	if args.plan_op == "--plan-decision":
		check_plan_id(args.plan_decision)
		check_plan_revision(args.revision)
		plan_path = f"{PLANS_DIR}/{args.plan_decision}.md"
		latest = None
		for entry in load_notebook():
			if (
				entry.get("type") == "decision"
				and entry.get("planPath") == plan_path
				and entry.get("planRevision") == args.revision
			):
				latest = entry
		return {"planPath": plan_path, "planRevision": args.revision, "latest": latest}
	if args.plan_op == "--plan-read":
		check_plan_id(args.plan_read)
		data = read_plan(args.plan_read)
		return {
			"plan": args.plan_read,
			"revision": plan_revision(data),
			"path": f"{PLANS_DIR}/{args.plan_read}.md",
		}
	text = read_text_input(args.plan_file, "--plan-file")
	if args.plan_op == "--plan-write":
		check_plan_slug(args.plan_write)
		plan_id = f"{date.today().isoformat()}-{args.plan_write}"
		plan_path = PLANS_DIR / f"{plan_id}.md"
		if plan_path.exists():
			raise RecorderError(
				f"notebook.py: plan {plan_id} already exists -- a same-day "
				"collision never clobbers; write a different slug, or "
				f"--plan-update {plan_id} to revise the recorded plan",
				1,
			)
		if not THETA_DIR.is_dir():
			raise RecorderError(
				"notebook.py: .theta is absent -- create the project's .theta "
				"before the first plan (an evidenced record creates it too)",
				2,
			)
		write_plan(plan_path, text)
		return {
			"plan": plan_id,
			"revision": plan_revision(text.encode("utf-8")),
			"path": f"{PLANS_DIR}/{plan_id}.md",
		}
	check_plan_id(args.plan_update)
	previous = plan_revision(read_plan(args.plan_update))
	write_plan(PLANS_DIR / f"{args.plan_update}.md", text)
	return {
		"plan": args.plan_update,
		"revision": plan_revision(text.encode("utf-8")),
		"previous_revision": previous,
		"path": f"{PLANS_DIR}/{args.plan_update}.md",
	}


def print_plan(result: dict, plan_op: str) -> None:
	"""Report the plan path and its revision, connector-footer style."""
	if plan_op == "--plan-decision":
		latest = result["latest"]
		if latest is None:
			print(
				f"no decision for {result['planPath']} revision "
				f"{result['planRevision']}"
			)
		else:
			print(
				f"decision {latest.get('decision')} for {result['planPath']} "
				"revision "
				f"{result['planRevision']} ({latest.get('id')})"
			)
		return
	line = f"plan {result['path']} revision {result['revision']}"
	previous = result.get("previous_revision")
	if previous is not None:
		line += f" (was {previous})"
	verb = {"--plan-write": "wrote", "--plan-update": "updated"}.get(plan_op)
	print(f"{verb} {line}" if verb else line)


def main(argv: list[str] | None = None) -> int:
	require_python()
	args = parse_args(argv)
	if THETA_DIR.exists() and not THETA_DIR.is_dir():
		fail("notebook.py: .theta exists but is not a directory", 2)
	if getattr(args, "plan_op", None) is not None:
		try:
			result = run_plan_op(args)
		except RecorderError as error:
			fail(str(error), error.exit_code)
		if args.json:
			emit(result)
		else:
			print_plan(result, args.plan_op)
		return 0
	try:
		item = None
		snapshot = None
		evidence_text = ""
		if args.evidence is not None:
			evidence_text = read_text_input(args.evidence, "--evidence")
			item = parse_evidence(evidence_text)
		elif args.job_record is not None:
			evidence_text = read_text_input(args.job_record, "--job-record")
			item = parse_job_record(evidence_text)
			# re-executed claims the machinery recomputed the result; the
			# claim stands on the fetched artifacts the manifest names.
			if args.grade == "re-executed" and item.get("artifacts") is None:
				raise RecorderError(
					"notebook.py: --grade re-executed needs the job record's "
					"artifact manifest -- fetch the artifacts first, or grade "
					"asserted",
					1,
				)
		if item is not None:
			item["grade"] = args.grade
			digest = hashlib.sha256(evidence_text.encode("utf-8")).hexdigest()
			item["snapshot"] = f"evidence/{digest}.json"
			if args.supports is not None:
				item["supports"] = args.supports
			snapshot = (f"{digest}.json", evidence_text)
		entries = load_notebook()
		resolve_ref(entries, args.on, "--on")
		resolve_ref(entries, args.supports, "--supports")
		plan_path = (
			resolve_plan_citation(args) if args.plan_cite is not None else None
		)
		entry = {
			"id": next_id(args.type, entries),
			"type": args.type,
			"date": date.today().isoformat(),
		}
		if args.type == "confidence":
			entry["hypothesis"] = args.on
		entry["text"] = args.text
		if plan_path is not None:
			entry["planPath"] = plan_path
			entry["planRevision"] = args.revision
			entry["decision"] = args.verdict
			if args.rationale is not None:
				entry["rationale"] = collapse_ws(args.rationale)
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
	if entry.get("planPath") is not None:
		print(
			f"# plan: {entry['planPath']} revision {entry['planRevision']} "
			f"{entry['decision']}"
		)
	if entry["type"] == "observation":
		print(f"# grade: {entry['grade']}")
		supports = entry["evidence"][0].get("supports")
		if supports is not None:
			print(f"# supports: {supports}")
	if "evidence" in entry:
		item = entry["evidence"][0]
		if "job_id" in item:
			template = item["template"]
			named = "no template" if template is None else f"template {template}"
			print(
				f"# evidence: {item['source']} job {item['job_id']} "
				f"{item['state']} ({named}); retrieved {item['retrieved']}; "
				f"grade {item['grade']}"
			)
			artifacts = item.get("artifacts")
			if artifacts is not None:
				counted = f"{len(artifacts['files'])} files"
				total = artifacts.get("total_bytes")
				if total is not None:
					counted += f", {total} bytes"
				print(f"# artifacts: {counted}")
		else:
			print(
				f"# evidence: {item['source']} via {', '.join(item['endpoints'])}; "
				f"retrieved {item['retrieved']}; grade {item['grade']}"
			)
		print(f"# snapshot: {item['snapshot']}")


if __name__ == "__main__":
	raise SystemExit(main())
