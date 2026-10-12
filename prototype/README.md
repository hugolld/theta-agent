# M2 shape contest (PROTOTYPE)

Throwaway prototype branch for the M2 deliverable-shape decision. Question:
does the M2 literature capability ship as Theta-owned skill material (arm A) or
a registered pi tool (arm B)? The m1-closeout grilling session (2026-10-12)
pre-registered the decision rule: if routing, enforcement, and evidence quality
are comparable across arms, the skill layer wins by simplicity; a tool win
needs a visible, repeatable advantage on at least one axis across the trials.

This is neither a logic nor a UI prototype: the question is mechanism behavior
in real sessions, so the contest runs one-shot pi sessions and scores captured
transcripts, per the recipe in docs/agents/dogfood.md and the checks in
scripts/audit-dogfood.mjs.

## Layout

- `arms/skill/theta-lit-probe/` - arm A canonical copy (placed at `skills/` in arm A state)
- `arms/tool/lit-probe.ts` - arm B canonical copy (placed at `extensions/` in arm B state)
- `arms/expected-skills.arm{A,B}.json` - per-arm inventory oracle for the audit
- `set-arm.sh A|B` - toggle the active arm as a commit (the launch gate refuses a dirty tree)
- `run-trial.sh A|B N "prompt"` - one trial per the dogfood recipe, plus evidence capture
- `evidence/` - per-run session dirs (transcript, process files, attestations)
- `../VERDICT.md` - scorecard and the call

Arm A's SKILL.md description and arm B's tool description share one text; the
contest measures the mechanism, not copywriting. The vendored `paper-lookup`
skill stays present and untouched in both arms: which capability the model
picks when the incumbent exists is itself an M2 finding.

## Re-run

```sh
./prototype/set-arm.sh A
./prototype/run-trial.sh A 1 "Find recent papers on <stable topic> and give me title, first author, year, journal, PMID, and DOI for each."
```

Trials interleave A, B, A, B, A, B. Never merge this branch: it is the primary
source for the contest, kept out of main. Only the validated decision lands on
main, in the M2 spec.
