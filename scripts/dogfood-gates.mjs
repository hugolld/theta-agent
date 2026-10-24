// Gates the dogfood paths share — the rig runner (test/rig/run.mjs) and the
// auditor (scripts/audit-dogfood.mjs) both bind evidence to a clean tree and
// to the package.json manifest as it stood at launch. One home, per the
// shared-helper rule, before the second caller.

import { execSync } from "node:child_process";
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
