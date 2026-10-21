"""The argument guard: what may become a Slurm argument at all (spec #49).

The audit middleware calls the guard before dispatching a tool; a refusal
raises GuardRefusal, records as DENY, and never reaches a subprocess. A
Slurm-side failure is not a refusal — it stays a SlurmError and records
as an allowed call that failed. S2's command guard (allow-listed sbatch
keys and ceilings) grows here.
"""

from __future__ import annotations

from typing import Any

from .slurm import GuardRefusal, parse_job_id


def guard_tool_arguments(tool: str, arguments: dict[str, Any]) -> None:
	"""Refuse arguments that may not reach a Slurm argv, or return."""
	if tool == "job_status":
		raw = arguments.get("job_id")
		if not isinstance(raw, str):
			raise GuardRefusal(f"invalid job id {raw!r}: expected a string of digits")
		parse_job_id(raw)
	# list_environments takes no arguments; nothing to guard.
