# pi's MCP client handling, 1.1.0 to 1.4.0: registration, naming, auth, annotations

Date: 2026-10-30

Scope note: this note answers ticket #83 — how pi's MCP client handling changed
between 1.1.0 (the machine's global install, the package's current floor in
practice) and 1.4.0 (npm latest at survey time). Every claim is read from the
two published packages themselves: `docs/mcp.md`, `CHANGELOG.md`, and the
compiled `dist/` types and modules of both versions, compared file by file. The
web was not needed; both trees are local. Each delta below states what changed,
whether it is breaking or additive, and one line of Theta relevance (the
compute gateway client path, the gateway-skill doctrine, or the S6 gate-bypass
residual recorded in ADR 0004). The four axes the ticket names — registration
timing and lifetime, tool-name sanitization, auth, tool annotations — are
sections 3 to 6.

Source ids used inline:

- [S110] `@earendil-works/pi-coding-agent` 1.1.0, the global install under
  `$(npm root -g)/@earendil-works/pi-coding-agent/` (read-only). Its bundled
  `@earendil-works/pi-mcp` SDK dependency is also 1.1.0.
- [S140] `@earendil-works/pi-coding-agent` 1.4.0, pulled as
  `npm pack @earendil-works/pi-coding-agent@1.4.0` from this repo checkout
  (its committed `.npmrc` pins registry.npmjs.org) and unpacked read-only to a
  temp directory. Never executed; read as data.
- [CL] The `CHANGELOG.md` shipped inside [S140]; section-attributed entries are
  quoted with their upstream issue links (repo `earendil-works/pi`).
- [T] Theta repo surfaces: `extensions/submit-gate.ts`, `docs/adr/0004-compute-is-a-native-mcp-server.md`,
  `gateway/README.md`.

Method: `diff -u` across the two trees per file — `docs/mcp.md` (one changed
sentence), `CHANGELOG.md` (section grep for `mcp`/`oauth`), `dist/core/mcp-servers.{js,d.ts}`
(byte-identical), `dist/core/extensions/types.d.ts`, and every file under
`dist/extensions/mcp/`. Identical files are named as such; that identity is
itself the finding for the axes that did not move.

## 1. Where the changes landed

All substantive MCP deltas shipped in **1.2.0** (2026-10-12). The 1.3.0
(2026-10-15) section contains no MCP or OAuth entry. 1.4.0 (2026-10-21)
contains one MCP fix (the `mcp.json` UTF-8 BOM parse, section 9). [CL]

`docs/mcp.md` changed by exactly one sentence between the two versions — the
`replaces the built-in tool` paragraph in "Replace the built-in MCP support"
(section 3.3 below). Every other paragraph, including the whole configuration,
OAuth, exposure, resources, and permissions text, is identical. [S110 §
"Replace the built-in MCP support"; S140 same]

One packaging-level change matters to MCP behavior: internal dependencies,
including the MCP client SDK `@earendil-works/pi-mcp`, moved from caret ranges
(`^1.1.0`) in 1.1.0 to exact pins (`1.4.0`) in 1.4.0 — the 1.3.0 fix "Pinned
internal Pi dependencies to exact release versions" (#10865). A pi install now
carries one exact MCP SDK version instead of resolving a range. [CL; package.json
of both versions]

## 2. Summary table

| # | Delta | Version | Breaking/additive | Theta relevance |
|---|---|---|---|---|
| 3.1 | `reachesTools` on tool definitions; MCP waits become declarative | 1.2.0 | additive API; behavior-preserving for built-ins | No Theta tool reaches other tools today; M5 gate framework gains a hook if it ever needs one |
| 3.2 | A replacement `codemode`/`tool_search` can now reach MCP tools when it declares `reachesTools` | 1.2.0 | additive (was: never) | The one `docs/mcp.md` sentence change; no Theta extension registers tools |
| 3.3 | Connect no longer lists resources; `pi mcp list --json` reports `resources: true` | 1.2.0 | breaking for JSON/type consumers | Theta parses neither; gateway offers no resources |
| 4 | Registration timing and lifetime otherwise unchanged | — | — | The S6 residual stands; preflight doctrine unchanged |
| 5 | `createMcpToolName` byte-identical; namespace `aliases` added | 1.2.0 (aliases) | additive | `mcp__theta_compute__` prefix and its `-`/`_` guarantee are stable |
| 6 | Auth surface unchanged in pi; two OAuth protocol fixes live in the pinned `pi-mcp` SDK | 1.2.0 | additive fixes | Bearer-header registration keeps working verbatim; exact pinning makes the client path reproducible |
| 7 | Tool annotations passthrough byte-identical | — | — | The submit gate's `destructiveHint` read is stable; no action |
| 8 | MCP result schema reworked (`structuredContent` any-JSON, `_meta` dropped) | 1.2.0 | additive for callers | Gateway returns JSON objects; nothing to do |
| 9 | `mcp.json` with a UTF-8 BOM now parses | 1.4.0 | additive fix | Windows-side only; parks under the M8 re-check |

