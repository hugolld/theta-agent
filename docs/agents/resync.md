# Re-syncing the vendored library

ADR 0001 sets the policy: re-syncs happen at milestone boundaries, driven by upstream release notes. The procedure:

1. Pick the upstream release of `K-Dense-AI/scientific-agent-skills`; record tag and commit.
2. Clone at the pin:

   ```sh
   git clone --no-checkout https://github.com/K-Dense-AI/scientific-agent-skills /tmp/k-dense-vendor
   git -C /tmp/k-dense-vendor checkout <commit>
   ```

3. Vendor each changed skill tree into `skills/`, then insert the six-line provenance header after `metadata:` in its `SKILL.md` (mirror `skills/literature-review/SKILL.md`; `date` is the vendoring date, not the release date).
4. Verify verbatim per tree: `diff -r` against the pin. The only allowed delta is the six-line header insert — nothing removed or changed.
5. Recompute `tree-sha256` for every changed tree in `test/expected-skills.json`. The algorithm is `treeDigest` in `test/skills-library.test.mjs`; replicate it exactly — any mismatch fails CI loudly.
6. Update the README "Vendored skills" list and its release/commit line. Then sweep prose count claims elsewhere — the README Status paragraph, CLAUDE.md's current-state text — so no hard count drifts.
7. Pin the release in a comment on the parent spec issue; record skip decisions there, with reasons.
8. Check the eval provenance pins: a re-sync's model-visible diff — a vendored body or provenance-header change, a description rewrite — reds the pins of the scenarios whose fixtures bind the changed surfaces, and each named scenario owes a fresh eval capture before the re-sync lands (procedure: `docs/agents/dogfood.md`; the recapture seam and doctrine: `docs/agents/eval.md`). Never edit a fixture or snapshot by hand.
9. Full battery: `npm test`, `npm run lint`, `npm run typecheck`, `npm pack --dry-run`; live dogfood per `docs/agents/dogfood.md` with the transcript and process evidence that recipe captures.

## Pool packs

The skill pool's domain packs ([ADR 0008](../adr/0008-the-skill-pool-is-a-vendored-project-scoped-library.md)) re-sync by the same nine steps at the same upstream pin as `skills/`, with pool targets: changed trees vendor into `pool/<pack>/<skill>/` with the same six-line provenance header (steps 3–4), digests land in `test/expected-pool.json` — the same `treeDigest` algorithm, a separate file so the shipped-surface pin stays clean (step 5) — and `pool/index.md`'s header and rows join the step-6 count sweep. A pack re-sync covers only the trees its pack carries; skip decisions are recorded on the parent issue with reasons (step 7). The eval-capture obligation for pool surfaces activates with S3's fixture — until then there is no pool capture to owe (step 8).
