# theta-compute — the Theta compute gateway

The M4 compute gateway (ADR 0004): a FastMCP server that wraps the Slurm
CLI on the cluster's login node and speaks MCP over streamable HTTP. The
research agent calls its tools directly through pi's built-in MCP client;
enforcement — bearer auth, the argument guard, one audit line per tool
call — stays server-side. This tree is generic code only: every
institutional fact (the token, the user name, the audit location) rides
deploy-time env, and the npm tarball does not ship it.

## Layout

```
gateway/
  pyproject.toml        locked uv environment (fastmcp, Python >= 3.11)
  uv.lock
  theta_compute/
    config.py           deploy-time env -> one validated Config
    auth.py             the static bearer-token verifier
    guard.py            what may become a Slurm argument at all
    audit.py            the JSONL audit trail and its rotation
    slurm.py            sinfo/squeue wrappers — argv arrays only
    server.py           the FastMCP app, audit middleware, tool surface
```

## Run

```sh
cd gateway
uv run --locked python -m theta_compute
```

The first run builds the environment from `uv.lock`. The server binds
loopback by default; an unauthenticated process on the same host is the
only thing it exposes, and phase-0 wants exactly that (reach it through
an SSH port-forward, below).

## Deploy-time environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `THETA_COMPUTE_TOKEN` | — (required) | the bearer token; the server refuses to start without one |
| `THETA_COMPUTE_USER` | the OS user | the principal the token belongs to; rides every audit line |
| `THETA_COMPUTE_AUDIT_LOG` | `./theta-compute-audit.jsonl` | audit JSONL path |
| `THETA_COMPUTE_AUDIT_MAX_BYTES` | 10485760 | rotation ceiling in bytes |
| `THETA_COMPUTE_SLURM_TIMEOUT` | 30 | per-command Slurm timeout in seconds |
| `THETA_COMPUTE_HOST` | 127.0.0.1 | bind address — keep loopback behind the forward |
| `THETA_COMPUTE_PORT` | 8421 | bind port |

## Tools (S1: the read-only pair)

Both declare the read-only hint and run ungated on the theta side.

- **`list_environments`** — every partition-state group sinfo reports
  (`sinfo --noheader --format "%P|%a|%l|%D|%t|%N"`), parsed to records:
  `partition`, `default`, `availability`, `time_limit`, `nodes`, `state`,
  `node_list`.
- **`job_status(job_id)`** — one job's status
  (`squeue --noheader --format "%i|%T|%j|%P|%M|%R" --job <id>`). A job id
  is digits only in v1; a well-formed id the queue does not hold answers
  `{"found": false, "job_id": ...}` — an answer, not an error.

## The audit trail

One JSONL line per tool call, in this byte shape — canonical JSON, sorted
keys, no whitespace (the user value below is illustrative):

```json
{"args_sha256":"sha256:7c5436bc2d8d4ac0751aff3bc8a18e8286be2c420163ad5e22a6062387794e75","decision":"ALLOW","job_id":"1851277","reason":null,"tool":"job_status","ts":"2026-10-21T01:05:08Z","user":"cluster-user"}
```

| Field | Meaning |
| --- | --- |
| `ts` | UTC ISO-8601 instant of the decision, second resolution |
| `user` | the authenticated principal the token belongs to |
| `tool` | tool name |
| `args_sha256` | `sha256:<hex>` over the canonical JSON of the argument object (sorted keys, no whitespace) — the digest, never the arguments |
| `decision` | `ALLOW` — the guard let the call through; `DENY` — the guard refused before any subprocess ran |
| `job_id` | the call's job-id argument when the tool takes one, else null; on a DENY, the rejected value verbatim when it was a string (the digest always covers the full arguments) |
| `reason` | null on success; a DENY names the refusal; an ALLOW that failed names the failure |

A call without a valid token is answered HTTP 401 by the transport and is
not a tool call — it leaves no audit line. Rotation keeps one prior
generation: past the byte ceiling the current file becomes `<name>.1`
(replacing any earlier one) and a fresh file starts. An institution that
needs deeper history ships the rotated file out on a schedule.

## Offline tests

`test/gateway-mcp.test.mjs` drives both tools at the MCP tool-call
boundary: it spawns this server with the stub `sinfo`/`squeue` binaries
in `test/fixtures/gateway/bin/` first on PATH (the stubs record the argv
they receive — the proof that no shell sits between gateway and Slurm)
and asserts tool results over the wire, the 401 path, the audit lines on
disk, and the guard's refusals. It runs with the repo suite: `npm test`.

## Phase-0 deploy recipe (owner process + SSH forward)

Institutional facts — the SSH alias, the cluster user, the remote
directory — live in the owner's private notes, not in this public tree;
the placeholders below are where they go. Steps 1–4 and a 401 health
check run as one command:

```sh
gateway/deploy.sh <login-node-alias> <remote-dir> <cluster-user> <token-file> [port]
```

1. Copy this subtree to the login node (the cluster's copy is the
   deployed one; institutional facts never come back into git):

   ```sh
   rsync -a --delete --exclude .venv --exclude audit --exclude '.nfs*' \
     gateway/ <login-node-alias>:theta-compute/
   ```

2. Build the environment there. A login node with an older uv (the
   HEBMU one has 0.11) cannot run `--locked` against a lock written by a
   newer uv — one unlocked `uv run` (no `--locked`) builds the
   environment and adapts the cluster's lock copy, and `--locked` holds
   from then on:

   ```sh
   ssh <login-node-alias>
   cd ~/theta-compute
   uv run python -m theta_compute   # builds the environment; Ctrl-C once it listens
   ```

3. Start it there, bound to loopback, with the deploy env in place:

   ```sh
   THETA_COMPUTE_TOKEN=<token> THETA_COMPUTE_USER=<cluster-user> \
     THETA_COMPUTE_AUDIT_LOG=audit/audit.jsonl \
     nohup uv run --locked python -m theta_compute >gateway.out 2>&1 &
   ```

4. From the laptop, forward the port and leave it open:

   ```sh
   ssh -N -L 8421:127.0.0.1:8421 <login-node-alias>
   ```

5. Register the server with pi once, user-level (the default file), so
   the token lives only in the user's own `~/.pi/agent/mcp.json` — never
   in git (the theta-side strike owns the researcher-facing setup; this
   is the one-time owner entry, verified against pi 0.99):

   ```sh
   pi mcp add theta-compute --url http://127.0.0.1:8421/mcp \
     --header "Authorization=Bearer <token>"
   ```
