#!/bin/sh
# One live-gateway probe: initialize → notifications → tools/list → one
# read-only call against the forwarded theta-compute (127.0.0.1:8421), the
# rig-preflight doctrine's forward check with a body. Usage:
#
#   THETA_TOKEN_FILE=~/.theta-compute-token sh scripts/gateway-probe.sh <out-dir>
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
# The token rides the 0600 curl config file, never argv or a shell string.
# Results land as files in <out-dir> (the exit-status rule: the channel is
# shared with payload output), and the script's own exit gates the caller.
set -eu

OUT=${1:-}
TOKEN_FILE=${THETA_TOKEN_FILE:-"$HOME/.theta-compute-token"}
[ -n "$OUT" ] && [ -f "$TOKEN_FILE" ] || {
	echo "usage: THETA_TOKEN_FILE=<file> sh scripts/gateway-probe.sh <out-dir>" >&2
	exit 1
}
mkdir -p "$OUT"
TMP=$(mktemp -d)
CFG="$TMP/curl-config"
umask 077

req() {
	# req <json-body> — sends with the captured session header when one
	# exists; writes the body to $TMP/body, echoes the HTTP code.
	{
		printf 'header = "Content-Type: application/json"\n'
		printf 'header = "Accept: application/json, text/event-stream"\n'
		printf 'header = "Authorization: Bearer %s"\n' "$(cat "$TOKEN_FILE")"
		[ -n "${SID:-}" ] && printf 'header = "mcp-session-id: %s"\n' "$SID"
	} >"$CFG"
	curl -s --max-time 20 -D "$TMP/headers" -o "$TMP/body" -w '%{http_code}' \
		-K "$CFG" -X POST http://127.0.0.1:8421/mcp -d "$1"
}

code=$(req '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"gateway-probe","version":"0"}}}')
[ "$code" = "200" ] || { echo "initialize -> $code (is the forward up?)" >&2; exit 1; }
SID=$(tr -d '\r' <"$TMP/headers" | sed -n 's/^[Mm][Cc][Pp]-[Ss][Ee][Ss][Ss][Ii][Oo][Nn]-[Ii][Dd]: *//p')

# A notification answers 202 with no body.
code=$(req '{"jsonrpc":"2.0","method":"notifications/initialized"}')
[ "$code" = "202" ] || { echo "notifications/initialized -> $code" >&2; exit 1; }

code=$(req '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}')
[ "$code" = "200" ] || { echo "tools/list -> $code" >&2; exit 1; }
grep '^data: ' "$TMP/body" | tail -1 | sed 's/^data: //' >"$TMP/listed.json"
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
grep '^data: ' "$TMP/body" | tail -1 | sed 's/^data: //' >"$TMP/env.json"
node -e '
	const call = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
	require("fs").writeFileSync(process.argv[2], JSON.stringify(call.result, null, "\t") + "\n");
	const envs = JSON.parse(call.result.content[0].text).environments;
	console.log("list_environments:", call.result.isError ? "ERROR" : "ok,", envs.length, "partition-state groups");
' "$TMP/env.json" "$OUT/list-environments.json"

rm -rf "$TMP"
echo "probe complete"
