// One home for the suite's throwaway-directory shape, per the tree-wide
// shared-helper rule: mkdtemp under the OS tmpdir, removed when the test
// ends. The rule wanted a home at the second caller — skill-pool's
// tempDir and submit-gate's inline hunk both predate it — and the
// notebook-cards suite (#178) made the third caller, so the home lands
// with that strike and both earlier callers re-point here.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function tempDir(t, prefix) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	return dir;
}
