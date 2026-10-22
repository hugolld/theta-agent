"""The staging tree: one run directory per run under the staging root.

The guard (guard.py) has already refused everything policy refuses from
the arguments alone; this module is the filesystem half of that same
policy plus the transfers. Staging lands whole or not at all (every path
is resolved before any file is written); artifact fetches return whole or
not at all (every file is read and sized before the answer is built).
Every path passes through the guard's sandbox resolution again on its way
in — the tools re-run the pure parsers rather than trusting transit.
"""

from __future__ import annotations

import base64
import os
from pathlib import Path
from typing import Any

from .guard import (
	GuardRefusal,
	decode_b64,
	out_of_band_hint,
	parse_staged_path,
	resolve_in_sandbox,
	run_dir,
)

#: The batch script every submission writes into the run directory.
SCRIPT_NAME = "job.sbatch"

#: The log files the forced --output/--error directives put there
#: (Slurm expands %j to the job id at submission time).
STDOUT_NAME = "slurm-{job_id}.out"
STDERR_NAME = "slurm-{job_id}.err"


def stage_files(root: Path, run_name: str, files: list[dict[str, Any]]) -> list[dict[str, Any]]:
	"""Write the staged files into the run directory, whole or not at all.

	The guard already validated shapes, decoded sizes, and containment;
	this re-runs the shared parsers (transit is not trust) and then writes
	every file only after every path resolved.
	"""
	resolved: list[tuple[str, Path, bytes]] = []
	for entry in files:
		relative = parse_staged_path(entry["path"])
		target = resolve_in_sandbox(root, run_name, relative)
		resolved.append((relative, target, decode_b64(relative, entry["content_b64"])))
	staged = []
	for relative, target, content in resolved:
		target.parent.mkdir(parents=True, exist_ok=True)
		target.write_bytes(content)
		staged.append({"path": relative, "bytes": len(content)})
	return staged


def job_name(user: str, run_name: str) -> str:
	"""The per-user ownership prefix every gateway job carries (spec #49):
	marking both gateway ownership (theta-) and the accountable account."""
	return f"theta-{user}-{run_name}"


def render_batch_script(root: Path, run_name: str, directives: dict[str, str], user: str) -> str:
	"""Render the guarded sbatch script: gateway-forced identity and log
	paths, the allow-listed directives in sorted order, and a fixed body —
	the client controls directives only, never commands."""
	run_directory = run_dir(root, run_name)
	lines = [
		"#!/bin/bash",
		f"#SBATCH --job-name={job_name(user, run_name)}",
		f"#SBATCH --output={run_directory}/{STDOUT_NAME.format(job_id='%j')}",
		f"#SBATCH --error={run_directory}/{STDERR_NAME.format(job_id='%j')}",
	]
	lines += [f"#SBATCH --{key}={directives[key]}" for key in sorted(directives)]
	body = f"printf 'theta-compute run {run_name} job %s on %s\\n' \"$SLURM_JOB_ID\" \"$SLURMD_NODENAME\""
	return "\n".join([*lines, "", body]) + "\n"


def write_batch_script(root: Path, run_name: str, script: str) -> Path:
	"""Write the rendered script into the run directory; return its path."""
	target = resolve_in_sandbox(root, run_name, SCRIPT_NAME)
	target.parent.mkdir(parents=True, exist_ok=True)
	target.write_text(script, encoding="utf-8")
	return target


def find_job_log(root: Path, job_id: str) -> Path | None:
	"""The staging tree's stdout log for one job id, or None when no run
	holds one. The job id maps to its run directory by the log file's own
	name — the gateway keeps no job state (ADR 0004)."""
	for candidate in sorted(root.expanduser().glob(f"*/{STDOUT_NAME.format(job_id=job_id)}")):
		# glob walks matching names wherever they sit, including through a
		# symlinked run directory — only containment-checked paths answer.
		return resolve_in_sandbox(root, candidate.parent.name, candidate.name)
	return None


def stderr_log_for(stdout_log: Path) -> Path:
	"""The stderr log that sits beside a stdout log (the forced pair)."""
	return stdout_log.with_name(stdout_log.name.replace(".out", ".err"))


def tail_text(path: Path, count: int, cap: int) -> str:
	"""The last count lines of one log, inside the in-band cap — over it,
	the refusal names the out-of-band path (the log file on the cluster)."""
	lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
	tail = "\n".join(lines[-count:])
	if len(tail.encode("utf-8")) > cap:
		raise GuardRefusal(f"the last {count} lines of {path.name} are over the in-band cap of {cap} bytes — read the log on the cluster instead: {path}")
	return tail


def collect_artifacts(
	root: Path, run_name: str, picks: list[str] | None, cap: int
) -> tuple[list[dict[str, Any]], int]:
	"""Read one run's files to return in-band: the whole run directory by
	default, or the named picks. Whole or not at all — the answer is built
	only after every file is read and sized within the cap."""
	base = run_dir(root, run_name)
	if picks is None:
		targets = _walk_files(base)
	else:
		targets = []
		for pick in picks:
			relative = parse_staged_path(pick)
			target = resolve_in_sandbox(root, run_name, relative)
			if not target.is_file():
				raise FileNotFoundError(f"{relative} is not a file in run {run_name!r}")
			targets.append((relative, target))
	files: list[dict[str, Any]] = []
	total = 0
	for relative, target in sorted(targets):
		content = target.read_bytes()
		total += len(content)
		if total > cap:
			raise GuardRefusal(
				f"the fetch is over the in-band cap of {cap} bytes ({total} so far) — "
				f"{out_of_band_hint(root, run_name)}"
			)
		files.append({"path": relative, "size": len(content), "content_b64": base64.b64encode(content).decode("ascii")})
	return files, total


def _walk_files(base: Path) -> list[tuple[str, Path]]:
	"""Every regular file under the run directory, symlink-free or refused."""
	if not base.is_dir():
		raise FileNotFoundError(f"run directory {base} does not exist")
	found: list[tuple[str, Path]] = []
	for dirpath, dirnames, filenames in os.walk(base, followlinks=False):
		for name in dirnames:
			if (Path(dirpath) / name).is_symlink():
				raise GuardRefusal(f"{name!r} under {Path(dirpath).name or 'the run directory'} is a symlink — fetch refuses to follow it out of the staging root")
		for name in filenames:
			target = Path(dirpath) / name
			if target.is_symlink():
				raise GuardRefusal(f"{name!r} under {Path(dirpath).name or 'the run directory'} is a symlink — fetch refuses to follow it out of the staging root")
			found.append((str(target.relative_to(base)), target))
	return found
