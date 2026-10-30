# Pi codemode: semantics, pipeline binding, and what K-Dense usage implies for Theta

Date: 2026-10-30

Scope note: this note answers research ticket #84 (wayfinder, map #80). It pins what pi's
codemode is, which release shipped it, how it binds to the tool-call pipeline Theta's gates
ride on, and its configuration points, then reads the K-Dense BYOK reference study's
"pi's built-in MCP + codemode" usage line for what it implies at M5. Facts come from the
pi-coding-agent 1.4.0 tarball (read as data, never executed), the pi repo's changelog and
design PR over GitHub, the vault study (read-only), K-Dense public repo probes, and this
repo's own deployment facts and M4 evidence. Quotations are transcribed to plain ASCII.

Source ids used inline:

- [P1] @earendil-works/pi-coding-agent 1.4.0 npm tarball (`npm pack`, unpacked read-only).
  Citations are file paths and line numbers against the tarball's `package/` root.
- [P2] earendil-works/pi, `packages/coding-agent/CHANGELOG.md` at `main`, fetched 2026-10-30.
- [P3] earendil-works/pi PR #10040, "feat(coding-agent): Codemode and MCP", fetched 2026-10-30.
- [K1] Vault record: "2026-10-01 Research Record - K-Dense BYOK Reference Study.md" (read-only).
- [K2] K-Dense-AI/k-dense-byok public repo probes, 2026-10-30: README, `docs/architecture.md`,
  issue search, full file tree, `server/src/agent/run-pipeline.ts`.
- [T1] This repo and this machine: `test/rig/` (Dockerfile, run.mjs), `bin/theta.mjs`,
  `extensions/submit-gate.ts`, the user-level pi MCP registration (structure only), and the
  M4 S1 live session transcript under the evidence directory named in CLAUDE.local.md.

## 1. Executive summary

- Codemode is a **built-in tool**, not a mode: the model writes a JavaScript script, pi runs it
  in a QuickJS sandbox, and the script calls pi's other tools (including `bash` and MCP tools)
  as async functions [P1]. It is **not** model-driven raw shell; every shell action is still a
  nested `bash` tool call through the normal pipeline.
- It shipped in **pi 0.99.0 (2026-09-29)** under the exact name `codemode`, headline "Codemode
  and MCP" [P2]. The ticket's 1.2-1.4 window only contains refinements (`reachesTools` in 1.2.0,
  worker admission in 1.3.0, free-worker queueing in 1.4.0). No rename ever happened.
- `tool_call` events **fire for both layers**: the `codemode` call itself, and every nested call
  the script makes (`parentToolCallId` links them). Extension gates can block and mutate nested
  calls "exactly as for direct calls" [P1]. The submit gate's `mcp__theta_compute__` prefix match
  keeps working under codemode — verified in Theta's own M4 S1 transcript [T1].
- Configuration: opt-in by tool selection (`defaultTools` `"+codemode"`, `--tools +codemode`),
  disable with `"-builtin:codemode"`; **no codemode-specific allowlist or confirmation exists** —
  the only approval mechanism is the generic extension `tool_call` gate [P1].
- The Theta-critical coupling: **the default MCP server exposure is `codemode`, and pi
  auto-activates the codemode tool when such a server connects** [P1]. The theta-compute
  registration carries only `url` and an auth header, so gateway sessions already run codemode
  auto-activated — the M4 S1 live evidence shows the model driving the gateway through codemode
  scripts [T1].
- K-Dense ships codemode-on to its end users with its guard layered on the same pipeline seam
  [K1][K2] — independent confirmation that pipeline-bound gating is the intended control point
  when codemode is active. The clean-room rig is unaffected today (no MCP config enters the
  container), with re-pin watch items listed in section 8.

## 2. What codemode is

"The `codemode` tool lets the model write a JavaScript script that calls pi's other tools and
runs non-LLM models, such as classifiers and image models. Only the script's output reaches the
model, so a script can run calls in parallel and filter large results before the model sees
them." [P1: docs/codemode.md:3]

The tool input is raw JavaScript source (not JSON, not a fenced block):

"It runs as the body of an async function in a QuickJS sandbox, so top-level `await` and
`return` work. The sandbox has no Node APIs, file system, network, or timers; scripts reach the
outside world only through tools and `models`." [P1: docs/codemode.md:7]

Execution model, pinned from the type declarations:

