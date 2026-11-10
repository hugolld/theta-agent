# The replay net and its captures

The replay net is the eval suite's base layer (ADR 0007): a keyless, deterministic regression net over recorded sessions, run host-side in the standard `npm test` — no model, no key, no rig. This doc owns the net's working doctrine: the three pins, the digest-scope decision, the capture recipe, and the drill leg. The live-model benchmark suite — the eval suite's second layer — is future M6 work and inherits the capture rules recorded here.

## What the net pins

Every fixture under `test/eval/fixtures/<scenario-id>/` is a sanitized pi session recording in pi's own session-file format, committed beside a provenance manifest and a normalized snapshot. The net replays it through pi's public reconstruction exports (`parseSessionEntries`, `buildSessionContext`, from the installed `@earendil-works/pi-coding-agent`) — never a Theta re-implementation of replay. Three pins per fixture, all keyless:

1. **Provenance** — the manifest declares one digest per model-visible surface class (below). The net recomputes each digest from the live tree; a mismatch reds naming the fixture. That red is the doctrine firing: a model-visible change (skill text, connector script, orchestrator doctrine, extension code) lands only with a fresh eval capture, never by editing the fixture.
2. **Snapshot** — the fixture's entry tree, run through the typed normalization layer (`test/eval/normalize.mjs`), equals its committed snapshot under `test/eval/snapshots/`. A fresh capture replaces the snapshot as a reviewable PR diff; the snapshot is never hand-edited.
3. **Determinism** — pi's reconstruction of the fixture yields one context hash, stable across repeated runs in the same pass. Cross-machine stability is what the typed tokens buy; the snapshot pin holds it.

A fourth check rides along: the scenario's expected shape (`test/eval/scenarios.mjs`), asserted structurally against the recording — the skill was advertised, its SKILL.md opened with a paired non-error result, the connector helper ran, the session ended in final assistant text. The capture-time half of that expectation is the auditor legs the rig run passes live.

## The digest-scope decision

One digest per model-visible surface class. The classes live in `test/eval/surfaces.mjs` and are pinned by test:

- `advertisement` — the `<available_skills>` bytes every session's system record carries, derived canonically from every skill's frontmatter name, description, and repo-relative location. Any edit that changes what a session advertises — a description rewrite anywhere, a vendored re-sync, a dropped skill — moves this digest.
- `skill:<name>` — one skill's whole tree under `skills/<name>/`, content-addressed (sorted relative paths, hashed bytes; machine-independent).
- `extensions` — the extension sources under `extensions/`, content-addressed.
- `project-context` — the project-instruction bytes pi loads into the system prompt: CLAUDE.md at the repo root, embedded as the `<project_instructions>` block every session carries. It moves on every milestone's current-state rewrite — exactly the drift the pin exists to catch.

