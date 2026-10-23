"""Deploy-time environment: the gateway's whole configuration surface.

Nothing is configurable from the client — the tool surface is fixed — and
no institutional fact lives in git (ADR 0004): the bearer token, the user
name it belongs to, the audit log's location and rotation ceiling, the
Slurm timeout, the bind address, the staging root, the template directory
the typed tools render from, the in-band transfer cap, and the directive
ceilings (which partitions a raw job may touch, how long, how big) all
ride env.
"""

from __future__ import annotations

import getpass
import os
import re
from dataclasses import dataclass
from pathlib import Path

from .guard import GuardLimits, GuardRefusal, parse_walltime

#: Defaults are local-run friendly; the cluster deploy overrides them in env
#: (gateway/README.md carries the recipe).
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8421
DEFAULT_AUDIT_NAME = "theta-compute-audit.jsonl"
DEFAULT_AUDIT_MAX_BYTES = 10 * 1024 * 1024
DEFAULT_SLURM_TIMEOUT_SECONDS = 30.0
DEFAULT_STAGING_ROOT = "~/theta-compute-runs"
DEFAULT_INBAND_MAX_BYTES = 32 * 1024 * 1024
#: The partitions a raw submit_job may name. The gpu partition stays off
#: the generic path in v1 — scarce nodes, and the typed AF3 tool owns them.
DEFAULT_PARTITIONS = ("cpu",)
DEFAULT_MAX_WALLTIME = "24:00:00"
DEFAULT_MAX_MEM_MB = 65536
DEFAULT_MAX_NTASKS = 16
DEFAULT_MAX_CPUS_PER_TASK = 16
DEFAULT_MAX_GPUS = 1

#: Partition names as the env may list them: plain scheduler names.
_PARTITION_NAME = re.compile(r"[A-Za-z0-9_.-]+")


class ConfigError(Exception):
	"""The environment does not describe a deployable gateway."""


@dataclass(frozen=True)
class Config:
	"""One validated snapshot of the deploy-time env."""

	token: str
	user: str
	audit_log: Path
	audit_max_bytes: int
	slurm_timeout_seconds: float
	host: str
	port: int
	staging_root: Path
	#: The deploy-time template directory (None: no typed tools registered).
	templates_dir: Path | None
	inband_max_bytes: int
	partitions: tuple[str, ...]
	max_walltime_seconds: int
	max_mem_mb: int
	max_ntasks: int
	max_cpus_per_task: int
	max_gpus: int

	def guard_limits(self) -> GuardLimits:
		"""The guard's view of this config: the sandbox and the ceilings."""
		return GuardLimits(
			staging_root=self.staging_root,
			inband_max_bytes=self.inband_max_bytes,
			partitions=self.partitions,
			max_walltime_seconds=self.max_walltime_seconds,
			max_mem_mb=self.max_mem_mb,
			max_ntasks=self.max_ntasks,
			max_cpus_per_task=self.max_cpus_per_task,
			max_gpus=self.max_gpus,
		)