- The model emits an ordinary tool call named `codemode` whose arguments carry the script
  source; the tool's input schema is a single `code` string [P1: dist/extensions/codemode/tool.d.ts:58-61].
- Inside the script, `tools.bash({...})`, `tools.read({...})`, `tools["mcp__server__tool"]({...})`
  resolve to structured results (`bash` yields output, truncated flag, exit code, wall time);
  `Promise.all` composes parallel calls [P1: docs/codemode.md:43].
- "Only the script's output reaches the model; nested results do not." [P1:
  dist/extensions/codemode/tool.d.ts:9-10]
- The sandbox is a real isolate: `quickjs-wasi` 3.6.2 is a pinned dependency, and the VM runs in
  a worker so a spinning script cannot wedge the host thread [P1: package.json:61; P3 commit
  "run scripts in a QuickJS wasm VM inside the worker"].

Design lineage, from the PR that added it: "The `codemode` tool in coding-agent is compatible
with Codex's `exec` tool, and `codemode.mode` works like Codex's tool modes (`on` or `only`).
[...] The main motivation is models like Jev, which work much better with a sandbox that
composes tools than with plain tool calls." [P3]

So the ticket's "model-driven shell execution?" resolves to: model-driven **scripted tool
composition**. Shell is reachable, but only as a nested `bash` tool call that goes through the
same pipeline as any model-issued call — there is no direct shell channel and no pipeline
bypass (section 4).

Stated limits: 256 MB VM per script; optional `timeout_ms` hard deadline; output caps (16 Mi
characters, 100k output items); at most two workers per pi process; no timers; "Scripts cannot
start other `codemode` scripts" [P1: docs/codemode.md:224-230]. Built-ins are frozen before the
script runs, so prototype patches have no effect [P1: CHANGELOG.md:241, 1.0.4].

## 3. Which release shipped it

**0.99.0, released 2026-09-29.** The feature headline is "Codemode and MCP", and the Added
entry reads: "Added codemode, tool search, and MCP support as built-in extensions. The
`codemode` tool runs model-written JavaScript in a QuickJS sandbox that calls pi's tools;
enable it with `defaultTools` or `--tools` and configure it with `codemode.mode` and
`codemode.inlineBudget`." [P2, 0.99.0; P1: CHANGELOG.md:440] The landing PR is #10040 [P3].

