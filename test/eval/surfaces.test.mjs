// Unit tests for the provenance surfaces (spec #133): the digest-scope
// decision is pinned here — one digest per model-visible surface class,
// the registry exactly advertisement / skill / extensions /
// project-context — together with the digest properties the provenance
// pin leans on: determinism, machine-independence (relative paths, hashed
// bytes), and sensitivity to a one-byte change.

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { REPO_ROOT as repoRoot } from "../helpers/repo-root.mjs";
import {
	advertisementBytes,
	fileTreeDigest,
	SURFACE_CLASSES,
	surfaceDigest,
	surfaceProbePaths,
} from "./surfaces.mjs";
import { SCENARIOS } from "./scenarios.mjs";

test("the surface registry is exactly the decided digest scope: one digest per model-visible surface class", () => {
	assert.deepEqual(Object.keys(SURFACE_CLASSES), [
		"advertisement",
		"skill",
		"extensions",
		"project-context",
	]);
});

test("the land guard's probe paths derive from the registry — every class resolves a root", () => {
	// The digests are computed at land time against the landing tree, so the
	// probe set is the capture binding: it must cover every registry class's
	// root. A class added without a root reds here (surfaceProbePaths
	// refuses), not as a silently unprobed path at the next capture.
	assert.deepEqual(surfaceProbePaths(), ["CLAUDE.md", "extensions", "skills"]);
});

test("an unknown surface class refuses loudly", () => {
	assert.throws(() => surfaceDigest("docs", repoRoot), /unknown model-visible surface class/);
	// An empty skill name would resolve to the whole skills tree — the
	// typo refuses as an unknown class instead of binding everything.
	assert.throws(() => surfaceDigest("skill:", repoRoot), /unknown model-visible surface class/);
});

test("fileTreeDigest is deterministic and machine-independent", (t) => {
	const dir = mkdtempSync(path.join(tmpdir(), "surfaces-digest-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	writeFileSync(path.join(dir, "a.txt"), "alpha\n");
	mkdirSync(path.join(dir, "sub"));
	writeFileSync(path.join(dir, "sub", "b.txt"), "beta\n");
	const first = fileTreeDigest(dir);
	// The same content under a different absolute root digests the same:
	// paths enter relative, bytes hashed, never embedded.
	const twin = mkdtempSync(path.join(tmpdir(), "surfaces-digest-"));
	t.after(() => rmSync(twin, { recursive: true, force: true }));
	cpSync(dir, twin, { recursive: true });
	assert.equal(fileTreeDigest(twin), first);
	assert.equal(fileTreeDigest(dir), first); // and stable across calls
});

test("fileTreeDigest moves on a one-byte change", (t) => {
	const dir = mkdtempSync(path.join(tmpdir(), "surfaces-digest-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	writeFileSync(path.join(dir, "a.txt"), "alpha\n");
	const before = fileTreeDigest(dir);
	writeFileSync(path.join(dir, "a.txt"), "alphaX\n");
	assert.notEqual(fileTreeDigest(dir), before);
	writeFileSync(path.join(dir, "new.txt"), "added\n");
	assert.notEqual(fileTreeDigest(dir), before);
});

test("advertisementBytes derives the canonical block, sorted, with repo-relative locations", (t) => {
	const dir = mkdtempSync(path.join(tmpdir(), "surfaces-ad-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const skill = (name, description) => {
		mkdirSync(path.join(dir, name));
		writeFileSync(
			path.join(dir, name, "SKILL.md"),
			`---\nname: ${name}\ndescription: ${description}\n---\n\nbody\n`,
		);
	};
	skill("zeta-skill", "last in inventory order");
	skill("alpha-skill", "first in inventory order");
	assert.equal(
		advertisementBytes(dir),
		[
			"<skill><name>alpha-skill</name><description>first in inventory order</description><location>skills/alpha-skill/SKILL.md</location></skill>",
			"<skill><name>zeta-skill</name><description>last in inventory order</description><location>skills/zeta-skill/SKILL.md</location></skill>",
			"",
		].join("\n"),
	);
});

test("every surface class every scenario declares digests over the live tree", () => {
	// Each scenario's declared binding, exercised end-to-end against the
	// real tree: each declared class resolves to a sha256 hex digest. The
	// pinned values live in each fixture's provenance manifest, compared by
	// the net itself. project-context is the #133 review round's addition:
	// pi embeds CLAUDE.md as the system record's <project_instructions>, so
	// its bytes are as model-visible as the advertisement. #134 adds the
	// orchestrator (whose binding includes the vendored
	// skill:hypothesis-generation — the re-sync drift class), the notebook,
	// the gateway skill, and the extension-strings scenarios.
	for (const scenario of SCENARIOS) {
		for (const surfaceClass of scenario.surfaces) {
			assert.match(
				surfaceDigest(surfaceClass, repoRoot),
				/^[0-9a-f]{64}$/,
				`${scenario.id}: declared surface ${surfaceClass} does not resolve over the live tree`,
			);
		}
	}
});
