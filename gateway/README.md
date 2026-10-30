# theta-compute — the Theta compute gateway

The M4 compute gateway (ADR 0004): a FastMCP server that wraps the Slurm
CLI on the cluster's login node and speaks MCP over streamable HTTP. The
research agent calls its tools directly through pi's built-in MCP client;
enforcement — bearer auth, the argument guard, the path sandbox, one
audit line per tool call — stays server-side. This tree is generic code
only: every institutional fact (the token, the user name, the audit
location, the ceilings) rides deploy-time env, and the npm tarball does
not ship it. A deploy-time submit capability (ADR 0006) is the outer
bound around job creation: while it is off, the job-creating tools answer
a hard refusal no client can talk its way past.

## Layout

```
gateway/
  pyproject.toml        locked uv environment (fastmcp, Python >= 3.11)
  uv.lock
  pyrightconfig.json     pins Pyright to .venv and Python 3.12 (editor
                        diagnostics; no CI leg runs it)
  theta_compute/
    config.py           deploy-time env -> one validated Config
    auth.py             the static bearer-token verifier
    guard.py            what may become a Slurm argument or a staged path
    staging.py          the staging root's filesystem half — runs, logs,
                        scripts, artifact reads
    audit.py            the JSONL audit trail and its rotation
    slurm.py            sinfo/squeue/sbatch/scancel wrappers — argv only
    templates.py        the template registry: load, validate, render
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
| `THETA_COMPUTE_SUBMIT_CAPABILITY` | `on` | `on`/`off` — while `off`, `submit_job` and `run_alphafold3` answer a hard refusal (a HOLD audit line); `cancel_job` and the read-only tools stay in service (ADR 0006) |
| `THETA_COMPUTE_AUDIT_LOG` | `./theta-compute-audit.jsonl` | audit JSONL path |
| `THETA_COMPUTE_AUDIT_MAX_BYTES` | 10485760 | rotation ceiling in bytes |
| `THETA_COMPUTE_SLURM_TIMEOUT` | 30 | per-command Slurm timeout in seconds |
| `THETA_COMPUTE_STAGING_ROOT` | `~/theta-compute-runs` | the staging root: every run directory lives under it |
| `THETA_COMPUTE_TEMPLATES` | — (unset) | the template registry directory; unset leaves the seven generic tools as the whole surface |
| `THETA_COMPUTE_INBAND_MAX_BYTES` | 33554432 | the in-band transfer cap (32 MiB) for stage and fetch alike |
| `THETA_COMPUTE_PARTITIONS` | `cpu` | the partitions a raw submit may name |
| `THETA_COMPUTE_MAX_WALLTIME` | `24:00:00` | ceiling for `time` |
| `THETA_COMPUTE_MAX_MEM_MB` | 65536 | ceiling for `mem`, in MB |
| `THETA_COMPUTE_MAX_NTASKS` | 16 | ceiling for `ntasks` |
| `THETA_COMPUTE_MAX_CPUS_PER_TASK` | 16 | ceiling for `cpus-per-task` |
| `THETA_COMPUTE_MAX_GPUS` | 1 | ceiling for `gres` (`gpu:N`); 0 removes `gres` from the raw path entirely |
| `THETA_COMPUTE_HOST` | 127.0.0.1 | bind address — keep loopback behind the forward |
| `THETA_COMPUTE_PORT` | 8421 | bind port |

## Tools

Seven generic tools, plus the typed `run_alphafold3` when a template
registry is configured (below). The four read-only ones declare the
read-only hint and run ungated on the theta side; `submit_job`,
`cancel_job`, and `run_alphafold3` declare the destructive hint — the
theta-side submit gate confirms them. All of that sits inside a second,
server-held bound: the submit capability, below.

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
- **`run_alphafold3(run_name, fold_input)`** — the typed tool: validate
  the AF3-native fold-input JSON (name, sequences, modelSeeds, dialect
  `"alphafold3"`, version 1), stage its canonical bytes into the run
  directory, render the registered template's free variables only, and
  submit. Answers `{job_id, job_name, script_path, fold_input_path,
  output_dir}`. Registered only when `THETA_COMPUTE_TEMPLATES` is set and
  its registry registers an `alphafold3` template.

## The submit capability

The outer bound (ADR 0006), deploy-time and server-held: while
`THETA_COMPUTE_SUBMIT_CAPABILITY` is `off`, `submit_job` and
`run_alphafold3` answer a hard refusal — pre-dispatch, before the guard,
with nothing written and nothing run. The refusal is its own audit-line
kind (`decision: "HOLD"`, below), so held submits are countable like
denials, and every mutating tool's line carries the capability the call
observed. `cancel_job` stays in service during a hold — a hold is
exactly when a runaway needs cancelling — and the read-only tools are
unaffected; `tools/list` keeps advertising the held tools, because the
hold is a call-time refusal, not a vanishing surface. The theta-side
confirm gate stays the inner, per-call gate; this one stands even for a
client that bypasses the package.

The capability is boolean-until-off: unset means `on`, and only an
explicit `off` holds. Its state never lives in the process — it is the
deploy env, so a restart of the same deploy keeps it by construction. On
the cluster the state rides `theta-compute.env` beside the deploy (rsync
never touches it), sourced by every start line — deploy.sh and the
runbook below both do it — so a redeploy cannot silently re-enable
submits. Where the file and the start line both name a variable, the
start line's own assignment wins. A hold or an enable is one edit plus
a restart:

```sh
ssh <login-node-alias>
cd <remote-dir>
echo 'THETA_COMPUTE_SUBMIT_CAPABILITY=off' > theta-compute.env   # the hold
# echo 'THETA_COMPUTE_SUBMIT_CAPABILITY=on' > theta-compute.env  # the enable
# then restart with the phase-0 start command (step 3), which sources the file
```

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

## The template registry

Typed tools render institutional job templates — the cluster's own
production scripts, never files in this repo (ADR 0004). The registry is
one deploy-time directory (`THETA_COMPUTE_TEMPLATES`) holding each
template's script beside a `registry.json` manifest:

```json
{
	"alphafold3": {
		"script": "alphafold3.sbatch",
		"free": ["RUN_DIR", "JOB_NAME"],
		"input_file": "af_input/fold_input.json",
		"output_dir": "af_output"
	}
}
```

- **Free variables** are the only client-shaped parts of a rendered
  script, and the vocabulary is closed: `{{RUN_DIR}}` (the run
  directory, absolute — the `cd` and the input/output binds) and
  `{{JOB_NAME}}` (the gateway-forced `theta-<user>-` ownership name).
  A template declares exactly the tokens its script carries; a declared
  token the script never uses, a token the manifest never declared, or a
  name outside the vocabulary refuses at startup.
- **`input_file` and `output_dir`** are paths inside the run directory —
  the manifest's own words must match what the script's fixed text binds
  on the container side; the registry validates the shapes (relative,
  no escapes), the deploy keeps the two consistent.
- **Startup validation.** A missing `registry.json`, invalid JSON, a
  missing script, or a registry that registers no `alphafold3` template
  refuses to boot — the same fail-loudly contract as a missing token.
  A directory that registers only other templates is legal for the
  registry and fatal for the typed tool, which has nothing to render.
- Everything else in the script is fixed text: partition, gres, binds,
  the SIF, the runner line. `run_alphafold3` takes no directives at all
  — any extra argument is an override attempt and a guard refusal.

Spec #49's optional project code is deliberately absent from v1: the
probed production template carries no account line to render it into,
so the closed vocabulary is that decision on record. The vocabulary
grows when an institutional template needs one.

The on-cluster recipe (owner, one time): copy the production af3 template
into the registry directory, replace the run-dir occurrences (the `cd`
and the three run binds) with `{{RUN_DIR}}` and the job name with
`{{JOB_NAME}}`, keep single `fold_input.json` as the input contract, and
write `registry.json` beside it. The probed live template, its drift
findings, and the pinned values (XLA_FLAGS line, platform model and
database paths, the nvidia bind) live on-cluster in the template mirror —
institutional facts, not repo content.

## The audit trail

One JSONL line per tool call, in this byte shape — canonical JSON, sorted
keys, no whitespace (the user value below is illustrative):

```json
{"args_sha256":"sha256:7c5436bc2d8d4ac0751aff3bc8a18e8286be2c420163ad5e22a6062387794e75","decision":"ALLOW","job_id":"1851277","reason":null,"tool":"job_status","ts":"2026-10-21T01:05:08Z","user":"cluster-user"}
```

And a held submit, its own kind (the mutating-only field rides it):

```json
{"args_sha256":"sha256:9a1f…","decision":"HOLD","job_id":null,"reason":"the submit capability is off — job-creating calls (submit_job, run_alphafold3) are held; the enable is out-of-band: the deploy env (theta-compute.env), see gateway/README.md; report the hold to the researcher and do not retry","submit_capability":"off","tool":"submit_job","ts":"2026-10-30T09:15:42Z","user":"cluster-user"}
```

| Field | Meaning |
| --- | --- |
| `ts` | UTC ISO-8601 instant of the decision, second resolution |
| `user` | the authenticated principal the token belongs to |
| `tool` | tool name |
| `args_sha256` | `sha256:<hex>` over the canonical JSON of the argument object (sorted keys, no whitespace) — the digest, never the arguments |
| `decision` | `ALLOW` — the guard let the call through; `DENY` — the guard refused before any subprocess ran; `HOLD` — the submit capability was off, so a job-creating call never reached the guard or a tool (ADR 0006) |
| `job_id` | the call's job-id argument when the tool takes one; else the id a successful `submit_job` minted; on a DENY it is the rejected value verbatim when it was a string (the digest always covers the full arguments) |
| `submit_capability` | `"on"`/`"off"` on lines for mutating tools (`stage_files`, `submit_job`, `cancel_job`, `run_alphafold3`) — the capability the call observed, on every decision; absent on read-only lines |
| `reason` | null on success; a DENY names the refusal; an ALLOW that failed names the failure; a HOLD names the hold |

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
what had run. The capability is checked before the guard: a call that
would fail both answers HOLD — one call, one line, and the outer bound is
the one that answered.

## Offline tests

`test/gateway-mcp.test.mjs` drives all seven tools at the MCP tool-call
boundary: it spawns this server with the stub `sinfo`/`squeue`/`sbatch`/
`scancel` binaries in `test/fixtures/gateway/bin/` first on PATH (the
stubs record the argv they receive — the proof that no shell sits between
gateway and Slurm) and asserts tool results over the wire, the 401 path,
files in the staging root, the audit lines on disk, and the guard's
refusals. `test/gateway-templates.test.mjs` drives `run_alphafold3` the
same way against the synthetic fixture registry in
`test/fixtures/gateway/templates/` (shaped like the probed production
template, generic paths — the real one is institutional), including the
registry's boot refusals. Both share the harness in
`test/helpers/gateway.mjs`. The sbatch stub answers a deterministic job
id and writes the script's forced output file itself, standing in for the
scheduler running the fixed body — so the offline lifecycle (stage,
submit, logs, fetch, fold) runs against real files. The same files drive
the submit capability: the held path (a HOLD line, nothing written,
nothing run — even when the guard would also refuse), cancel and the
read-only tools in service during a hold, the observed state on mutating
lines, the restart that keeps holding, and the boot refusal on a value
that is neither on nor off. It runs with the repo
suite: `npm test`.

## Phase-0 deploy recipe (owner process + SSH forward)

Institutional facts — the SSH alias, the cluster user, the remote
directory — live in the owner's private notes, not in this public tree;
the placeholders below are where they go. Steps 1–3 and a 401 health
check run as one command:

```sh
gateway/deploy.sh <login-node-alias> <remote-dir> <cluster-user> <token-file> [port] [templates-dir]
```

1. Copy this subtree to the login node (the cluster's copy is the
   deployed one; institutional facts never come back into git — and
   neither does `theta-compute.env`, the cluster-side deploy state the
   next step's start line sources):

   ```sh
   rsync -a --delete --exclude .venv --exclude __pycache__ --exclude audit --exclude '.nfs*' \
     --exclude theta-compute.env \
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

