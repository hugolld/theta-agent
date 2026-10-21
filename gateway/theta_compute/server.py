"""The FastMCP app: two read-only tools behind bearer auth, one audit
line per tool call (spec #49, ADR 0004).

The audit middleware is the only cross-cutting code: it sees every tool
call after authentication (a call without a valid token is answered 401
by the transport and is not a tool call), records the decision line, and
maps a guard refusal to a DENY line plus a tool error. The tools
themselves stay thin — argument guard, Slurm wrapper call, structured
answer.
"""

from __future__ import annotations

import sys
from typing import Any

from fastmcp import FastMCP
from fastmcp.exceptions import ToolError
from fastmcp.server.dependencies import get_access_token
from fastmcp.server.middleware import CallNext, Middleware, MiddlewareContext
from fastmcp.tools.base import ToolAnnotations

from .audit import AuditLog
from .auth import StaticBearerToken
from .config import Config, ConfigError, load_config
from .guard import guard_tool_arguments
from .slurm import GuardRefusal, SlurmError, job_status as squeue_job_status
from .slurm import list_environments as sinfo_environments
from .slurm import parse_job_id

#: The argument name whose value rides the audit line's job_id field.
JOB_ID_ARGUMENT = "job_id"


class AuditMiddleware(Middleware):
	"""One audit JSONL line per tool call: ALLOW dispatched, DENY refused."""

	def __init__(self, audit: AuditLog) -> None:
		self._audit = audit

	async def on_call_tool(
		self,
		context: MiddlewareContext[Any],
		call_next: CallNext[Any, Any],
	) -> Any:
		tool = context.message.name
		arguments = dict(context.message.arguments or {})
		raw_job_id = arguments.get(JOB_ID_ARGUMENT)
		job_id = raw_job_id if isinstance(raw_job_id, str) else None
		token = get_access_token()
		user = token.client_id if token is not None else "unauthenticated"
		# The guard runs before dispatch: a refusal is a policy decision
		# (DENY) and never reaches a subprocess.
		try:
			guard_tool_arguments(tool, arguments)
			result = await call_next(context)
		except GuardRefusal as refusal:
			self._audit.record(
				user=user, tool=tool, arguments=arguments,
				decision="DENY", job_id=job_id, reason=str(refusal),
			)
			raise ToolError(str(refusal)) from refusal
		except ToolError as error:
			self._audit.record(
				user=user, tool=tool, arguments=arguments,
				decision="ALLOW", job_id=job_id, reason=f"tool error: {error}",
			)
			raise
		except Exception as error:
			self._audit.record(
				user=user, tool=tool, arguments=arguments,
				decision="ALLOW", job_id=job_id, reason=f"internal error: {error!r}",
			)
			raise
		self._audit.record(
			user=user, tool=tool, arguments=arguments,
			decision="ALLOW", job_id=job_id, reason=None,
		)
		return result


def build_app(config: Config) -> FastMCP:
	"""Assemble the gateway: verifier, audit middleware, tool surface."""
	audit = AuditLog(config.audit_log, config.audit_max_bytes)
	app = FastMCP(
		name="theta-compute",
		instructions=(
			"The Theta compute gateway: read-only Slurm access. "
			"Every call is authenticated and audited; see gateway/README.md."
		),
		auth=StaticBearerToken(config.token, config.user),
		middleware=[AuditMiddleware(audit)],
	)

	@app.tool(annotations=ToolAnnotations(read_only_hint=True, open_world_hint=False))
	async def list_environments() -> dict[str, Any]:
		"""List the cluster's partition-state groups: where a job can run.

		Returns one record per sinfo partition-state group — partition name,
		whether it is the default, availability, time limit, node count,
		state, and node list.
		"""
		try:
			return {"environments": await sinfo_environments(config.slurm_timeout_seconds)}
		except SlurmError as error:
			raise ToolError(str(error)) from error

	@app.tool(annotations=ToolAnnotations(read_only_hint=True, open_world_hint=False))
	async def job_status(job_id: str) -> dict[str, Any]:
		"""Read one Slurm job's status by job id (digits only).

		Answers found: false when the id is well formed but not in the
		queue; a malformed id is refused before Slurm is touched.
		"""
		parsed = parse_job_id(job_id)
		try:
			return await squeue_job_status(parsed, config.slurm_timeout_seconds)
		except SlurmError as error:
			raise ToolError(str(error)) from error

	return app


def main() -> int:
	"""Run the gateway over streamable HTTP until interrupted."""
	try:
		config = load_config()
	except ConfigError as error:
		print(f"theta-compute: {error}", file=sys.stderr)
		return 1
	app = build_app(config)
	print(
		f"theta-compute listening on http://{config.host}:{config.port}/mcp "
		f"(user {config.user}, audit {config.audit_log})",
		file=sys.stderr,
	)
	app.run(transport="http", host=config.host, port=config.port)
	return 0
