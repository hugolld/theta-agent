# theta-compute — the Theta compute gateway

The M4 compute gateway (ADR 0004): a FastMCP server that wraps the Slurm
CLI on the cluster's login node and speaks MCP over streamable HTTP. The
research agent calls its tools directly through pi's built-in MCP client;
enforcement — bearer auth, the argument guard, the path sandbox, one
audit line per tool call — stays server-side. This tree is generic code
only: every institutional fact (the token, the user name, the audit
location, the ceilings) rides deploy-time env, and the npm tarball does
not ship it.

## Layout

```
gateway/
  pyproject.toml        locked uv environment (fastmcp, Python >= 3.11)
  uv.lock
  theta_compute/
    config.py           deploy-time env -> one validated Config
    auth.py             the static bearer-token verifier
    guard.py            what may become a Slurm argument or a staged path
    staging.py          the staging root's filesystem half — runs, logs,
                        scripts, artifact reads
    audit.py            the JSONL audit trail and its rotation
    slurm.py            sinfo/squeue/sbatch/scancel wrappers — argv only
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
| `THETA_COMPUTE_USER` | the OS user | the principal the token belongs to; rides every audit line and the job-name prefix |
| `THETA_COMPUTE_AUDIT_LOG` | `./theta-compute-audit.jsonl` | audit JSONL path |
| `THETA_COMPUTE_AUDIT_MAX_BYTES` | 10485760 | rotation ceiling in bytes |
| `THETA_COMPUTE_SLURM_TIMEOUT` | 30 | per-command Slurm timeout in seconds |
| `THETA_COMPUTE_STAGING_ROOT` | `~/theta-compute-runs` | the staging root: every run directory lives under it |
| `THETA_COMPUTE_INBAND_MAX_BYTES` | 33554432 | the in-band transfer cap (32 MiB) for stage and fetch alike |
| `THETA_COMPUTE_PARTITIONS` | `cpu` | the partitions a raw submit may name |
| `THETA_COMPUTE_MAX_WALLTIME` | `24:00:00` | ceiling for `time` |
| `THETA_COMPUTE_MAX_MEM_MB` | 65536 | ceiling for `mem`, in MB |
| `THETA_COMPUTE_MAX_NTASKS` | 16 | ceiling for `ntasks` |
| `THETA_COMPUTE_MAX_CPUS_PER_TASK` | 16 | ceiling for `cpus-per-task` |
| `THETA_COMPUTE_MAX_GPUS` | 1 | ceiling for `gres` (`gpu:N`) |
| `THETA_COMPUTE_HOST` | 127.0.0.1 | bind address — keep loopback behind the forward |
| `THETA_COMPUTE_PORT` | 8421 | bind port |

## Tools

Seven generic tools. The four read-only ones declare the read-only hint
and run ungated on the theta side; `submit_job` and `cancel_job` declare
the destructive hint — the theta-side submit gate confirms them.

- **`list_environments`** — every partition-state group sinfo reports
  (`sinfo --noheader --format "%P|%a|%l|%D|%t|%N"`), parsed to records:
  `partition`, `default`, `availability`, `time_limit`, `nodes`, `state`,
  `node_list`.
- **`job_status(job_id)`** — one job's status
  (`squeue --noheader --format "%i|%T|%j|%P|%M|%R" --job <id>`). A job id
  is digits only in v1; a well-formed id the queue does not hold answers
  `{"found": false, "job_id": ...}` — an answer, not an error.
- **`stage_files(run_name, files)`** — write the given files (base64,
  in-band) into `<staging root>/<run_name>/`. The call lands whole or
  not at all: every path resolves and every byte counts against the cap
  before the first write.
- **`submit_job(run_name, directives?)`** — render the run's guarded
  batch script and submit it (`sbatch <script path>`, argv only).
  Answers `{job_id, job_name, script_path}`.
- **`job_logs(job_id, tail_lines?)`** — the job's stdout and stderr from
  its run directory (the forced `--output`/`--error` put them there),
  tailed to the last `tail_lines` (default 100, max 1000). A job no run
  directory holds a log for answers `found: false`.
- **`cancel_job(job_id)`** — cancel one job, after squeue confirms its
  name carries this user's `theta-<user>-` prefix. A well-formed id the
  queue no longer holds answers `{"found": false, "canceled": false}`.
- **`fetch_artifacts(run_name, paths?)`** — read the run directory back
  in-band (base64): the whole tree by default, or the named picks. Whole
  or not at all — every file is read and sized inside the cap before
  anything returns.

## The guard: sandbox, allow-list, ceilings

- **Path sandbox.** Every path the tools touch resolves under the
  staging root. Lexical escapes (`..`, absolute paths) refuse at the
  argument guard; symlinks that resolve outside the root refuse at
  resolution; a fetch never follows a symlink out. A run name is
  1–64 characters of `[A-Za-z0-9_-]` — a directory name and nothing else.
- **Command guard.** `submit_job` directives are an allow-list, not a
  passthrough: `partition`, `time`, `mem`, `ntasks`, `cpus-per-task`,
  `gres` (`gpu:N`, N ≤ the ceiling). Each value is one token of safe
  characters (no spaces, no newline — nothing that could break out of a
  script line) and each sits under its ceiling. The job name
  (`theta-<user>-<run_name>`, the per-user ownership prefix), the log
  paths (inside the run directory), and the script body are
  gateway-forced: the client controls directives only, never commands —
  commands arrive with templates (S3), never through the raw path.
- **In-band cap.** `stage_files` and `fetch_artifacts` move at most
  `THETA_COMPUTE_INBAND_MAX_BYTES` per call. Past it the refusal names
  the out-of-band path: move the files with scp to (or from) the run
  directory on the cluster — large inputs (an MSA, a feature directory)
  travel that way by design.

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

DENY is strictly pre-dispatch: it covers every refusal decidable from the
arguments alone — shapes, the path sandbox, the directive ceilings, the
in-band cap — and nothing has run when it lands. Refusals that need the
call to run first stay ALLOW with the refusal as the reason: cancelling a
job whose name lacks the ownership prefix (squeue had to answer first),
a fetch past the cap (the run directory had to be read), a symlink in the
fetched tree. The audit trail holds both; the distinction is honest about
what had run.

## Offline tests

`test/gateway-mcp.test.mjs` drives all seven tools at the MCP tool-call
boundary: it spawns this server with the stub `sinfo`/`squeue`/`sbatch`/
`scancel` binaries in `test/fixtures/gateway/bin/` first on PATH (the
stubs record the argv they receive — the proof that no shell sits between
gateway and Slurm) and asserts tool results over the wire, the 401 path,
files in the staging root, the audit lines on disk, and the guard's
refusals. The sbatch stub answers a deterministic job id and writes the
script's forced output file itself, standing in for the scheduler running
the fixed body — so the offline lifecycle (stage, submit, logs, fetch)
runs against real files. It runs with the repo suite: `npm test`.

## Phase-0 deploy recipe (owner process + SSH forward)

Institutional facts — the SSH alias, the cluster user, the remote
directory — live in the owner's private notes, not in this public tree;
the placeholders below are where they go. Steps 1–3 and a 401 health
check run as one command:

```sh
gateway/deploy.sh <login-node-alias> <remote-dir> <cluster-user> <token-file> [port]
```

1. Copy this subtree to the login node (the cluster's copy is the
   deployed one; institutional facts never come back into git):

   ```sh
   rsync -a --delete --exclude .venv --exclude __pycache__ --exclude audit --exclude '.nfs*' \
     gateway/ <login-node-alias>:theta-compute/
   ```

2. Build the environment there. A login node with an older uv (the
   HEBMU one has 0.11) cannot run `--locked` against a lock written by a
   newer uv — one unlocked `uv run` (no `--locked`) builds the
   environment and adapts the cluster's lock copy, and `--locked` holds
   from then on:

   ```sh
   ssh <login-node-alias>
   cd theta-compute
   uv run python -c 'import theta_compute.server'   # adapt the lock; no server starts
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
