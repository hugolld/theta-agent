// Pins the eval-capture land guard's mechanics (spec #133): a landing may
// bind only digests the session actually saw, so the guard must refuse
// every way the landing tree's surfaces can differ from the session's
// pre-head — committed edits, untracked files, ignored files (the surface
// digests walk the raw filesystem, so an ignored __pycache__ rides a tree
// digest exactly like an edit would), and case-only renames under
// core.ignorecase (macOS default; the digest walks readdirSync names) —
// and must refuse rather than pass vacuously when the evidence's pre-head
// does not resolve. Runs against a throwaway git repo, never this one.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { run } from "../../scripts/dogfood-gates.mjs";
import { initHardenedGitRepo } from "../helpers/git-repo.mjs";
import { assertSurfacesUnmoved } from "./capture.mjs";

const scratch = mkdtempSync(path.join(tmpdir(), "eval-land-guard-"));
test.after(() => rmSync(scratch, { recursive: true, force: true }));

function git(...args) {
	const result = run("git", ["-C", scratch, ...args]);
	assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
	return result.stdout;
}

function write(rel, body) {
	const abs = path.join(scratch, rel);
	mkdirSync(path.dirname(abs), { recursive: true });
	writeFileSync(abs, body);
}

// A minimal surface-bearing tree, committed: one skill dir, extensions/,
// and the project-context file — the three paths the guard covers.
write("skills/demo/SKILL.md", "---\nname: demo\ndescription: demo\n---\n");
write("extensions/demo.ts", "export const demo = 1;\n");
write("CLAUDE.md", "# demo\n");
initHardenedGitRepo(scratch);
git("add", "-A");
git("commit", "-m", "capture tree");
const preHead = git("rev-parse", "HEAD").trim();

test("a surface-identical tree passes", () => {
	assertSurfacesUnmoved(scratch, preHead);
});

test("a committed surface edit since the pre-head refuses", () => {
	write("CLAUDE.md", "# demo, edited\n");
	git("add", "-A");
	git("commit", "-m", "surface edit");
	assert.throws(() => assertSurfacesUnmoved(scratch, preHead), /changed since the session's HEAD/);
	write("CLAUDE.md", "# demo\n");
	git("add", "-A");
	git("commit", "-m", "surface restored");
});

test("an untracked file under a surface path refuses", () => {
	write("skills/demo/stray.txt", "stray\n");
	assert.throws(() => assertSurfacesUnmoved(scratch, preHead), /changed since the session's HEAD/);
	rmSync(path.join(scratch, "skills/demo/stray.txt"));
});

test("a case-only rename under a skill tree refuses under core.ignorecase", () => {
	// macOS default core.ignorecase=true: git status with a pathspec
	// reports nothing after a case-only rename on disk, yet
	// fileTreeDigest walks readdirSync names — the guard must not share
	// the blindness (reviewer probe: -c core.ignorecase=false then
	// reports the renamed path). The tracked path is skills/demo/SKILL.md;
	// the disk file becomes skill.md.
	renameSync(
		path.join(scratch, "skills/demo/SKILL.md"),
		path.join(scratch, "skills/demo/skill.md"),
	);
	assert.throws(() => assertSurfacesUnmoved(scratch, preHead), /changed since the session's HEAD/);
	// the guard's own probe must see what plain -uall cannot
	assert.equal(
		run("git", ["-C", scratch, "status", "--porcelain", "-uall", "--", "skills"]).stdout.trim(),
		"",
	);
	renameSync(
		path.join(scratch, "skills/demo/skill.md"),
		path.join(scratch, "skills/demo/SKILL.md"),
	);
});

test("an ignored file under a skill tree refuses like an edit would", () => {
	write(".gitignore", "__pycache__/\n");
	git("add", "-A");
	git("commit", "-m", "ignore pycache");
	write("skills/demo/scripts/__pycache__/demo.cpython-313.pyc", "bytes");
	// plain -uall sees nothing; the guard must not share that blindness
	assert.equal(
		run("git", ["-C", scratch, "status", "--porcelain", "-uall", "--", "skills"]).stdout.trim(),
		"",
	);
	assert.throws(() => assertSurfacesUnmoved(scratch, preHead), /changed since the session's HEAD/);
	rmSync(path.join(scratch, "skills/demo/scripts"), { recursive: true, force: true });
});

test("an unresolvable pre-head refuses instead of passing vacuously", () => {
	assert.throws(() => assertSurfacesUnmoved(scratch, "not-a-revision"), /git probe failed/);
});
