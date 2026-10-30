# Pi durable sessions/runs in 1.4.0: semantics, release attribution, and the M7 shell implications

Date: 2026-10-30

Scope note: this note resolves wayfinder ticket #85 (parent #80). The question: what are pi's
"durable sessions/runs" in 1.4.0, and what do they change for the M7 Theta shell plan? The answer
has two halves, and the split is the finding. **Inside `@earendil-works/pi-coding-agent` — the
package Theta embeds — there are durable session *files* but no durable *runs***: a run dies with
its process, and resume means a new process replaying the transcript. **True durable runs exist
elsewhere in the pi monorepo: `@earendil-works/pi-durable`, a separate, explicitly experimental
"durable agent harness"** that versions in lock-step with the coding agent (its 1.4.0 landed the
same day), commits every turn to storage before it is shown, and resumes interrupted runs after a
crash — but it is a parallel harness over pi-ai, not the coding agent, and the coding agent's 1.4.0
tree never references it. Consequence for M7: the session/run broker stays Theta-built on the
coding-agent SDK; pi-durable is a watch item with named re-evaluation triggers, not an adoption.

Method: both 1.4.0 tarballs were downloaded with `npm pack` from this repo checkout and read as
data — never executed; the installed 1.1.0 coding-agent baseline at the global npm root was
diffed against its 1.4.0 tarball (read-only); npm registry metadata was read with `npm view`; pi's
GitHub release notes were fetched through Firecrawl; the three vault comparison inputs were read
as-is. Quotations are transcribed plain; package path and line numbers cite every load-bearing
claim.

Source ids used inline (all tarballs and registry accessed 2026-10-30):

- [T] `@earendil-works/pi-coding-agent` 1.4.0 tarball (shasum `7f5dd2a4…`, 1279 files), unpacked
  read-only at a temp path. Cited as `T:<path>:<line>`.
- [B] Baseline 1.1.0 coding-agent install (global npm root, read-only). Same citation form.
- [D] `@earendil-works/pi-durable` 1.4.0 tarball (339 files), unpacked read-only. Cited as
  `D:<path>:<line>`.
- [N] npm registry metadata for `@earendil-works/pi-durable` (`npm view`, 2026-10-30).
- [R] pi GitHub release notes and repository pages (fetched via Firecrawl, 2026-10-30):
  `github.com/earendil-works/pi/releases`, tag pages v1.0.0–v1.4.0, and
  `packages/coding-agent/CHANGELOG.md` / `packages/durable/CHANGELOG.md` raw views.
- [W] Vault design note "2026-10-15 Design Note - Theta M7 Web Workbench Shell.md" (read-only),
  including Annex A (2026-10-20).
- [K] Vault research record "2026-10-01 Research Record - K-Dense BYOK Reference Study.md"
  (read-only).
- [H] Vault handoff "handoff-pi-agent-interface-research.md" (2026-09-29, read-only) — the document
  whose `packages/server` claim started this thread.

## 1. Answer in brief

1. **The coding agent: durable files, not durable runs.** A pi coding-agent "run" lives inside one
   process (TUI, print, JSON, RPC child, or the embedding host). No daemon, no detach/attach, no
   socket or WebSocket server exists anywhere in its 1.4.0 docs or shipped `dist/` (Section 2).
   Sessions persist automatically as append-only JSONL entry trees; "resume" is transcript replay
   in a *new* process. This model predates 1.0 — the 1.1.0→1.4.0 docs diff for `sdk.md`, `rpc.md`,
   `rpc-commands.md`, `json.md`, and `session-format.md` is zero lines.
2. **No coding-agent release in the window shipped a durability feature.** The GitHub release
   notes for v1.2.0/v1.3.0/v1.4.0 mirror `packages/coding-agent/CHANGELOG.md` and contain the
   string "durable" zero times [R]; there are no 1.2.x/1.3.x patch releases [R]. The
   durability-adjacent entries are resume bug fixes (1.3.0, 1.4.0) and 1.2.0's run-semantics
   change for extension-triggered runs (Section 3.1). The one experimental server stack an earlier
   Theta handoff called "durable Session/Agent interfaces" was **removed** in 1.2.0, never having
   shipped in a published package (Section 3.2).
