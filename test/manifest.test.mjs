import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { test } from "node:test";

// Smoke guard for the pi package manifest (see CLAUDE.md "pi-package rules"):
// if these break, `pi -e <package-root>` loads nothing, silently.
const manifest = JSON.parse(
	await readFile(new URL("../package.json", import.meta.url), "utf8"),
);

test("package.json carries the pi manifest", () => {
	assert.equal(manifest.name, "theta-agent");
	assert.ok(manifest.pi, "missing top-level pi manifest");
	for (const key of ["extensions", "skills"]) {
		// pi's readPiManifest accepts only arrays of strings; a bare string
		// field is silently dropped, so `pi -e <root>` would load nothing.
		assert.ok(
			Array.isArray(manifest.pi[key]) &&
				manifest.pi[key].length > 0 &&
				manifest.pi[key].every((entry) => typeof entry === "string"),
			`pi.${key} must be a non-empty array of strings (got ${JSON.stringify(manifest.pi[key])})`,
		);
	}
});

test("pi manifest targets exist on disk", async () => {
	for (const dir of [manifest.pi.extensions, manifest.pi.skills]) {
		const dirStat = await stat(new URL(`../${dir}`, import.meta.url));
		assert.ok(dirStat.isDirectory(), `${dir} is not a directory`);
	}
});
