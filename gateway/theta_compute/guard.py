"""The argument guard: what may become a Slurm argument at all (spec #49).

The audit middleware calls the guard before dispatching a tool; a refusal
raises GuardRefusal, records as DENY, and never reaches a subprocess. A
Slurm-side failure is not a refusal — it stays a SlurmError and records
as an allowed call that failed. S2's command guard (allow-listed sbatch
keys and ceilings) grows here.
"""

from __future__ import annotations

import re
from typing import Any

#: Slurm job ids as the gateway accepts them: plain digits in v1 (spec #49).
_JOB_ID = re.compile(r"\d+")


class GuardRefusal(Exception):
	"""The guard refused an argument before any subprocess ran."""


def parse_job_id(raw: str) -> str:
	"""Accept a plain-digits Slurm job id or refuse it (DENY)."""
	if not _JOB_ID.fullmatch(raw):
		raise GuardRefusal(f"invalid job id {raw!r}: a v1 job id is digits only")
	return raw


def guard_tool_arguments(tool: str, arguments: dict[str, Any]) -> None:
	"""Refuse arguments that may not reach a Slurm argv, or return."""
	if tool == "job_status":
		raw = arguments.get("job_id")
		if not isinstance(raw, str):
			raise GuardRefusal(f"invalid job id {raw!r}: expected a string of digits")
		parse_job_id(raw)
	# list_environments takes no arguments; nothing to guard.
