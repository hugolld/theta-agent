import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { staleStagedFiles } from "../scripts/stale-stage.mjs";
import { fixtureGitRunner, initHardenedGitRepo } from "./helpers/git-repo.mjs";

// The staged-vs-worktree divergence the pre-commit hook warns about
// (the S3 retro, #150): the commit takes the index, the suite tests the
// working tree — a file both staged-modified and worktree-modified
// means the commit ships the index version while the tree holds newer
// content (7622676's message described a guard its stale index did not
// contain). The warning names the class at commit time; it never
// refuses — a git add -p partial-hunk commit leaves exactly this state
// on purpose. Seam split as in check-strike: the pure parse is pinned
// here, the hook invocation stays orchestration.

test("a file staged and worktree-modified is stale-stage", () => {
	assert.deepEqual(staleStagedFiles("MM src/a.ts\n"), ["src/a.ts"]);
});

test("one-sided shapes are not stale-stage", () => {
	// staged-clean worktree-modified (" M"): nothing staged to go stale.
	// staged-modified clean worktree ("M "): the commit carries exactly
	// what the tree holds. Untracked and a rename with a clean worktree:
	// no index/worktree divergence to warn about.
	assert.deepEqual(staleStagedFiles(" M src/a.ts\nM  src/b.ts\n?? src/c.ts\nR  old.ts -> new.ts\n"), []);
});

test("only the divergent files in a mixed status are named", () => {
	assert.deepEqual(staleStagedFiles(" M keep-a.ts\nMM stale-b.ts\n?? noise\nAM fresh-c.ts\n"), [
		"stale-b.ts",
		"fresh-c.ts",
	]);
});

test("empty and undefined parse to nothing", () => {
	assert.deepEqual(staleStagedFiles(""), []);
	assert.deepEqual(staleStagedFiles(undefined), []);
});

// The fixture half: the script at the process boundary, in a real repo —
// the porcelain semantics are the drift risk, so the warning is proven
// against git itself, not against a hand-written status string.
const scriptPath = fileURLToPath(new URL("../scripts/stale-stage.mjs", import.meta.url));

function makeRepo(t) {
	const root = initHardenedGitRepo(mkdtempSync(path.join(tmpdir(), "stale-stage-")));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const git = fixtureGitRunner(root);
	writeFileSync(path.join(root, "a.txt"), "one\n");
	git(["add", "a.txt"]);
	git(["commit", "--message", "base"]);
	return { git, root };
}

function runScript(cwd) {
	return spawnSync(process.execPath, [scriptPath], { cwd, encoding: "utf8" });
}

test("a stale-staged file warns, naming it, and exits zero", (t) => {
	const { git, root } = makeRepo(t);
	writeFileSync(path.join(root, "a.txt"), "worktree newer\n");
	git(["add", "a.txt"]);
	writeFileSync(path.join(root, "a.txt"), "worktree newer still\n");
	const run = runScript(root);
	assert.equal(run.status, 0, "the warning never blocks the commit");
	assert.match(run.stderr, /a\.txt/);
	assert.match(run.stderr, /INDEX/);
});

test("a clean repo says nothing and exits zero", (t) => {
	const { root } = makeRepo(t);
	const run = runScript(root);
	assert.equal(run.status, 0);
	assert.equal(run.stderr.trim(), "");
});
