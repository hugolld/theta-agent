"""The FastMCP app: the seven generic tools behind bearer auth, one audit
line per tool call (spec #49, ADR 0004).

The audit middleware is the only cross-cutting code: it sees every tool
call after authentication (a call without a valid token is answered 401
by the transport and is not a tool call), records the decision line, and
maps a guard refusal to a DENY line plus a tool error. The guard itself
is pre-dispatch — refusals decidable from the arguments alone (shapes,
the path sandbox, the directive ceilings, the in-band cap) are DENY;
refusals that need a call to run first (cancelling a job the prefix says
is not this user's) happen inside the tool and record as an allowed call
that failed. The tools themselves stay thin — argument guard, wrapper
call, structured answer.
"""

from __future__ import annotations

import sys
from contextvars import ContextVar
from typing import Any

from fastmcp import FastMCP
from fastmcp.exceptions import ToolError
from fastmcp.server.dependencies import get_access_token
from fastmcp.server.middleware import CallNext, Middleware, MiddlewareContext
from fastmcp.tools.base import ToolAnnotations

from . import staging
from . import templates as template_registry
from .audit import AuditLog, Decision
from .auth import StaticBearerToken
from .config import Config, ConfigError, load_config
from .guard import (
	DEFAULT_TAIL_LINES,
	GuardLimits,
	GuardRefusal,
	guard_directives,
	guard_tool_arguments,
	parse_job_id,
	parse_tail_lines,
	run_dir,
	validate_fold_input,
)
from .slurm import SlurmError
from .slurm import cancel_job as slurm_cancel
from .slurm import job_status as squeue_job_status
from .slurm import list_environments as sinfo_environments
from .slurm import submit_job as slurm_submit

#: The argument name whose value rides the audit line's job_id field.
JOB_ID_ARGUMENT = "job_id"

#: The job id a submit_job mints mid-call. No argument carried it, but the
#: institutional trail must tie the submission to its job — the middleware
#: reads this when it records the line.
_minted_job_id: ContextVar[str | None] = ContextVar("theta_minted_job_id", default=None)


def _boundary_error(error: Exception) -> ToolError:
	"""The one mapping from internal failures to the boundary's error: the
	message is the failure, nothing added."""
	return ToolError(str(error))


class AuditMiddleware(Middleware):
	"""One audit JSONL line per tool call: ALLOW dispatched, DENY refused."""

	def __init__(self, audit: AuditLog, limits: GuardLimits) -> None:
		self._audit = audit
		self._limits = limits

	async def on_call_tool(
		self,
		context: MiddlewareContext[Any],
		call_next: CallNext[Any, Any],
	) -> Any:
		tool = context.message.name
		arguments = dict(context.message.arguments or {})
		raw_job_id = arguments.get(JOB_ID_ARGUMENT)
		job_id = raw_job_id if isinstance(raw_job_id, str) else None
		_minted_job_id.set(None)
		token = get_access_token()
		if token is None:
			# The transport refuses unauthenticated calls with 401 before
			# any tool runs; reaching here means auth is misconfigured —
			# fail loudly rather than misattribute the audit trail.
			raise RuntimeError("tool call reached the middleware unauthenticated")
		user = token.client_id

		def record(decision: Decision, reason: str | None) -> None:
			self._audit.record(
				user=user, tool=tool, arguments=arguments,
				decision=decision,
				# A minted submit id rides the line when no argument carried
				# a job id — the trail ties the submission to its job.
				job_id=job_id if job_id is not None else _minted_job_id.get(),
				reason=reason,
			)

		# The guard runs before dispatch: a refusal is a policy decision
		# (DENY) and never reaches a subprocess or a file.
		try:
			guard_tool_arguments(tool, arguments, self._limits)
			result = await call_next(context)
		except GuardRefusal as refusal:
			record("DENY", str(refusal))
			raise ToolError(str(refusal)) from refusal
		except ToolError as error:
			record("ALLOW", f"tool error: {error}")
			raise
		except Exception as error:
			record("ALLOW", f"internal error: {error!r}")
			raise
		record("ALLOW", None)
		return result