def load_config(env: dict[str, str] | None = None) -> Config:
	"""Read and validate the env. Raises ConfigError naming the bad var."""
	source = dict(os.environ if env is None else env)

	token = source.get("THETA_COMPUTE_TOKEN", "")
	if not token:
		raise ConfigError("THETA_COMPUTE_TOKEN is not set — the gateway refuses to run unauthenticated")

	user = source.get("THETA_COMPUTE_USER") or getpass.getuser()

	audit_raw = source.get("THETA_COMPUTE_AUDIT_LOG") or DEFAULT_AUDIT_NAME
	audit_log = Path(audit_raw).expanduser()
	max_bytes = _positive_int(source, "THETA_COMPUTE_AUDIT_MAX_BYTES", DEFAULT_AUDIT_MAX_BYTES)
	timeout = _positive_float(source, "THETA_COMPUTE_SLURM_TIMEOUT", DEFAULT_SLURM_TIMEOUT_SECONDS)
	port = _int_in_range(source, "THETA_COMPUTE_PORT", DEFAULT_PORT, 1, 65535)

	staging_root = Path(source.get("THETA_COMPUTE_STAGING_ROOT") or DEFAULT_STAGING_ROOT).expanduser()
	templates_raw = source.get("THETA_COMPUTE_TEMPLATES") or ""
	templates_dir: Path | None = None
	if templates_raw:
		templates_dir = Path(templates_raw).expanduser()
		if not templates_dir.is_dir():
			raise ConfigError(f"THETA_COMPUTE_TEMPLATES={templates_raw!r} is not a directory")
	inband = _positive_int(source, "THETA_COMPUTE_INBAND_MAX_BYTES", DEFAULT_INBAND_MAX_BYTES)
	partitions = _partitions(source, "THETA_COMPUTE_PARTITIONS", DEFAULT_PARTITIONS)
	walltime = _walltime(source, "THETA_COMPUTE_MAX_WALLTIME", DEFAULT_MAX_WALLTIME)

	return Config(
		token=token,
		user=user,
		audit_log=audit_log,
		audit_max_bytes=max_bytes,
		slurm_timeout_seconds=timeout,
		host=source.get("THETA_COMPUTE_HOST") or DEFAULT_HOST,
		port=port,
		staging_root=staging_root,
		templates_dir=templates_dir,
		inband_max_bytes=inband,
		partitions=partitions,
		max_walltime_seconds=walltime,
		max_mem_mb=_positive_int(source, "THETA_COMPUTE_MAX_MEM_MB", DEFAULT_MAX_MEM_MB),
		max_ntasks=_positive_int(source, "THETA_COMPUTE_MAX_NTASKS", DEFAULT_MAX_NTASKS),
		max_cpus_per_task=_positive_int(source, "THETA_COMPUTE_MAX_CPUS_PER_TASK", DEFAULT_MAX_CPUS_PER_TASK),
		# Zero is a legal GPU ceiling: it removes gres from the raw path
		# entirely (the typed AF3 tool still owns the GPUs it fixes).
		max_gpus=_int_in_range(source, "THETA_COMPUTE_MAX_GPUS", DEFAULT_MAX_GPUS, 0, None),
	)


def _partitions(env: dict[str, str], name: str, default: tuple[str, ...]) -> tuple[str, ...]:
	raw = env.get(name)
	if raw is None or raw == "":
		return default
	entries = tuple(entry.strip() for entry in raw.split(",") if entry.strip())
	if not entries:
		raise ConfigError(f"{name}={raw!r} names no partitions")
	for entry in entries:
		if _PARTITION_NAME.fullmatch(entry) is None:
			raise ConfigError(f"{name}: {entry!r} is not a partition name")
	return entries


def _walltime(env: dict[str, str], name: str, default: str) -> int:
	raw = env.get(name)
	if raw is None or raw == "":
		raw = default
	try:
		return parse_walltime(raw)
	except GuardRefusal as error:
		raise ConfigError(f"{name}: {error}") from None


def _positive_int(env: dict[str, str], name: str, default: int) -> int:
	return _int_in_range(env, name, default, 1, None)


def _positive_float(env: dict[str, str], name: str, default: float) -> float:
	raw = env.get(name)
	if raw is None or raw == "":
		return default
	try:
		value = float(raw)
	except ValueError:
		raise ConfigError(f"{name}={raw!r} is not a number") from None
	if value <= 0:
		raise ConfigError(f"{name}={raw!r} must be positive")
	return value


def _int_in_range(env: dict[str, str], name: str, default: int, low: int, high: int | None) -> int:
	raw = env.get(name)
	if raw is None or raw == "":
		return default
	try:
		value = int(raw, 10)
	except ValueError:
		raise ConfigError(f"{name}={raw!r} is not an integer") from None
	if value < low or (high is not None and value > high):
		top = f" and {high}" if high is not None else ""
		raise ConfigError(f"{name}={raw!r} must be {low} or greater{top}")
	return value
