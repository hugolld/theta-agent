"""The FastMCP app: the seven generic tools behind bearer auth, one audit
line per tool call (spec #49, ADR 0004).

Each tool's policy — its annotations, whether it creates cluster jobs,
and its pre-dispatch guard callable — lives in one co-located ToolPolicy
record (spec #116): the registry the middleware reads per call, the hold
and throttle bounds derive from, and the boundary tests pin. Boot
reconciles the registry against the registered surface and refuses a
mismatch — the same fail-loudly contract as a broken deploy env.

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

The submit capability is the outer bound around all of it (ADR 0006):
while it is off, the job-creating tools answer a hard refusal before the
guard runs, recorded as a HOLD line — the server-held hold that stands
even when a client bypasses the theta-side confirm gate. Inside it, the
per-principal submit ceiling (spec #94) throttles a runaway loop past
its rolling budget — the count derived from the audit log itself,
recorded as a THROTTLE line.
"""

from __future__ import annotations

import asyncio
import sys
from contextvars import ContextVar
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from fastmcp import FastMCP
from fastmcp.exceptions import ToolError
from fastmcp.server.dependencies import get_access_token
from fastmcp.server.middleware import CallNext, Middleware, MiddlewareContext
from fastmcp.tools.base import ToolAnnotations

from . import staging
from . import templates as template_registry
from .audit import AuditLog, Decision, SubmitCapability
from .auth import StaticBearerToken
from .config import SUBMIT_WINDOW_SECONDS, Config, ConfigError, load_config
from .guard import (
	DEFAULT_TAIL_LINES,
	GuardLimits,
	GuardRefusal,
	guard_cancel_job,
	guard_directives,
	guard_fetch_artifacts,
	guard_job_logs,
	guard_job_status,
	guard_list_environments,
	guard_run_alphafold3,
	guard_stage_files,
	guard_submit_job,
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

@dataclass(frozen=True)
class ToolPolicy:
	"""One tool's enforcement record — the tool policy (spec #116): the
	annotations the wire reports, whether the tool creates cluster jobs
	(the set the submit capability holds, ADR 0006, and the submit ceiling
	counts, spec #94), and the pre-dispatch guard callable. One record sits
	beside each tool definition in build_app; the middleware, the bounds,
	and the boundary tests read this one structure. `mutating` is derived,
	never stored: a tool is mutating exactly when its annotations say it
	is not read-only, so the audit line's submit_capability field and the
	wire's hint cannot drift apart."""

	annotations: ToolAnnotations
	job_creating: bool
	guard: Callable[[dict[str, Any], GuardLimits], None]

	@property
	def mutating(self) -> bool:
		"""The mutating surface: the lines that carry the observed submit
		capability on every decision; read-only lines omit the field."""
		return not self.annotations.read_only_hint

#: The hold's words. The audit line's reason and the tool error carry the
#: same text, so the far side and the trail say one thing — and the far
#: side learns the remediation channel from the refusal alone. The tool
#: names in these words stay literal bytes — ADR 0006 freezes them on
#: every HOLD line — and the boundary test pins them to the registry's
#: job-creating set (spec #116).
SUBMIT_HELD_MESSAGE = (
	"the submit capability is off — job-creating calls (submit_job, "
	"run_alphafold3) are held; the enable is out-of-band: the deploy env "
	"(theta-compute.env), see gateway/README.md; report the hold to the "
	"researcher and do not retry"
)


def _throttled_message(user: str, observed: int, ceiling: int, window_seconds: int) -> str:
	"""The throttle's words, shaped like the hold's: the audit line's
	reason and the tool error carry the same text, and the refusal names
	the principal, the observed count, and the window — the three spec
	#94 demands — plus the ceiling and the channel it rides."""
	return (
		f"the submit ceiling is reached — principal {user} has {observed} submit(s) "
		f"in the rolling {window_seconds}-second window (ceiling {ceiling}); the "
		"ceiling is deploy-time env (theta-compute.env on the cluster), see "
		"gateway/README.md; wait for the window to roll, report the throttle to "
		"the researcher, and do not retry in this session"
	)

#: The job id a submit_job mints mid-call. No argument carried it, but the
#: institutional trail must tie the submission to its job — the middleware
#: reads this when it records the line.
_minted_job_id: ContextVar[str | None] = ContextVar("theta_minted_job_id", default=None)


def _boundary_error(error: Exception) -> ToolError:
	"""The one mapping from internal failures to the boundary's error: the
	message is the failure, nothing added."""
	return ToolError(str(error))


class AuditMiddleware(Middleware):
	"""One audit JSONL line per tool call: ALLOW dispatched, DENY refused,
	HOLD held at the submit capability, THROTTLE past the submit ceiling."""

	def __init__(
		self,
		audit: AuditLog,
		limits: GuardLimits,
		submit_capability: SubmitCapability,
		submit_ceiling: int,
		policies: dict[str, ToolPolicy],
	) -> None:
		self._audit = audit
		self._limits = limits
		self._submit_capability = submit_capability
		self._submit_ceiling = submit_ceiling
		self._policies = policies
		# The registry is still empty at construction (the defs below the
		# FastMCP call populate it), so the job-creating set materializes
		# on first use — a fact of the registry, derived once.
		self._derived_job_creating: frozenset[str] | None = None

	def _job_creating(self) -> frozenset[str]:
		"""The job-creating names, derived from the registry on first use
		(see __init__ for why not at construction): the submit ceiling
		counts exactly these."""
		if self._derived_job_creating is None:
			self._derived_job_creating = frozenset(
				name for name, policy in self._policies.items() if policy.job_creating
			)
		return self._derived_job_creating

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
		policy = self._policies.get(tool)
		if policy is None:
			# Boot reconciliation already refused a registry that does not
			# match the registered surface; a call reaching this without a
			# record means the server is misassembled — fail loudly rather
			# than police a call there is no policy for.
			raise RuntimeError(f"tool call reached the middleware without a tool policy: {tool!r}")

		def record(
			decision: Decision,
			reason: str | None,
			submit_count: int | None = None,
			submit_window_seconds: int | None = None,
		) -> None:
			self._audit.record(
				user=user, tool=tool, arguments=arguments,
				decision=decision,
				# A minted submit id rides the line when no argument carried
				# a job id — the trail ties the submission to its job.
				job_id=job_id if job_id is not None else _minted_job_id.get(),
				reason=reason,
				# The observed capability rides every mutating-tool line,
				# whatever the decision; read-only lines omit the field.
				submit_capability=self._submit_capability if policy.mutating else None,
				# The ceiling's count and window ride only THROTTLE lines.
				submit_count=submit_count,
				submit_window_seconds=submit_window_seconds,
			)

		# The capability is the outer bound: a held call is refused before
		# the guard, any tool code, or a subprocess — and its own line kind
		# makes held submits countable like denials (ADR 0006).
		if policy.job_creating and self._submit_capability != "on":
			record("HOLD", SUBMIT_HELD_MESSAGE)
			raise ToolError(SUBMIT_HELD_MESSAGE)

		# The submit ceiling sits inside the capability and outside the
		# guard: a principal past its rolling budget is refused before the
		# guard, any tool code, or a subprocess, and the count is the audit
		# log's own record — no state but the trail (spec #94). When a hold
		# and the ceiling both fail a call, the hold above has already
		# answered: one call, one line, the outer bound wins (ADR 0006).
		if policy.job_creating:
			observed = self._audit.count_recent_submits(
				user=user, tools=self._job_creating(), window_seconds=SUBMIT_WINDOW_SECONDS
			)
			if observed >= self._submit_ceiling:
				reason = _throttled_message(user, observed, self._submit_ceiling, SUBMIT_WINDOW_SECONDS)
				record("THROTTLE", reason, submit_count=observed, submit_window_seconds=SUBMIT_WINDOW_SECONDS)
				raise ToolError(reason)

		# The guard runs before dispatch: a refusal is a policy decision
		# (DENY) and never reaches a subprocess or a file.
		try:
			policy.guard(arguments, self._limits)
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


def build_app(config: Config, template_specs: dict[str, template_registry.TemplateSpec]) -> FastMCP:
	"""Assemble the gateway: verifier, audit middleware, tool surface.

	Every tool definition below carries its tool policy — one co-located
	ToolPolicy record assigned into the registry, and the @app.tool
	decorator binding its annotations from that record — so the policy
	cannot drift from the registration it governs (spec #116). The typed
	tools register only when a template registry is configured — the seven
	generic tools are the fixed base surface; a deployment without
	templates serves exactly that."""
	if config.templates_dir is not None and "alphafold3" not in template_specs:
		raise ConfigError(
			"the template registry registers no alphafold3 template — run_alphafold3 has nothing to render; check THETA_COMPUTE_TEMPLATES"
		)
	audit = AuditLog(config.audit_log, config.audit_max_bytes)
	# The tool-policy registry: filled in by the co-located records as the
	# defs below register, read by the middleware on every call, and
	# reconciled against the registered surface before build_app returns.
	# The middleware takes the dict itself — no call can arrive until the
	# assembly below has finished populating it.
	tool_policies: dict[str, ToolPolicy] = {}
	app = FastMCP(
		name="theta-compute",
		instructions=(
			"The Theta compute gateway: staged Slurm runs. Stage input files, "
			"submit a guarded job, watch it, fetch its artifacts — every call "
			"is authenticated and audited; see gateway/README.md."
			+ (
				""
				if config.submit_capability == "on"
				else " The submit capability is off: submit_job and run_alphafold3 "
				"answer a hard refusal until the deploy env re-enables them."
			)
		),
		auth=StaticBearerToken(config.token, config.user),
		middleware=[
			AuditMiddleware(
				audit, config.guard_limits(), config.submit_capability, config.submit_ceiling, tool_policies
			)
		],
	)

	tool_policies["list_environments"] = ToolPolicy(
		annotations=ToolAnnotations(read_only_hint=True, open_world_hint=False),
		job_creating=False,
		guard=guard_list_environments,
	)

	@app.tool(annotations=tool_policies["list_environments"].annotations)
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

	tool_policies["job_status"] = ToolPolicy(
		annotations=ToolAnnotations(read_only_hint=True, open_world_hint=False),
		job_creating=False,
		guard=guard_job_status,
	)

	@app.tool(annotations=tool_policies["job_status"].annotations)
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

	tool_policies["stage_files"] = ToolPolicy(
		annotations=ToolAnnotations(read_only_hint=False, open_world_hint=False),
		job_creating=False,
		guard=guard_stage_files,
	)

	@app.tool(annotations=tool_policies["stage_files"].annotations)
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

	async def _submit_script(script_path: Path) -> str:
		"""Submit one rendered script and mint the job id onto the audit
		line — the submit half both submitting tools share. A Slurm-side
		failure stays an allowed call that failed."""
		try:
			job_id = await slurm_submit(str(script_path), config.slurm_timeout_seconds)
		except SlurmError as error:
			raise _boundary_error(error) from error
		_minted_job_id.set(job_id)
		return job_id

	tool_policies["submit_job"] = ToolPolicy(
		annotations=ToolAnnotations(read_only_hint=False, destructive_hint=True, open_world_hint=False),
		job_creating=True,
		guard=guard_submit_job,
	)

	@app.tool(annotations=tool_policies["submit_job"].annotations)
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
		except GuardRefusal as error:
			raise _boundary_error(error) from error
		except OSError as error:
			raise ToolError(f"writing the batch script for run {run_name!r} failed: {error}") from error
		job_id = await _submit_script(script_path)
		return {
			"job_id": job_id,
			"job_name": staging.job_name(config.user, run_name),
			"script_path": str(script_path),
		}

	tool_policies["job_logs"] = ToolPolicy(
		annotations=ToolAnnotations(read_only_hint=True, open_world_hint=False),
		job_creating=False,
		guard=guard_job_logs,
	)

	@app.tool(annotations=tool_policies["job_logs"].annotations)
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

	# cancel_job is deliberately not job-creating: it remediates a
	# runaway, it starts nothing — it stays in service during a hold
	# (ADR 0006).
	tool_policies["cancel_job"] = ToolPolicy(
		annotations=ToolAnnotations(read_only_hint=False, destructive_hint=True, open_world_hint=False),
		job_creating=False,
		guard=guard_cancel_job,
	)

	@app.tool(annotations=tool_policies["cancel_job"].annotations)
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

	tool_policies["fetch_artifacts"] = ToolPolicy(
		annotations=ToolAnnotations(read_only_hint=True, open_world_hint=False),
		job_creating=False,
		guard=guard_fetch_artifacts,
	)

	@app.tool(annotations=tool_policies["fetch_artifacts"].annotations)
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

	if config.templates_dir is not None:
		af3 = template_specs["alphafold3"]

		tool_policies["run_alphafold3"] = ToolPolicy(
			annotations=ToolAnnotations(read_only_hint=False, destructive_hint=True, open_world_hint=False),
			job_creating=True,
			guard=guard_run_alphafold3,
		)

		@app.tool(annotations=tool_policies["run_alphafold3"].annotations)
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
			except GuardRefusal as error:
				raise _boundary_error(error) from error
			except OSError as error:
				raise ToolError(f"staging the alphafold3 run {run_name!r} failed: {error}") from error
			job_id = await _submit_script(script_path)
			return {
				"job_id": job_id,
				"job_name": name,
				"script_path": str(script_path),
				"fold_input_path": str(input_path),
				"output_dir": str(output_path),
			}

	# Boot reconciliation (spec #116): the registry and the registered
	# surface must name the same tools. A def without a record is a tool
	# the middleware cannot police; a record without a def is dead policy.
	# The same fail-loudly contract as a broken theta-compute.env — the
	# server refuses to start misassembled.
	registered = {tool.name for tool in asyncio.run(app.list_tools())}
	if registered != set(tool_policies):
		raise ConfigError(
			"tool policies do not match the registered surface — "
			f"no record for {sorted(registered - set(tool_policies))}, "
			f"no tool for {sorted(set(tool_policies) - registered)}"
		)

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