Name resolution: the name is `codemode`, one word, unchanged since introduction. The only
two-word "code mode" spelling in the changelog is incidental prose in a 1.3.0 line ("the code
mode tool description"), not a rename [P1: CHANGELOG.md:142]. No alias or prior name exists
(`yolo` and similar appear nowhere in the changelog).

The ticket's 1.2-1.4 guess is off by four minors. What that window actually landed:

| Version | Date | Codemode-relevant changes [P2] |
|---|---|---|
| 0.99.0 | 2026-09-29 | Introduction; `pi config` Built-in disable (`-builtin:<name>`); `defaultTools` `+codemode` |
| 0.99.2 | 2026-10-01 | Default `codemode` MCP exposure dropped from the codemode description; `codemode-deferred` alias; `codemode.mode: "only"` fix |
| 1.0.0 | 2026-10-01 | "Leaner codemode" (~40% fewer prompt tokens); `models.generateImages()` |
| 1.0.4 | 2026-10-05 | `--tools`/`--exclude-tools` `*` patterns; frozen built-ins |
| 1.1.0 | 2026-10-07 | `--tools` `+name`/`-name` entries |
| 1.2.0 | 2026-10-12 | `reachesTools` on tool definitions; namespace `aliases` |
| 1.3.0 | 2026-10-15 | Worker admission capped at two live workers across sessions |
| 1.4.0 | 2026-10-21 | Scripts queue up to 60 s for a free worker; `PI_CODEMODE_MAX_WORKERS` |

Cross-check: the vault study (2026-10-01) already records K-Dense using codemode [K1] — two
days after 0.99.0 shipped, and twelve days before 1.2.0. The introduction date and the
reference usage line up.

## 4. Pipeline binding (the load-bearing section)

Two layers, both inside the pipeline:

**Layer 1 — the codemode call itself.** Codemode is registered with `pi.registerTool()` as an
ordinary tool definition [P1: dist/extensions/codemode/index.js:14-27]. A model call to
`codemode` is a normal tool call: it fires the usual `tool_call`/`tool_result` events with
`toolName: "codemode"`, and any extension gate can block or mutate it like any other tool.

**Layer 2 — nested calls from scripts.** The authoritative statement, from the tool's own type
declarations: "Nested calls run through the agent loop's tool pipeline (`ctx.executeTool`), so
validation, `tool_call`/`tool_result` hooks, and permission checks apply exactly as for direct
calls." [P1: dist/extensions/codemode/tool.d.ts:8-10]

Mechanism, verified through the code path: each `tools.<name>(args)` in the sandbox maps to
`ctx.executeTool(...)` [P1: dist/extensions/codemode/execute.js:468]; the session runs each
nested call through the agent's `runToolCall` with the same `beforeToolCall`/`afterToolCall`
extension handlers as model-issued calls [P1: dist/core/agent-session.js:384-415]; those
handlers emit the `type: "tool_call"` event, and a handler throw blocks the call [P1:
dist/core/agent-session.js:325-345]. The extension docs state the contract plainly:

"A tool can run other tools with `ctx.executeTool(name, args, ...)`. Nested calls go through
argument validation and the `tool_call` and `tool_result` handlers like model-issued calls, and
emit `tool_execution_start`, `tool_execution_update`, and `tool_execution_end`; all of these
events carry `parentToolCallId`, and their `toolCallId` is assigned by pi as `<parent id>/<n>`."
[P1: docs/extensions.md:261]

And for MCP tools specifically — the compute gateway's category: "Every MCP call passes through
Pi's tool pipeline. Extension `tool_call` and `tool_result` handlers, including permission
gates, therefore apply to MCP tools. Calls made from codemode scripts carry the codemode call
ID as `parentToolCallId`." [P1: docs/mcp.md:252]

Gating semantics: the `tool_call` event "Can block. `event.input` is mutable. Mutate it in
place to patch tool arguments before execution." [P1: dist/core/extensions/types.d.ts:978-981];
returning `{ block: true, reason }` from a handler refuses the call [P1:
docs/extensions.md:288]; and "A `tool_call` handler failure blocks the tool as a fail-safe"
[P1: docs/extensions.md:375]. The permission model is entirely extension-based — pi ships a
`permission-gate.ts` example that combines `tool_call`, mode-aware UI, and fail-closed behavior
[P1: docs/extensions.md:390].

**One transcript nuance that matters for Theta's auditors.** Nested calls do not get their own
transcript entries: "These ids do not appear as tool calls or results in the transcript. [...]
The session keeps a bounded record of them (name, arguments, status, duration, error; never
results) as `nestedCalls` on the calling tool's result message." Bounds: arguments over 8 KiB
per call or 32 KiB per tool result are omitted, at most 256 calls are kept, and `complete:
false` marks a lossy record [P1: docs/extensions.md:261; dist/core/nested-tool-calls.d.ts:1-13].
Extension-side event handlers see every nested call regardless of these bounds — the bound
applies to the transcript record, not to the events.

**Empirical confirmation from Theta's own evidence.** The M4 S1 live session transcript
(2026-10-21) contains five `codemode` tool calls; the model's thinking shows it discovering
`mcp__theta_compute__*` names via the script helpers and calling them from inside scripts; the
codemode tool results carry `nestedCalls` entries such as
`{"id": "call_.../1", "name": "mcp__theta_compute__list_environments", "status": "ok"}`
[T1]. Theta's gateway flow already runs through codemode in practice.

## 5. Configuration points

| Point | Key / flag | Effect | Source |
|---|---|---|---|
| Enable (settings) | `defaultTools: ["+codemode"]` | Adds codemode to the default tool set (user or project settings) | [P1: docs/settings.md:41,48-52] |
| Enable (CLI) | `pi --tools +codemode` or `--tools read,codemode` | Per-run activation; `*` patterns allowed | [P1: docs/cli.md:128-135] |
| Disable (extension) | `extensions: ["-builtin:codemode"]` | Removes the built-in extension globally or per project (`pi config` Built-in section) | [P1: docs/settings.md:163] |
| Disable (CLI) | `--exclude-tools codemode`, `--no-extensions` | Per-run removal; `--no-extensions` disables all built-ins | [P1: docs/cli.md:128-135] |
| Presentation | `codemode.mode`: `"on"` (default) or `"only"` | `"only"` hides direct tools from the model; every tool is listed as script-callable. Presentation only — not an on/off switch | [P1: schemas/settings.schema.json:609-632] |
| Description budget | `codemode.inlineBudget` (default 3000) | Estimated tokens the codemode description may spend on tool declarations | [P1: docs/settings.md:44] |
| MCP auto-activation | `"autoEnableCodemode": false` beside `mcpServers` | Suppresses automatic codemode activation when a `codemode`-exposure server connects; project value overrides user value | [P1: docs/mcp.md:230] |
| MCP exposure | per-server `exposure`, per-tool `toolExposure` (`direct`, `codemode` (default), `deferred`, `hidden`, patterns like `"get_*"`) | Controls how the model reaches each server's tools (section 6) | [P1: docs/mcp.md:187-216] |
| Workers | `PI_CODEMODE_MAX_WORKERS` (default 2) | Live codemode workers per process | [P1: docs/environment-variables.md:87] |
| Per-script | `// @options: {"timeout_ms": ..., "max_output_tokens": ...}` first line | Deadline and output cap for one script | [P1: docs/codemode.md:11-16] |

Not found, stated explicitly: there is **no codemode-specific allowlist or denylist of commands,
no codemode-specific confirmation or approval setting, and no codemode sandbox option** anywhere
in settings, configuration, or mcp.json [P1: zero hits for codemode in docs/configuration.md;
no such keys in schemas/settings.schema.json]. The only approval mechanism is the generic
extension `tool_call` gate. OS-level sandboxing of the *tools* a script calls is assigned to
containerization, not codemode: security.md says "Treat model-generated commands and code as
untrusted [...] it does not ask for approval before every tool call" and names the lack of a
built-in sandbox as outside the boundary; codemode is never mentioned there [P1:
docs/security.md:3,7,99]. The QuickJS sandbox confines the *script*, not the tools it calls.

## 6. The MCP coupling Theta already lives with

This is the finding that changes the M5 framing. From the exposure table in the MCP docs:

"`codemode` (default) — Callable from `codemode` scripts, but neither declared to the model nor
listed in the codemode description. Scripts find tools with `searchTools()`, `describeTool()`,
or `ALL_TOOLS`." [P1: docs/mcp.md:187-195]

"Pi activates `codemode` when a server with `codemode` exposure connects." [P1:
docs/mcp.md:204] The design PR is blunter: "By default a server's tools are codemode-only [...]
and pi activates the codemode tool for them." [P3]

Deployment fact: the user-level theta-compute MCP registration carries only `url` and an auth
header — no `exposure`, no `autoEnableCodemode` [T1]. So on the host path (live gateway legs,
dogfood with the forward up), the gateway's tools take the default `codemode` exposure and pi
auto-activates the codemode tool at session start. The model does not see
`mcp__theta_compute__*` declared as direct tools; it reaches them by writing scripts (or via
`tool_search`). The M4 S1 transcript confirms this is not hypothetical — it is how the live
evidence was produced [T1]. The submit gate still fired in that flow because nested calls pass
through the pipeline (section 4).

Two levers exist if Theta wants a different posture, both deploy-time config, no code:
`"exposure": "direct"` on the theta-compute server entry (model sees gateway tools declared,
still callable from scripts), or `"autoEnableCodemode": false` (keeps codemode off unless
explicitly enabled; pi then warns once while non-direct tools cannot be called) [P1:
docs/mcp.md:204,230]. Which posture M5 wants is a design decision this note records, not makes.

## 7. K-Dense usage and what it implies

What the vault study records (from the 2026-10-01 snapshot of their repo): their app — a
standalone desktop co-scientist with one embedded pi lead agent per session — uses "pi's
built-in MCP + codemode" for connectors (their T4 row), and their M5 guard row reads
"Combines with our server-side audit and pi `tool_call` gates" [K1].

What the public repo shows today (2026-10-30): README, `docs/architecture.md`, and the issue
tracker carry no codemode mention, and no path in the file tree names it [K2] — the wording
drifted, the mechanism stayed: `server/src/agent/run-pipeline.ts` still bills for "a model a
tool ran itself (codemode `models.*`, `generate_image`)" [K2: run-pipeline.ts:268], so codemode
scripts with inner model calls run in their production path and are accounted for.

Implications for Theta:

1. **Codemode-on is the shipping configuration of the reference product, not an exotic one.**
   K-Dense embedded pi with codemode active for end users within two days of 0.99.0. Theta's
   M5 gate framework should treat codemode-active sessions as the default case to design for,
   and the auto-activation coupling (section 6) means "default case" is literal: registering
   the compute gateway is enough to turn it on.
2. **Their guard architecture stacks on the same seam Theta uses.** The study's M5 row pairs
   their classifier/policy guard with "pi `tool_call` gates" [K1] — an independent
   confirmation that extension pipeline gates are the intended control point when codemode is
   active. K-Dense did not need a codemode-specific guard, and per section 4 neither does
   Theta: nested calls arrive at the same handlers.
3. **Cost accounting must see inside-tool spend.** They bill codemode `models.*` calls
   explicitly [K2]. Pi folds nested-call usage into the calling tool's result usage [P1:
   docs/extensions.md:261], so session cost is already correct; Theta's per-stage cost records
   should keep attributing nested usage to the parent call rather than double-counting.

