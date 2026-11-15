// Shared git-repo construction for tests that need a throwaway repo
// (dogfood-audit's integration fixtures, the eval land-guard pins): init,
// identity, and the hardening that keeps a developer's global git config
// from breaking the suite — signing off, hooks firing, and case-only
// renames vanishing from status probes under core.ignorecase.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const HARDENED_CONFIG = [
	["user.email", "test@example.com"],
	["user.name", "test"],
	["commit.gpgsign", "false"],
	["core.hooksPath", "/dev/null"],
];

// Init `dir` as a git repo with the hardened config applied. Returns the
// canonical path (mount aliases — /var vs /private/var on macOS — must not
// leak lexical paths into containment comparisons).
export function initHardenedGitRepo(dir) {
	// Inits through the runner so init itself cannot inherit a machine's
	// init.defaultBranch — the runner's -c pin covers every call.
	const git = fixtureGitRunner(dir);
	git(["init", "-q"]);
	for (const [key, value] of HARDENED_CONFIG) git(["config", key, value]);
	return dir;
}

// A spawnSync-based git runner for fixture repos: asserts status per
// call, so a fixture setup failure names the command instead of
// failing obscurely downstream. The init.defaultBranch pin keeps
// fixture repos on main regardless of machine config —
// initHardenedGitRepo inits through this runner, so both entry paths
// carry it. The shared shape of the strike-teardown and stale-stage
// fixtures (the S3 retro's extract-at-two find).
export function fixtureGitRunner(defaultCwd) {
	return (args, cwd = defaultCwd) => {
		const run = spawnSync("git", ["-c", "init.defaultBranch=main", ...args], {
			cwd,
			encoding: "utf8",
		});
		assert.equal(run.status, 0, `git ${args.join(" ")}: ${run.stderr}`);
		return run.stdout;
	};
}
