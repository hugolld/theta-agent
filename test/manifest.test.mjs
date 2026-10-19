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

test("package.json bin exposes the theta launcher", () => {
	// npm strips invalid bin entries at publish time with only a warning in
	// the tarball output — a red test here makes that failure loud instead.
	assert.deepEqual(
		manifest.bin,
		{ theta: "./bin/theta.mjs" },
		"bin must map the theta command to ./bin/theta.mjs (got " +
			JSON.stringify(manifest.bin) +
			")",
	);
	// version must be full SemVer: npm rejects bare "1.2" at publish time
	assert.match(
		manifest.version,
		/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/,
		`version must be full SemVer (got ${JSON.stringify(manifest.version)})`,
	);
});

test("pi manifest targets exist on disk", async () => {
	for (const dir of [manifest.pi.extensions, manifest.pi.skills]) {
		const dirStat = await stat(new URL(`../${dir}`, import.meta.url));
		assert.ok(dirStat.isDirectory(), `${dir} is not a directory`);
	}
});

test("npm scripts pin one-off tool runs", () => {
	// uvx/npx resolve a bare tool name at run time, so an unpinned script
	// lints differently on every machine: M3's verify went red on CI's
	// fresh ruff resolve while every local cache still passed (#41 retro).
	// Local bins are lockfile-pinned; these runners are not — the version
	// rides in the script (uvx ruff@0.15.7).
	for (const [name, script] of Object.entries(manifest.scripts)) {
		const tokens = script.split(/\s+/);
		for (let i = 0; i < tokens.length; i += 1) {
			if (tokens[i] !== "uvx" && tokens[i] !== "npx") continue;
			let j = i + 1;
			// flag prefixes belong to the runner, not the tool name
			while (j < tokens.length && tokens[j].startsWith("-")) j += 1;
			const tool = tokens[j] ?? "";
			assert.match(
				tool,
				/@[^/@]+$/,
				`scripts.${name}: '${tokens[i]}' must name the tool version ` +
					`(uvx ruff@0.15.7) — got '${tool || "nothing"}'`,
			);
		}
	}
});
