import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { pipefailOffenders, shellSurfaces } from "../scripts/lint-sh.mjs";

test("a pipeline without pipefail is named by file and line; a comment cannot supply the pipefail", () => {
	const offenders = pipefailOffenders([
		["clean.sh", "# a comment with | is not a pipeline\nset -euo pipefail\nfoo | bar\n"],
		["commented.sh", "# set -o pipefail (someday)\nset -eu\nfoo | bar\n"],
		["bare.sh", "set -eu\nfoo | bar\n"],
		["oror.sh", "set -eu\nfoo || bar\n"],
		["empty.sh", "set -eu\n"],
	]);
	assert.deepEqual(offenders, [
		"commented.sh: 1 pipeline line(s) (first at line 3) with no pipefail",
		"bare.sh: 1 pipeline line(s) (first at line 2) with no pipefail",
	]);
});

test("an argued exception is skipped entirely", () => {
	const offenders = pipefailOffenders([
		["gateway/deploy.sh", "set -eu\nfoo | bar\n"],
	]);
	assert.deepEqual(offenders, []);
});

test("the lint's surface list covers every .sh under scripts/ and gateway/ on disk", async () => {
	// The census's map↔disk pattern, applied to the surface list: this walk
	// is its own recursion over the tree, not the linter's readdir, so a
	// script the walk finds but the surfaces miss fails here by name.
	const root = fileURLToPath(new URL("..", import.meta.url));
	const found = [];
	const visit = (rel) => {
		for (const entry of readdirSync(`${root}${rel}`, { withFileTypes: true })) {
			if (entry.isDirectory()) {
				// A dev machine's gateway/.venv is environment, not tree —
				// lint:dups ignores it for the same reason.
				if (entry.name !== ".venv") visit(`${rel}/${entry.name}`);
			} else if (entry.name.endsWith(".sh")) found.push(`${rel}/${entry.name}`);
		}
	};
	visit("scripts");
	visit("gateway");
	const surfaces = await shellSurfaces();
	const unscanned = found.filter((path) => !surfaces.includes(path));
	assert.deepEqual(
		unscanned,
		[],
		`shell scripts on disk the lint never scans: ${unscanned.join(", ")}`,
	);
	assert.ok(surfaces.includes(".githooks/pre-commit"), "the pre-commit hook is a scanned surface");
});