3. Start it there, bound to loopback, with the deploy env in place
   (`THETA_COMPUTE_TEMPLATES` names the on-cluster template registry
   directory when the typed tool is in service). The start sources
   `theta-compute.env` when present — the cluster-side deploy state, the
   submit capability today — and a file that fails to source aborts the
   start rather than silently dropping its state; the start line's own
   assignments win where both name a variable:

   ```sh
   if [ -f theta-compute.env ]; then set -a; . ./theta-compute.env; set +a; fi
   THETA_COMPUTE_TOKEN=<token> THETA_COMPUTE_USER=<cluster-user> \
     THETA_COMPUTE_AUDIT_LOG=audit/audit.jsonl \
     THETA_COMPUTE_TEMPLATES=<templates-dir> \
     nohup uv run --locked python -m theta_compute >gateway.out 2>&1 &
   ```

4. From the laptop, forward the port and leave it open:

   ```sh
   ssh -N -L 8421:127.0.0.1:8421 <login-node-alias>
   ```

5. Register the server with pi once, user-level (the default file), so
   the token lives only in the user's own `~/.pi/agent/mcp.json` — never
   in git. This command is the researcher-facing setup too; its home in
   the docs is the root README's "Compute gateway setup" section (verified
   against pi 1.4.0):

   ```sh
   pi mcp add theta-compute --url http://127.0.0.1:8421/mcp \
     --header "Authorization=Bearer <token>"
   ```
