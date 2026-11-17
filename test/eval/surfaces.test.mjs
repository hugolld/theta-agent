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
	poolPackDigest,
	SURFACE_CLASSES,
	surfaceDigest,
	surfaceProbePaths,
} from "./surfaces.mjs";
import { SCENARIOS } from "./scenarios.mjs";

test("the surface registry is exactly the decided digest scope: one digest per model-visible surface class", () => {
	assert.deepEqual(Object.keys(SURFACE_CLASSES), [
		"advertisement",
		"skill",
		"pool",
		"extensions",
		"project-context",
	]);
});

test("the land guard's probe paths derive from the registry — every class resolves a root", () => {
	// The digests are computed at land time against the landing tree, so the
	// probe set is the capture binding: it must cover every registry class's
	// root. A class added without a root reds here (surfaceProbePaths
	// refuses), not as a silently unprobed path at the next capture.
	assert.deepEqual(surfaceProbePaths(), ["CLAUDE.md", "extensions", "pool", "skills"]);
});

test("an unknown surface class refuses loudly", () => {
	assert.throws(() => surfaceDigest("docs", repoRoot), /unknown model-visible surface class/);
	// An empty skill name would resolve to the whole skills tree — the
	// typo refuses as an unknown class instead of binding everything.
	assert.throws(() => surfaceDigest("skill:", repoRoot), /unknown model-visible surface class/);
	// An empty pack name would escape the pack tree — same refusal.
	assert.throws(() => surfaceDigest("pool:", repoRoot), /unknown model-visible surface class/);
	// An unknown pack resolves to nothing — a typo in the class refuses
	// (the missing root surfaces as the walker's ENOENT, an empty pack as
	// the digest's own refusal; either way it never digests).
	assert.throws(() => surfaceDigest("pool:no-such-pack", repoRoot), /surface tree is empty|ENOENT/);
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

// A minimal pool in a scratch tree: one pack with two skills and the class
// map — the two inputs the pool digest binds (spec #167).
function scratchPool(t) {
	const root = mkdtempSync(path.join(tmpdir(), "surfaces-pool-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const writePool = (rel, body) => {
		mkdirSync(path.join(root, "pool", path.dirname(rel)), { recursive: true });
		writeFileSync(path.join(root, "pool", rel), body);
	};
	writePool("bioinformatics/demo/SKILL.md", "---\nname: demo\n---\nbody\n");
	writePool("bioinformatics/demo/scripts/run.py", "print('hi')\n");
	writePool("bioinformatics/keyed/SKILL.md", "---\nname: keyed\n---\nbody\n");
	writePool("classes.json", '{"bioinformatics/demo": "local", "bioinformatics/keyed": "key"}\n');
	writePool("index.md", "# the human surface, deliberately unbound\n");
	return root;
}

test("poolPackDigest binds the pack tree and the class map, and refuses a pool without either", (t) => {
	const root = scratchPool(t);
	const digest = poolPackDigest(root, "bioinformatics");
	assert.match(digest, /^[0-9a-f]{64}$/);
	// stable across calls
	assert.equal(poolPackDigest(root, "bioinformatics"), digest);
	// a pack body byte moves it — the model-visible edit class
	writeFileSync(path.join(root, "pool/bioinformatics/demo/SKILL.md"), "---\nname: demo\n---\nbodyX\n");
	assert.notEqual(poolPackDigest(root, "bioinformatics"), digest);
	// a reclass moves it: the class map gates what loads, so it is as
	// model-visible as a body edit
	writeFileSync(
		path.join(root, "pool/classes.json"),
		'{"bioinformatics/demo": "key", "bioinformatics/keyed": "key"}\n',
	);
	assert.notEqual(poolPackDigest(root, "bioinformatics"), digest);
	// the unbound human surface (index.md) does not move it
	writeFileSync(path.join(root, "pool/index.md"), "# edited prose\n");
	const held = poolPackDigest(root, "bioinformatics");
	writeFileSync(path.join(root, "pool/index.md"), "# the human surface, deliberately unbound\n");
	assert.equal(poolPackDigest(root, "bioinformatics"), held);
	// an unknown pack and a missing class map refuse, never digest silence
	assert.throws(() => poolPackDigest(root, "no-such-pack"), /surface tree is empty|ENOENT/);
	const bare = mkdtempSync(path.join(tmpdir(), "surfaces-pool-"));
	t.after(() => rmSync(bare, { recursive: true, force: true }));
	mkdirSync(path.join(bare, "pool/lonely"), { recursive: true });
	writeFileSync(path.join(bare, "pool/lonely/SKILL.md"), "---\nname: lonely\n---\n");
	assert.throws(() => poolPackDigest(bare, "lonely"), /ENOENT/);
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
