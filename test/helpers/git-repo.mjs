// Shared git-repo construction for tests that need a throwaway repo
// (dogfood-audit's integration fixtures, the eval land-guard pins): init,
// identity, and the hardening that keeps a developer's global git config
// from breaking the suite — signing off, hooks firing, and case-only
// renames vanishing from status probes under core.ignorecase.

import { execFileSync } from "node:child_process";

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
	const git = (args) =>
		execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
	git(["init", "-q"]);
	for (const [key, value] of HARDENED_CONFIG) git(["config", key, value]);
	return dir;
}

// The -c overrides for later commits in an already-initialized repo
// (gpgsign is the one setting that can leak from global config into a
// plain `git commit`).
export const COMMIT_SIGNOFF_OVERRIDE = ["-c", "commit.gpgsign=false"];
