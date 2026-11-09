// Unit tests for the provenance surfaces (spec #133): the digest-scope
// decision is pinned here — one digest per model-visible surface class,
// the registry exactly advertisement / skill / extensions — together with
// the digest properties the provenance pin leans on: determinism,
// machine-independence (relative paths, hashed bytes), and sensitivity to
// a one-byte change.

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { advertisementBytes, fileTreeDigest, SURFACE_CLASSES, surfaceDigest } from "./surfaces.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("the surface registry is exactly the decided digest scope: one digest per model-visible surface class", () => {
	assert.deepEqual(Object.keys(SURFACE_CLASSES), ["advertisement", "skill", "extensions"]);
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

test("every surface class the connector scenario declares digests over the live tree", () => {
	// The tracer's fixture #1 binding, exercised end-to-end against the
	// real tree: each declared class resolves to a sha256 hex digest. The
	// pinned values live in the fixture's provenance manifest, compared by
	// the net itself.
	for (const surfaceClass of ["advertisement", "skill:theta-lit-search", "extensions"]) {
		assert.match(surfaceDigest(surfaceClass, repoRoot), /^[0-9a-f]{64}$/);
	}
});
