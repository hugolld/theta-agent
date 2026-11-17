// Gates the dogfood and strike paths share — the rig runner
// (test/rig/run.mjs) and the strike teardown (scripts/strike-teardown.mjs)
// spawn their child processes through one environment-inheriting shape, and
// the rig runner plus the auditor (scripts/audit-dogfood.mjs) bind evidence
// to a clean tree and to the package.json manifest as it stood at launch.
// One home, per the shared-helper rule, before the second caller. The drill
// scaffold (scripts/drill-scratch.mjs, spec #125) joins both shapes and
// takes the main-checkout anchoring the teardown first wrote.

import { execSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

// Empty string means clean; callers fail on their own terms.
export function gitStatus(cwd) {
	return execSync("git status --porcelain --untracked-files=all", {
		cwd,
	}).toString().trim();
}

// The clean-tree gate those bindings read through, one home tree-wide (the
// shared-helper rule — the auditor's two refusal sites set the shape, and
// the rig runner's refusal joined it in #172's retro): throw naming the
// dirt, so a refusal never sends anyone rediscovering what the message
// already held — the rig's refusal dropped the porcelain output, and the
// #167 capture spent its refusal hunting an untracked node_modules symlink
// by hand. The label preserves each caller's context prefix.
export function requireCleanTree(root, label = "working tree dirty — commit first") {
	let status;
	try {
		status = gitStatus(root);
	} catch (error) {
		throw new Error(`cannot read git status: ${error.message}`);
	}
	if (status) throw new Error(`${label}:\n${status}`);
}

export function manifestSha256(root) {
	return createHash("sha256")
		.update(readFileSync(`${root}/package.json`))
		.digest("hex");
}

// The environment always inherits: Node's env option replaces the child
// environment rather than merging, and an opts.env riding alone wipes PATH
// far from the cause (#72). The caller reads status/stdout/stderr itself.
export function run(cmd, args, opts = {}) {
	return spawnSync(cmd, args, {
		encoding: "utf8",
		...opts,
		env: { ...process.env, ...opts.env },
	});
}

// The main checkout's root from anywhere inside the repo — the session's
// shell usually stands in a worktree, and the shared git dir names the
// main tree that holds what a worktree only borrows (node_modules). Null
// when the probe fails; callers fail on their own terms.
export function mainCheckoutRoot() {
	const probe = run("git", ["rev-parse", "--git-common-dir"]);
	if (probe.status !== 0) return null;
	return path.dirname(path.resolve(process.cwd(), probe.stdout.trim()));
}
