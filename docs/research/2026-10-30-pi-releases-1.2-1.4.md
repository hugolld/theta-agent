# pi releases 1.2–1.4: the capability inventory

Date: 2026-10-30

Ticket: #81 (part of #80).

Scope note: this note inventories every user-facing and package-facing change in pi
(`@earendil-works/pi-coding-agent`) from 1.2.0 through 1.4.0, so the M5–M8 strikes can decide
what to adopt and what to design around. The primary source is the `CHANGELOG.md` shipped
inside the 1.4.0 npm tarball; every capability claim is then checked against the tarball's own
docs and type declarations and diffed against the installed 1.1.0 baseline (the version this
machine runs), so "doc completeness" verdicts describe the docs that ship with 1.4.0 itself.
GitHub release pages corroborate the changelog (same text, same dates). "Durable sessions and
runs" predate this window — 1.1.0 already had `/resume`, session trees, and
`pi.sendMessage()`-triggered runs — so what 1.2–1.4 shipped on that axis is the hardening
enumerated below, not the base capability.

Source ids used inline:

- [S1] `CHANGELOG.md`, sections [1.2.0] (2026-10-12), [1.3.0] (2026-10-15), [1.4.0]
  (2026-10-21), as shipped in the 1.4.0 tarball.
  Mirror: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/CHANGELOG.md
  (the changelog lives in `packages/coding-agent/`, not at the repo root).
- [S2] Docs shipped in the 1.4.0 tarball: `docs/codemode.md`, `docs/extensions.md`,
  `docs/mcp.md`, `docs/models.md`, `docs/models-configuration.md`, `docs/settings.md`,
  `docs/sessions.md`, `docs/compaction.md`, `docs/environment-variables.md`
  (repo mirror under `packages/coding-agent/docs/`).
- [S3] Installed 1.1.0 baseline at the global npm root (read-only), including its docs and
  `dist/core/extensions/types.d.ts`, used as the diff base.
- [S4] GitHub releases for earendil-works/pi, tags `v1.2.0`, `v1.3.0`, `v1.4.0`:
  https://github.com/earendil-works/pi/releases/tag/v1.2.0 ,
  https://github.com/earendil-works/pi/releases/tag/v1.3.0 ,
  https://github.com/earendil-works/pi/releases/tag/v1.4.0 .
  Corroboration: each release body is generated from [S1] and matches it verbatim; the dates
  match the changelog headers.
- [S5] `package.json` of 1.1.0 [S3] vs 1.4.0 (tarball), plus the tarball file manifest
  (1279 files, includes the new `schemas/` directory).

## Releases in range

| Release | Tag | Date | Headline | Breaking changes |
|---|---|---|---|---|
| 1.2.0 | `v1.2.0` | 2026-10-12 | Extension run semantics, config schemas, MCP connect behavior | 4 (own section in [S1]) |
| 1.3.0 | `v1.3.0` | 2026-10-15 | Resume keeps tools, share destination, catalog/provider moves | 0 (one migration note: kimi base URLs need `/v1`) |
| 1.4.0 | `v1.4.0` | 2026-10-21 | Codemode worker queue, classifier images, summary output cap | 0 (one API deprecation: `reserveTokens` ignored) |

No patch releases exist in the window — the changelog heads jump 1.1.0 → 1.2.0 → 1.3.0 →
1.4.0 [S1], and the release list shows the same tags [S4]. Cadence: three minor releases in
nine days.

## Capability inventory

Maturity verdicts read: *shipped clean* (no follow-up needed), *hardened* (follow-up fixes in
a later release in range), *breaking* (the release itself flags a migration).

### 1. Codemode worker model — admission, queueing, and deadlines

