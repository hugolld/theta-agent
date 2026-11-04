#!/bin/sh
# One live-gateway probe: initialize → notifications → tools/list → one
# read-only call against the forwarded theta-compute (127.0.0.1:8421), the
# rig-preflight doctrine's forward check with a body. Usage:
#
#   THETA_TOKEN_FILE=<token-file> sh scripts/gateway-probe.sh <out-dir>
#
# Four transport facts this script encodes (learned on the 2026-11-02 live
# leg, spec #116 — none of them confess themselves anywhere else):
#   - undici's fetch (node) answers 406 from the cluster's FastMCP 4.1.3 on
#     the accept header; curl's passes. Probe with curl.
#   - curl -K configs silently drop the tuple form header = ("Name",
#     "value") on this Mac — the string form below is the one that works.
#   - notifications/initialized answers 202, not 200, and has no body.
#   - the session id rides the initialize response header, so -D captures
#     what the payload alone cannot.
#
# The token never rides argv and never lands on disk: it rides the curl
# config's own stdin (a heredoc, not a pipeline). Results land as files in
# <out-dir> (the exit-status rule) and carry the cluster's own payload
# (node lists, partition names) — evidence dirs only, never committed
# fixtures. An in-200 error (isError: true) exits 3, the connector-script
# contract. Multi-step extractions run one unpiped step at a time: the
# exit-status rule this script is the first consumer of says unpiped or
# pipefail — this script takes the unpiped arm for portability: the
# cluster's /bin/sh is unprobed, and the unpiped form runs under any sh.
# lint:sh (#139) carries the disjunction.
set -eu

OUT=${1:-}
[ -n "$OUT" ] && [ -n "${THETA_TOKEN_FILE:-}" ] && [ -f "$THETA_TOKEN_FILE" ] || {
	echo "usage: THETA_TOKEN_FILE=<token-file> sh scripts/gateway-probe.sh <out-dir>" >&2
	exit 1
}
mkdir -p "$OUT"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

req() {
	# req <json-body> — echoes the HTTP code; body and headers land in
	# $TMP. The config rides curl's stdin — the token never argv, never
	# disk — as ONE printf: assembling it from $()-substituted fragments
	# fuses lines (substitution strips trailing newlines, and the fused
	# Authorization/session line reached the wire as one malformed
	# header — the 400 this script shipped on its first run). The printf
	# head of the pipe is a builtin with no failure mode: the only
	# fallible stage is curl, the tail, whose exit is the one observed
	# (the exit-status rule). -S keeps curl's own error audible under -s.
	session_line=""
	[ -n "${SID:-}" ] && session_line=$(printf 'header = "mcp-session-id: %s"' "$SID")
	printf 'header = "Content-Type: application/json"\nheader = "Accept: application/json, text/event-stream"\nheader = "Authorization: Bearer %s"\n%s' \
		"$(cat "$THETA_TOKEN_FILE")" "$session_line" |
		curl -sS --max-time 20 -D "$TMP/headers" -o "$TMP/body" \
			-w '%{http_code}' -K - -X POST http://127.0.0.1:8421/mcp -d "$1"
}

sse_last() {
	# The last SSE data: line as JSON, one unpiped step at a time: a body
	# with no data: lines fails at grep's own exit instead of hiding
	# behind sed's.
	grep '^data: ' "$TMP/body" >"$TMP/sse" || return 1
	tail -n 1 "$TMP/sse" >"$TMP/last"
	sed 's/^data: //' "$TMP/last"
}

code=$(req '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"gateway-probe","version":"0"}}}')
[ "$code" = "200" ] || { echo "initialize -> $code (is the forward up?)" >&2; exit 1; }
# The session id rides the response header — captured because -D wrote
# it; unpiped here too (tr to a file, then sed reads it).
tr -d '\r' <"$TMP/headers" >"$TMP/headers-clean"
SID=$(sed -n 's/^[Mm][Cc][Pp]-[Ss][Ee][Ss][Ss][Ii][Oo][Nn]-[Ii][Dd]: *//p' "$TMP/headers-clean")

# A notification answers 202 with no body.
code=$(req '{"jsonrpc":"2.0","method":"notifications/initialized"}')
[ "$code" = "202" ] || { echo "notifications/initialized -> $code" >&2; exit 1; }

code=$(req '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}')
[ "$code" = "200" ] || { echo "tools/list -> $code" >&2; exit 1; }
sse_last >"$TMP/listed.json"
node -e '
	const listed = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
	const tools = listed.result.tools.map((t) => ({
		name: t.name,
		readOnlyHint: t.annotations?.readOnlyHint ?? null,
		destructiveHint: t.annotations?.destructiveHint ?? null,
	}));
	require("fs").writeFileSync(process.argv[2], JSON.stringify(tools, null, "\t") + "\n");
	console.log("tools/list:", tools.length, "tools:", tools.map((t) => t.name).join(", "));
' "$TMP/listed.json" "$OUT/tools-list.json"

code=$(req '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_environments","arguments":{}}}')
[ "$code" = "200" ] || { echo "tools/call list_environments -> $code" >&2; exit 1; }
sse_last >"$TMP/env.json"
node -e '
	const call = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
	require("fs").writeFileSync(process.argv[2], JSON.stringify(call.result, null, "\t") + "\n");
	const envs = JSON.parse(call.result.content[0].text).environments;
	console.log("list_environments:", call.result.isError ? "ERROR" : "ok,", envs.length, "partition-state groups");
	process.exit(call.result.isError ? 3 : 0);
' "$TMP/env.json" "$OUT/list-environments.json"

echo "probe complete"
