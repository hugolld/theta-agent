#!/usr/bin/env node
// Strike teardown in one command (S5 retro): ends a coding strike whose PR
// is merged without replaying the accident class that ended S4 and S5.
//
//   node scripts/strike-teardown.mjs <branch>
//
// Run it from anywhere inside the repo — the session's shell usually stands
// in the worktree, and the anchoring survives that: the main checkout comes
// from the shared git dir, and every git call targets it with -C. The
// sequence: fetch, refuse unless the branch is merged into origin/main (the
// guard that licenses the -D below — plain -d compares against the remote
// topic branch, which lags the merge), pull main fast-forward, remove the
// worktree, then delete the branch — last, because the worktree holds it
// checked out and the delete refuses until the worktree is gone. A branch
// already gone locally with its remote merged is the harness worktree-exit
// having already torn down: the run finishes the shared steps and answers
// success, not refusal. No destructive mutation — the pull, the worktree
// remove, the branch delete — precedes any refusal: a dead network or an
// unmerged branch leaves the working tree exactly as it stood.

import path from "node:path";
import { pathToFileURL } from "node:url";
import { run } from "./dogfood-gates.mjs";

function fail(message) {
	console.error(`strike-teardown: ${message}`);
	process.exit(1);
}

// The porcelain output pairs each worktree with its checked-out branch;
// bare and detached entries carry no branch line.
export function parseWorktrees(porcelain) {
	const out = [];
	let cur = null;
	for (const line of porcelain.split("\n")) {
		if (line.startsWith("worktree ")) {
			cur = { path: line.slice("worktree ".length) };
			out.push(cur);
		} else if (cur !== null && line.startsWith("branch ")) {
			cur.branch = line.slice("branch ".length);
		} else if (line === "") {
			cur = null;
		}
	}
	return out;
}

function git(root, args, opts = {}) {
	const result = run("git", ["-C", root, ...args], opts);
	if (result.error) {
		fail(`cannot run git ${args[0]}: ${result.error.message}`);
	}
	return result;
}

function mainRepoRoot() {
	const probe = run("git", ["rev-parse", "--git-common-dir"]);
	if (probe.status !== 0) {
		fail(`${process.cwd()} is not inside a git work tree`);
	}
	const commonDir = path.resolve(process.cwd(), probe.stdout.trim());
	return path.dirname(commonDir);
}

// The merge-base guard in main() licenses -D: the branch is merged into
// origin/main, and plain -d compares against the remote topic branch, which
// lags the merge.
function deleteBranch(root, branch) {
	const deleted = git(root, ["branch", "-D", branch]);
	if (deleted.status !== 0) {
		fail(`branch delete refused: ${deleted.stderr}`);
	}
}

function main() {
	const branch = process.argv[2];
	if (!branch) {
		fail("usage: strike-teardown.mjs <branch>");
	}
	const root = mainRepoRoot();

	// Fetch first: the network is the one dependency, and the refusals after
	// it land before any destructive mutation.
	const fetched = git(root, ["fetch", "origin", "--prune"]);
	if (fetched.status !== 0) {
		fail(`git fetch failed — nothing changed; check the network\n${fetched.stderr}`);
	}
	const branchPresent =
		git(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).status === 0;
	if (!branchPresent) {
		// Absent locally is often the success path wearing a refusal's
		// costume: the harness's worktree exit removes the worktree and its
		// branch before this script runs, and the M5 S1 teardown walked the
		// git state to learn that. Absent with no remote branch is a typo;
		// absent with the remote unmerged is the same refusal as below.
		if (
			git(root, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`]).status !== 0
		) {
			fail(`no local branch ${branch} and no origin/${branch} — check the branch name; nothing changed`);
		}
	}
	const merged = git(root, [
		"merge-base",
		"--is-ancestor",
		branchPresent ? branch : `origin/${branch}`,
		"origin/main",
	]);
	if (merged.status !== 0) {
		fail(
			branchPresent
				? `${branch} is not merged into origin/main — merge the PR first; nothing changed`
				: `no local branch ${branch} and origin/${branch} is not merged into origin/main — merge the PR first; nothing changed`,
		);
	}
	// The pull fast-forwards whatever the main checkout holds, so it must
	// hold main — a checked-out side branch would move instead (the very
	// wrong-branch class the stray-pull accidents seeded).
	const checkedOut = git(root, ["symbolic-ref", "--short", "HEAD"]).stdout.trim();
	if (checkedOut !== "main") {
		fail(
			`the main checkout is on ${checkedOut}, not main — check main out first; nothing changed`,
		);
	}
	const pulled = git(root, ["pull", "--ff-only", "origin", "main"]);
	if (pulled.status !== 0) {
		fail(
			"pull --ff-only origin main refused — resolve the main checkout's state first; nothing changed\n" +
			pulled.stderr,
		);
	}
	const worktree = parseWorktrees(
		git(root, ["worktree", "list", "--porcelain"]).stdout,
	).find((entry) => entry.branch === `refs/heads/${branch}`);
	if (worktree !== undefined) {
		const removed = git(root, ["worktree", "remove", worktree.path]);
		if (removed.status !== 0) {
			fail(
				"worktree remove refused — a dirty worktree, a locked one, or the main working tree itself; resolve it by hand; nothing else changed\n" +
				"A lock reason naming a live session is the harness holding its own worktree: exit the worktree through the harness's own tool, then rerun — never force a removal past a live session\n" +
				removed.stderr,
			);
		}
		console.log(`strike-teardown: worktree removed (${worktree.path})`);
		// The S3 retro session was standing in its worktree when it went away.
		console.log("strike-teardown: any shell still standing in the removed worktree must leave it");
	}
	const head = git(root, ["rev-parse", "--short", "HEAD"]).stdout.trim();
	if (branchPresent) {
		deleteBranch(root, branch);
		console.log(`strike-teardown: branch ${branch} deleted; main at ${head}`);
	} else {
		console.log(
			`strike-teardown: ${branch} is already torn down — no local branch, none to delete; main at ${head}`,
		);
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main();
}
