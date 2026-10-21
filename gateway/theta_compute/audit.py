"""The audit trail: one JSONL line per tool call (spec #49).

Line shape (the user-facing copy is gateway/README.md; keep the two in
sync):

	ts           UTC ISO-8601 timestamp of the decision
	user         the authenticated principal the bearer token belongs to
	tool         tool name
	args_sha256  "sha256:<hex>" over the canonical JSON of the argument
	             object (sorted keys, no spaces) — the digest, never the
	             arguments themselves
	decision     "ALLOW" — the guard let the call through; reason is then
	             null on success, or names whatever failed after
	             acceptance (a Slurm-side failure, a routing error)
	             "DENY" — the guard refused before any subprocess ran;
	             reason names the refusal
	job_id       the call's job-id argument when the tool takes one, else
	             null; on a DENY it is the rejected value verbatim
	reason       see decision

The file rotates by size: when appending would push the current file past
the ceiling, the file is renamed to "<name>.1" (replacing any earlier .1)
and the line starts a fresh file.
"""

from __future__ import annotations

import hashlib
import json
import os
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal

#: The canonical-JSON shape every argument digest is taken over — sorted
#: keys and no whitespace, so the same arguments always hash the same.
CANONICAL_SEPARATORS = (",", ":")

Decision = Literal["ALLOW", "DENY"]


def canonical_json(value: Any) -> str:
	"""Serialize for hashing: sorted keys, no whitespace."""
	return json.dumps(value, sort_keys=True, separators=CANONICAL_SEPARATORS, ensure_ascii=False)


def argument_digest(arguments: dict[str, Any]) -> str:
	"""The audit line's argument digest: sha256 over canonical JSON."""
	return "sha256:" + hashlib.sha256(canonical_json(arguments).encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class AuditEntry:
	"""One tool call's decision line."""

	ts: str
	user: str
	tool: str
	args_sha256: str
	decision: Decision
	job_id: str | None
	reason: str | None

	def to_json(self) -> str:
		return canonical_json(
			{
				"ts": self.ts,
				"user": self.user,
				"tool": self.tool,
				"args_sha256": self.args_sha256,
				"decision": self.decision,
				"job_id": self.job_id,
				"reason": self.reason,
			}
		)


class AuditLog:
	"""Append-only JSONL with size rotation; one process, one writer."""

	def __init__(self, path: Path, max_bytes: int) -> None:
		self._path = path
		self._max_bytes = max_bytes

	def record(
		self,
		*,
		user: str,
		tool: str,
		arguments: dict[str, Any],
		decision: Decision,
		job_id: str | None,
		reason: str | None,
	) -> None:
		"""Append one line, rotating first when the ceiling demands it."""
		entry = AuditEntry(
			ts=datetime.now(UTC).isoformat(timespec="seconds").replace("+00:00", "Z"),
			user=user,
			tool=tool,
			args_sha256=argument_digest(arguments),
			decision=decision,
			job_id=job_id,
			reason=reason,
		)
		line = entry.to_json() + "\n"
		self._rotate_if_needed(len(line))
		parent = self._path.parent
		if str(parent):
			os.makedirs(parent, exist_ok=True)
		with open(self._path, "a", encoding="utf-8") as handle:
			handle.write(line)

	def _rotate_if_needed(self, incoming: int) -> None:
		try:
			current = self._path.stat().st_size
		except FileNotFoundError:
			return
		if current > 0 and current + incoming > self._max_bytes:
			rotated = self._path.with_name(self._path.name + ".1")
			if rotated.exists():
				rotated.unlink()
			self._path.rename(rotated)
