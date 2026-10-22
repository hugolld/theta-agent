#!/bin/sh
# Deploy theta-compute to a login node — the phase-0 recipe from
# gateway/README.md as one command. Institutional facts (ssh alias, remote
# directory, cluster user) arrive as arguments and never live in this
# public tree; the token is read from a local file so it never rides in a
# process listing or a shell's history.
#
# Usage: deploy.sh <ssh-alias> <remote-dir> <cluster-user> <token-file> [port]
# remote-dir is absolute or relative to the remote home — a quoted tilde
# does not expand on the far side, so pass `hpc_projects/theta-compute`,
# not `~/hpc_projects/theta-compute`.
#
# What it does: rsync the tree (never touching the remote audit log or
# venv), adapt the remote lock copy for an older uv, restart the gateway
# bound to loopback, and wait for the 401 that means listening-and-
# authenticating. The pkill pattern brackets one letter so this script's
# own remote shell can never match it.
set -eu

alias_name=${1:-}
remote_dir=${2:-}
cluster_user=${3:-}
token_file=${4:-}
port=${5:-8421}

[ -n "$alias_name" ] && [ -n "$remote_dir" ] && [ -n "$cluster_user" ] && [ -f "$token_file" ] ||
	{ echo "usage: deploy.sh <ssh-alias> <remote-dir> <cluster-user> <token-file> [port]" >&2; exit 1; }

repo_root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)

# uv may live in ~/.local/bin on the login node, off the non-interactive PATH.
remote="export PATH=\"\$HOME/.local/bin:\$PATH\"; cd '$remote_dir'"

echo "rsync gateway/ -> $alias_name:$remote_dir"
# .nfs* are NFS silly-renames of files a live process still holds open —
# not ours to delete; they clear when the process exits.
rsync -a --delete --exclude .venv --exclude __pycache__ --exclude audit --exclude '.nfs*' \
	"$repo_root/gateway/" "$alias_name:$remote_dir/"

# The remote uv may be older than the one that wrote uv.lock; one unlocked
# run adapts the remote lock copy (README deploy step 2). A no-op when
# the lock is already current for that uv.
ssh "$alias_name" "$remote && uv run python -c 'import theta_compute.server'"

# The anchored pattern spares bystanders (a grep over the audit log) while
# still matching both the uv wrapper and the python it runs.
ssh "$alias_name" "pkill -f '(python|uv run).*theta[_]compute'" || true
sleep 1
ssh "$alias_name" "read -r token; export PATH=\"\$HOME/.local/bin:\$PATH\"; cd '$remote_dir' && \
	THETA_COMPUTE_TOKEN=\$token THETA_COMPUTE_USER='$cluster_user' \
	THETA_COMPUTE_AUDIT_LOG=audit/audit.jsonl THETA_COMPUTE_PORT='$port' \
	nohup uv run --locked python -m theta_compute >gateway.out 2>&1 < /dev/null &" \
	< "$token_file"

payload='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"deploy","version":"0"}}}'
# One connection, remote wait: the bastion resets rapid serial connects,
# so the 401 loop runs on the far side of a single ssh — the payload rides
# stdin (its quotes are never re-parsed), same 40 x 1s budget.
code=$(printf '%s' "$payload" | ssh "$alias_name" '
	read -r json
	i=0
	while [ "$i" -lt 40 ]; do
		c=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
			http://127.0.0.1:'"$port"'/mcp -H "content-type: application/json" \
			-H "accept: application/json, text/event-stream" -d "$json")
		[ "$c" = "401" ] && { echo 401; exit 0; }
		i=$((i + 1))
		sleep 1
	done
	echo timeout' 2>/dev/null || true)
if [ "$code" = "401" ]; then
	echo "gateway up: 401 without a token on $alias_name 127.0.0.1:$port"
	exit 0
fi
echo "gateway did not answer 401 within 40s — check $remote_dir/gateway.out" >&2
exit 1
