# 0006 — A server-held capability bounds submits

- **Status**: accepted (2026-10-30)
- **Context**: M4's only gate over job creation is the Submit gate, a client-side pi permission extension (GLOSSARY). A harness defect, a codemode-nested call path, or a second client that skips the package submits with no confirm — the gate-bypass residual ADR 0004 records; MCP registration timing is unchanged upstream, so bounding that residual is Theta's to do. The gateway itself had no out-of-band control either: no way to hold submits during an incident, and no audit answer to "were submits enabled when this call arrived?". Specs #92 and #93 (the M5 S0 tracer).
- **Decision**: A deploy-time submit capability (GLOSSARY) on the gateway — `THETA_COMPUTE_SUBMIT_CAPABILITY`, boolean-until-off: unset means on, and only an explicit `off` holds. The value is read once at boot into the Config snapshot and never lives in the process, so a restart of the same deploy keeps it by construction. On the cluster the state rides `theta-compute.env` beside the deploy: rsync never touches it, every start line sources it (deploy.sh and the README runbook), a file that fails to source aborts the start, and where the file and the start line both name a variable the start line wins. While off, the job-creating tools (`submit_job`, `run_alphafold3`) answer a hard refusal pre-dispatch — before the argument guard, nothing written, nothing run — recorded as its own audit-line kind (`decision: "HOLD"`) with the observed state riding every mutating tool's line (`submit_capability`). `cancel_job` stays in service during a hold (remediation, not creation) and the read-only tools are unaffected. Layering: pi's confirm stays the inner, per-call gate; the capability is the outer bound that holds even for a client that bypasses the package. This ADR is the M5 epic's "ADR 0005 (safety-gate architecture)", renumbered because the clean-room rig took 0005 first; the S1 throttle and the S2 gate framework land as instances under this architecture.

## Considered options

- **An in-band set-capability tool** — the clients this bound exists for are exactly the ones that could call it; it also breaks the fixed-tool-surface rule (ADR 0004). Rejected.
- **State derived from the audit log at boot** — no state file at all, but boot couples to the log format, a fresh deploy holds until proven on, and the epic's decision is deploy-time env. Rejected.
- **A deploy.sh argument as the channel, like the token file** — the state would live on the laptop; a manual on-cluster restart from the README runbook, or an unargued redeploy, silently re-enables submits. The cluster-side env file survives both paths. Rejected.

## Consequences

- Held submits are countable with one query over `decision: "HOLD"`, and every mutating-tool line answers "were submits enabled?" with no second source.
- One call, one line: when a hold and a guard refusal both apply, the HOLD line wins — the outer bound answered. The S1 throttle inherits the same rule under the capability.
- The audit line's byte shape grows a third decision value and the mutating-only `submit_capability` field; prior lines remain valid JSON of the earlier shape, and the offline boundary tests (which deep-equal full lines) moved in this strike.
- A broken `theta-compute.env` aborts the start and the deploy rather than silently dropping its state — the same fail-loudly contract as a missing token.
- ADR 0004's gate-bypass residual is bounded for job creation: a bypassing client now reaches a gateway that can refuse. The registration-timing exposure itself is unchanged upstream and stays recorded there.
