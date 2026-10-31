# pi session transcript schema

Reference for the JSONL records pi writes under `~/.pi/agent/sessions/<project>/*.jsonl`, as consumed by `scripts/audit-dogfood.mjs`. Pinned against pi 1.4.0 by `test/dogfood-audit.test.mjs` (two golden fixtures — the 2026-10-10 real transcript and the 2026-10-21 M4 S1 codemode capture) and the boot-clean rig run in PR #98 — first pinned by the pi 1.1.0 live runs in PR #13; the custom-tool and `details` shapes below are pinned by the M2 shape-contest runs (`prototype/m2-shape-contest`).

## Record envelope

Every line is one JSON object: `type`, `id`, `parentId`, plus a type-specific payload. Records form ONE linear chain rooted at the session record: `parentId` is either `null` (only the first post-session record may be a root — observed once, on `model_change`) or the previous record's `id`. Unknown types are appended over time (`thinking_level_change`, …).

## Types

| type | payload | notes |
|---|---|---|
| `session` | `id`, `cwd`, `version` | first record; `cwd` is the launch directory |
| `model_change` | `id`, `provider`, `modelId` | may carry `parentId: null` (root exception) |
| `thinking_level_change` | `id`, parentId | |
| `message` | `id`, `parentId`, `message` | the evidence records; see below |

## message records

`message: { role, provider, model, stopReason, errorMessage?, content, durationMs?, usage? }`

- **roles**: `system`, `user`, `assistant`, `toolResult`.
- **system**: `content: ""`; the payload lives in `sections` — `{ preamble, tools, rules, docs, project_context, skills, cwd }`. `sections.skills` holds the advertisement: exactly one `<available_skills>` block of `<skill><name/><description/><location/></skill>` records, XML-escaped (`&apos;`, `&quot;`). `<location>` is the absolute path to each SKILL.md, spelling affected by mount aliases. `sections.tools` is the built-in-tools text block (it ends with a generic "other custom tools" line); a custom tool registered by an extension is declared via the provider tool schema, and the transcript persists that declaration at the message level — the system record's `toolsAdded` array holds one entry per tool (`name`, `description`, `parameters`), the built-ins plus any extension-registered tool. No system section names a custom tool.
- **assistant**: `content` items are `{type: "text"|"thinking"|"toolCall", …}`. `toolCall` items carry `{id, name, arguments}`; `read` arguments are `{path, offset?, limit?}` — pi passes `offset: 1, limit: 2000` even for full-file reads. `bash` arguments are `{command, timeout?}` — the raw command string, with paths spelled absolutely or relative to the session cwd; the auditor's script attestation reads program position out of it.
- **toolResult**: own record with `role: "toolResult"`, `toolCallId`, `toolName`, `isError` (boolean, always present; the bash tool sets it `true` for a non-zero exit status), `content` (array of typed items — `{type: "text", text}` — carrying the returned output; for a SKILL.md read, the text is exactly the file bytes). Custom-tool results also persist a `details` object (tool-defined; observed: query, sort, count, pmids, records, provenance) — machine-checkable without parsing shell text. Built-in tools (bash, read) carry no `details`. A result whose tool called other tools (a codemode script) also carries `nestedCalls` — pi's bounded record of them: `{ calls: [{id, name, status, arguments, durationMs?}], complete }`, never results. Nested ids are assigned by pi as `<parent id>/<n>` (a deeper nest appends further `/n` segments) and never appear as toolCall or toolResult records — the parent result is their only transcript presence. `arguments` over 8 KiB per call are omitted, at most 256 calls are kept, and `complete: false` marks a record that lost anything. The auditor reads this record (`collectNestedCalls`): every nested id must derive from the carrying result's `toolCallId`, all nested ids are unique, and none collides with a top-level call id — a fabricated record fails closed. Pinned by the sanitized M4 S1 codemode capture (`test/fixtures/m4-s1-codemode-transcript.jsonl`), which drove the gateway through nested calls.
- **stopReason** values observed: `stop`, `toolUse`, `length`, `error` (with `errorMessage`).
