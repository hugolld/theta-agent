"""Slurm CLI wrappers: argv arrays only (ADR 0004).

Every invocation is a list — the binary name resolved by PATH, each
argument its own element, never a string handed to a shell. Output format
strings are pipe-delimited with one record per line, so the parsers never
guess. Policy — what may become a Slurm argument at all — is the guard's
(guard.py); a failure down here is a SlurmError, an allowed call that
failed.
"""

from __future__ import annotations

import re
import subprocess
from typing import Any

import anyio

#: sinfo: partition, availability, time limit, node count, state, node list.
#: sinfo emits one line per partition-state group; both are kept.
SINFO_ARGV = ["sinfo", "--noheader", "--format", "%P|%a|%l|%D|%t|%N"]

#: squeue: job id, state, name, partition, time used, reason.
SQUEUE_ARGV = ["squeue", "--noheader", "--format", "%i|%T|%j|%P|%M|%R"]

#: squeue's not-in-queue answer for a well-formed id (any Slurm version the
#: cluster has run says exactly this; the stub binaries record it).
_INVALID_JOB = re.compile(r"invalid job id", re.IGNORECASE)


class SlurmError(Exception):
	"""A Slurm command failed, timed out, or is missing."""


async def _run(argv: list[str], timeout_seconds: float) -> str:
	"""Run one Slurm command and return its stdout, off the event loop."""
	def invoke() -> subprocess.CompletedProcess[str]:
		return subprocess.run(argv, capture_output=True, text=True, timeout=timeout_seconds, check=False)

	try:
		done = await anyio.to_thread.run_sync(invoke)
	except FileNotFoundError:
		raise SlurmError(f"{argv[0]} not found on PATH") from None
	except subprocess.TimeoutExpired:
		raise SlurmError(f"{argv[0]} timed out after {timeout_seconds:g}s") from None
	if done.returncode != 0:
		detail = (done.stderr or "").strip().splitlines()[-1] if done.stderr.strip() else "no stderr"
		raise SlurmError(f"{argv[0]} exited {done.returncode}: {detail}")
	return done.stdout


async def list_environments(timeout_seconds: float) -> list[dict[str, Any]]:
	"""Every partition-state group sinfo reports, parsed to records."""
	stdout = await _run(SINFO_ARGV, timeout_seconds)
	return [_parse_environment(line) for line in stdout.splitlines() if line.strip()]


def _parse_environment(line: str) -> dict[str, Any]:
	partition, availability, time_limit, nodes, state, node_list = line.split("|")
	is_default = partition.endswith("*")
	return {
		"partition": partition.rstrip("*"),
		"default": is_default,
		"availability": availability,
		"time_limit": time_limit,
		"nodes": int(nodes) if nodes.isdigit() else nodes,
		"state": state,
		"node_list": node_list,
	}


async def job_status(job_id: str, timeout_seconds: float) -> dict[str, Any]:
	"""One job's status; a well-formed id not in the queue is an answer.

	squeue exits 1 with "invalid job id" both for a malformed id and for a
	digits id the queue does not hold. The guard has already refused
	malformed ids, so reaching that failure with digits in hand means the
	job is not in the queue — found: false, not an error.
	"""
	try:
		stdout = await _run([*SQUEUE_ARGV, "--job", job_id], timeout_seconds)
	except SlurmError as error:
		if is_unknown_job(error):
			return {"found": False, "job_id": job_id}
		raise
	lines = [line for line in stdout.splitlines() if line.strip()]
	if not lines:
		return {"found": False, "job_id": job_id}
	return _parse_job(lines[0])


def _parse_job(line: str) -> dict[str, Any]:
	job_id, state, name, partition, time_used, reason = line.split("|")
	return {
		"found": True,
		"job_id": job_id,
		"state": state,
		"name": name,
		"partition": partition,
		"time_used": time_used,
		"reason": reason,
	}


def is_unknown_job(error: SlurmError) -> bool:
	"""True when a failed squeue named the id invalid — the not-found path."""
	return bool(_INVALID_JOB.search(str(error)))
