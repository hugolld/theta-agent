"""The template registry: typed tools render institutional templates (spec
#49, story 2; #53).

A typed tool's commands live in a template the institution owns, on the
cluster, never in git (ADR 0004) — the raw path refuses script bodies for
exactly this reason (guard.py). The registry is one deploy-time directory
(``THETA_COMPUTE_TEMPLATES``) holding each template's script plus a
``registry.json`` manifest that declares, per template, the script file,
its free variables, where the typed input lands inside the run directory,
and the output directory. Everything is validated at startup: a broken
registry refuses to boot rather than serve half a contract, the way a
missing token does (config.py).

Free variables are the only client-shaped parts of a rendered script.
The vocabulary is fixed — ``{{RUN_DIR}}`` (the run directory, absolute)
and ``{{JOB_NAME}}`` (the gateway-forced ownership name) — and a template
declares exactly the tokens its script carries; a declared token the
script never uses, or a token the manifest never declared, refuses at
load. Partition, gres, and binds stay template-fixed text: the typed tool
exposes no override for them.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .config import ConfigError
from .guard import GuardRefusal, parse_staged_path

#: The registry file every template directory holds.
REGISTRY_NAME = "registry.json"

#: The free-variable vocabulary the renderer can substitute. A manifest
#: may declare a subset; never anything else. The tuple is the one order
#: the error messages name the vocabulary in.
FREE_VARIABLES = frozenset({"RUN_DIR", "JOB_NAME"})
_VOCABULARY = "RUN_DIR and JOB_NAME"

#: The token syntax in a template script: {{NAME}}, uppercase and
#: underscore only, so a shell script's own ${...} and $NAME forms never
#: collide with it.
_TOKEN = re.compile(r"\{\{([A-Z0-9_]+)\}\}")


@dataclass(frozen=True)
class TemplateSpec:
	"""One registered template: its script text and its run contract."""

	name: str
	script_name: str
	script: str
	free: tuple[str, ...]
	#: Where the typed tool writes the validated input, relative to the
	#: run directory.
	input_file: str
	#: The output directory the template binds, relative to the run
	#: directory — created before submission so the bind finds it.
	output_dir: str


def load_registry(directory: Path) -> dict[str, TemplateSpec]:
	"""Load and validate every template the directory registers. Raises
	ConfigError naming the template and the defect; never returns a
	partial registry."""
	registry_path = directory / REGISTRY_NAME
	if not registry_path.is_file():
		raise ConfigError(f"THETA_COMPUTE_TEMPLATES: {REGISTRY_NAME} is missing — the template registry is a directory holding {REGISTRY_NAME} beside the templates")
	try:
		raw = json.loads(registry_path.read_text(encoding="utf-8"))
	except (OSError, ValueError) as error:
		raise ConfigError(f"THETA_COMPUTE_TEMPLATES: {REGISTRY_NAME} is not valid JSON: {error}") from None
	if not isinstance(raw, dict) or not all(isinstance(value, dict) for value in raw.values()):
		raise ConfigError(f"THETA_COMPUTE_TEMPLATES: {REGISTRY_NAME} must map template names to their specs")
	templates: dict[str, TemplateSpec] = {}
	for name, spec in raw.items():
		templates[name] = _load_template(directory, name, spec)
	return templates


def _load_template(directory: Path, name: str, spec: dict[str, Any]) -> TemplateSpec:
	"""Validate one manifest entry against its script; read the script."""
	where = f"THETA_COMPUTE_TEMPLATES: {REGISTRY_NAME}'s {name} template"
	script_name = spec.get("script")
	if not isinstance(script_name, str) or not script_name or "/" in script_name:
		raise ConfigError(f"{where}: script is a file name beside {REGISTRY_NAME}, not {script_name!r}")
	script_path = directory / script_name
	if not script_path.is_file():
		raise ConfigError(f"THETA_COMPUTE_TEMPLATES: {script_name} (the {name} template's script) does not exist")
	free_raw = spec.get("free")
	if not isinstance(free_raw, list) or not free_raw or not all(isinstance(item, str) for item in free_raw):
		raise ConfigError(f"{where}: free is a non-empty list of free-variable names")
	unknown = [item for item in free_raw if item not in FREE_VARIABLES]
	if unknown:
		raise ConfigError(f"{where} declares free variable {unknown[0]!r} — the vocabulary is {_VOCABULARY}")
	input_file = _staged_field(where, spec, "input_file")
	output_dir = _staged_field(where, spec, "output_dir")
	script = script_path.read_text(encoding="utf-8")
	declared, carried = set(free_raw), set(_TOKEN.findall(script))
	for token in sorted(carried - declared):
		raise ConfigError(f"THETA_COMPUTE_TEMPLATES: {script_name} carries undeclared token {token} — declare it in {REGISTRY_NAME} or remove it from the script")
	for token in sorted(declared - carried):
		raise ConfigError(f"THETA_COMPUTE_TEMPLATES: {REGISTRY_NAME} declares {token} but {script_name} never carries its token")
	return TemplateSpec(
		name=name,
		script_name=script_name,
		script=script,
		free=tuple(free_raw),
		input_file=input_file,
		output_dir=output_dir,
	)


def _staged_field(where: str, spec: dict[str, Any], field: str) -> str:
	"""One manifest path field: relative, inside the run directory."""
	value = spec.get(field)
	if not isinstance(value, str) or not value:
		raise ConfigError(f"{where}: {field} is a relative path inside the run directory, not {value!r}")
	try:
		parse_staged_path(value)
	except GuardRefusal as refusal:
		raise ConfigError(f"{where}: {field} is not a staged path: {refusal}") from None
	return value


def render(spec: TemplateSpec, run_directory: Path, job_name: str) -> str:
	"""Render the template: substitute the free variables, nothing else.
	The load-time token check guarantees every token is declared, so the
	render cannot leave one behind."""
	values = {"RUN_DIR": str(run_directory), "JOB_NAME": job_name}
	return _TOKEN.sub(lambda match: values[match.group(1)], spec.script)
