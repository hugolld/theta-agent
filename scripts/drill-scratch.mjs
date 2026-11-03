#!/usr/bin/env node
// The mutation-drill scaffold (spec #125): everything up to the mutation,
// made deterministic. A drill proves a strike's pin chain bites (#120,
// #122) — but its setup was tribal knowledge that cost the #122 strike
// two dead runs: a worktree has no node_modules of its own (it resolves
// the main checkout's by directory walk-up, and a scratch outside the
// repo cannot), and leg output piped straight into grep swallowed the
// crash line that named the problem. This script owns those mechanics;
// the mutation stays the strike's own.
//
//   node scripts/drill-scratch.mjs <scratch-dir> [suite-file...]
//
// Run it from inside the strike's worktree: the archive carries that
// tree's HEAD (committed files only — untracked state never enters a
// drill), while node_modules symlinks the MAIN checkout's copy (found
// through the shared git dir, so a session inside a worktree can build
// its scratch). gateway/.venv is copied from the worktree when present,
// from the main checkout otherwise, and noted absent when neither has
// one (uv rebuilds on the first leg). The destination must not exist —
// a drill never reuses a scratch. The legs are printed, not run: each
// leg's output lands in a file before anything greps it (the exit-status
// rule — a piped-away crash line is a lost diagnosis).

import { existsSync, mkdirSync, symlinkSync, cpSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { run } from "./dogfood-gates.mjs";

function fail(message) {
	console.error(`drill-scratch: ${message}`);
	process.exit(1);
}

// The legs the strike runs by hand, printed as copyable lines. Output to
// a file first, grep after — and the grep pattern reads the summary
// lines and the failing-test names only, never standing between the
// runner and its exit status.
export function legLines(suites, dest) {
	const files = suites.length > 0 ? suites.join(" ") : "<suite-files...>";
	return [
		`  leg 0 (baseline): cd ${dest} && node --test ${files} > leg0.out 2>&1`,
		"  leg 1 (mutated):  edit the scratch (never the branch tree), then the same command > leg1.out",
		`  read a leg:       grep -E '^. (tests|pass|fail)|^✖' leg0.out | sort -u`,
	];
}

function main() {
	const dest = process.argv[2];
	if (!dest) {
		fail("usage: drill-scratch.mjs <scratch-dir> [suite-file...]");
	}
	const suites = process.argv.slice(3);
	if (existsSync(dest)) {
		fail(`${dest} already exists — a drill never reuses a scratch; remove it first`);
	}

	// The worktree to archive is the caller's own tree: HEAD here is the
	// strike branch, and the worktree guard accepts a call anchored to it.
	const toplevel = run("git", ["rev-parse", "--show-toplevel"]);
	if (toplevel.status !== 0) {
		fail(`${process.cwd()} is not inside a git work tree`);
	}
	const worktreeRoot = toplevel.stdout.trim();
	// The main checkout holds the node_modules a worktree only borrows.
	const commonDir = run("git", ["rev-parse", "--git-common-dir"]);
	if (commonDir.status !== 0) {
		fail("cannot find the shared git dir");
	}
	const mainRoot = path.dirname(path.resolve(process.cwd(), commonDir.stdout.trim()));
	const checkoutModules = path.join(mainRoot, "node_modules");
	if (!existsSync(checkoutModules)) {
		fail(`the main checkout has no node_modules (${checkoutModules}) — npm ci there first`);
	}

	// Archive to a buffer, then hand it to tar: both exit statuses are
	// checked in sequence, the unpiped equivalent of pipefail. The buffer
	// carries the whole tarball, so maxBuffer needs real headroom —
	// spawnSync's 1MB default ENOBUFS-kills the archive mid-stream (the
	// scaffold's own first test run).
	mkdirSync(dest, { recursive: true });
	const archive = run("git", ["-C", worktreeRoot, "archive", "HEAD"], {
		encoding: "buffer",
		maxBuffer: 128 * 1024 * 1024,
	});
	if (archive.status !== 0) {
		fail(`git archive failed — nothing extracted\n${archive.stderr}`);
	}
	const extract = run("tar", ["-x", "-C", dest], { input: archive.stdout });
	if (extract.status !== 0) {
		fail(`tar extract failed — partial scratch at ${dest}\n${extract.stderr}`);
	}
	symlinkSync(checkoutModules, path.join(dest, "node_modules"));

	// A warm venv from either tree keeps the first gateway leg fast; a
	// missing one is a note, not a failure (uv rebuilds on first run).
	const venvFrom = [worktreeRoot, mainRoot]
		.map((root) => path.join(root, "gateway", ".venv"))
		.find((candidate) => existsSync(candidate));
	if (venvFrom !== undefined) {
		cpSync(venvFrom, path.join(dest, "gateway", ".venv"), { recursive: true });
	}

	const head = run("git", ["-C", worktreeRoot, "rev-parse", "--short", "HEAD"]).stdout.trim();
	console.log(`drill-scratch: scratch ready at ${dest} (HEAD ${head}, committed tree only)`);
	console.log(`drill-scratch: node_modules -> ${checkoutModules} (symlink)`);
	console.log(
		venvFrom !== undefined
			? `drill-scratch: gateway/.venv copied from ${venvFrom}`
			: "drill-scratch: no gateway/.venv found in either tree — uv rebuilds on the first leg",
	);
	console.log("drill-scratch: legs — mutate the scratch, never the branch tree:");
	for (const line of legLines(suites, dest)) {
		console.log(line);
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main();
}
