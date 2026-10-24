import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const dockerfile = await readFile(fileURLToPath(new URL("./rig/Dockerfile", import.meta.url)), "utf8");
const runnerPath = fileURLToPath(new URL("./rig/run.mjs", import.meta.url));

test("Dockerfile pins every base by digest", () => {
	const froms = dockerfile.match(/^FROM .*$/gm) ?? [];
	assert.equal(froms.length, 2, "two stages expected");
	for (const from of froms) {
		assert.match(
			from,
			/^FROM \S+@sha256:[0-9a-f]{64}( AS \S+)?$/,
			`base not digest-pinned: ${from}`,
		);
	}
});

test("Dockerfile runs non-root and installs no packages", () => {
	assert.match(dockerfile, /^RUN useradd --create-home .* theta$/m);
	const users = dockerfile.match(/^USER .*$/gm) ?? [];
	assert.deepEqual(users, ["USER theta"], "exactly one USER, the non-root one");
	assert.doesNotMatch(dockerfile, /apt-get|apt install/, "no package installs — tools ride official images");
});

test("Dockerfile bakes in no repo content", () => {
	for (const line of dockerfile.match(/^COPY .*$/gm) ?? []) {
		assert.match(line, /^COPY --from=\S+ /, `unexpected COPY without a stage source: ${line}`);
	}
});

test("Dockerfile pins pi to an exact version", () => {
	assert.match(dockerfile, /pi-coding-agent@\d+\.\d+\.\d+/);
});

test("runner parses and answers help without a daemon", () => {
	const check = spawnSync(process.execPath, ["--check", runnerPath]);
	assert.equal(check.status, 0, check.stderr);
	const help = spawnSync(process.execPath, [runnerPath, "help"]);
	assert.equal(help.status, 0, help.stderr);
	assert.match(help.stdout.toString(), /^usage: /);
});

// The live leg builds the image and boots it. It needs Docker and network;
// the offline suite stays fast and machine-independent by default.
test("rig builds and boots (RIG_E2E)", { skip: !process.env.RIG_E2E }, async (t) => {
	const info = spawnSync("docker", ["info"]);
	if (info.status !== 0) t.skip("Docker daemon not reachable");
	const build = spawnSync("docker", ["build", "-t", "theta-rig:test", fileURLToPath(new URL("./rig/", import.meta.url))], { stdio: "inherit" });
	assert.equal(build.status, 0);
	const boot = spawnSync("docker", ["run", "--rm", "theta-rig:test"]);
	assert.equal(boot.status, 0, boot.stderr);
	assert.match(boot.stdout.toString(), /^\d+\.\d+\.\d+\n$/);
});
