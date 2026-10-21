"""The argument guard: what may become a Slurm argument at all (spec #49).

The audit middleware calls the guard before dispatching a tool; a refusal
raises GuardRefusal, records as DENY, and never reaches a subprocess or a
file. A Slurm-side failure is not a refusal — it stays a SlurmError and
records as an allowed call that failed.

S2 grows the guard from digits-only job ids to the full pre-dispatch
policy (spec #49): run names, staged-path shapes and the path sandbox,
the in-band cap, and the command guard — the allow-listed sbatch keys a
submit_job may set, each inside a ceiling. Everything here is decidable
from the arguments plus read-only filesystem lookups (symlink
containment); refusals that need a call to run first (a non-owned job's
cancel) belong to the tool, not the guard.
"""

from __future__ import annotations

import base64
import binascii
import math
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

#: Slurm job ids as the gateway accepts them: plain digits in v1 (spec #49).
_JOB_ID = re.compile(r"\d+")

#: Run names: one run's identity, and its directory name under the staging
#: root. No dots, no slashes — nothing that could shape a path.
_RUN_NAME = re.compile(r"[A-Za-z0-9_-]{1,64}")

#: Directive values are written into the rendered script file: one token
#: of safe characters, nothing that could end an #SBATCH line early.
_DIRECTIVE_VALUE = re.compile(r"[A-Za-z0-9_.:+,%-]+")

#: The sbatch keys a submit_job may set: scheduler sizing only (spec #49's
#: command guard). job-name, output, and error are gateway-forced; any
#: other key — and any script body — is refused: commands arrive with
#: templates (S3), never through the raw path.
SBATCH_KEYS = frozenset({"cpus-per-task", "gres", "mem", "ntasks", "partition", "time"})

#: gres in v1: whole GPUs only, gpu:N.
_GRES = re.compile(r"gpu:(\d+)")

#: --mem: a size with an optional Slurm suffix (K, M, G, T, P — powers of 1024).
_MEM = re.compile(r"(\d+)([KMGTP]?)(?:B)?", re.IGNORECASE)
_MEM_TO_MB = {"": 1.0, "K": 1 / 1024, "M": 1.0, "G": 1024.0, "T": 1024.0**2, "P": 1024.0**3}

#: --time: Slurm's compact forms — minutes, minutes:seconds, hours:minutes:
#: seconds, each optionally under a days- prefix.
_WALLTIME = re.compile(r"(?:(\d+)-)?(\d+)(?::(\d+))?(?::(\d+))?")

#: Plain integer directive values (ntasks, cpus-per-task).
_COUNT = re.compile(r"\d+")

#: job_logs tail size: between one line and the ceiling (vault spec: max 1000).
MAX_TAIL_LINES = 1000
DEFAULT_TAIL_LINES = 100


class GuardRefusal(Exception):
	"""The guard refused an argument before any subprocess ran."""


@dataclass(frozen=True)
class GuardLimits:
	"""What the guard needs beyond the arguments: the sandbox and the
	ceilings (all deploy-time facts, projected from Config)."""

	staging_root: Path
	inband_max_bytes: int
	partitions: tuple[str, ...]
	max_walltime_seconds: int
	max_mem_mb: int
	max_ntasks: int
	max_cpus_per_task: int
	max_gpus: int


def parse_job_id(raw: str) -> str:
	"""Accept a plain-digits Slurm job id or refuse it (DENY)."""
	if not _JOB_ID.fullmatch(raw):
		raise GuardRefusal(f"invalid job id {raw!r}: a v1 job id is digits only")
	return raw


def parse_run_name(raw: Any) -> str:
	"""Accept one run name or refuse it (DENY)."""
	if not isinstance(raw, str) or not _RUN_NAME.fullmatch(raw):
		raise GuardRefusal(f"invalid run name {raw!r}: 1-64 characters of letters, digits, '-' and '_'")
	return raw


def parse_tail_lines(raw: Any) -> int:
	"""Accept a job_logs tail size or refuse it (DENY)."""
	if isinstance(raw, bool) or not isinstance(raw, int):
		raise GuardRefusal(f"invalid tail_lines {raw!r}: expected an integer between 1 and {MAX_TAIL_LINES}")
	if not 1 <= raw <= MAX_TAIL_LINES:
		raise GuardRefusal(f"invalid tail_lines {raw}: expected an integer between 1 and {MAX_TAIL_LINES}")
	return raw


