// Gates the dogfood and strike paths share — the rig runner
// (test/rig/run.mjs), the auditor (scripts/audit-dogfood.mjs), and the
// strike teardown (scripts/strike-teardown.mjs) bind evidence to a clean
// tree, to the package.json manifest as it stood at launch, and spawn their
// child processes through one environment-inheriting shape. One home, per
// the shared-helper rule, before the second caller.

import { execSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

// Empty string means clean; callers fail on their own terms.
export function gitStatus(cwd) {
	return execSync("git status --porcelain --untracked-files=all", {
		cwd,
	}).toString().trim();
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
