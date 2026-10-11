# pi session transcript schema

Reference for the JSONL records pi writes under `~/.pi/agent/sessions/<project>/*.jsonl`, as consumed by `scripts/audit-dogfood.mjs`. Pinned against pi 1.1.0 by `test/dogfood-audit.test.mjs` (golden fixture) and the live runs in PR #13.

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
- **system**: `content: ""`; the payload lives in `sections` — `{ preamble, tools, rules, docs, project_context, skills, cwd }`. `sections.skills` holds the advertisement: exactly one `<available_skills>` block of `<skill><name/><description/><location/></skill>` records, XML-escaped (`&apos;`, `&quot;`). `<location>` is the absolute path to each SKILL.md, spelling affected by mount aliases.
- **assistant**: `content` items are `{type: "text"|"thinking"|"toolCall", …}`. `toolCall` items carry `{id, name, arguments}`; `read` arguments are `{path, offset?, limit?}` — pi passes `offset: 1, limit: 2000` even for full-file reads.
- **toolResult**: own record with `role: "toolResult"`, `toolCallId`, `toolName`, `isError` (boolean, always present), `content` (the returned file text or output — for a SKILL.md read, exactly the file bytes).
- **stopReason** values observed: `stop`, `toolUse`, `length`, `error` (with `errorMessage`).