def parse_staged_path(raw: Any) -> str:
	"""Accept one path relative to the run directory, or refuse it (DENY).

	Absolute paths, empty segments, '.' and '..' all refuse here — the
	lexical half of the path sandbox. The containment half (symlinks that
	resolve outside the staging root) is resolve_in_sandbox.
	"""
	if not isinstance(raw, str) or not raw:
		raise GuardRefusal(f"invalid staged path {raw!r}: expected a non-empty relative path")
	segments = raw.split("/")
	bad = [segment for segment in segments if segment in ("", ".", "..")]
	if bad or "\x00" in raw:
		raise GuardRefusal(f"invalid staged path {raw!r}: relative paths inside the run directory only — no '/', '.', or '..' segments")
	return raw


def resolve_in_sandbox(root: Path, run_name: str, relative: str) -> Path:
	"""Resolve one staged path inside the staging root, or refuse it (DENY).

	Symlinks that already exist are followed and the resolved target must
	stay under the staging root — an escape (a planted link out of the
	tree) refuses rather than reads or writes outside.
	"""
	base = root.expanduser().resolve()
	resolved = (base / run_name / relative).resolve()
	if resolved != base and base not in resolved.parents:
		raise GuardRefusal(f"staged path {relative!r} resolves outside the staging root {base}")
	return resolved


def parse_walltime(raw: str) -> int:
	"""Parse a Slurm time value to seconds, or refuse it (DENY)."""
	match = _WALLTIME.fullmatch(raw)
	if match is None:
		raise GuardRefusal(f"invalid time {raw!r}: expected Slurm's minutes, minutes:seconds, hours:minutes:seconds, or a days- prefix form")
	days, first, second, third = match.groups()
	if days is not None:
		hours, minutes, seconds = int(first), int(second or 0), int(third or 0)
	elif third is not None:
		hours, minutes, seconds = int(first), int(second), int(third)
	elif second is not None:
		hours, minutes, seconds = 0, int(first), int(second)
	else:
		hours, minutes, seconds = 0, int(first), 0
	if minutes > 59 or seconds > 59:
		raise GuardRefusal(f"invalid time {raw!r}: minutes and seconds stay under 60")
	return ((int(days or 0) * 24 + hours) * 60 + minutes) * 60 + seconds


def parse_mem_mb(raw: str) -> int:
	"""Parse a Slurm --mem value to megabytes, or refuse it (DENY)."""
	match = _MEM.fullmatch(raw)
	if match is None:
		raise GuardRefusal(f"invalid mem {raw!r}: expected a size like 4096M or 64G")
	count = int(match.group(1))
	if count == 0:
		raise GuardRefusal(f"invalid mem {raw!r}: zero would mean 'the node's whole memory' — name a size")
	return math.ceil(count * _MEM_TO_MB[match.group(2).upper()])


def guard_directives(raw: Any, limits: GuardLimits) -> dict[str, str]:
	"""Check one submit_job's directives against the allow-list and the
	ceilings; return them ready to render. An absent or empty object is a
	valid trivial job (defaults only). Integer values are accepted and
	stringified — a client counts in numbers; everything else is a string."""
	if not isinstance(raw, dict):
		raise GuardRefusal(f"invalid directives {raw!r}: expected an object of sbatch keys to values")
	if not all(isinstance(key, str) for key in raw):
		raise GuardRefusal("invalid directives: keys are strings")
	if not all(isinstance(value, (str, int)) and not isinstance(value, bool) for value in raw.values()):
		raise GuardRefusal("invalid directives: values are strings or integers")
	refused = sorted(set(raw) - SBATCH_KEYS)
	if refused:
		raise GuardRefusal(
			f"directive keys refused: {', '.join(refused)} — the allow-list is {', '.join(sorted(SBATCH_KEYS))}; job-name, output, and error are gateway-forced"
		)
	checked: dict[str, str] = {}
	for key, value in raw.items():
		formed = value if isinstance(value, str) else str(value)
		if not _DIRECTIVE_VALUE.fullmatch(formed):
			raise GuardRefusal(f"directive {key}={value!r}: the value carries characters a script line must not")
		checked[key] = formed
	if "partition" in checked and checked["partition"] not in limits.partitions:
		allowed = ", ".join(limits.partitions)
		raise GuardRefusal(f"partition {checked['partition']!r} is not allowed here (allowed: {allowed})")
	if "time" in checked and parse_walltime(checked["time"]) > limits.max_walltime_seconds:
		raise GuardRefusal(f"time {checked['time']!r} is over the ceiling — at most {_format_seconds(limits.max_walltime_seconds)}")
	if "mem" in checked and parse_mem_mb(checked["mem"]) > limits.max_mem_mb:
		raise GuardRefusal(f"mem {checked['mem']!r} is over the ceiling — at most {limits.max_mem_mb} MB")
	if "ntasks" in checked and not _within(checked["ntasks"], limits.max_ntasks):
		raise GuardRefusal(f"ntasks {checked['ntasks']!r} is over the ceiling — at most {limits.max_ntasks}")
	if "cpus-per-task" in checked and not _within(checked["cpus-per-task"], limits.max_cpus_per_task):
		raise GuardRefusal(f"cpus-per-task {checked['cpus-per-task']!r} is over the ceiling — at most {limits.max_cpus_per_task}")
	if "gres" in checked:
		match = _GRES.fullmatch(checked["gres"])
		if match is None or not 1 <= int(match.group(1)) <= limits.max_gpus:
			raise GuardRefusal(f"gres {checked['gres']!r} is not allowed — whole GPUs only, gpu:N with N at most {limits.max_gpus}")
	return checked


