import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

// scripts/strike-teardown.mjs ends a coding strike in one command: anchor the
// main checkout by the shared git dir (the session's shell may stand anywhere
// in the repo, including inside the worktree being removed), fetch, refuse
// unless the branch is merged into origin/main, pull main fast-forward, then
// remove the worktree and delete the branch. The fixture repos run offline —
// the origin is a local bare clone — and the process tests drive the script at
// the process boundary the way a strike session would.
const scriptPath = fileURLToPath(
	new URL("../scripts/strike-teardown.mjs", import.meta.url),
);
import { parseWorktrees } from "../scripts/strike-teardown.mjs";

// A fixture: a bare origin, a main checkout cloned from it (on branch main),
// and one feature worktree. `merged` decides whether the feature branch's
// commit lands on origin/main. Returns the paths the tests assert on.
function makeFixture(t, { merged }) {
	const root = mkdtempSync(path.join(tmpdir(), "strike-teardown-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const git = (args, cwd = root) => {
		const run = spawnSync("git", ["-c", "init.defaultBranch=main", ...args], {
			cwd,
			encoding: "utf8",
		});
		assert.equal(run.status, 0, `git ${args.join(" ")}: ${run.stderr}`);
		return run.stdout;
	};
	const origin = path.join(root, "origin.git");
	git(["init", "--bare", "--initial-branch=main", origin]);
	const main = path.join(root, "main");
	git(["clone", "--quiet", origin, main]);
	git(["config", "user.email", "fixture@example.com"], main);
	git(["config", "user.name", "fixture"], main);
	git(["commit", "--allow-empty", "--message", "base"], main);
	git(["push", "--quiet", "origin", "main"], main);
	// The feature branch, checked out in its own worktree, one commit ahead.
	git(["worktree", "add", "--quiet", path.join(root, "wt"), "-b", "feature-x"], main);
	git(["config", "user.email", "fixture@example.com"], path.join(root, "wt"));
	git(["config", "user.name", "fixture"], path.join(root, "wt"));
	git(["commit", "--allow-empty", "--message", "strike work"], path.join(root, "wt"));
	if (merged) {
		git(["merge", "--quiet", "--no-ff", "feature-x", "--message", "Merge pull request #0"], main);
		git(["push", "--quiet", "origin", "main"], main);
	}
	return { root, origin, main, wt: path.join(root, "wt") };
}

function runTeardown(cwd, branch) {
	return spawnSync(process.execPath, [scriptPath, branch], {
		cwd,
		encoding: "utf8",
		timeout: 60_000,
	});
}

const branchExists = (main, branch) =>
	existsSync(path.join(main, ".git", "refs", "heads", branch));

test("the porcelain parser pairs worktrees with their checked-out branches", () => {
	assert.deepEqual(parseWorktrees([
		"worktree /repo",
		"HEAD abc123",
		"",
		"worktree /repo/.claude/worktrees/wt",
		"HEAD def456",
		"branch refs/heads/worktree-x",
		"",
		"worktree /repo/.claude/worktrees/detached",
		"HEAD 789abc",
		"",
	].join("\n")), [
		{ path: "/repo" },
		{ path: "/repo/.claude/worktrees/wt", branch: "refs/heads/worktree-x" },
		{ path: "/repo/.claude/worktrees/detached" },
	]);
});

test("teardown from inside the worktree: anchored, guarded, and complete", (t) => {
	const fx = makeFixture(t, { merged: true });
	const run = runTeardown(fx.wt, "feature-x");
	assert.equal(run.status, 0, `stderr: ${run.stderr}`);
	assert.match(run.stdout, /worktree removed/);
	assert.match(run.stdout, /branch feature-x deleted/);
	assert.equal(existsSync(fx.wt), false, "the worktree directory is gone");
	assert.equal(branchExists(fx.main, "feature-x"), false, "the branch is gone");
	// main sits at origin/main: the fast-forward pull ran against the real
	// merge commit, not the local pre-merge state.
	const head = spawnSync("git", ["-C", fx.main, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
	const originHead = spawnSync("git", ["-C", fx.main, "rev-parse", "origin/main"], { encoding: "utf8" }).stdout.trim();
	assert.equal(head, originHead);
});

test("teardown from the main checkout removes the worktree the same way", (t) => {
	const fx = makeFixture(t, { merged: true });
	const run = runTeardown(fx.main, "feature-x");
	assert.equal(run.status, 0, `stderr: ${run.stderr}`);
	assert.equal(existsSync(fx.wt), false);
	assert.equal(branchExists(fx.main, "feature-x"), false);
});

test("an unmerged branch is refused, and nothing changes", (t) => {
	const fx = makeFixture(t, { merged: false });
	const before = spawnSync("git", ["-C", fx.main, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout;
	const run = runTeardown(fx.main, "feature-x");
	assert.equal(run.status, 1);
	assert.match(run.stderr, /not merged into origin\/main/);
	assert.equal(existsSync(fx.wt), true, "the worktree still stands");
	assert.equal(branchExists(fx.main, "feature-x"), true, "the branch still exists");
	assert.equal(
		spawnSync("git", ["-C", fx.main, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout,
		before,
		"main did not move",
	);
});

test("an unknown branch is refused", (t) => {
	const fx = makeFixture(t, { merged: true });
	const run = runTeardown(fx.main, "no-such-branch");
	assert.equal(run.status, 1);
	assert.match(run.stderr, /no local branch/);
});

test("an unreachable origin refuses before any mutation — the network-flap class", (t) => {
	const fx = makeFixture(t, { merged: true });
	// Point the remote at a path that exists as a directory but is no repo —
	// fetch fails the way a dead network does, offline.
	spawnSync("git", ["-C", fx.main, "remote", "set-url", "origin", path.join(fx.root, "not-a-repo")]);
	const run = runTeardown(fx.main, "feature-x");
	assert.equal(run.status, 1);
	assert.match(run.stderr, /fetch failed/);
	assert.equal(existsSync(fx.wt), true, "the worktree still stands");
	assert.equal(branchExists(fx.main, "feature-x"), true, "the branch still exists");
});

test("a branch with no worktree still deletes (the retry-after-partial-failure path)", (t) => {
	const fx = makeFixture(t, { merged: true });
	// The worktree was already removed by hand; only the branch remains.
	spawnSync("git", ["-C", fx.main, "worktree", "remove", fx.wt]);
	const run = runTeardown(fx.main, "feature-x");
	assert.equal(run.status, 0, `stderr: ${run.stderr}`);
	assert.equal(branchExists(fx.main, "feature-x"), false);
});
