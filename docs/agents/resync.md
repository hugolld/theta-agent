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
8. Full battery: `npm test`, `npm run lint`, `npm run typecheck`, `npm pack --dry-run`; live dogfood per `docs/agents/dogfood.md` with the transcript and process evidence that recipe captures.
