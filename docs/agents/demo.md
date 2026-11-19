# Demo doctrine — the collaborator demonstration

The M7a demo slice: a repeatable, rehearsed demonstration of Theta running
live in pi's interactive TUI, deployed on the cluster login node, for an
audience of pharmacology and wet-lab researchers who will not drive the
agent themselves. Campaign-level decisions live in the vault's M7a design
note (D1–D6); this doc is the repo's build and runbook surface.

## Scope and standing decisions

- **The terminal session is the demonstration.** No web UI, no new shell:
  pi's interactive mode dressed through the extension API. The audience
  reads the loop; the owner drives.
- **English throughout** — output, notebook text, code. Slides and
  narration may be Chinese; the product surface stays English.
- **The cluster leg is optional.** The demo script runs complete without
  it. Enabling the leg requires the deployed compute gateway on the login
  node — owner-run verification, the gateway README's phase-0 recipe; the
  leg adds the submit-gate confirm, poll, fetch, and job-record path.
- **The demo runs in tmux on the login node, in the standing allocation's
  compute node** (the devnode tool: a persistent sbatch allocation whose
  tmux session lives on the login node and whose pane runs `ssh -t` into
  the compute node — the venue the 2026-11-19 rehearsal settled, because
  the login node's hard 5 GB virtual-memory cap breaks pi's provider
  calls: the bundled undici needs a WASM allocation per HTTP request, and
  every allocation fails under the cap). The session's environment is
  prepared once: a uv-managed Python 3.12 venv in the checkout, first on
  PATH (the compute node's system python predates the connector scripts'
  3.11 floor), and a loopback forward from the compute node to the
  login-node gateway, raised before the session boots — pi registers MCP
  servers at session start only. No laptop or VPN dependency for the live
  run.
- **The recording is part of the demo.** Rehearse in the clean-room rig;
  carry an asciinema capture and an exported-HTML session as the fallback
  for any live-run failure.

## Build items

