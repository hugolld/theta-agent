"""Dump build_app's tool-policy registry as JSON (spec #116).

The boundary test's load-bearing scrape, moved onto the registry: instead
of a regex over source text, Python's own parser reads the co-located
records — ``tool_policies["name"] = ToolPolicy(...)`` — and the decorated
``@app.tool`` defs, so formatting and comments cannot fool it. Output on
stdout is one JSON object: {"records": {...}, "decorated": [...],
"bindings": {...}, "held_message": "...", "instructions_off": "..."};
the test asserts records, decorated defs, and decorator bindings name
the same tools, and that the hold's words and the instructions' off
sentence still name the job creators.
"""

from __future__ import annotations

import ast
import json
import sys
from pathlib import Path

REGISTRY = "tool_policies"
RECORD_TYPE = "ToolPolicy"
HELD_MESSAGE = "SUBMIT_HELD_MESSAGE"


def _const(node):
	"""A literal's value, or None for anything else."""
	if isinstance(node, ast.Constant):
		return node.value
	return None


def _record(call):
	"""One ToolPolicy(...) literal's facts: job_creating, the guard's
	name, and the annotations' hint keywords."""
	fields = {"job_creating": None, "guard": None, "annotations": {}}
	for keyword in call.keywords:
		if keyword.arg == "job_creating":
			fields["job_creating"] = _const(keyword.value)
		elif keyword.arg == "guard" and isinstance(keyword.value, ast.Name):
			fields["guard"] = keyword.value.id
		elif keyword.arg == "annotations" and isinstance(keyword.value, ast.Call):
			for hint in keyword.value.keywords:
				if hint.arg is not None:
					fields["annotations"][hint.arg] = _const(hint.value)
	return fields


def main():
	source = Path(sys.argv[1]).read_text(encoding="utf-8")
	tree = ast.parse(source)
	records = {}
	decorated = []
	bindings = {}
	held_message = None
	instructions_off = None
	for node in ast.walk(tree):
		# The instructions' capability-off sentence: a plain string
		# constant (adjacent literals fold at parse), so finding it here
		# proves it stayed a literal — an f-string or a derived string
		# would not be one Constant.
		if (
			instructions_off is None
			and isinstance(node, ast.Constant)
			and isinstance(node.value, str)
			and "The submit capability is off:" in node.value
		):
			instructions_off = node.value
		if isinstance(node, ast.Assign) and len(node.targets) == 1:
			target = node.targets[0]
			if isinstance(target, ast.Name) and target.id == HELD_MESSAGE:
				value = _const(node.value)
				if isinstance(value, str):
					held_message = value
			if (
				isinstance(target, ast.Subscript)
				and isinstance(target.value, ast.Name)
				and target.value.id == REGISTRY
				and isinstance(target.slice, ast.Constant)
				and isinstance(target.slice.value, str)
				and isinstance(node.value, ast.Call)
				and isinstance(node.value.func, ast.Name)
				and node.value.func.id == RECORD_TYPE
			):
				records[target.slice.value] = _record(node.value)
		if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
			for decorator in node.decorator_list:
				if (
					isinstance(decorator, ast.Call)
					and isinstance(decorator.func, ast.Attribute)
					and decorator.func.attr == "tool"
				):
					decorated.append(node.name)
					for keyword in decorator.keywords:
						binding = keyword.value
						if (
							keyword.arg == "annotations"
							and isinstance(binding, ast.Attribute)
							and isinstance(binding.value, ast.Subscript)
							and isinstance(binding.value.value, ast.Name)
							and binding.value.value.id == REGISTRY
							and isinstance(binding.value.slice, ast.Constant)
						):
							bindings[node.name] = binding.value.slice.value
	json.dump(
		{
			"records": records,
			"decorated": decorated,
			"bindings": bindings,
			"held_message": held_message,
			"instructions_off": instructions_off,
		},
		sys.stdout,
	)
	return 0


if __name__ == "__main__":
	raise SystemExit(main())
