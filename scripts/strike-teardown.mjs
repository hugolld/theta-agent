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
// checked out and the delete refuses until the worktree is gone. Every
// refusal happens before any mutation: a dead network or an unmerged branch
// leaves the tree exactly as it stood.

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
	return run("git", ["-C", root, ...args], opts);
}

function mainRepoRoot() {
	const probe = run("git", ["rev-parse", "--git-common-dir"]);
	if (probe.status !== 0) {
		fail(`${process.cwd()} is not inside a git work tree`);
	}
	const commonDir = path.resolve(process.cwd(), probe.stdout.trim());
	return path.dirname(commonDir);
}

function main() {
	const branch = process.argv[2];
	if (!branch) {
		fail("usage: strike-teardown.mjs <branch>");
	}
	const root = mainRepoRoot();

	// Fetch first: the network is the one dependency, and every refusal
	// before this point is cheap — nothing has mutated yet.
	const fetched = git(root, ["fetch", "origin", "--prune"]);
	if (fetched.status !== 0) {
		fail(`git fetch failed — nothing changed; check the network\n${fetched.stderr}`);
	}
	if (git(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).status !== 0) {
		fail(`no local branch ${branch}`);
	}
	const merged = git(root, ["merge-base", "--is-ancestor", branch, "origin/main"]);
	if (merged.status !== 0) {
		fail(`${branch} is not merged into origin/main — merge the PR first; nothing changed`);
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
				`worktree remove refused — the worktree is dirty; resolve it by hand; nothing else changed\n${removed.stderr}`,
			);
		}
		// The guard above licenses -D: the branch is merged into origin/main,
		// and plain -d compares against the remote topic branch, which lags.
		const deleted = git(root, ["branch", "-D", branch]);
		if (deleted.status !== 0) {
			fail(`branch delete refused: ${deleted.stderr}`);
		}
		console.log(`strike-teardown: worktree removed (${worktree.path})`);
		// The S3 retro session was standing in its worktree when it went away.
		console.log("strike-teardown: any shell still standing in the removed worktree must leave it");
	} else {
		const deleted = git(root, ["branch", "-D", branch]);
		if (deleted.status !== 0) {
			fail(`branch delete refused: ${deleted.stderr}`);
		}
	}
	const head = git(root, ["rev-parse", "--short", "HEAD"]).stdout.trim();
	console.log(`strike-teardown: branch ${branch} deleted; main at ${head}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main();
}
