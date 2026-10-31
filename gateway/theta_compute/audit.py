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
	             "HOLD" — the submit capability was off; a job-creating
	             call never reached the guard, a tool, or a subprocess;
	             reason names the hold (ADR 0006)
	             "THROTTLE" — the principal reached the submit ceiling;
	             the job-creating call never reached the guard, a tool,
	             or a subprocess; reason names the principal, the
	             observed count, and the window (spec #94)
	job_id       the call's job-id argument when the tool takes one, else
	             null; on a DENY it is the rejected value verbatim
	submit_capability  "on"/"off" on lines for mutating tools — the
	             capability observed when the call arrived, on every
	             decision; absent on read-only lines
	submit_count on a THROTTLE line: the submits the log held for the
	             principal inside the window when the call arrived
	             (spec #94); absent from every other line
	submit_window_seconds  on a THROTTLE line: the rolling window, in
	             seconds, the count was taken over; absent from every
	             other line
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

Decision = Literal["ALLOW", "DENY", "HOLD", "THROTTLE"]

#: The submit capability's two states — one name for the words the env
#: var, the audit line, and the refusal all share (ADR 0006). A leaf type
#: beside Decision: guard and config both sit above this module.
SubmitCapability = Literal["on", "off"]


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
	#: The observed submit capability on mutating-tool lines; None omits
	#: the key entirely — read-only lines never carry it.
	submit_capability: SubmitCapability | None = None
	#: The submits the log held inside the window, on THROTTLE lines only
	#: (spec #94); None omits the key — no other line carries it.
	submit_count: int | None = None
	#: The rolling window the count was taken over, on THROTTLE lines
	#: only; None omits the key.
	submit_window_seconds: int | None = None

	def to_json(self) -> str:
		line = {
			"ts": self.ts,
			"user": self.user,
			"tool": self.tool,
			"args_sha256": self.args_sha256,
			"decision": self.decision,
			"job_id": self.job_id,
			"reason": self.reason,
		}
		if self.submit_capability is not None:
			line["submit_capability"] = self.submit_capability
		if self.submit_count is not None:
			line["submit_count"] = self.submit_count
		if self.submit_window_seconds is not None:
			line["submit_window_seconds"] = self.submit_window_seconds
		return canonical_json(line)


class AuditLog:
	"""Append-only JSONL with size rotation; one process, one writer.

	Also the submit ceiling's only state: the count derives from these
	lines at call time (spec #94)."""

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
		submit_capability: SubmitCapability | None = None,
		submit_count: int | None = None,
		submit_window_seconds: int | None = None,
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
			submit_capability=submit_capability,
			submit_count=submit_count,
			submit_window_seconds=submit_window_seconds,
		)
		line = entry.to_json() + "\n"
		self._rotate_if_needed(len(line))
		parent = self._path.parent
		if str(parent):
			os.makedirs(parent, exist_ok=True)
		with open(self._path, "a", encoding="utf-8") as handle:
			handle.write(line)

	def count_recent_submits(self, *, user: str, tools: frozenset[str], window_seconds: int) -> int:
		"""How many submits `user` was allowed inside the rolling window
		(spec #94) — derived from this log, the ceiling's only state.

		An ALLOW line for a job-creating tool counts even when Slurm then
		refused it: the call spent the boundary's dispatch, and a loop of
		failing submits is still a loop. Lines this writer would not have
		written — unparseable, untimestamped, naive — do not count.
		"""
		cutoff = datetime.now(UTC).timestamp() - window_seconds
		count = 0
		for path in self._window_files():
			with open(path, encoding="utf-8") as handle:
				for raw in handle:
					if _counts_toward_ceiling(raw, user, tools, cutoff):
						count += 1
		return count

	@property
	def _rotated_path(self) -> Path:
		"""The one rotated generation: rotation writes it, the window
		reads it — one home for the name, so the two never drift."""
		return self._path.with_name(self._path.name + ".1")

	def _window_files(self) -> list[Path]:
		"""The current audit file plus the one rotated generation, each
		only when present — a fresh deploy has written no line yet, so an
		empty count is the honest one. The window's memory is exactly the
		trail the deploy keeps; rotation must not reset the ceiling."""
		candidates = [self._path, self._rotated_path]
		return [path for path in candidates if path.exists()]

	def _rotate_if_needed(self, incoming: int) -> None:
		try:
			current = self._path.stat().st_size
		except FileNotFoundError:
			return
		if current > 0 and current + incoming > self._max_bytes:
			rotated = self._rotated_path
			if rotated.exists():
				rotated.unlink()
			self._path.rename(rotated)


def _counts_toward_ceiling(raw: str, user: str, tools: frozenset[str], cutoff: float) -> bool:
	"""One audit line's verdict for the submit ceiling: an allowed
	in-window submit by this principal for a job-creating tool."""
	try:
		line = json.loads(raw)
	except ValueError:
		return False
	if not isinstance(line, dict):
		return False
	if line.get("user") != user or line.get("decision") != "ALLOW" or line.get("tool") not in tools:
		return False
	ts = line.get("ts")
	if not isinstance(ts, str):
		return False
	try:
		moment = datetime.fromisoformat(ts)
	except ValueError:
		return False
	# A naive stamp compares against the wrong clock; the writer always
	# stamps UTC, so anything else is not this writer's line.
	return moment.tzinfo is not None and moment.timestamp() >= cutoff