| # | Item | Mechanism | Status |
|---|---|---|---|
| B1 | Notebook entry cards — each provenance entry renders as a card in the transcript, badged with the evidence grades of the evidence items it stands on (asserted / cross-checked / re-executed) | recorder hook → `pi.appendEntry()` + `pi.registerEntryRenderer()`; card data is durable, excluded from model context | shipped |
| B2 | `/notebook` command — render the project notebook on demand: entries table, evidence grades, dates | `pi.registerCommand()` reading `.theta/notebook.jsonl`; notify output only — no blocking dialogs — so the command degrades cleanly outside interactive mode | shipped |
| B3 | Demo prompt templates — scripted, repeatable runs (a pharmacology question, the benchmark suite's `lit-triage` shape) | prompt templates shipped with the package; `/demo-lit-triage` | shipped |
| B4 | `/roadmap` command — the future-plans card: M7b web workbench, cloud deployment study, M8 packaging | `pi.registerCommand()` + TUI boxes | shipped |
| B5 | Theta theme — brand colors, status line: `themes/theta.json` (teal on pi's dark base, shipped through the pi manifest) brands the session at start — the switch fires only when the user set no theme preference — and `theta.ts` sets a persistent branded footer segment (`setStatus`) beside it | pi theme files + session-start switch | shipped |
| B6 | This runbook + rehearsal | this doc; rig rehearsal before the date | shipped |

Mode constraint (binds B1, B2, B4, B5): extension UI is complete in
interactive mode; RPC forwards dialogs and notifications but not custom
components; print and JSON modes have no UI. The demo runs interactive;
commands degrade to notify-only elsewhere.

### The operator-vouched visual capture

Every B-item's acceptance carries one operator-vouched interactive render —
the card, command, or theme surface drawn in the live TUI. The recipe, as
B1 (#178) settled it after five attempts:

1. Launch from the repo or strike-worktree cwd. Two checks key on the
   cwd: `theta --dev` wants the checkout (or `THETA_DEV_ROOT`), and pi's
   sandbox reads the skill tree relative to the cwd, so a `/tmp` launch
   refuses the reads. The sandbox stays on — it keeps the session's
   permission dialogs answering to a human.
2. Wrap the launch in a pty recorder so the TUI renders into the
   capture: `script -q <capture> node bin/theta.mjs --dev --provider
   zai-coding-cn --model glm-5.3-flash`, then run the B-item's
   one-prompt surface against a throwaway `.theta/` in that cwd.
   The probe's input sequence makes the capture complete: boot outgrew
   4 s (B5's probe sleeps 8 s first), feed the surface command, a
   `\r` redraw, then a trailing `/exit\r` — `script`'s typescript
   flushes in ~4K chunks and the last one flushes only on a clean
   script exit, so a killed probe stalls the file at a 4096 multiple
   while the session rendered fine; bound the whole pipeline with a
   background killer as the backstop (one Ctrl-C rarely exits pi).
   Verify counts with `grep -o <pat> <capture> | wc -l`: the ANSI
   capture is one line, so `grep -c` reports 1 regardless of
   occurrences.
3. Archive beside the strike evidence: the ANSI original, the faithful
   copy, plus a plain stripped copy that reads cleanly; clear the
   scratch `.theta/` afterwards.
4. The vouch is the owner's per-capture sign-off in the session,
   attested in the PR body like the fixture sign-offs.

## Runbook — the seminar script

Rehearse the full script in the clean-room rig first
(`node test/rig/run.mjs run "<prompt>"` for the legs it covers); the
live run is the same script on the login node.

```
 1. SSH to login node → devnode attach (tmux on the login node; the pane
    runs ssh -t into the standing allocation's compute node; forward up,
    venv first on PATH, TERM=xterm-256color) → theta --dev (from the
    checkout)
    Show: /theta (status); the / command menu — every loaded skill
    lists there as a /skill:name entry
 2. /demo-lit-triage — the scripted pharmacology question; the research
    loop runs live: literature search → triage → notebook cards appear
    in the transcript as the recorder appends
 3. /notebook — the provenance trail: entries, grades, dates
 4. OPTIONAL cluster leg — theta-compute: stage → submit (the submit
    gate confirms) → poll → fetch → the job record lands in the notebook
    (graded re-executed). SKIP PATH: if the gateway is down or the queue
    is hostile, narrate from the roadmap card and move on — the script
    is complete without it.
 5. /roadmap — the web workbench (M7b), the cloud deployment study,
    M8 packaging
 6. /export <path> — the self-contained HTML transcript, sent to the
    audience afterwards
```

## Rehearsal and fallback

- Rehearse end-to-end at least twice before the date: once in the rig,
  once on the login node itself (the live environment — tmux, the
  cluster's shell, the real terminal size).
- The rig rehearsal (2026-11-19, #193) measured the pacing: the
  lit-triage leg runs about ten minutes end to end (637 s in the rig).
  The narration plans around the long middle — searches scanning,
  the abstract fetch, cards landing as the recorder appends.
- The loop composes two skills: `theta-lit-search` runs the searches,
  and the vendored `paper-lookup` runs the documented abstract
  fetch. Both beats belong in the script — the second is not an
  improvisation.
- Semantic Scholar skips keyless (exit 5, by invariant) in every leg
  that carries no key: a visible, correct beat, not a failure.
- Prepare the demo project directory before the audience arrives, with
  `.theta/` already present. The recorder refuses an evidence-free
  first record into a fresh project (exit 2) until the directory
  exists — an evidenced first record creates it. A prepared
  directory removes that beat from the live script.
- Give `/exit` time before teardown: the session saves slowly on the
  shared filesystem, and the asciinema cast flushes its final chunk only
  on the recorder's clean exit — a session killed first keeps its
  recording truncated at the tail (the 2026-11-19 rehearsal lost only the
  exit beat that way; the playback otherwise complete).
- Record the login-node rehearsal (asciinema). The recording plus the
  exported HTML travel with the demo as the fallback pair.
- A live-run failure (model error, network, queue) falls back to the
  recording with narration; the demo does not retry live.
- The demo prompt is pure ASCII (the dogfood rule); the scripted
  templates own this by construction.
- Before the live cluster leg runs, the owner signs off its two open
  questions: the demo's submit runs under the owner's cluster account,
  and the audit trail's location is acceptable to show on screen.
