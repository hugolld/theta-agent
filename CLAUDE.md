# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repository is

`theta-agent` — a **pi package** (extensions + skills for the [pi](https://pi.dev) coding agent) that grows into **Theta**, a science co-researcher agent for biology/biomedicine. It is the code repo of the Theta campaign; design decisions (T1–T10), milestone definitions, and task handoffs live in the campaign vault (path in `CLAUDE.local.md`). Treat the vault as read-only reference.

Current state: 0.3.0 — M3 is shipped. The M1 base ships the `theta` launcher (a thin `bin/theta.mjs` that runs `pi -e <package-root>`; macOS/Linux — Windows waits for M8, tracked in issue #2) and the Tier-1 library: K-Dense skills vendored verbatim per ADR 0001 plus the self-authored `theta-research-loop` orchestrator, with re-syncs at milestone boundaries (`docs/agents/resync.md`). M2 adds the first connector skill, `theta-lit-search` (PubMed, arXiv, Semantic Scholar), landed tracer-first: search and get-by-identifier with pacing, in-200 error detection, and credential redaction enforced in its scripts (ADR 0002; script invariants in `docs/agents/connector-scripts.md`). M3 adds `theta-notebook`, the project notebook skill (ADR 0003): five dated provenance-entry types with content-addressed, graded evidence snapshots under the research project's `.theta/`, a recorder script under the connector-script invariants, a notebook-written attestation in the dogfood auditor, and orchestrator doctrine weaving recording into all six loop stages.

## pi-package rules

- Host-provided packages (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, `@earendil-works/pi-agent-core`, `@earendil-works/pi-tui`, `typebox`) go in `peerDependencies` with `"*"` ranges — never `dependencies`, never bundled.
- Keep the `pi-package` keyword (gallery eligibility) and the explicit `pi` manifest (`extensions`, `skills`) in `package.json`. Manifest fields are arrays of strings — pi silently drops bare-string fields (guarded by `test/manifest.test.mjs`).
- Never install `pi-mcp-adapter` — an installed adapter replaces pi's built-in MCP support (native since pi 0.99).
- Target pi ≥ 0.99 and Node ≥ 22. Package loading uses `pi -e <source>`; local-path sources load without copying, so a repo checkout works exactly like the installed package.

## Conventions

- Conventional commits (`feat:`, `chore:`, `docs:`). Tabs and existing field order in `package.json`.
- Extract a shared helper as soon as the same logic shape appears twice within one module (tests included); copying code verbatim is for separately shipped trees only — skill-to-skill, never within a file.
- When a change supersedes text in a steering doc (`CLAUDE.md`, `GLOSSARY.md`, `docs/adr/`), the same strike edits that text.
- `.npmrc` pins the official registry (the machine default is npmmirror).
- No build step; tests use Node's built-in node:test runner (pi loads extension TS via jiti). Verify changes with `npm test`, `npm run lint`, `npm run lint:py` (ruff over the self-authored skill scripts — vendored trees stay verbatim and out of scope), `npm run lint:dups` (jscpd duplication ratchet), and `npm run typecheck`; check shipped files with `npm pack --dry-run`.
- Commits run the suite via the versioned `.githooks/pre-commit` hook; enable it per clone with `git config core.hooksPath .githooks`.
- Dogfood acceptance criteria are met on captured evidence — session transcripts for the skill criteria, recorded exit status and stderr for clean boot — never the model's self-report. Procedure: `docs/agents/dogfood.md`.

## Git workflow — one "coding strike" per task

1. Start the strike in a new git worktree on a feature branch. A worktree inside the repo (`.claude/worktrees/`) resolves the checkout's `node_modules`; one placed elsewhere needs `npm ci` first.
2. On the first commit, open a **draft** PR against `main`.
3. Commit and push every further change to that PR branch, and refresh the PR body as each strike lands — the body is read mid-flight by reviewers and the owner, not only before ready.
4. Before marking the PR ready, run `node scripts/check-strike.mjs <spec#>` — every child of the spec issue must be landed on the branch or already closed (a closeout ticket for the post-merge steps is the expected open exception; a childless issue is a maintenance strike). The same gate fails a PR whose body attests dogfood evidence at an SHA that is not HEAD — recapture the pair, never rebind the words — and refuses while any PR check is non-pass, pending included (M3's red `verify` sat four hours past ready; only merge-day habit caught it). Refresh the PR's title and body to cover every landed child, then mark the PR ready and run a dedicated PR review pass before merging to `main`. For milestone-sized PRs, consider one external-model review round before merge — M2's Codex round caught a defect class two same-model rounds missed.
5. The adversarial loop's stop condition is judgment: once findings require crafted attack strings that honest usage would never produce, stop, record them as a residual trust boundary, and move on. "Findings stay wording-level for two consecutive rounds" applies only to findings a realistic session could trigger; if it has not fired within ~10 rounds, it will not — an adversarial reviewer regenerates findings indefinitely, and "clean" is not a stopping condition it can reach.
6. While a review round is in flight, hold further commits on that branch; when its report arrives, triage against the SHA it reviewed.

## Publishing

`npm publish` is owner-only (browser 2FA; non-interactive publishes fail with `EOTP`). Prepare the release, commit, push — then stop and let the owner publish. It runs from the repo checkout — the committed `.npmrc` pins `registry.npmjs.org` (the machine default is npmmirror) — and that checkout must be the merged tree first: `git pull --ff-only origin main`, then confirm `package.json`'s version and the `npm pack --dry-run` file count match the release, because the M3 publish ran from a stale checkout (0.2.0, 289 files) and only npm's version-conflict refusal caught it. A publish that fails `E404` before any OTP prompt is a lapsed npmjs token, not a missing package: run `npm login` from inside the repo, then retry.

## Agent skills

### Issue tracker

Issues live in GitHub Issues on `hugolld/theta-agent`, managed with the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-role vocabulary (each label string equals its role name). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: root `GLOSSARY.md` + `docs/adr/`. See `docs/agents/domain.md`. Glossary edits are suite-enforced: `_Avoid_` terms are banned from self-authored prose and every headword word must appear in it — the scan list lives in `test/skills-library.test.mjs`.

### Connector scripts

Connector helper scripts (`theta-lit-search`, plus the `theta-notebook` recorder) share enforced invariants — exit-code contract, classification shape, repeat-the-call records. See `docs/agents/connector-scripts.md`.

### SKILL.md frontmatter

Descriptions are capped at 1..1024 chars and must stay plain-scalar-safe (no `: ` sequences in the value). `test/skills-library.test.mjs` enforces both: it parses frontmatter with the `yaml` package — the same engine pi runs — so invalid YAML fails the suite instead of pi silently dropping the skill.