3. **The real durable runs: `@earendil-works/pi-durable`.** A separate npm package from the same
   monorepo, self-described "durable agent harness": "Conversations, model turns, tool calls, and
   your own state are committed to storage before anything is shown. If the process dies mid-turn,
   reopening the storage picks the work up where it stopped." (D:README.md:5-7). On npm since the
   0.86.x era; 1.0.0 on 2026-10-01; 1.2.0 and 1.4.0 extended it materially within the ticket's
   window (Section 3.3). Banner maturity wording: "**Experimental.** The API changes without
   notice between releases." (D:README.md:3).
4. **The two halves do not touch.** The pi-coding-agent 1.4.0 tree contains zero references to
   `pi-durable` (grep over [T], no hits), and pi-durable builds on `@earendil-works/pi-ai` +
   `@earendil-works/chord` with its *own* tool registry, coding tools, codemode, and tool_search
   (D:README.md:9, 32-34) — it does not host the coding agent's skill/extension/MCP runtime that
   theta-agent rides.
5. **M7 verdict.** "One core, two faces" is natively pi's own architecture — every interface mode
   wraps the same `AgentSession` — so M7c is confirmed, not threatened. The K-Dense-style session/
   run broker **stays Theta-built**: adopting pi-durable would replace not just the broker but the
   entire embedding surface theta-agent is built on. What the adoption rule *does* delete, on the
   coding-agent side: the turn-adoption observer (native since 1.2.0's `before_agent_start`
   change), transcript catch-up bookkeeping (`get_entries` durable cursor), durable extension
   state (`pi.appendEntry()`), and the session cost ledger (`UsageEntry`). pi-durable's `watch()`
   frame semantics are a ready-made design spec for Theta's SSE fan-out even without adopting the
   harness (Section 6).
6. **M6 relevance.** Coding-agent session files are a replayable, deterministically reconstructable
   event log, and branching primitives give eval sweeps a shared-prefix mechanism; pi-durable adds
   an in-ecosystem demonstration of journal-based deterministic replay and a fake clock — signals,
   not dependencies (Section 7).

## 2. The coding agent's durability semantics (1.4.0)

### 2.1 What persists — the session file

Pi saves a conversation as a session, automatically, unless started with `--no-session`
(T:docs/sessions.md:7). The unit of durability is the **session file**, not the run:

- Location: `~/.pi/agent/sessions/--<path>--/<timestamp>_<session-id>.jsonl`, grouped by working
  directory; relocatable via `--session-dir`, `PI_CODING_AGENT_SESSION_DIR`, or the `sessionDir`
  setting (T:docs/sessions.md:50; T:docs/session-format.md:8-14). Custom session IDs can be
  supplied through the SDK or `--session-id` (T:docs/session-format.md:14).
- Format: JSONL, one entry per line; entries form a **tree** via `id`/`parentId`, so branching
  happens in place (T:docs/session-format.md:3). Session header version 3 as of 1.4.0
  (T:docs/session-format.md:22-30).
