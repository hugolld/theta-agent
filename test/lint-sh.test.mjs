import assert from "node:assert/strict";
import { test } from "node:test";
import { pipefailOffenders } from "../scripts/lint-sh.mjs";

test("a pipeline without pipefail is named by file and line; pipefail, no-pipe, and || pass", () => {
	const offenders = pipefailOffenders([
		["clean.sh", "# a comment with | is not a pipeline\nset -euo pipefail\nfoo | bar\n"],
		["bare.sh", "set -eu\nfoo | bar\n"],
		["oror.sh", "set -eu\nfoo || bar\n"],
		["empty.sh", "set -eu\n"],
	]);
	assert.deepEqual(offenders, ["bare.sh: 1 pipeline line(s) (first at line 2) with no pipefail"]);
});

test("an argued exception is skipped entirely", () => {
	const offenders = pipefailOffenders([
		["gateway/deploy.sh", "set -eu\nfoo | bar\n"],
	]);
	assert.deepEqual(offenders, []);
});