What: codemode (the QuickJS scripting tool) executes scripts in workers. 1.3.0 fixed repeated
timeouts/aborts accumulating surviving workers by admitting at most two live workers across
all sessions in one pi process, counting cancelled workers until they actually exit
(#10748). 1.4.0 then changed busy-failure into queueing: a script that finds both workers
busy waits up to 60 seconds in arrival order — the wait counts against `timeout_ms` — and
`PI_CODEMODE_MAX_WORKERS` raises the default limit of two (#11184). Shipped: the limit in
1.3.0, the queue and the env knob in 1.4.0 [S1].

Maturity: *hardened twice*. The worker-leak fix (1.3.0) and the busy-fail fix (1.4.0) are two
stages of the same arc, and the docs track it: `docs/codemode.md`'s "Limits" section (present
since before this window) gained the worker-admission paragraph in 1.4.0 — the two-worker
rule, the slot-holding of cancelled workers, the 60-second wait, the env var — and the
`timeout_ms` wording now includes the worker wait [S2 vs S3 diff]. The v1.2.0-tagged
`codemode.md` in the repo carries the same heading structure, so the page shipped complete
with each change [S4]. Earlier 1.2.0 fixes in the same area: a misplaced `// @options:` line
now fails the call before running (#10631), quadratic joining of many `text()` calls removed
(#10678), and the bridge no longer breaks under `node --watch` on Node 24/26 (#10725) [S1].

Theta relevance (M6 eval): parallel eval-harness scripts now queue instead of failing, but
the two-worker global cap bounds throughput unless the rig sets `PI_CODEMODE_MAX_WORKERS`.

### 2. Extension event lifecycle — `before_agent_start` union and busy-at-start

What: 1.2.0 (breaking) made `before_agent_start` fire for runs started by
`pi.sendMessage(..., { triggerTurn: true })` while idle, not just user prompts;
`BeforeAgentStartEvent` became a union on `messageType` — `"user"` events carry `prompt` and
`images`, `"custom"` events carry the starting `message` and no `prompt`. Handlers that
should act only on prompts must check `event.messageType === "user"` (#10267, #5581, #10739).
The same release made the session count as busy while a run starts, including during
`before_agent_start`: `ctx.isIdle()` is false there, `pi.sendMessage()` queues into the
starting run instead of failing with "Agent is already processing", `pi.sendUserMessage()`
requires `deliverAs`, and an abort requested meanwhile aborts the run once it starts
(#10739) [S1]. The type declarations confirm the union exactly:
`BeforeAgentStartUserEvent | BeforeAgentStartCustomEvent` [S2 vs S3 diff].

Maturity: *breaking, then completed*. The introducing release also carried the follow-up
(triggered runs once dropped system-prompt sections added in `before_agent_start` after their
first tool call, breaking the prompt cache twice per run — fixed in 1.2.0 itself, #10267)
[S1]. Doc completeness is now high: `docs/extensions.md` was rewritten between 1.1.0 and
1.4.0 (274 → 400 lines) with lifecycle flow diagrams, an event-to-intent table, a
handler-composition table, and the `messageType` guidance [S2].

Theta relevance (M5 gates): the Theta extension's submit gate listens on `tool_call`, which
is unchanged — but any future gate that adjusts prompts or tools at run start must handle
both union arms, and may not assume `prompt` exists.

### 3. Tool registry — `reachesTools` and namespace `aliases`

What: 1.2.0 added `reachesTools` to tool definitions — tools that reach other tools
(`codemode`, `tool_search`) declare which tools a call may reach (`"all"` or input words);
the MCP extension uses it from its `tool_call` handler to finish registering servers that are
still connecting before the call runs, and to decide whether a replacement `codemode` or
`tool_search` tool can reach MCP tools. Namespace `aliases` let scripts look a namespace up
by other names (for example the server name `docs` for `mcp__docs`) [S1]. Both surface in the
shipped types (`ToolDefinition.reachesTools`, `ToolNamespace.aliases`, and `ToolInfo` now
picks up `reachesTools`) [S2 vs S3 diff] and in the rewritten `docs/extensions.md` [S2].

Maturity: *shipped clean* — no follow-up fixes in range; typed and documented.

Theta relevance (M5 gates / M7 shell): if Theta ever registers an orchestrating tool that
calls MCP tools (theta-compute), it should declare `reachesTools` so calls wait for
connecting servers instead of failing.

### 4. MCP handling — connect behavior, spec revision, OAuth hardening

What: 1.2.0 (breaking for `--json` consumers) changed `pi mcp list --json` to report
`resources: true` instead of `resources`/`resourceTemplates` counts, and pi stopped listing
resources when connecting — which also fixed MCP servers with resources registering no tools
until every resource was listed (#10526). The same release accepted MCP 2026-07-28
structured content that is not an object (array, `null`, primitive) (#10416), stopped
sending tool calls that were cancelled or timed out during an OAuth refresh (#10598), and
hardened OAuth sign-in to reject an authorization response whose `iss` could not be checked
against authorization-server metadata (external security report) [S1]. 1.4.0 fixed
`mcp.json` files starting with a UTF-8 BOM failing to parse, which silently skipped every
server in the file (#11191) [S1].

Maturity: *stable feature, actively hardened*. No new MCP capability shipped; the changes are
a spec-revision accommodation, two availability fixes, and one security fix. Docs: the
`reachesTools` note is the only `docs/mcp.md` delta (2 lines); the page was already complete
at 1.1.0 [S2 vs S3 diff].

Theta relevance (M5 gates): theta-compute is unaffected server-side; dogfood checks that
parse `pi mcp list --json` must read `resources: true`, not counts — and the BOM fix removes
a failure mode where a hand-edited `mcp.json` silently drops the gateway registration.

### 5. Sessions and resume — tools survive, recovery repaired

What: 1.3.0 made resumed sessions keep the tools activated during the session, with
`--tools +name`/`-name` applied on top unless `--tools` selects explicitly (#10785). 1.4.0
fixed two durability holes: resumed sessions and `/tree` navigation left extension tools
inactive when the branch recorded its tools before registration — tools the branch never
added or removed are now active unless registered `defaultActive: false` (#11062, #11075);
and sessions broke after recovery from a response cut off at the output limit, because the
truncated tool call was omitted while its tool results were kept, making every later request
fail provider validation (#11227, #11233) [S1].

Maturity: *hardened*. Two releases of repair on recovery paths is the signature of a feature
used hard in the field; both fixes landed with the release that carried them (no open
follow-ups in range).

Theta relevance (M6 eval): multi-session dogfood and rig legs that `/resume` now keep the
Theta extension's tools active — resume no longer silently strips registered tools.

### 6. Sharing — `sessionShareDestination`

What: 1.3.0 added the `sessionShareDestination` setting (`"auto" | "gist" | "radius"`) so
`/share` can be pinned to one destination instead of auto-choosing Radius-when-authenticated
else gist (#10870) [S1]. Documented in `docs/settings.md` and `docs/sessions.md` in the same
release [S2].

Maturity: *shipped clean*.

Theta relevance (M8 packaging): session exports for public evidence — if a strike ever shares
a transcript, `gist` is the deterministic destination.

### 7. Configuration schemas and the generated reference

What: 1.2.0 (breaking) published generated schemas for `settings.json`, `models.json`,
keybindings, and themes at `https://pi.dev/schemas/*.schema.json`; the theme schema moved to
`theme.schema.json`, themes loaded during startup now get the same validation as reloads, and
theme files must move `$schema` references, define reusable colors under `vars`, and drop
unsupported metadata (#9880, #10751). The schemas also ship inside the tarball
(`schemas/*.schema.json` — new directory) [S5]. 1.4.0 completed the arc: the models schema
gained field descriptions it was missing (#10790), and a generated reference doc,
`docs/models-configuration.md` (196 lines, every provider/model/override/compat field),
joined the doc set along with `nvidia-rtx-llama-cpp.md` [S1][S2][S5].

Maturity: *breaking, completed within the window*. The 1.4.0 descriptions fix is the direct
follow-up to the 1.2.0 schema publication.

Theta relevance (M8 packaging): no theta-agent change required — the package ships no themes
or settings — but `models.json` (where the machine's provider override lives) now has both
editor validation and a complete field reference.

### 8. Compaction and summaries — output cap removed

What: 1.4.0 made compaction and branch summaries use the model's output limit instead of a
fixed summary cap, fixing "generation hit the token cap" failures when reasoning consumed the
budget (#9512, #9075); `compaction.reserveTokens` now only controls when compaction starts
[S1]. API note: `generateSummary()` and `generateSummaryWithUsage()` now ignore their
`reserveTokens` parameter — a silent deprecation [S1]. Related 1.2.0 change:
`serializeConversation()` omits thinking blocks so summary requests cannot exceed the context
they summarize [S1]. 1.4.0 also fixed `/compact <instructions>` ignoring its instructions
when compaction split the start of a turn (#11058) [S1].

Maturity: *hardened*; the long-standing cap failures (#9075 dates back months) closed in
1.4.0.

Theta relevance (M6 eval): long research sessions that compact mid-loop no longer fail
summarization — relevant to any long-running eval leg; do not pass `reserveTokens` in new
extension code.

### 9. Codemode classifier models — image input

What: 1.4.0 extended `models.classify()` to accept `images` for TypeSafe's Jev and
Cloudflare's Clef models on `typesafe`, `cloudflare-workers-ai`, and OpenRouter (GPT-6 Luna
image judging shipped earlier, in 1.1.0); provider-level `compat` in `models.json` now
applies to classifiers, with System One `imageInput`/`sendImageOptInHeader` fields for
proxies serving another service's classifiers [S1][S3]. `docs/models.md` documents which
providers take images and the per-model formats (PNG/JPEG/WebP, counts) [S2].

Maturity: *shipped clean*, with one pricing correction in the same release (Clef Flash /
Jev per-million prices corrected) [S1].

Theta relevance (M6 eval): image-capable classifiers could judge figures/plots in eval
scoring without a vision chat model.

### 10. Provider catalog and request handling

What (selected, user-facing): per-key OpenRouter model lists — with an OpenRouter key, pi
lists only that key's usable models with its context/prices, cached for offline use (#10353,
#10672) [1.2.0]; `kimi-coding` moved to Chat Completions and base-URL overrides must now
include `/v1` (#10720) [1.3.0]; thinking-level changes mid-session keep the prompt cache on
OpenAI GPT-6 API-key models (#10853) [1.3.0]; model switching drops an earlier model's
thinking blocks instead of showing them to the new model as text (#10995) [1.3.0]; `--model`
resolves provider ambiguity by preferring the provider with credentials (#10160) [1.3.0];
provider attribution headers now come from pi-ai's client identity — extensions'
`before_provider_headers` no longer see the OpenRouter/NVIDIA/OpenCode attribution headers
[1.4.0]; default-model changes (Copilot `gpt-6.1-sol`, NVIDIA, Xiaomi `mimo-v2.6-pro`) and
additions (MiniMax-M3.1-Flash, Grok `xhigh`) [1.4.0] [S1].

Maturity: *continuous churn* — this is the highest-volume area of every release; treat any
catalog fact as release-bound. The attribution-header change is extension-visible (a handler
returning `null` still removes a header).

Theta relevance: the machine's custom provider override is untouched by these releases; if a
future extension inspects provider headers, code to the 1.4.0 semantics.

### 11. CLI, print mode, and context loading

What: 1.2.0 made print mode (`-p`) print the partial text, warn on stderr, and exit 1 when
the final response is cut off at the output limit, instead of silently exiting 0 (#10799);
1.2.0 also fixed `~` not expanding in `!pattern`/`+path`/`-path` entries of the `extensions`,
`skills`, `prompts`, and `themes` settings (#10765), prompt templates dropping empty quoted
arguments (#10867), tool-call argument parsing dropping fields on invalid `\u` escapes
(#10868), and a symlinked `AGENTS.md` in a git worktree nested inside its main repo loading
no project context at all (#10681) [S1]. 1.3.0 fixed tool calls with malformed final
arguments silently running with the fields parsed before the error — they now fail validation
and show the model its raw arguments (#10897) [S1]. 1.4.0 made the `grep` tool run
`rg --no-config`, so `RIPGREP_CONFIG_PATH` options can no longer silently change regex
searches into literal ones (#11203, #11230) [S1].

Maturity: *hardened*; all are fixes to shipped behavior, each landing complete.

Theta relevance (M5 gates, M7 shell): the rig records exit status — a truncated rig response
now fails loudly (exit 1) instead of passing silently; the nested-worktree `AGENTS.md` fix
matters the day theta-agent carries one (every strike works in `.claude/worktrees/`);
`--no-config` removes a machine-config leak from tool behavior.

### 12. Terminal, TUI, and clipboard

What: 1.2.0 added `PI_CLIPBOARD_OSC52=1` so copies reach a remote client's clipboard through
multiplexer attaches (#10826, #10835) and fixed shifted-symbol keybindings (`ctrl++`) under
Kitty keyboard / modifyOtherKeys (#9880); 1.4.0 added Rex terminal support (OSC 8 hyperlinks,
truecolor, inline images) (#11131, #11150, #11183), fixed the terminal staying in
mouse-tracking/Kitty/alternate-screen modes after an abnormal exit (#11170), fixed concurrent
extension dialogs (a second dialog no longer swallows the first's promise, #11166, #9909),
and fixed overlay `done()` closing the wrong overlay (#10648 fixed in 1.3.0, #10999) [S1].

Maturity: *hardened*; the dialog and overlay fixes are the ones extension UI can build on.

Theta relevance (M7 shell): whatever the M7 shell surface is, it inherits a more robust
terminal-teardown and dialog stack; no Theta action needed now.

### 13. Packaging and distribution (package-facing)

What: 1.2.0 removed the unreleased experimental server/client/plugin stack and the
`./client`/`./experimental/plugin` source exports, and with them the separate
`@earendil-works/pi-client`, `pi-protocol`, and `pi-server` packages; the `@earendil-works/chord`
dependency left too [S1][S5]. 1.3.0 pinned the internal companion packages
(`pi-agent-core`, `pi-ai`, `pi-codemode`, `pi-mcp`, `pi-tui`) to exact release versions so
fresh installs cannot mix incompatible packages (#10865) [S1][S5]. The 1.4.0 tarball adds the
`schemas/` directory to the shipped files; `engines.node` is unchanged at `>=22.19.0` in both
1.1.0 and 1.4.0 [S5]. A 1.4.0 fix also un-broke extension imports of
`@earendil-works/pi-ai/models` (for example `clampThinkingLevel`) through the extension
loader's aliases (#11156) [S1].

Maturity: *stable*. The removed tree was never in the published package, so no consumer
impact; exact pinning is preventive.

Theta relevance (M8 packaging): theta-agent's `peerDependencies: "*"` convention still
resolves — pi carries its own exact-pinned copies; the pi-client/pi-server removal closes the
door on any M7 remote-execution design built on those packages (build on the documented
extension RPC surface instead); note pi's real floor is Node >= 22.19.0, tighter than the
repo's stated "Node ≥ 22".

## Per-release digest (condensed from [S1])

### 1.2.0 — 2026-10-12

Breaking: published config schemas (theme schema moved, startup theme validation);
`before_agent_start` union for triggered runs; busy-while-a-run-starts semantics;
`pi mcp list --json` `resources: true`.

Added: per-key OpenRouter model lists; `$schema` for settings/models/keybindings/themes;
`PI_CLIPBOARD_OSC52`; codemode constraint tags and elapsed/total time; `reachesTools`;
namespace `aliases`.

Changed: `showHardwareCursor` terminal-cursor only; codemode MCP declarations spell out
result types; `serializeConversation()` omits thinking.

Fixed (beyond those above): Mistral mid-generation aborts; OpenRouter negative placeholder
prices; Anthropic strict-tool-set retry; retry classes ("upstream provider returned an
error"); fullscreen overlay scrolling; fragmented terminal color replies; Herdr inline
images; compaction indicator colors; MCP OAuth refresh/cancellation; `auth.json` EPERM on
Windows.

Removed: experimental server/client/plugin stack (+ `pi-client`, `pi-protocol`, `pi-server`
packages); `@earendil-works/chord` dependency.

### 1.3.0 — 2026-10-15

Features: `sessionShareDestination`; cache-preserving thinking-level changes (OpenAI GPT-6
API key); kimi-coding on Chat Completions (base-URL overrides need `/v1`); clean model
switching (drop prior model's thinking); resumed sessions keep active tools.

Fixed: internal deps pinned exact; codemode stop/deadline waits for non-interruptible
built-ins on Bun; worker accumulation (two-worker admission); `--model` provider ambiguity;
`read` line-range labels; Nix flake catalog pin and PATH; prompt-template empty quoted
arguments; `\u` escape argument parsing; error tool results with images (Anthropic/Bedrock);
OpenCode Go endpoints; more retry classes; LiteLLM same-chunk thinking order; Gemini 4 Argon
on Vertex; Xiaomi MiMo thinking levels; openai-codex context window; malformed final
arguments; Claude Haiku 5.5/Opus 5 `off` level; overlay `done()` targeting.

### 1.4.0 — 2026-10-21

Features: classifier image input (Jev, Clef; Clef Omni and Jev 1.14 listed); Models
Configuration reference; summaries use model output limit (no fixed cap); codemode queues
for a free worker (`PI_CODEMODE_MAX_WORKERS`); Rex terminal support; MiniMax-M3.1-Flash.

Changed: attribution headers from pi-ai client identity (extension-visible);
`generateSummary()` ignores `reserveTokens`; default model changes (Copilot, NVIDIA, Xiaomi);
Grok `xhigh`; ChatGPT Business usage-limit errors not retried.

Fixed: models schema descriptions; `pi update` BOM; HTML export CJK emphasis; terminal
teardown escape floods; concurrent extension dialogs; Linux clipboard suspend hang;
`@earendil-works/pi-ai/models` extension imports; `mcp.json` BOM; `/compact` instructions;
resumed-session extension tools; truncated-output session recovery; `grep` `--no-config`;
Windows shell detection (two); Copilot 413 compact-retry; openai-codex phantom models;
whitespace-only tool output 400s; more retry classes (gateway upstream, Codex CLI proxy,
Vertex OAuth, digits-in-request-id over-retry); OpenAI Responses deferred-tool-load cache;
Cloudflare classifier pricing; unclosed `$$` math blocks; CJK bold/italic; `@` autocomplete
regex metacharacters.

## Theta relevance summary

| Capability | Release | Theta line |
|---|---|---|
| Codemode worker queue + cap | 1.3.0/1.4.0 | M6 eval: parallel scripts queue; raise `PI_CODEMODE_MAX_WORKERS` in the rig |
| `before_agent_start` union, busy-at-start | 1.2.0 | M5 gates: handle both union arms; `prompt` only on `"user"` |
| `reachesTools`, namespace aliases | 1.2.0 | M5/M7: declare on any Theta orchestrating tool that calls MCP tools |
| MCP connect/spec/OAuth/BOM fixes | 1.2.0/1.4.0 | M5 gates: `pi mcp list --json` shape; BOM fix protects gateway registration |
| Resume keeps tools; recovery repairs | 1.3.0/1.4.0 | M6 eval: multi-session legs keep theta tools active |
| `sessionShareDestination` | 1.3.0 | M8 packaging: pin `gist` for deterministic public exports |
| Config schemas + models reference | 1.2.0/1.4.0 | M8 packaging: no theta change; `models.json` now fully documented |
| Summary output cap removed | 1.4.0 | M6 eval: long sessions compact reliably; drop `reserveTokens` |
| Classifier images | 1.4.0 | M6 eval: judge figures without a vision chat model |
| Print-mode exit code; `grep --no-config` | 1.2.0/1.4.0 | Rig evidence: truncated responses fail loudly; no rg config leak |
| Nested-worktree `AGENTS.md` fix | 1.2.0 | M7/M8: strike worktrees load project context correctly |
| Packaging: exact pins, removed experimental stack | 1.2.0/1.3.0 | M8 packaging: peer-`*` convention still safe; no pi-client/pi-server to build on |

## Verification and limits

- The changelog [S1] is the inventory's backbone; the tarball docs and type declarations
  [S2] verified each capability that names one, and the 1.1.0 diffs [S3] verified what
  actually changed (for example `docs/extensions.md` +126 lines, `types.d.ts` +38/-8, two new
  doc pages, `schemas/` added, engines unchanged).
- Provider-catalog facts (model names, defaults, prices) are release-bound and will drift;
  they are recorded as shipped, not as promises.
- The 1.4.0 tarball was unpacked and read as data only; nothing from it was executed, and
  the global 1.1.0 install was not touched.
- GitHub release pages [S4] corroborate the changelog text and dates (release bodies are
  generated from the changelog and match it verbatim); no release-notes-only capability
  surfaced, and no claim above rests on the pi.dev site beyond the schema URLs quoted from
  [S1].
