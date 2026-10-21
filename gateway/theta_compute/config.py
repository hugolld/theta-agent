"""Deploy-time environment: the gateway's whole configuration surface.

Nothing is configurable from the client — the tool surface is fixed — and
no institutional fact lives in git (ADR 0004): the bearer token, the user
name it belongs to, the audit log's location and rotation ceiling, the
Slurm timeout, and the bind address all ride env.
"""

from __future__ import annotations

import getpass
import os
from dataclasses import dataclass
from pathlib import Path

#: Defaults are local-run friendly; the cluster deploy overrides them in env
#: (gateway/README.md carries the recipe).
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8421
DEFAULT_AUDIT_NAME = "theta-compute-audit.jsonl"
DEFAULT_AUDIT_MAX_BYTES = 10 * 1024 * 1024
DEFAULT_SLURM_TIMEOUT_SECONDS = 30.0


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

	return Config(
		token=token,
		user=user,
		audit_log=audit_log,
		audit_max_bytes=max_bytes,
		slurm_timeout_seconds=timeout,
		host=source.get("THETA_COMPUTE_HOST") or DEFAULT_HOST,
		port=port,
	)


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