## 3. Server registration timing and lifetime

### 3.1 What a session still does at start (unchanged)

The connection lifecycle pi used in 1.1.0 is the same in 1.4.0, sentence for
sentence in `docs/mcp.md` ("Diagnose connection problems"): pi connects every
enabled server in the background when a session starts; a server's tools appear
once it connects; the first prompt waits up to 10 seconds only for servers with
`direct` tools; other servers are waited for when they are needed; a dropped
connection shows as disconnected and reconnects on the next call;
`tools/list_changed` adds new tools and withdraws removed ones live;
configuration errors, failed connections, and required sign-ins are reported
once after startup; `/reload` picks up out-of-session `mcp.json` changes.
[S110, S140 docs/mcp.md — identical text]

The compiled connect path agrees: the 1.1.0-to-1.4.0 diff of
`dist/extensions/mcp/runtime.js` (`McpServerConnection.connect`) touches only
resource listing (3.3 below); the initialize-then-`tools/list`-then-register
sequence is untouched. `dist/core/mcp-servers.js` — the config loader,
`validateMcpServerConfig`, and `mcpNamespace` — is byte-identical, as is the
extension-facing `pi.registerMcpServer(name, config)` and its precedence rules
("Add servers from extensions" paragraph, identical). [S110, S140]

**Theta relevance:** the S6 gate-bypass residual (ADR 0004's known limit: a
session whose MCP registration missed at launch reached the compute gateway
outside the tool-call pipeline with a hand-written client) is *not* narrowed by
1.2.0–1.4.0. Registration is still session-start-only; a server that is absent
or failed at launch still never produces tools, and the failure is still
reported once and then silent. The gateway-session preflight doctrine — verify
the tunnel before launching the session — keeps carrying that risk, and
bounding client-side gating stays M5's subject. [T: ADR 0004 known-limit
paragraph; S110/S140]

### 3.2 `reachesTools`: the wait-for-servers mechanism became declarative

New in 1.2.0: `ToolDefinition.reachesTools?: (input: Record<string, unknown>) =>
"all" | readonly string[]` — a tool that reaches other tools declares which
ones a call with `input` may reach. The type doc states the MCP use verbatim:
"Extensions that register tools late, such as MCP servers that are still
connecting, use it from their `tool_call` handler to finish registering those
tools before the call runs." `ToolInfo` (what `pi.getAllTools()` returns)
gained the same field in its `Pick`. [S140 `dist/core/extensions/types.d.ts`;
CL 1.2.0 Added, `reachesTools`; S140 docs/extensions.md "Tool exposure"]

The built-ins declare it: codemode returns `"all"` when the script uses a
discovery global (`searchTools`, `describeNamespace`, `describeTool`,
`ALL_TOOLS`) and the word tokens of the script source otherwise;
`tool_search` always returns `"all"`. [S140 `dist/extensions/codemode/tool.js`
`getScriptReach`; `dist/extensions/tool-search/tool.js`]

In 1.1.0 the MCP extension hard-coded this knowledge: it imported
`isCodemodeTool`/`isToolSearchTool` predicates (the codemode one required
`tool.name === "codemode" && tool.parameters === codemodeSchema`) and parsed
the codemode script itself — `scriptNeedsServer(code, server)` tested the
discovery-global regex and `code.includes(mcpNamespace(server))`. In 1.4.0 the
extension's `tool_call` handler calls `tool.reachesTools?.(event.input)` and
`reachesServer` matches when a returned word *contains* the server's namespace
(documented in the type to over-match, the safe direction). Direct MCP calls
still wait only for their own server, "including a reconnect still closing its
old transport" — that comment is verbatim identical in both versions. [S110
`dist/extensions/mcp/index.js` `scriptNeedsServer`; S140 same file
`reachesServer` and the `tool_call` handler]

Additive API, behavior-preserving for the built-in tools. The waiting policy
itself (which call waits for which server) did not change — only who declares
it.

**Theta relevance:** Theta registers no reaching tool today; this matters only
if the M5 gate framework or a later skill registers a codemode-shaped tool,
which would now work against MCP servers without pi-side special-casing.

### 3.3 Replacement `codemode`/`tool_search` tools, and the one docs sentence

The single `docs/mcp.md` change between the versions extends "An extension
that registers `codemode` or `tool_search` similarly replaces the built-in tool
with that name" with: "Pi activates the replacement for MCP servers and waits
for the servers its calls need only when it declares `reachesTools`." [S110 vs
S140 docs/mcp.md]

