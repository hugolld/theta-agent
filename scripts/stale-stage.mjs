// The stale-stage warning (the S3 retro, #150): the pre-commit hook runs
// the suite against the working tree, while the commit takes the index —
// a file both staged-modified and worktree-modified (porcelain XY, both
// columns set) means the commit ships the index version while the tree
// holds newer content. 7622676's message described a guard its stale
// index did not contain; this warning names that class at commit time.
// A warning, never a refusal: a git add -p partial-hunk commit leaves
// exactly this state on purpose. Exits zero in every outcome — the hook
// stays green; the warning is the whole point.
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

// Porcelain v1 XY codes: X = index vs HEAD, Y = worktree vs index. The
// stale-stage class is a staged change (X set) paired with a worktree
// delta (Y M/D/T) — the two snapshots differ in both directions.
const STAGED_CODES = new Set(["M", "A", "D", "R", "C", "T"]);
const WORKTREE_DELTA_CODES = new Set(["M", "D", "T"]);

export function staleStagedFiles(statusOutput) {
	const files = [];
	for (const line of String(statusOutput ?? "").split("\n")) {
		if (line.length < 4) continue;
		const [x, y] = line;
		if (STAGED_CODES.has(x) && WORKTREE_DELTA_CODES.has(y)) {
			files.push(line.slice(3));
		}
	}
	return files;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const status = spawnSync("git", ["status", "--porcelain"], { encoding: "utf8" });
	if (status.status !== 0) {
		// Not a repo, or git refused: the warning is best-effort — say
		// nothing rather than block a commit the suite already gates.
		process.exit(0);
	}
	const files = staleStagedFiles(status.stdout);
	if (files.length > 0) {
		console.error(
			`pre-commit: staged content differs from the working tree for ${files.length} ` +
				`file(s) — committing the INDEX version of: ${files.join(", ")}. ` +
				"If the newer worktree content belongs in this commit, re-add before committing.",
		);
	}
}