## 8. Theta stakes

**M5 gate framework — the pipeline-bound design holds.** No bypass exists: nested codemode
calls fire `tool_call` events carrying the real `toolName` (so the submit gate's
`mcp__theta_compute__` prefix match in extensions/submit-gate.ts:26 keeps matching), and
handlers can block or mutate them exactly as for model-issued calls [P1: section 4 quotes].
Three duties follow for the gate framework:

- **Audit linkage**: record `parentToolCallId` and the `<parent>/<n>` id shape in gate records,
  so a refused or confirmed nested call links back to its codemode parent.
- **Evidence fidelity**: transcript readers (the dogfood auditor's legs, notebook provenance)
  must read nested calls from the parent result's `nestedCalls`, never expect first-class
  entries, and respect the record's bounds — arguments are dropped over 8 KiB per call /
  32 KiB total / 256 calls, results are never recorded [P1]. Where the transcript's bounded
  record is not enough, the gate extension's own event-side record is the stronger source.
- **Posture decision**: keep the default `codemode` exposure (better composition: one script
  can stage, submit, and poll in parallel) or switch the gateway server to `direct` exposure
  (first-class transcript calls, simpler evidence). Either way the gate fires; the tradeoff is
  evidence fidelity versus composition, and it belongs in the M5 spec, not this note.

**Compute gateway — unaffected, one nuance.** Auth, path sandbox, command guard, and the audit
line are server-side; codemode changes only how the client composes calls [P1; T1]. The nuance:
codemode scripts can also run `models.classify()`/`generateImages()` with the session's
provider credentials, billed to the session [P1: docs/codemode.md, models section] — a
client-side spend path Theta's cost notes should carry, and one more reason the provider key
stays the only credential the clean-room rig receives.

**Clean-room rig — unaffected today, two watch items.** The rig container installs
pi-coding-agent 1.4.0 and copies only `models.json` from the host config — no `mcp.json`, no
`settings.json` enter it [T1: test/rig/Dockerfile:20, test/rig/run.mjs:148] — so no MCP server
connects, the auto-activation trigger never fires, and codemode stays inactive (it is
registered inactive and the launcher passes no `--tools` flags) [T1: bin/theta.mjs; P1:
dist/extensions/codemode/index.d.ts:4-6]. The model cannot self-activate a tool. Watch items
for milestone re-pins: (a) re-check the default exposure and auto-activation semantics against
the new pinned pi — they are the reason a config-less container is codemode-off; (b) if a
project-level `.pi/settings.json` or `.pi/mcp.json` ever ships in this repo, remember pi loads
project MCP config "per project once trusted" [P1: docs/mcp.md] and treat that as a new
runtime path for the rig.

## 9. Verification notes

- The 1.4.0 tarball was fetched with `npm pack` into a scratch directory and read as data;
  nothing from it was executed or installed. Line numbers cite the unpacked `package/` tree.
- GitHub facts (changelog, PR #10040, K-Dense repo) were fetched read-only 2026-10-30 via the
  firecrawl plugin (WebSearch/WebFetch are disabled here); rate-limit pauses caused one retry.
- Local probes: the user-level pi MCP registration was inspected for structure only — key
  names, never credential values. The M4 S1 transcript was read from the evidence directory
  named in CLAUDE.local.md; no cluster identifiers appear in this note beyond what the public
  repo already carries (ADR 0004 names the cluster itself).
- The vault study was read in place, read-only; its claims are cited as the campaign's own
  record of the 2026-10-01 snapshot, with today's public-repo probes layered on top.
- Codemode's absence of configuration surface (section 5, "not found") is stated from zero-hit
  searches over the tarball's docs and schemas, not from silence elsewhere.
