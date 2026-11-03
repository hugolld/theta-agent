import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { legLines } from "../scripts/drill-scratch.mjs";

// The scaffold owns the drill mechanics that the #122 strike paid two
// dead runs to learn (spec #125): committed-tree archive, node_modules
// symlinked from the main checkout, warm venv copied, legs printed with
// output-to-file. The test drives the script end-to-end from this
// worktree and asserts each mechanic; the mutation itself stays
// per-strike and is not the scaffold's to test.

const script = new URL("../scripts/drill-scratch.mjs", import.meta.url).pathname;

function scaffold(dest) {
	return new Promise((resolve) => {
		execFile(
			process.execPath,
			[script, dest, "test/skills-library.test.mjs"],
			{ encoding: "utf8" },
			(error, stdout, stderr) => resolve({ error, stdout, stderr }),
		);
	});
}

test("the scaffold builds a scratch: committed tree, module symlink, leg lines", async () => {
	const tmp = mkdtempSync(path.join(tmpdir(), "drill-scratch-"));
	const dest = path.join(tmp, "scratch");
	try {
		const { error, stdout } = await scaffold(dest);
		if (error) throw new Error(`scaffold failed: ${error.message}\n${stdout}`);
		// Committed tree only: a tracked file arrives, and the scratch's
		// git-adjacent untracked state never does (nothing here to copy).
		assert(existsSync(path.join(dest, "CLAUDE.md")), "committed tree missing CLAUDE.md");
		assert(existsSync(path.join(dest, "package.json")), "committed tree missing package.json");
		// The node_modules symlink resolves into the main checkout — the
		// walk-up a scratch outside the repo cannot do for itself.
		// lstat reads the link itself; stat would follow it.
		const link = path.join(dest, "node_modules");
		assert(lstatSync(link).isSymbolicLink(), "node_modules is not a symlink");
		assert(existsSync(link), "node_modules symlink does not resolve");
		// The legs print with output-to-file and the suite the caller named.
		const legs = legLines(["test/skills-library.test.mjs"], dest).join("\n");
		assert(/leg 0 \(baseline\): cd .+ && node --test test\/skills-library\.test\.mjs > leg0\.out/.test(legs));
		assert(stdout.includes("legs — mutate the scratch, never the branch tree"), "leg preamble missing");
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

test("an existing destination refuses — a drill never reuses a scratch", async () => {
	const tmp = mkdtempSync(path.join(tmpdir(), "drill-scratch-"));
	try {
		const first = await scaffold(path.join(tmp, "scratch"));
		if (first.error) throw new Error(`first scaffold failed: ${first.error.message}`);
		const { error, stderr } = await scaffold(path.join(tmp, "scratch"));
		assert(error !== null, "the second scaffold exited 0");
		assert(stderr.includes("never reuses a scratch"), `refusal lost its reason: ${stderr}`);
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});
