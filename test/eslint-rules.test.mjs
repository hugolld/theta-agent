import test from "node:test";
import assert from "node:assert/strict";
import { Linter } from "eslint";
import spawnEnvInherit from "../scripts/eslint-rules/spawn-env-inherit.mjs";

const linter = new Linter();
const config = {
	plugins: { local: { rules: { "spawn-env-inherit": spawnEnvInherit } } },
	rules: { "local/spawn-env-inherit": "error" },
};
const messages = (code) => linter.verify(code, config).map((m) => m.message);

test("spawn-env-inherit: a bare env option is flagged", () => {
	const found = messages('spawnSync("docker", args, { env: { RIG_PROMPT: p } });');
	assert.equal(found.length, 1);
	assert.match(found[0], /replaces the child environment/);
});

test("spawn-env-inherit: the spreading form passes", () => {
	assert.deepEqual(
		messages('spawnSync("docker", args, { env: { ...process.env, ...opts.env } });'),
		[],
	);
});

test("spawn-env-inherit: no env option passes", () => {
	assert.deepEqual(messages('execSync("git status", { cwd: root });'), []);
});

test("spawn-env-inherit: an identifier built from a process.env spread passes", () => {
	const code = [
		"const env = { ...process.env, PATH: stub };",
		'spawnSync("docker", args, { env });',
	].join("\n");
	assert.deepEqual(messages(code), []);
});

test("spawn-env-inherit: a bare identifier is still flagged", () => {
	const code = [
		"const env = { RIG_PROMPT: p };",
		'spawnSync("docker", args, { env });',
	].join("\n");
	assert.equal(messages(code).length, 1);
});

test("spawn-env-inherit: env set to process.env itself passes", () => {
	assert.deepEqual(messages('spawn("pi", args, { env: process.env });'), []);
});
