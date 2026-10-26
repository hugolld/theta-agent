---
name: theta-compute
description: Theta's compute doctrine - drives the theta-compute gateway (the compute gateway MCP server on the cluster's login node) through the whole Slurm job lifecycle, staging inputs, submitting, polling with discipline, fetching artifacts, and recording every job ID in the project notebook. Use when a research task needs cluster compute, an AlphaFold3 structure prediction, or the status, logs, or artifacts of a job an earlier session started. The model calls the gateway's tools directly; oversized inputs travel out-of-band by scp; destructive calls are confirmed by the submit gate before they reach the cluster.
license: MIT
metadata:
  version: "0.2.0"
  authorship: self-authored
---

# Theta compute

The gateway skill: the doctrine for running cluster jobs through the
**compute gateway** (ADR 0004) — the `theta-compute` MCP server wrapping the
Slurm CLI on the cluster's login node. Enforcement (bearer auth, the argument
guard, the path sandbox, one audit line per call) stays server-side; this
skill carries the judgment — when to stage, submit, poll, fetch, and record.
There are no helper scripts here: call the gateway's tools directly.

## Before the first call

The gateway is reached through a port-forward to the login node (phase-0).
If a call fails to connect, the forward is down — tell the researcher; do
not retry in a loop. Setup lives in the package README ("Compute gateway
setup"); the registration is one-time and user-level.

Start every compute task with `list_environments` — it shows the partitions
and their state, and a partition drained or down changes the plan before any
job is staged.

## The lifecycle

One run of the loop, in order:

1. **Stage** — `stage_files(run_name, files)` writes the inputs into the
   run's directory under the staging root. Pick a short, descriptive
   `run_name` (`[A-Za-z0-9_-]`); it names the directory and the job. The
   in-band cap is 32 MiB per call; past it the refusal names the out-of-band
   path — move large inputs (an MSA, a feature directory) into the run
   directory with `scp` and say so in the report.
2. **Submit** — `submit_job(run_name, directives?)` for a raw batch job, or
   `run_alphafold3(run_name, fold_input)` for the typed AlphaFold3 path
   (fold-input JSON in, job out). Either answer carries the `job_id` — the
   handle for everything that follows. Directives stay inside the gateway's
   allow-list and ceilings; the fixed partition/gres defaults are the
   cluster's own production values, so pass directives only when the task
   genuinely needs them.
3. **Poll** — `job_status(job_id)` until the job leaves the queue. Poll
   with discipline (below).
4. **Fetch** — `fetch_artifacts(run_name)` brings the run directory back
   (whole tree by default, named picks when the manifest is known). Same
   in-band cap; oversized outputs ride `scp` out of the run directory.
5. **Record** — close the run out in the project notebook. Assemble the job
   record from the answers in hand — job ID, gateway, run name, template
   (null for a raw submit), argument digest (the sha256 of the job's
   canonical input), final state, and the artifact manifest when
   `fetch_artifacts` answered (paths and sizes; strip the contents) — save
   it as JSON, and append it through `theta-notebook`'s recorder with
   `--method` and `--job-record`, graded `re-executed` when the artifacts
   were fetched and `asserted` otherwise. A recorded job ID is durable —
   any later session can re-fetch its artifacts or cross-check its state
   without this one's memory.

## Poll discipline

- Poll `job_status` at sane intervals; a queued job waits on the scheduler,
  and tight polling changes nothing. Between polls, do other work or end
  the turn — never spin on status calls.
- A job still queued after unusually long (compare `list_environments` for
  partition state) is a report to the researcher, not a reason to resubmit.
- On a failed or unexpected state, read `job_logs(job_id)` before
  concluding anything; the log tail is the evidence.
- Never call `cancel_job` without the researcher's explicit request — it is
  a destructive call and the submit gate prompts for it like a submission.
- Long jobs survive the session: jobs live in Slurm, the session does not.
  Record the job ID first, then it is safe to close the laptop; a later
  session resumes from the notebook, polls the same job ID, and fetches.

## The submit gate

The package's submit gate extension asks the researcher before every
destructive gateway call — `submit_job`, `cancel_job`, and
`run_alphafold3`. That confirm dialog is part of the flow, not friction:
state what is about to run and let the answer land. A refused call stays
refused — never retry it unprompted. Read-only calls (`job_status`,
`job_logs`, `list_environments`, `fetch_artifacts`) and staging run without
prompts; monitoring stays frictionless.

## Boundaries

- Call the gateway's tools directly. No wrapper scripts, no SSH by hand
  while the gateway is up — an SSH session bypasses the audit trail the
  institution requires.
- One `run_name` per compute task; reuse a name only to restage the same
  task's inputs deliberately, never to mix two tasks' files.
- Report the job ID, the final state, and where the artifacts landed in the
  workspace — the researcher must be able to find the run without the
  transcript.