def _within(raw: str, ceiling: int) -> bool:
	return _COUNT.fullmatch(raw) is not None and 1 <= int(raw) <= ceiling


def _format_seconds(total: int) -> str:
	hours, seconds = divmod(total, 3600)
	return f"{hours // 24}-{hours % 24:02d}:{seconds // 60:02d}:{seconds % 60:02d}"


def guard_tool_arguments(tool: str, arguments: dict[str, Any], limits: GuardLimits) -> None:
	"""Refuse arguments that may not reach a Slurm argv or the staging
	tree, or return. The whole check is pre-dispatch: a refusal here is a
	DENY line and nothing has run."""
	if tool in ("job_status", "job_logs", "cancel_job"):
		raw = arguments.get("job_id")
		if not isinstance(raw, str):
			raise GuardRefusal(f"invalid job id {raw!r}: expected a string of digits")
		parse_job_id(raw)
	if tool == "job_logs" and arguments.get("tail_lines") is not None:
		parse_tail_lines(arguments["tail_lines"])
	if tool in ("stage_files", "submit_job", "fetch_artifacts"):
		run_name = parse_run_name(arguments.get("run_name"))
		if tool == "stage_files":
			_guard_stage_files(run_name, arguments.get("files"), limits)
		elif tool == "submit_job":
			guard_directives(arguments.get("directives") or {}, limits)
		else:
			_guard_fetch_paths(run_name, arguments.get("paths"), limits)
	# list_environments takes no arguments; nothing to guard.


def _guard_stage_files(run_name: str, raw_files: Any, limits: GuardLimits) -> None:
	"""The in-band cap and the path sandbox, checked before any write:
	decode everything, size the total, resolve every path — then the tool
	writes (or, on refusal here, nothing is written at all)."""
	if not isinstance(raw_files, list) or not raw_files:
		raise GuardRefusal("invalid files: a non-empty list of {path, content_b64} records")
	seen: set[str] = set()
	total = 0
	for entry in raw_files:
		if not isinstance(entry, dict):
			raise GuardRefusal(f"invalid file record {entry!r}: expected {{path, content_b64}}")
		path, content = entry.get("path"), entry.get("content_b64")
		if not isinstance(path, str) or not isinstance(content, str):
			raise GuardRefusal(f"invalid file record {entry!r}: path and content_b64 are strings")
		relative = parse_staged_path(path)
		if relative in seen:
			raise GuardRefusal(f"invalid file record: {relative!r} is staged twice in one call")
		seen.add(relative)
		resolve_in_sandbox(limits.staging_root, run_name, relative)
		try:
			total += len(base64.b64decode(content, validate=True))
		except (binascii.Error, ValueError) as error:
			raise GuardRefusal(f"invalid content_b64 for {relative!r}: {error}") from None
		if total > limits.inband_max_bytes:
			raise GuardRefusal(
				f"staged payload is over the in-band cap of {limits.inband_max_bytes} bytes — "
				f"stage out of band instead: scp the files to {limits.staging_root.expanduser() / run_name}/ on the cluster"
			)


def _guard_fetch_paths(run_name: str, raw_paths: Any, limits: GuardLimits) -> None:
	"""Explicit fetch picks: each a relative path inside the run directory."""
	if raw_paths is None:
		return
	if not isinstance(raw_paths, list) or not raw_paths or not all(isinstance(p, str) for p in raw_paths):
		raise GuardRefusal("invalid paths: a non-empty list of relative paths, or omit it to fetch the whole run directory")
	for raw in raw_paths:
		resolve_in_sandbox(limits.staging_root, run_name, parse_staged_path(raw))