In 1.1.0 the MCP extension's auto-activation check was name-plus-identity
(`isCodemodeTool`: name and the built-in schema), with the comment "Other
extensions' tools of the same names cannot reach MCP tools, so never activate
them" — a replacement was never activated for MCP. In 1.4.0 the check is
`tool.name === name && tool.reachesTools`: a replacement that declares reach
*is* activated for MCP servers and its calls wait properly. [S110 vs S140
`dist/extensions/mcp/index.js` around `hasReachingTool`]

Additive (a previously impossible configuration now works). **Theta
relevance:** none direct — the note exists because the repo's CLAUDE.md pins
the old wording's implication ("pi-mcp-adapter replaces built-in MCP"); the
replacement surface itself is unchanged.

### 3.4 Resources are no longer listed at connect

1.2.0 removed resource enumeration from the connect path: `McpServerConnection`
keeps only `hasResources` (from the server's declared capabilities); the
`resources` and `resourceTemplates` fields, `fetchResources()`, and the
`resources/list_changed` refresh handler are gone; the three resource tools
(`list_mcp_resources`, `list_mcp_resource_templates`, `read_mcp_resource`)
list and read on demand. This fixes "MCP servers with resources registering no
tools until every resource was listed" (#10526) — a server with a large
resource set previously delayed its *tool* registration until every resource
was enumerated. The changelog marks the consumer-visible part as breaking:
`pi mcp list --json` now reports `"resources": true` instead of counts. [CL
1.2.0 Breaking and Fixed, #10526; S110 vs S140 `runtime.d.ts`, `runtime.js`,
`cli.js`]

Breaking for JSON consumers of `pi mcp list --json` and for SDK readers of the
removed `runtime.d.ts` fields; additive robustness for everyone else. **Theta
relevance:** the repo parses neither surface (grep over `extensions/`,
`test/`, `docs/agents/` finds only the submit gate's `getAllTools()`), and the
compute gateway exposes tools, not resources — no action.

### 3.5 Adjacent, for completeness

1.4.0 fixed "resumed sessions and `/tree` navigation leaving extension tools
inactive when the branch recorded its tools before they were registered"
(#11062) — extension tools, not MCP server tools, but the same late-registration
visibility theme; noted so the survey's registration-timing picture is
complete. [CL 1.4.0 Fixed]

## 4. Tool-name sanitization (`createMcpToolName`)

Byte-identical between the versions, implementation and rules:

```js
const name = `mcp__${server}__${tool}`.replace(/[^A-Za-z0-9_]/g, "_");
// over MAX_TOOL_NAME_LENGTH or already taken:
// `${name.slice(0, MAX-9)}_${sha256(`${server}\0${tool}`).slice(0, 8)}`
```

[S110 and S140 `dist/extensions/mcp/tools.js` — identical function bodies; the
`.d.ts` signature `createMcpToolName(server, tool, isTaken?)` is unchanged]

The surrounding guarantees are also unchanged: `dist/core/mcp-servers.js`
(byte-identical) still rejects a second server whose name differs only in `-`
vs `_`, so one sanitized prefix still names exactly one server — the property
`extensions/submit-gate.ts` documents for `mcp__theta_compute__`. [S110/S140;
T: submit-gate.ts header comment]

One addition rides alongside: `ToolNamespace.aliases` (1.2.0). MCP namespaces
now register the bare server name as an alias (`aliases: [server]`), so
codemode's `describeNamespace("theta-compute")` resolves `mcp__theta_compute`
without the sanitized form. Additive. **Theta relevance:** the submit gate's
prefix match is untouched; aliases are a free convenience for any future
codemode-style script naming the gateway. [S140 `dist/extensions/mcp/index.js`
`registerTools`; CL 1.2.0 Added, `aliases`]

## 5. Auth

The static path Theta uses is unchanged in every file pi ships: `headers` with
`${ENV}` and `!command` value forms, `pi mcp add --header KEY=VALUE` and
`--bearer-token-env-var NAME`, the OAuth block (`oauth.clientId` through
`clientRegistration: "cimd"`), and the credential files
(`~/.pi/agent/mcp.json`, `~/.pi/agent/mcp-auth.json`). `docs/mcp.md`'s auth
sections, `dist/extensions/mcp/oauth.{js,d.ts}`, and `config.d.ts` are
byte-identical between 1.1.0 and 1.4.0; no new auth mechanism appeared.
[S110/S140]

Two OAuth protocol fixes shipped in 1.2.0, and both live in the pinned
`@earendil-works/pi-mcp` SDK (pi's own oauth files did not change — the SDK
moved from 1.1.0 to 1.4.0 alongside):

- "MCP tool calls that were cancelled or timed out while waiting for an OAuth
  refresh still being sent to the server once the refresh finished" (#10598) —
  a cancelled call is no longer sent. [CL 1.2.0 Fixed]
- Sign-in now rejects an authorization response whose `iss` parameter could
  not be checked against discovered authorization-server metadata, instead of
  accepting it (no issue number; reported by AizenvoltPrime). [CL 1.2.0 Fixed]
- Documentation-only: `pi mcp login --timeout` was changed to limit the whole
  sign-in in 1.1.0 already (#10565); 1.2.0 fixed the `--help` text and CLI
  docs to say so (#10636). Between the two versions under study this is a
  wording fix, not a behavior change. [CL 1.1.0 Changed; 1.2.0 Fixed]

**Theta relevance:** the compute gateway client path — deploy-time bearer
token registered once with `pi mcp add ... --header "Authorization=Bearer
${...}"`, read by pi at session start — works verbatim on 1.4.0; the exact
dependency pinning (#10865) additionally means a fresh pi install resolves one
known MCP SDK version rather than a caret range, which makes the gateway
client path reproducible across machines. (Token values never enter this note;
the config path is public documentation in pi's own docs.)

## 6. Tool annotations (the submit gate's input)

Unchanged, to the byte. Both versions convert an MCP tool's server-declared
annotations with the same list and the same boolean-only filter:

```js
const ANNOTATION_HINTS = ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"];
// booleans passed through to ToolDefinition.annotations; anything else dropped
```

A missing hint keeps the MCP defaults pi documents ("a tool is not read-only,
and may be destructive and reach an open world"); `title` still serves as the
description fallback; `ToolInfo.annotations` is untouched by the 1.4.0 type
diff, which only added `reachesTools` to the `Pick`. `pi.getAllTools()` — the
exact call the submit gate makes — still reports the hints. [S110 and S140
`dist/extensions/mcp/tools.js` `toToolAnnotations`, identical; S140
`types.d.ts` diff; docs/extensions.md annotations paragraph, identical]
[T: submit-gate.ts `pi.getAllTools().find(...)?.annotations?.destructiveHint`]

**Theta relevance:** the submit gate's read path is stable across 1.1.0 and
1.4.0 — no code change, and the M5 gate framework inherits the same surface.
The server stays the single source of what is destructive, exactly as ADR 0004
settled.

## 7. Tool result shape (what codemode-visible MCP tools declare)

1.2.0 reworked `createMcpResultSchema`, the output schema every MCP tool
carries: `content` items now have a concrete content-block schema (text, image,
audio, resource_link, resource); `structuredContent` is now always present —
the server's declared output schema relocated under
`#/properties/structuredContent` with its `$ref`s rewritten, or an empty
schema (any JSON value) when the server declares none; `_meta` is dropped from
the schema (the result converter drops it from results); `additionalProperties:
true` covers fields newer protocol versions add. This is the fix for "MCP tool
calls failing when the server returns structured content that is not an object
(an array, `null`, or a primitive, as MCP 2026-07-28 allows)" (#10416), and it
let codemode declarations spell out `content`/`structuredContent`/`isError`
instead of referencing an undefined `CallToolResult<T>`. [S110 vs S140
`dist/extensions/mcp/tools.js` `createMcpResultSchema`; CL 1.2.0 Changed and
Fixed #10416]

Additive (accepts strictly more server behavior). **Theta relevance:** the
compute gateway's tools return JSON objects (the assembled job record among
them), so nothing changes; only servers returning non-object structured content
stopped failing.

## 8. Configuration parse robustness (1.4.0)

`mcp.json` files that begin with a UTF-8 BOM now parse (`stripBom` wraps both
the reader and the editor); previously every server in such a file was skipped
and `pi mcp add`/`remove` failed (#11191). [CL 1.4.0 Fixed; S140
`dist/extensions/mcp/config.js` vs S110 — the only functional change in that
file]

**Theta relevance:** macOS/Linux-authored configs are unaffected; this removes
a silent drop-all-servers mode that Windows tooling can produce — park it under
the M8 packaging re-check, which already gates on Windows-relevant drift.

## 9. What this means for the version-floor decision

Nothing in 1.2.0–1.4.0 forces Theta's hand: the package's two hard pi-MCP
dependencies — the `mcp__theta_compute__` naming guarantee and the
`destructiveHint` passthrough into `getAllTools()` — are byte-stable across
the whole range, and the bearer-header auth Theta registers works verbatim.
The changes that did land are quality-of-service (resources off the connect
path, any-JSON structured content, OAuth cancellation correctness, exact SDK
pinning) plus one genuinely new surface, `reachesTools`, which is optional and
relevant to M5's gate framework only if it registers a reaching tool. The S6
gate-bypass residual is untouched by upstream progress: registration remains
session-start-only, so the preflight doctrine and M5's server-side bounding
keep carrying it.
