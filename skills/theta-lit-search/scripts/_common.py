#!/usr/bin/env python3
"""Shared layer for theta-lit-search connector scripts. Stdlib only, 3.11+.

Two transports behind one interface so every connector script is testable
offline at the process boundary (exit codes, stdout, stderr) without monkey
patching:

`HttpTransport`
    The real network client. Enforces the per-API pace with a
    monotonic-clock floor between calls -- the rate contract is code, not
    prose. The floor is per-process: parallel shells can still burst past a
    limit, a documented residual a stateless script cannot fix.

`FixtureTransport`
    Reads recorded response bodies from a directory (path taken from
    THETA_LIT_SEARCH_FIXTURES) in call order, so a test harness can pipe
    fixture payloads through the whole CLI. A fixture's first line may be
    "# status: NNN" to encode a non-200 HTTP status; otherwise the status
    is 200 and the file is the body verbatim.

These APIs can fail inside HTTP 200 bodies, so nothing here treats a
completed request as a successful one -- classification is the caller's job
(`ApiError.exit_code` carries the script's documented exit contract).

Credentials ride in query strings or headers depending on the API, so any
URL or parameter map that reaches output goes through `redact_url` /
`redact_params` first: the parameter names survive so a reader can repeat
the call with their own key, the values never do.
"""

from __future__ import annotations

import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import NoReturn
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

#: Set to a fixture directory to swap the network out (tests only).
FIXTURE_ENV = "THETA_LIT_SEARCH_FIXTURES"

#: Optional "# status: NNN" first line for fixture bodies.
FIXTURE_STATUS_RE = re.compile(r"^# status: (\d{3})\r?\n")

#: Query parameters that must never appear with their value in output.
REDACTED_PARAMS = frozenset({"api_key", "apikey", "key", "email", "mailto", "tool"})
REDACTION = "REDACTED"

_CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
_WHITESPACE = re.compile(r"\s+")

#: Advisory backoff when the server reports an empty rate budget. Semantics
#: of the observed x-ratelimit-remaining header are UNVERIFIED (live
#: observation 2026-10-11, not in NCBI's docs), so this can only add a
#: pause, never skip a call; the monotonic floor above stays the contract.
ADVISORY_BACKOFF_SECONDS = 1.0

USER_AGENT = "theta-lit-search/0.1"


class ApiError(Exception):
	"""A failure the API (or the local invocation) reported.

	`exit_code` is the script's documented contract code, so callers translate
	an exception directly into a process exit -- no re-classification at the
	top level.
	"""

	def __init__(self, message: str, exit_code: int) -> None:
		super().__init__(message)
		self.exit_code = exit_code


def require_python() -> None:
	"""Refuse to run below 3.11, naming the versioned fallbacks."""
	if sys.version_info < (3, 11):
		version = ".".join(str(part) for part in sys.version_info[:3])
		fail(
			f"Python 3.11+ required (this interpreter is {version}); "
			"retry with python3.13, python3.12, or python3.11",
			code=1,
		)


def redact_params(params: dict[str, str]) -> dict[str, str]:
	"""Parameter map with credential values replaced (names survive)."""
	return {
		name: REDACTION if name.lower() in REDACTED_PARAMS else value
		for name, value in params.items()
	}


def redact_url(url: str) -> str:
	"""URL with credential query-parameter values replaced.

	Same contract as `redact_params`: `api_key` stays visible as a parameter
	name so the call remains repeatable with the reader's own key. The query
	is re-encoded from its parsed pairs, so the result can differ cosmetically
	from the wire URL (commas become %2C) while staying valid and repeatable.
	"""
	parts = urlsplit(url)
	if not parts.query:
		return url
	pairs = [
		(name, REDACTION if name.lower() in REDACTED_PARAMS else value)
		for name, value in parse_qsl(parts.query, keep_blank_values=True)
	]
	return urlunsplit(parts._replace(query=urlencode(pairs)))


def collapse_ws(text: str | None) -> str:
	"""Collapse whitespace runs and drop control characters.

	API payloads are third-party text; titles arrive hard-wrapped or with
	control bytes, and a raw value compares unequal to the same string from
	any other source.
	"""
	if not text:
		return ""
	return _WHITESPACE.sub(" ", _CONTROL.sub("", text)).strip()


def emit(payload: object) -> None:
	"""Write `payload` as UTF-8 JSON to stdout."""
	sys.stdout.write(json.dumps(payload, indent=2, ensure_ascii=False) + "\n")


def fail(message: str, code: int) -> NoReturn:
	"""Write `message` to stderr and exit with a contract code."""
	sys.stderr.write(f"{message}\n")
	raise SystemExit(code)


class HttpTransport:
	"""Paced HTTP GET client; the floor between calls is the rate contract."""

	def __init__(self, min_interval: float) -> None:
		self.min_interval = min_interval
		self._next_ok = 0.0

	def get(self, url: str, headers: dict[str, str] | None = None) -> tuple[int, str]:
		wait = self._next_ok - time.monotonic()
		if wait > 0:
			time.sleep(wait)
		self._next_ok = time.monotonic() + self.min_interval
		request = urllib.request.Request(
			url,
			headers={"User-Agent": USER_AGENT, **(headers or {})},
		)
		try:
			with urllib.request.urlopen(request, timeout=60) as response:
				body = response.read().decode("utf-8", "replace")
				status = response.status
				remaining = response.headers.get("x-ratelimit-remaining")
		except urllib.error.HTTPError as error:
			# The body of an HTTP error can still carry an API error (or a
			# throttle notice); surface both to the caller for classification.
			return error.code, error.read().decode("utf-8", "replace")
		except (urllib.error.URLError, OSError) as error:
			raise ApiError(f"request failed at the network layer: {error}", 2) from None
		# Advisory only (see module docstring): a reported empty budget earns a
		# pause, never a skip.
		if remaining is not None and remaining.strip() == "0":
			self._next_ok = max(self._next_ok, time.monotonic() + ADVISORY_BACKOFF_SECONDS)
		return status, body


class FixtureTransport:
	"""Offline stand-in: recorded bodies from a directory, in call order."""

	def __init__(self, root: str) -> None:
		directory = Path(root)
		if not directory.is_dir():
			raise ApiError(f"{FIXTURE_ENV} is not a directory: {root}", 2)
		self._files = sorted(
			entry for entry in directory.iterdir() if entry.is_file()
		)
		if not self._files:
			raise ApiError(f"fixture directory has no files: {root}", 2)

	def get(self, url: str, headers: dict[str, str] | None = None) -> tuple[int, str]:
		# The URL is still built by the caller and recorded in provenance;
		# here it selects nothing. Signature matches HttpTransport.get.
		del url, headers
		if not self._files:
			raise ApiError(
				"fixtures exhausted: the script made more calls than the fixture "
				"directory provides files",
				2,
			)
		text = self._files.pop(0).read_text(encoding="utf-8")
		match = FIXTURE_STATUS_RE.match(text)
		if match:
			return int(match.group(1)), text[match.end() :]
		return 200, text


def make_transport(min_interval: float) -> HttpTransport | FixtureTransport:
	"""The real network unless the fixture variable points somewhere."""
	source = os.environ.get(FIXTURE_ENV, "")
	return FixtureTransport(source) if source else HttpTransport(min_interval)