- Entry types (T:docs/session-format.md:62-207): `message` (including **system messages that carry
  the prompt sections and the tool loadout** — "Replaying them in order yields the current prompt
  and tools; there is no separate prompt state entry", T:docs/session-format.md:80), `model_change`,
  `thinking_level_change`, `usage` (model-attributed cost/token records that feed session totals),
  `compaction` (summary plus a complete system-prompt/tool checkpoint and `firstKeptEntryId`),
  `context_edit`, `branch_summary`, `custom` (extension state via `pi.appendEntry()`; excluded from
  model context), `custom_message` (extension-injected content that does enter context), `label`,
  `session_info`.

So "what persists" is the full provenance of the conversation: every turn, every tool result, the
exact system-prompt and tool state over time, cost accounting, compaction checkpoints, and
extension-owned durable state. Compaction never deletes original entries (T:docs/sessions.md:40-42).

### 2.2 What does not persist — the run

The agent run (pi's own term: "runs started by `pi.sendMessage(..., { triggerTurn: true })`",
T:CHANGELOG.md:113) is process-local state. There is no mechanism in 1.4.0 to detach a run from its
controlling process, attach a second client from another process, or resume an interrupted run
mid-flight rather than from its last finalized entries. Evidence:

- Grep over all of `T:docs/`, `T:CHANGELOG.md`, `T:README.md` for `daemon`, `detach`, `re-attach`,
  `multi-client`, `websocket`, `server mode`: no hit describes a pi server process (the only
  "server" hits are MCP servers, `llama-server`, provider gateways).
- The shipped mode surface is `InteractiveMode`, `runPrintMode`, `runRpcMode` — no server class
  (T:dist/index.d.ts:36).
- RPC mode is a *child* process: "Close the child's stdin to request an orderly shutdown. Pi
  disposes the active runtime before exiting." (T:docs/rpc.md:91-93).

Crash semantics: the session file keeps whatever entries were finalized before death. 1.4.0
repaired a related recovery defect — "Fixed sessions breaking after recovery from a response cut
off at the output limit: the truncated tool call was omitted but its tool results were kept"
(T:CHANGELOG.md:45, #11227/#11233) — which confirms recovery means *replaying finalized entries*,
never resuming an in-flight provider stream.

### 2.3 The resume story

Resume is transcript replay in a fresh process:

- CLI: `pi --continue` (most recent session for the cwd), `pi --resume` (picker), `/resume`,
  `/new`, `--session <id-or-path>`, `--fork` (T:docs/sessions.md:10-16, 54).
- SDK: `SessionManager.continueRecent(cwd)`, `SessionManager.open(path)`,
  `SessionManager.forkFrom(...)`, plus `AgentSessionRuntime.switchSession/newSession/fork`
  (T:dist/core/session-manager.d.ts:371-414; T:dist/core/agent-session-runtime.d.ts:73-104).
- RPC: `switch_session`, `new_session` (with parent lineage), `fork`, `clone` commands
  (T:docs/rpc-commands.md:130, 592-666).
- Context reconstruction on resume is a documented, deterministic pipeline: `buildContextEntries()`
  walks leaf-to-root honoring the latest compaction; `buildSessionProjection()` applies
  `context_edit`s; `buildSessionContext()` emits the model-visible message list
  (T:docs/session-format.md:224-248).

Recent resume fixes show this path is actively maintained: 1.3.0 "Resumed sessions keep their
active tools" (T:CHANGELOG.md:67, #10785); 1.4.0 "resumed sessions and `/tree` navigation leaving
extension tools inactive" fixed (T:CHANGELOG.md:44, #11062/#11075).

### 2.4 The headless-core process model

Three embedding shapes, per the docs' own choice table (T:docs/rpc.md:7-10):

| Interface | Process boundary | Control model |
|---|---|---|
| SDK (`createAgentSession()`) | In process | Direct TypeScript methods and events |
| RPC (`pi --mode rpc`) | Child process | JSONL commands/responses/events on stdio |
| JSON (`pi --mode json`) | One-shot child | JSONL event stream, then exit |

Two load-bearing properties: the core is a **library, not a service** (no listening endpoint in any
mode), and **one core, many faces is pi's own architecture** — `AgentSession` is "shared between
all run modes (interactive, print, rpc) … Modes use this class and add their own I/O layer on top"
(T:dist/core/agent-session.d.ts:1-14); "All interfaces use the same agent and session mechanisms"
(T:docs/how-pi-works.md:37-39). An embedding host is one more face over the same core.

## 3. Release attribution, 1.2.0–1.4.0

### 3.1 The coding agent: nothing durable shipped in the window

The changelog shipped in the coding-agent 1.4.0 tarball covers every release in the window — 1.2.0
(2026-10-12), 1.3.0 (2026-10-15), 1.4.0 (2026-10-21), no patch releases between
(T:CHANGELOG.md:3, 59, 105) — and the GitHub release notes mirror it verbatim, with zero
occurrences of "durable" [R]. The durability-adjacent entries that do exist:

- 1.2.0: "**`before_agent_start` for extension-triggered runs**: runs started by
  `pi.sendMessage(..., { triggerTurn: true })` go through the same setup as prompts"
  (T:CHANGELOG.md:113); the session "counts as busy while a run starts, including during
  `before_agent_start` handlers: … `pi.sendMessage()` queues into the starting run instead of
  starting a second run" (T:CHANGELOG.md:119, #10739).
- 1.3.0: resumed sessions keep their active tools (T:CHANGELOG.md:67, #10785).
- 1.4.0: the two resume/recovery fixes quoted in Section 2.

The durable-session machinery the coding agent *does* have all predates the window:
`pi.appendEntry()` ("Persist custom data in session (survives restart/branch)") and the
`get_entries`/`get_tree` RPC commands are old changelog entries already present verbatim in the
1.1.0 baseline (B:CHANGELOG.md:4697, 5016, 1375-1382).

### 3.2 The removed experimental stack — where Theta's "durable server" premise came from

The interface research handoff [H:§3], verified 2026-09-29 against the pre-1.0 repository, listed
these "headless building blocks":

> | `packages/client` | Transport-neutral client (WebSocket, Unix socket, …) |
> | `packages/server` | Experimental local server for durable Session/Agent interfaces |
> | `packages/protocol` | The wire contract between them |

That is the only place in Theta's records where "durable" attaches to a pi server capability. The
0.84.0 coding-agent changelog names what it was: "experimental remote-session client APIs: the
transport-neutral `PiClient`, CBOR protocol, Unix-socket transport, and … `RemoteSession`
controller" [R:B:CHANGELOG §0.84.0]. Six weeks later 1.2.0 removed all of it (T:CHANGELOG.md:165):

> "Removed the unreleased experimental server, client, and plugin stack (`src/experimental`,
> `src/cli/experimental`) and its source-only `./client` and `./experimental/plugin` exports; none
> of it was part of the published package. The `@earendil-works/pi-client`,
> `@earendil-works/pi-protocol`, and `@earendil-works/pi-server` packages it used are removed and
> no longer released"

Consequences: (a) no pi release ever "shipped durable sessions" in that sense — the experiment
never reached a published package; (b) any plan text citing `packages/{client,server,protocol}` is
stale as of 1.2.0 — M7 Annex A.3's existence-proof row does exactly that [W:A.3].

### 3.3 The real durable runs: `@earendil-works/pi-durable`

A separate package from the same monorepo, absent from the coding agent's release notes because
those notes cover only the coding-agent package [R]. Registry and changelog facts:

- **On npm since the pre-1.0 era**: versions `0.0.1`, `0.86.0`–`0.87.1` (Sept 2026),
  `0.99.0`–`0.99.2`, then `1.0.0`→`1.4.0` in lock-step with the monorepo — same version numbers,
  same release dates (1.4.0 published 2026-10-21, the coding agent's 1.4.0 day) [N].
- **1.0.0 (2026-10-01)**: "Initial release of `@earendil-works/pi-durable`, a durable agent
  harness." (D:CHANGELOG.md:§1.0.0). So the harness *predates* the 1.2–1.4 window; the window
  extended it.
- **Within the window** (D:CHANGELOG.md): 1.2.0 heavily — nested tool calls ("a tool calls another
  tool as a nested call… its own `pi.tool` task owned by the caller… a replay-safe caller's rerun
  reattaches to its nested calls"), structured tool output, deferred tools, and a restart-surviving
  codemode: "a `codemode` tool … whose scripts call the conversation's tools as nested calls and
  survive a restart: the script is replayed deterministically from a journal of the results it
  got, written before each delivery". 1.3.0 lightly — SQLite `prefix` namespacing; Durable-Object
  adapters sharing one database coordinate their operations. 1.4.0 heavily again — "Durable
  sleeps: a sleeping task holds no invocation, survives restarts, and resumes at its checkpoint";
  a crash-loop guard (a task cut off by a crash 5 times without committing new state "is parked
  instead of run again"; `settings.restartLimit`); `IndexedDbStorage` (browser);
  `Harness.wake()`/`onWake` for evictable hosts.
- **The coding agent does not use it.** Grep over the entire coding-agent 1.4.0 tarball for
  `pi-durable`: zero hits. pi-durable's own install line is `npm install @earendil-works/pi-durable
  @earendil-works/pi-ai @earendil-works/chord` (D:README.md:32-34) — a parallel stack. Its tool
  surface *mirrors* coding-agent features ("As in the coding agent, a `codemode` prompt section
  lists the tools scripts can call", D:CHANGELOG.md:§1.2.0), and its changelog lineage is the
  0.84.0-era "inherited pi-agent-core harness session model … durable operation records" work
  [R:B:CHANGELOG §0.84.0] — the harness thread forked away from the coding agent rather than into
  it.

### 3.4 Maturity signals

Coding agent (the surface Theta embeds):

- Cadence and activity: 1.0.0 (2026-10-01) to 1.4.0 (2026-10-21) — three minors in three weeks,
  every changelog entry issue-linked, external contributors named (T:CHANGELOG.md:3-167).
- Surface stability: `sdk.md`, `rpc.md`, `rpc-commands.md`, `json.md`, `session-format.md` are
  byte-identical between the installed 1.1.0 and the 1.4.0 tarball (diff = 0 lines each);
  `sessions.md` differs by 2 lines (1.3.0 `/share` setting), `extensions.md` by ~127 lines (a
  doc restructure of the run lifecycle into diagrams — no new event types; `agent_before_settle`
  exists in both versions' declarations, T vs B:dist/core/extensions/types.d.ts:798/:774).
- 14 typechecked SDK examples plus a checked RPC client example ship in the package
  (T:docs/sdk.md:120-138).

pi-durable (the durable harness):

- Self-declared: "**Experimental.** The API changes without notice between releases."
  (D:README.md:3).
- Breaking changes in every window minor: 1.2.0 renames `ToolExecutionResult.content` → `output`
  and retags tool-call unions; 1.4.0 removes `TaskRuntime.sleep()`, adds a `sleeping` task status,
  and migrates SQLite storage to schema v2 irreversibly — "a migrated database cannot be opened by
  1.3.0 or earlier, so a deployment cannot roll back past this release" (D:CHANGELOG.md:§1.2.0,
  §1.4.0).
- Real engineering underneath: benchmark numbers in the changelog (scheduler fan-out, document
  cache bounds), a design document in-repo (D:CHANGELOG.md:§1.0.0 links `docs/spec.md`), and
  Cloudflare-Durable-Object deployment as a first-class target (D:README.md:166-200).
- Adoption signal: zero references from the coding agent — it is not yet the blessed embedding
  path for anything Theta-size.

## 4. pi-durable: the durable-run semantics and API surface

What the harness actually provides (all from D:README.md unless noted):

- **Commit-before-show persistence.** "Everything a UI needs is committed state."
  (D:README.md, Watching a Conversation). Conversations, model turns, tool calls, and host state
  are committed to storage before display; partial answers and tool output are committed at most
  every 100 ms by default — "a crash loses at most that window" (`settings.progress` tunes it).
- **Resume of interrupted runs.** `harness.resume()` — "continue any run the last process left
  unfinished"; "Work interrupted by a crash or close stays pending." A model request the process
  died during "counts as a failed attempt and is retried" (D:README.md:5-7, Persist and Resume).
  Retried submissions are idempotent by `requestId` ("the same request ID finds the same
  submission"), and `harness.submission(id)` reacquires a submission after a restart.
- **Durable sleeps and evictable hosts.** A sleeping task "holds no invocation, survives restarts,
  and resumes at its checkpoint"; `Harness.wake()`/`onWake` tell the host when the Session next
  needs a process, "so a Cloudflare Durable Object can hibernate and wake on its alarm"
  (D:README.md:166-200; D:CHANGELOG.md:§1.4.0).
- **Storage backends** (D:README.md, Storage): Memory; SQLite (Node, WAL, `synchronous = NORMAL` —
  "commits survive process crashes; the newest may be lost on power or host failure"); JSONL
  (append-only, optional `fsync` per commit marker); Cloudflare Durable Object SQLite ("commits
  are its storage transactions"); IndexedDB (browser, 1.4.0). Ownership: "One process owns a
  storage at a time; there is no cross-process locking." A browser tab must hold a Web Lock.
- **Watchers and fan-out — committed views, not event mirrors.** `viewState()` returns the
  conversation's structural view as a read-only state updated after every commit;
  `view.subscribe(render)` is the simple UI path. `watch()` "delivers the same view with the exact
  Chord operations of each commit, one callback at a time" — designed for remoting: "send(ops);
  // for example to a remote client that applies them". Backpressure: "A slow watch keeps at most
  100 undelivered frames. After that, the pending frames are replaced by one frame holding the
  whole newest view. A client that joins late or reconnects starts from the current view; nothing
  is replayed." (D:README.md, Watching a Conversation). `Session.subscribeCommits()` observes
  complete commits synchronously (D:dist/types.d.ts:948).
- **Busy semantics mirror the coding agent.** Submitting to a busy conversation queues in an inbox;
  `whenBusy: "steer"` / follow-up (default) / `"reject"`; failed runs keep queued items in the
  inbox (D:README.md, Busy Conversations). `reset()` with a handoff note starts a new context while
  old entries stay in storage (D:README.md, Reset and Handoff).
- **Determinism affordances**: a fake clock — "pass both [`setTimer`, `now`] to run a Harness on a
  fake clock" (D:README.md:166 area); journal-based deterministic replay for codemode scripts
  (D:CHANGELOG.md:§1.2.0).

What it is **not**: a host for the coding agent. It has its own extension model, tool registry
(`createRegistry()`, `createCodingTools()`), settings, and compaction. theta-agent's assets —
skills, extensions, connector scripts, the MCP config — target `@earendil-works/pi-coding-agent`
resource discovery; none of that loads in pi-durable today.

## 5. Coding-agent API surface: embedding, observers, fan-out

For contrast, the surfaces Theta's M7 broker would actually build on:

- **Embedding (SDK).** `createAgentSession()` returns an `AgentSession` owning "one conversation,
  its model and tools, queued messages, compaction state, and extension runtime"
  (T:docs/sdk.md:26-30). Every boundary is injectable — `modelRuntime`, `settingsManager`,
  `sessionManager` (including `SessionManager.inMemory()`), `resourceLoader`, tools
  (T:docs/sdk.md:96-108). `AgentSessionRuntime` adds multi-session hosting in one process:
  `newSession()`, `switchSession()`, `fork()`, `importFromJsonl()` (T:docs/sdk.md:58-60). `RpcClient`
  wraps the child-process shape with typed methods and `promptAndWait()`/`waitForIdle()`
  (T:dist/modes/rpc/rpc-client.d.ts:35-247).
- **Session observers.** SDK: `session.subscribe(listener)` — "Multiple listeners can be added."
  (T:dist/core/agent-session.d.ts:382-384); the class couples "Event subscription with automatic
  session persistence" — observing and persisting are one pipeline
  (T:dist/core/agent-session.d.ts:1-14). Extensions: `pi.on(...)` for the run lifecycle —
  `before_agent_start` (a union on `messageType: "user" | "custom"` since 1.2.0,
  T:CHANGELOG.md:118), `agent_start`, turn/message/tool events, `agent_before_settle` ("May append
  entries and ensure one next provider request", T:dist/core/extensions/types.d.ts:798-801),
  `agent_settled` (with `aborted`), `session_start`/`session_shutdown`.
- **Event fan-out — primitives, not a broker.** The `AgentSessionEvent` union covers
  agent/turn/message/tool/queue/compaction/retry families plus `entry_appended` carrying the
  persisted entry (T:dist/core/agent-session.d.ts:47-80). The broker-relevant pair: live tail via
  `entry_appended`, and durable catch-up via `get_entries` with `since: <last entry id>` — "an
  entry id works as a durable cursor: pass the last entry id you have seen as `since` to get only
  entries strictly after it, even across client restarts. Unlike `get_messages`, this includes
  pre-compaction history and abandoned branches" (T:docs/rpc-commands.md:691). What pi does *not*
  supply: any transport beyond one client — no SSE/WebSocket fan-out, no client registry, no
  attach/detach; the exported `createEventBus` is a generic in-process channel utility
  (T:dist/core/event-bus.d.ts:1-8).

## 6. M7 implications

### 6.1 Comparison with the K-Dense turn lifecycle

[K:§3]: "pi events fan out to a server-owned **run broker**, the browser SSE stream, and the
**provenance recorder** … A session observer adopts extension-triggered turns; idle tabs re-attach.
Broker survives browser disconnects (not backend restarts)." Mapped onto pi 1.4.0:

| K-Dense mechanism | coding-agent 1.4.0 | pi-durable 1.4.0 |
|---|---|---|
| Broker owning sessions in the backend | `AgentSession`/`AgentSessionRuntime` give the owned object; the broker process is host code | The harness *is* the owned object, with admission, inbox, and scheduler |
| SSE fan-out to browser tabs | `subscribe()` + `entry_appended`; cursor catch-up via `get_entries since`; transport is host code | `watch()` ships ops frames with coalescing (100-frame cap) and reconnect-gets-current-view semantics — but the remote transport is still host code |
| Survives browser disconnects | host property (the host process outlives clients) | same — storage is single-owner |
| Survives backend restarts | **no** — runs die; the session file survives; resume = transcript replay in a new process | **yes** — `resume()` continues unfinished runs; commits are the source of truth; a model request interrupted by death is retried as a failed attempt |
| Session observer adopts extension-triggered turns | **native since 1.2.0**: `before_agent_start` fires for `triggerTurn: true` runs; busy-while-starting; `sendMessage()` queues (T:CHANGELOG.md:113, 118-119) | native differently: everything is a submission through admission, with steer/follow-up/reject placement rules |
| Per-session cost ledger | `UsageEntry` lines feed session totals (T:docs/session-format.md:113-121) | Usage and Cost section in its own docs |
| Storage | JSONL files, one tree per session, no cross-process story | SQLite/JSONL/IndexedDB/DO, single owner, explicit durability/atomicity contract |

### 6.2 Adoption-rule verdict ("adopt when it deletes Theta-built machinery")

- **Deleted — adopt the pi capability, do not build it** (all coding-agent side):
  1. *Turn-adoption observer*: 1.2.0's `before_agent_start`-for-`triggerTurn` runs plus
     busy-while-starting semantics make extension-triggered activity first-class runs through the
     same setup path. The observer K-Dense built (and Theta planned) to normalize these into turns
     is obsolete before it is written.
  2. *Transcript catch-up bookkeeping*: the durable entry-id cursor replaces any offset/watermark
     scheme over transcript files.
  3. *Durable extension state*: `pi.appendEntry()` (`custom` entries, branch-scoped, excluded from
     model context) is the right home for broker-adjacent state that must survive restarts.
  4. *Session cost ledger*: `UsageEntry`/`appendUsage()` already accumulates per-session token and
     cost totals.
- **Not deleted — the broker stays Theta-built.** pi-durable is the only native answer to "runs
  that survive restarts", and adopting it would delete far more than the broker: it would orphan
  the entire theta-agent embedding surface (skills, extensions, connectors, MCP config are
  pi-coding-agent resources; Section 4). At M7b-1 the K-Dense pattern on the coding-agent SDK
  remains the correct build, and its known limit (broker dies on backend restart) is acceptable —
  the session file preserves the transcript, and the broker restarts into `--continue` semantics.
- **pi-durable is a watch item, with triggers.** Re-evaluate if any of these appear in pi release
  notes: (a) the coding agent referencing or depending on pi-durable; (b) skills/extensions/MCP
  resource discovery landing in pi-durable; (c) the "Experimental" banner dropping plus a
  stability promise. Any one of them reopens the M7b broker design; (b) alone would let Theta host
  the workbench backend on the durable harness without abandoning the package model.
- **A free design spec regardless of adoption.** pi-durable's `watch()` contract answers, with
  shipped-code evidence, the fan-out questions K-Dense answered ad hoc: frame = committed state
  delta (ops), coalescing under backpressure (bounded queue → newest-whole-view frame), reconnect
  = current view without replay, persistence interval decoupled from display (100 ms commit
  window). Theta's SSE broker should copy these semantics deliberately and cite them.

### 6.3 Corrections to carrying documents

- [W:A.3] existence-proof row "pi core: `--mode rpc`, `--mode json`, TS SDK,
  `packages/{client,server,protocol}`" — the last item was removed in pi 1.2.0 (Section 3.2);
  the row should list the three surviving surfaces, and may now add "pi-durable (experimental,
  parallel harness)" as a fourth building block with its own caveat. Vault-side edit, flagged
  here.
- [H:§3] building-blocks table — same staleness, plus its `packages/server` wording is the origin
  of this ticket's premise; the durability it gestured at lives on, reshaped, in pi-durable.
- [W:A.4] "pi API churn — Medium risk, cheap mitigation": the 1.2.0 removal is the worked example
  — the mitigation held (none of the removed packages were ever in Theta's deps), and the
  byte-identical SDK/RPC docs across 1.1.0→1.4.0 (Section 3.4) lower the estimate for those
  surfaces specifically. The lock-step pi-durable track cuts the other way and stays on the watch
  list.

### 6.4 "One core, two faces" — confirmed by pi's own architecture

M7c's rule ("two layouts, one process — never two applications", [W:§1]) is how pi itself is built:
`AgentSession` is the single core that TUI, print, JSON, and RPC modes all wrap (Section 2.4). The
M7 workbench backend is one more face over the same `AgentSession`/`SessionManager` the TUI uses,
with session files as the shared durable state between faces — M7a (TUI) and M7b (workbench) can
even share sessions by pointing at the same `--session-dir`, independent of broker code.

## 7. M6 eval relevance (session replay, determinism)

On the coding agent (the M6 surface):

1. **Replay without re-running.** A session file plus `buildContextEntries()` →
   `buildSessionProjection()` → `buildSessionContext()` reconstructs the exact model-visible
   context deterministically (documented algorithm, T:docs/session-format.md:224-248); system
   entries persist prompt sections and tool loadout over time, replayable in order
   (T:docs/session-format.md:80). `importFromJsonl()` and `migrateSessionEntries` are exported for
   harness use (T:dist/index.d.ts:20-21). An eval harness can grade transcripts and audit context
   assembly offline.
2. **Determinism boundaries to record in the M6 design.** Compaction checkpoints replay as
   complete system state; `context_edit`s apply branch-relatively; thinking blocks are
   deliberately excluded from summarization serialization (1.2.0, T:CHANGELOG.md:135); entry ids
   are stable, so ingest can be incremental and idempotent; `message_end` is "the authoritative
   completed message" (T:docs/json.md:31-68), so event-replay and entry-replay agree.
3. **Branching as an eval primitive.** `fork`/`clone`/`newSession({ parentSession })`/
   `createBranchedSession(leafId)` run variant continuations from a shared recorded prefix — the
   controlled-prefix shape multi-model or multi-prompt eval sweeps want — with custom
   `--session-id` for stable naming (T:docs/session-format.md:14, 72-76;
   T:dist/core/session-manager.d.ts:347-414).

From pi-durable (signals, not dependencies): the restart-surviving codemode shows the shape of
journal-based deterministic replay ("replayed deterministically from a journal of the results it
got, written before each delivery", D:CHANGELOG.md:§1.2.0), and the fake-clock option
(`setTimer`/`now` injection) is the time-control pattern M6's harness will need if it ever
evaluates scheduled or long-running loop behavior. If M6 evals later need run-level (not
transcript-level) replay, that is an argument for the durable harness — record it as a trigger,
not a plan.

## 8. Verification notes

- Coding-agent 1.4.0 tarball: `npm pack @earendil-works/pi-coding-agent@1.4.0` from this repo
  checkout (`.npmrc` pins registry.npmjs.org), shasum `7f5dd2a4f7fa46ed252465ac4d341831896b1fc2`,
  1279 files, unpacked to a temp directory and read as data; no file executed, no interpreter run
  inside the unpacked tree.
- pi-durable 1.4.0 tarball: same method, 339 files, shasum recorded by npm at pack time; README
  (876 lines), CHANGELOG (185 lines), and `dist/types.d.ts` read in full or by section.
- Baseline: installed 1.1.0 coding agent at the global npm root (read-only), version confirmed
  from its `package.json`; doc-set diff computed file-by-file (Section 3.4).
- Registry: `npm view @earendil-works/pi-durable` (versions, dist-tags, timestamps) on 2026-10-30.
- GitHub: release list, tags v1.0.0–v1.4.0, the three window release pages, and both packages'
  changelogs fetched via Firecrawl [R]. The release notes mirror `packages/coding-agent/CHANGELOG.md`
  verbatim; zero "durable" occurrences in the v1.2.0–v1.4.0 notes; no 1.2.x/1.3.x patch releases
  exist. One scrape-level note: the repository root has no `CHANGELOG.md`; the changelogs live at
  `packages/{coding-agent,durable}/CHANGELOG.md`.
- Claim corrections made against the fetched GitHub leg: two API names reported there
  (`observeConversation`, a `readOnly` open mode) do **not** exist in the pi-durable 1.4.0 artifact
  (grep over D:README.md and D:dist/*.d.ts); this note uses only the verified names —
  `viewState()`, `watch()`, `subscribeCommits()`, `subscribeClose()`, `harness.resume()`,
  `harness.wake()`/`onWake`.
- Vault inputs ([W], [K], [H]) are the campaign vault's own records, quoted with section pointers;
  the vault is read-only reference by standing rule.
- Every verbatim quotation above was transcribed to plain ASCII from the cited file and line.

## 9. Conclusion for the ticket

Resolve #85 as: **pi's "durable sessions/runs" resolve to two different things, and only one of
them is in the package Theta embeds.** The coding agent 1.4.0 has durable session *files*
(append-only JSONL, resume-by-replay, pre-1.x) and no durable *runs* — no release in 1.2.0–1.4.0
shipped one, and the experimental "durable" server an old handoff recorded was removed in 1.2.0.
True durable runs live in the separate, experimental, lock-step-versioned
`@earendil-works/pi-durable` harness, which the coding agent does not reference and which cannot
host theta-agent's resource model today. The M7 session/run broker therefore stays Theta-built on
the coding-agent SDK; the adoption rule deletes the turn-adoption observer, catch-up bookkeeping,
durable extension state, and the cost ledger in pi's favor; pi-durable's `watch()` semantics give
the broker's SSE design a shipped reference; and M6 keeps session-file replay as its determinism
base. Watch triggers for reopening: pi-coding-agent referencing pi-durable, resource discovery
landing in pi-durable, or its Experimental banner dropping.