Scoping is per session, honest to what the model actually saw: the connector scenario's fixture binds `advertisement` (every session sees every skill's advertisement line), `project-context`, `skill:theta-lit-search` (the connector's own bytes), and `extensions` (the tool declarations its system record carried) — but not another skill's body, whose bytes were never model-visible in that session. Pi-owned sections (preamble, tools, rules, docs) stay out of scope: they are the installed pi's bytes, pinned by the rig image, not this repo's. The registry is open: a later strike adds a class when a scenario's surface demands one, and the registry pin forces that to be a decision, not an accident.

Digests are computed at land time against the landing tree, which the guard proves identical to the capture's on every surface path — it refuses evidence whose surface paths moved between the session's `pre-head` and the landing tree: committed, uncommitted, ignored (`--ignored=matching`: the digests walk the raw filesystem, so an ignored `__pycache__` under a skill tree rides a tree digest exactly like an edit would), or case-renamed (the status probe runs `-c core.ignorecase=false`: under macOS's default `true`, a case-only rename on disk vanishes from a pathspec status while the digests walk `readdirSync` names). The guard's union is deliberately broader than a fixture's declared classes — an edit to a skill the scenario does not bind refuses too, a false refusal, never a stale landing — and the probe set itself derives from the class registry (`surfaceProbePaths` in `test/eval/surfaces.mjs`, pinned beside the registry): a class added to the registry widens the probe automatically, and a registry class without a probe root refuses instead of escaping the guard. Every refusal class is pinned by `test/eval/capture-guard.test.mjs` against a throwaway git repo. An eval capture binds surfaces, not HEAD: a test-tree-only commit after the capture changes nothing the model saw, so landing stays honest without a recapture. A refused auditor leg means redoing the capture, never patching the evidence — the 2026-11-09 recapture round hit the class twice: a session that never invoked the helper, and one whose every helper call trailed `; echo "EXIT=$?"` (the `;` breaks the auditor's `&&`-chain proof — steer the next roll toward one plain command per call, the way the read-headroom phrasing steers whole-file reads).

## The normalization layer

Typed, never regex-laundered: exactly five rewrite classes — absolute paths, ISO timestamps, durations, identifiers (session/entry/tool-call), provider/model attribution — pinned as a design constant by `test/eval/normalize.test.mjs`. Everything outside the five passes through untouched; a snapshot diff there is behavior drift, the net's signal. Identifiers renumber in first-occurrence walk order (`<id#N>`), so entry chains and toolCall pairing survive while raw ids never enter a snapshot.

## Taking a capture

From a clean, committed tree (the rig gates on it), with the scenario list as the only source of the prompt:

```sh
node test/eval/capture.mjs rig connector          # rig leg + live audit (~minutes)
node test/eval/capture.mjs land connector <evidence-dir>   # sanitize + fixture + snapshot
npm test                                           # the net must be green before commit
```

The rig leg drives `test/rig/run.mjs` with the scenario's own prompt and legs, so the capture is deliberate, prompt for prompt; the auditor attests the live session (skill opened, script executed). The land step sanitizes by the golden-fixture recipe — the session's checkout root becomes `__REPO__` (structure survives, machine roots do not), host machine paths (the shared prefix vocabulary in `test/helpers/machine-paths.mjs`, plus the operator's live home) and every provider entry's credential bytes must be absent (both guarded mechanically) — then writes the fixture, the provenance manifest, and the regenerated snapshot. The manifest anchors both ends of the binding: `sessionPreHead` is the capture session's HEAD, `landedHead` the tree the digests were computed against — the guard proves the surfaces identical between the two.

Payload redaction beyond paths is a per-capture judgment: the operator reads the sanitized transcript before it enters the public repo (bibliographic payloads from public APIs have shipped verbatim; node lists and job names would be redacted as `__HOST_*__` placeholders, the dogfood golden-fixture recipe). Every capture carries the owner's per-capture sign-off, recorded in the landing PR body — GitHub keeps body edit history, so a scrub-after is not undo.

## The pi pairing

The suite replays fixtures through the pi version the lockfile installs; the rig writes its sessions at the rig's own pinned pi. Transcript replay is stable across that pairing (same session-file format), and the pairing is honest by construction: if a future lock or rig bump changes reconstruction semantics, the snapshot pin reds and the snapshot regenerates deliberately, in review — never silently.

## The drill leg

Replay-net strikes carry a drill leg (ADR 0007: the drill proves the net's pins bite). On a scaffold scratch, flip one model-visible byte in the connector surface — the provenance pin must red naming the fixture. Targeted suites only, never the full suite in a scratch (an archived scratch carries no git work tree; measured 2026-11-04):

```sh
node scripts/drill-scratch.mjs /tmp/spec133-drill test/eval/replay-net.test.mjs
# leg 0 (baseline): green — then, in the scratch only, one byte in
# skills/theta-lit-search/SKILL.md; leg 1 reds on the provenance pin by name
```

The captured leg output rides the strike's PR body.