def build_app(config: Config, template_specs: dict[str, template_registry.TemplateSpec] | None = None) -> FastMCP:
	"""Assemble the gateway: verifier, audit middleware, tool surface.

	The typed tools register only when a template registry is configured —
	the seven generic tools are the fixed base surface; a deployment
	without templates serves exactly that."""
	specs = template_specs or {}
	if config.templates_dir is not None and "alphafold3" not in specs:
		raise ConfigError(
			"the template registry registers no alphafold3 template — run_alphafold3 has nothing to render; check THETA_COMPUTE_TEMPLATES"
		)
	audit = AuditLog(config.audit_log, config.audit_max_bytes)
	app = FastMCP(
		name="theta-compute",
		instructions=(
			"The Theta compute gateway: staged Slurm runs. Stage input files, "
			"submit a guarded job, watch it, fetch its artifacts — every call "
			"is authenticated and audited; see gateway/README.md."
		),
		auth=StaticBearerToken(config.token, config.user),
		middleware=[AuditMiddleware(audit, config.guard_limits())],
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

	@app.tool(annotations=ToolAnnotations(read_only_hint=False, open_world_hint=False))
	async def stage_files(run_name: str, files: list[dict[str, Any]]) -> dict[str, Any]:
		"""Stage input files into one run's directory under the staging root.

		Files travel in-band as base64 (32 MiB per call by default) and the
		path sandbox confines them to the run directory. Past the cap the
		refusal names the out-of-band path: scp to the run directory on the
		cluster. Staging lands whole or not at all.
		"""
		try:
			staged = staging.stage_files(config.staging_root, run_name, files)
		except GuardRefusal as error:
			raise _boundary_error(error) from error
		except OSError as error:
			raise ToolError(f"staging run {run_name!r} failed: {error}") from error
		return {
			"run_name": run_name,
			"run_dir": str(run_dir(config.staging_root, run_name)),
			"staged": staged,
		}

	@app.tool(annotations=ToolAnnotations(read_only_hint=False, destructive_hint=True, open_world_hint=False))
	async def submit_job(run_name: str, directives: dict[str, str | int] | None = None) -> dict[str, Any]:
		"""Submit the run's guarded batch script to Slurm; answers the job id.

		Directives are scheduler sizing only — partition, time, mem, ntasks,
		cpus-per-task, gres — each inside a ceiling; the job name (the
		per-user theta- prefix), the log paths, and the script body are
		gateway-forced. This spends cluster time: the theta side confirms
		it before the call leaves.
		"""
		checked = guard_directives(directives or {}, config.guard_limits())
		script = staging.render_batch_script(config.staging_root, run_name, checked, config.user)
		try:
			script_path = staging.write_batch_script(config.staging_root, run_name, script)
			job_id = await slurm_submit(str(script_path), config.slurm_timeout_seconds)
		except (GuardRefusal, SlurmError) as error:
			raise _boundary_error(error) from error
		except OSError as error:
			raise ToolError(f"writing the batch script for run {run_name!r} failed: {error}") from error
		_minted_job_id.set(job_id)
		return {
			"job_id": job_id,
			"job_name": staging.job_name(config.user, run_name),
			"script_path": str(script_path),
		}

	@app.tool(annotations=ToolAnnotations(read_only_hint=True, open_world_hint=False))
	async def job_logs(job_id: str, tail_lines: int | None = None) -> dict[str, Any]:
		"""Read one job's stdout and stderr from its run directory.

		Returns the last tail_lines of each (100 by default, 1000 at most).
		Answers found: false when no run in the staging tree holds a log
		for the id — a job that never started, or not a gateway job.
		"""
		parsed = parse_job_id(job_id)
		count = DEFAULT_TAIL_LINES if tail_lines is None else parse_tail_lines(tail_lines)
		try:
			stdout_log = staging.find_job_log(config.staging_root, parsed)
			if stdout_log is None:
				return {"found": False, "job_id": parsed}
			stdout = staging.tail_text(stdout_log, count, config.inband_max_bytes)
			stderr_log = staging.stderr_log_for(stdout_log)
			stderr = staging.tail_text(stderr_log, count, config.inband_max_bytes) if stderr_log.exists() else ""
		except GuardRefusal as error:
			raise _boundary_error(error) from error
		except OSError as error:
			raise ToolError(f"reading logs for job {parsed} failed: {error}") from error
		return {"found": True, "job_id": parsed, "stdout": stdout, "stderr": stderr}

	@app.tool(annotations=ToolAnnotations(read_only_hint=False, destructive_hint=True, open_world_hint=False))
	async def cancel_job(job_id: str) -> dict[str, Any]:
		"""Cancel one gateway-owned job (the theta- prefix marks ownership).

		Only jobs whose name carries this user's theta-<user>- prefix are
		cancelled; anything else is refused. Answers found: false when the
		queue no longer holds the id — nothing to cancel, not an error.
		"""
		parsed = parse_job_id(job_id)
		prefix = f"theta-{config.user}-"
		try:
			status = await squeue_job_status(parsed, config.slurm_timeout_seconds)
			if not status["found"]:
				return {"found": False, "canceled": False, "job_id": parsed}
			name = status["name"]
			if not name.startswith(prefix):
				# The prefix check needs squeue's answer, so this refusal is
				# an allowed call that failed — the audit line's reason
				# names it (see gateway/README.md).
				raise ToolError(
					f"job {parsed} ({name!r}) does not carry this user's ownership prefix ({prefix}) — refusing to cancel a job the gateway does not own"
				)
			await slurm_cancel(parsed, config.slurm_timeout_seconds)
		except SlurmError as error:
			raise ToolError(str(error)) from error
		return {"found": True, "canceled": True, "job_id": parsed, "job_name": name}

	@app.tool(annotations=ToolAnnotations(read_only_hint=True, open_world_hint=False))
	async def fetch_artifacts(run_name: str, paths: list[str] | None = None) -> dict[str, Any]:
		"""Fetch one run's files back in-band: the whole run directory by
		default, or the named picks.

		The answer is whole or not at all — every file is read and sized
		within the in-band cap before anything returns. Past the cap the
		refusal names the out-of-band path: scp from the run directory on
		the cluster.
		"""
		try:
			files, total = staging.collect_artifacts(
				config.staging_root, run_name, paths, config.inband_max_bytes
			)
		except (GuardRefusal, FileNotFoundError) as error:
			raise _boundary_error(error) from error
		except OSError as error:
			raise ToolError(f"fetching run {run_name!r} failed: {error}") from error
		return {"run_name": run_name, "total_bytes": total, "files": files}

	if "alphafold3" in specs:
		af3 = specs["alphafold3"]

		@app.tool(annotations=ToolAnnotations(read_only_hint=False, destructive_hint=True, open_world_hint=False))
		async def run_alphafold3(run_name: str, fold_input: dict[str, Any]) -> dict[str, Any]:
			"""Fold one input on the cluster's registered AlphaFold3 template.

			Takes a run name and the AF3-native fold-input JSON (name,
			sequences, modelSeeds, dialect "alphafold3", version 1). The
			gateway validates the envelope, stages the JSON into the run
			directory, renders the template's free variables only — the
			job name and the run directory — and submits. Partition, gres,
			and binds are fixed by the template; the typed tool exposes no
			overrides. Answers the job id, the job name, the script, the
			staged input, and the output directory the artifacts land in.
			This spends GPU time: the theta side confirms it before the
			call leaves.
			"""
			# The guard already refused what policy refuses; the pure
			# parser re-runs here (transit is not trust) and returns the
			# canonical bytes to stage.
			payload = validate_fold_input(fold_input, config.inband_max_bytes)
			name = staging.job_name(config.user, run_name)
			run_directory = run_dir(config.staging_root, run_name)
			try:
				input_path = staging.write_staged_file(config.staging_root, run_name, af3.input_file, payload)
				output_path = staging.make_staged_dir(config.staging_root, run_name, af3.output_dir)
				script = template_registry.render(af3, run_directory, name)
				script_path = staging.write_staged_file(
					config.staging_root, run_name, af3.script_name, script.encode("utf-8")
				)
				job_id = await slurm_submit(str(script_path), config.slurm_timeout_seconds)
			except (GuardRefusal, SlurmError) as error:
				raise _boundary_error(error) from error
			except OSError as error:
				raise ToolError(f"staging the alphafold3 run {run_name!r} failed: {error}") from error
			_minted_job_id.set(job_id)
			return {
				"job_id": job_id,
				"job_name": name,
				"script_path": str(script_path),
				"fold_input_path": str(input_path),
				"output_dir": str(output_path),
			}

	return app


def main() -> int:
	"""Run the gateway over streamable HTTP until interrupted."""
	try:
		config = load_config()
		registry = (
			template_registry.load_registry(config.templates_dir)
			if config.templates_dir is not None
			else {}
		)
		app = build_app(config, registry)
	except ConfigError as error:
		print(f"theta-compute: {error}", file=sys.stderr)
		return 1
	if registry:
		print(
			f"theta-compute: {len(registry)} template(s) registered from {config.templates_dir}",
			file=sys.stderr,
		)
	print(
		f"theta-compute listening on http://{config.host}:{config.port}/mcp "
		f"(user {config.user}, audit {config.audit_log})",
		file=sys.stderr,
	)
	app.run(transport="http", host=config.host, port=config.port)
	return 0
