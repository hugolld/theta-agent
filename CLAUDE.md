# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repository is

`theta-agent` — a **pi package** (extensions + skills for the [pi](https://pi.dev) coding agent) that grows into **Theta**, a science co-researcher agent for biology/biomedicine. It is the code repo of the Theta campaign; design decisions (T1–T10), milestone definitions, and task handoffs live in the campaign vault (path in `CLAUDE.local.md`). Treat the vault as read-only reference.

Current state: 0.0.2 — the M1 launcher (stage A of T9, PR #1) is merged: a thin `bin/theta.mjs` that runs `pi -e <package-root>` so `npm i -g theta-agent && theta` works (macOS/Linux; Windows waits for M8, tracked in issue #2). The M1 Tier-1 library ships complete: 19 K-Dense skills vendored verbatim per ADR 0001 (tracer PR #9, batch PR #10) plus the self-authored `theta-research-loop` orchestrator; re-syncs happen at milestone boundaries (`docs/agents/resync.md`).

## pi-package rules

- Host-provided packages (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, `@earendil-works/pi-agent-core`, `@earendil-works/pi-tui`, `typebox`) go in `peerDependencies` with `"*"` ranges — never `dependencies`, never bundled.
- Keep the `pi-package` keyword (gallery eligibility) and the explicit `pi` manifest (`extensions`, `skills`) in `package.json`. Manifest fields are arrays of strings — pi silently drops bare-string fields (guarded by `test/manifest.test.mjs`).
- Never install `pi-mcp-adapter` — an installed adapter replaces pi's built-in MCP support (native since pi 0.99).
- Target pi ≥ 0.99 and Node ≥ 22. Package loading uses `pi -e <source>`; local-path sources load without copying, so a repo checkout works exactly like the installed package.

## Conventions

- Conventional commits (`feat:`, `chore:`, `docs:`). Tabs and existing field order in `package.json`.
- When a change supersedes text in a steering doc (`CLAUDE.md`, `GLOSSARY.md`, `docs/adr/`), the same strike edits that text.
- `.npmrc` pins the official registry (the machine default is npmmirror).
- No build step; tests use Node's built-in node:test runner (pi loads extension TS via jiti). Verify changes with `npm test`, `npm run lint`, and `npm run typecheck`; check shipped files with `npm pack --dry-run`.
- Dogfood acceptance criteria are met on pi session-transcript evidence, never the model's self-report. Procedure: `docs/agents/dogfood.md`.

## Git workflow — one "coding strike" per task

1. Start the strike in a new git worktree on a feature branch.
2. On the first commit, open a **draft** PR against `main`.
3. Commit and push every further change to that PR branch.
4. When the strike is complete, mark the PR ready, then run a dedicated PR review pass before merging to `main`.

## Publishing

`npm publish` is owner-only (browser 2FA; non-interactive publishes fail with `EOTP`). Prepare the release, commit, push — then stop and let the owner publish.

## Agent skills

### Issue tracker

Issues live in GitHub Issues on `hugolld/theta-agent`, managed with the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-role vocabulary (each label string equals its role name). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: root `GLOSSARY.md` + `docs/adr/`. See `docs/agents/domain.md`.
