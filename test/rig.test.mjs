import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, mkdir, rm, stat, symlink, writeFile, chmod } from "node:fs/promises";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createJiti } from "jiti";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gitStatus, requireCleanTree } from "../scripts/dogfood-gates.mjs";
import { initHardenedGitRepo } from "./helpers/git-repo.mjs";
import { SESSION_FILES } from "../scripts/session-evidence.mjs";
import { assertPoolPack, parseFlags, poolStateJson, prepareProviderConfig, prepareGatewayConfig, gatewayPreflightScript, runTeardown, stagePoolStateCommand } from "./rig/run.mjs";

const dockerfile = await readFile(fileURLToPath(new URL("./rig/Dockerfile", import.meta.url)), "utf8");
const runnerPath = fileURLToPath(new URL("./rig/run.mjs", import.meta.url));
const driverPath = fileURLToPath(new URL("./rig/rpc-driver.mjs", import.meta.url));
// One home for the stubs' helper import — both stub shapes load the
// driver's own drainJsonl, the wire format's single reader.
const jsonlHelperUrl = pathToFileURL(path.join(path.dirname(driverPath), "rpc-jsonl.mjs")).href;

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

// Spot-check legs ride --leg, repeatable, and never bleed into the prompt.
test("leg flags collect into order and leave the prompt in rest", () => {
	const { flags, rest } = parseFlags([
		"--leg", "skills/theta-notebook/SKILL.md",
		"the prompt text",
		"--leg", "skills/theta-notebook/scripts/notebook.py",
		"--leg", ".theta",
	]);
	assert.deepEqual(flags.legs, [
		"skills/theta-notebook/SKILL.md",
		"skills/theta-notebook/scripts/notebook.py",
		".theta",
	]);
	assert.equal(rest.join(" "), "the prompt text");
});

// The pool leg (spec #167): --pool collects like the other value flags and
// never bleeds into the prompt, the staged state parses through the
// loader's own reader (the jiti pattern the skill-pool suite uses — the
// staged bytes and the loader's state v1 cannot drift apart), and the
// staging command writes the file the loader reads, from an env var,
// never the bash command line.
test("pool staging: the flag collects, the state loads, the command writes the loader's path", async () => {
	const { flags, rest } = parseFlags(["--pool", "bioinformatics", "the prompt text"]);
	assert.equal(flags.pool, "bioinformatics");
	assert.equal(rest.join(" "), "the prompt text");
	const { readSkillsState } = await createJiti(import.meta.url).import(
		"../extensions/skill-pool.ts",
	);
	const dir = await mkdtemp(path.join(tmpdir(), "rig-pool-"));
	try {
		await mkdir(path.join(dir, ".theta"), { recursive: true });
		await writeFile(path.join(dir, ".theta", "skills.json"), poolStateJson("bioinformatics"));
		const read = readSkillsState(dir);
		assert.equal(read.kind, "ok", `staged state must read as ok, got ${JSON.stringify(read)}`);
		assert.equal(read.state.classAllow.length, 1);
		assert.equal(read.state.classAllow[0], "local");
		assert.equal(read.state.packs.bioinformatics.enabled, true);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
	const command = stagePoolStateCommand();
	assert.match(command, /"\$HOME\/theta\/\.theta\/skills\.json"$/);
	assert.match(command, /printf '%s' "\$RIG_POOL_STATE"/);
	// No argv-quoted JSON anywhere: the bytes ride the env var only.
	assert.doesNotMatch(command, /RIG_POOL_STATE=/);
});

// --pool is validated against the repo's own pool before anything
// disposable is spent, and carries no credential shape at all.
test("pool pack validation names the valid packs and refuses the rest", () => {
	assert.doesNotThrow(() => assertPoolPack("bioinformatics"));
	assert.throws(() => assertPoolPack("not-a-pack"), /valid packs: bioinformatics, cheminformatics, protein-engineering/);
	const empty = mkdtempSync(path.join(tmpdir(), "rig-pool-empty-"));
	try {
		assert.throws(() => assertPoolPack("bioinformatics", empty), /no pool/);
	} finally {
		rmSync(empty, { recursive: true, force: true });
	}
});

// #172's retro: the refusal used to drop the porcelain output it already
// held, and the #167 capture spent its refusal rediscovering the offender
// (an untracked node_modules symlink) by hand. The dirt rides the message,
// byte for byte against the gitStatus the gate reads.
test("the clean-tree gate names the dirt it refuses", () => {
	const repo = initHardenedGitRepo(mkdtempSync(path.join(tmpdir(), "rig-clean-tree-")));
	try {
		assert.doesNotThrow(() => requireCleanTree(repo));
		writeFileSync(path.join(repo, "node_modules"), "");
		const dirt = gitStatus(repo);
		assert.ok(dirt.includes("node_modules"));
		assert.throws(
			() => requireCleanTree(repo),
			(error) => error.message === `working tree dirty — commit first:\n${dirt}`,
		);
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
	const notGit = mkdtempSync(path.join(tmpdir(), "rig-not-git-"));
	try {
		assert.throws(() => requireCleanTree(notGit), /cannot read git status/);
	} finally {
		rmSync(notGit, { recursive: true, force: true });
	}
});

// The credential path: the prepared config carries the target provider and
// nothing else, at 0600 — the rig's one-credential boundary starts here.
test("provider config prep extracts one provider, 0600, nothing else", async (t) => {
	const dir = await mkdtemp(path.join(tmpdir(), "rig-test-"));
	const configPath = path.join(dir, "models.json");
	await writeFile(configPath, JSON.stringify({
		providers: { "keep-me": { apiKey: "k1" }, "drop-me": { apiKey: "k2" } },
	}), { mode: 0o600 });
	const prepared = prepareProviderConfig("keep-me", configPath);
	t.after(() => Promise.all([rm(prepared, { recursive: true, force: true }), rm(dir, { recursive: true, force: true })]));
	const text = await readFile(path.join(prepared, "agent/models.json"), "utf8");
	const parsed = JSON.parse(text);
	assert.deepEqual(Object.keys(parsed.providers), ["keep-me"]);
	assert.equal(parsed.providers["keep-me"].apiKey, "k1");
	const mode = (await stat(path.join(prepared, "agent/models.json"))).mode & 0o777;
	assert.equal(mode, 0o600);
});

// The second credential: the gateway admission rewrites the loopback host
// to the Docker alias, keeps everything else about the entry, and drops
// every other registered server — the token enters, nothing else does.
test("gateway config prep admits one rewritten registration, 0600", async (t) => {
	const providerDir = await mkdtemp(path.join(tmpdir(), "rig-gw-"));
	const configPath = path.join(providerDir, "mcp.json");
	await writeFile(configPath, JSON.stringify({
		mcpServers: {
			"theta-compute": {
				url: "http://127.0.0.1:8421/mcp",
				headers: { Authorization: "Bearer test-token" },
			},
			"other-server": { url: "http://example.com/mcp" },
		},
	}), { mode: 0o600 });
	const admitted = prepareGatewayConfig(providerDir, configPath);
	t.after(() => rm(providerDir, { recursive: true, force: true }));
	assert.equal(admitted.url, "http://host.docker.internal:8421/mcp");
	assert.equal(admitted.headers.Authorization, "Bearer test-token");
	const text = await readFile(path.join(providerDir, "agent/mcp.json"), "utf8");
	const parsed = JSON.parse(text);
	assert.deepEqual(Object.keys(parsed.mcpServers), ["theta-compute"]);
	assert.equal(parsed.mcpServers["theta-compute"].url, "http://host.docker.internal:8421/mcp");
	const mode = (await stat(path.join(providerDir, "agent/mcp.json"))).mode & 0o777;
	assert.equal(mode, 0o600);
});

// The preflight script rides an env var into the container, so its content
// never has a shell-quoting surface (the first assembly closed its bash
// quote as a JS delimiter and the in-container bash saw it unmatched). The
// offline floor: the shipped script parses, and with nothing behind the URL
// it fails loudly through its catch, not with a syntax error.
test("gateway preflight script parses and fails loudly with no server", () => {
	const script = gatewayPreflightScript();
	assert.equal(script.includes("—"), true, "the messages keep their em dashes verbatim");
	const probe = spawnSync(process.execPath, ["-e", script], {
		encoding: "utf8",
		env: { ...process.env, GATEWAY_URL: "http://127.0.0.1:1/mcp", GATEWAY_AUTH: "Bearer none" },
	});
	assert.equal(probe.status, 1, `expected exit 1, got ${probe.status}\nstdout: ${probe.stdout}\nstderr: ${probe.stderr}`);
	assert.match(probe.stderr, /gateway preflight failed/);
	assert.doesNotMatch(probe.stderr, /SyntaxError/, "the shipped script must parse as-is");
});

// The admission refusals run in a child process: the runner's fail() exits,
// and the probe imports the real module so the tested path is the shipped one.
async function admissionRefusal(fixture, expected) {
	const dir = await mkdtemp(path.join(tmpdir(), "rig-gwref-"));
	const configPath = path.join(dir, "mcp.json");
	await writeFile(configPath, JSON.stringify(fixture));
	try {
		const probe = spawnSync(process.execPath, [
			"--input-type=module", "-e",
			`const { prepareGatewayConfig } = await import(${JSON.stringify(pathToFileURL(runnerPath).href)});` +
				`prepareGatewayConfig(${JSON.stringify(dir)}, ${JSON.stringify(configPath)});`,
		], { encoding: "utf8" });
		assert.equal(probe.status, 1, `expected a refusal, got exit ${probe.status}\n${probe.stderr}`);
		assert.match(probe.stderr, expected);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

test("gateway config prep refuses a url that does not name the host-side forward", async () => {
	await admissionRefusal(
		{ mcpServers: { "theta-compute": { url: "http://10.1.2.3:8421/mcp", headers: { Authorization: "Bearer t" } } } },
		/loopback/,
	);
});

test("gateway config prep refuses an entry without the Authorization header", async () => {
	await admissionRefusal(
		{ mcpServers: { "theta-compute": { url: "http://127.0.0.1:8421/mcp" } } },
		/Authorization/,
	);
});

test("gateway config prep refuses when no theta-compute is registered", async () => {
	await admissionRefusal({ mcpServers: {} }, /no theta-compute registration/);
});

// The confirm leg needs the gateway: the driver exists to answer the submit
// gate, and the refusal lands before the Docker daemon is ever needed.
test("--rpc without --gateway refuses without a daemon", () => {
	const probe = spawnSync(process.execPath, [runnerPath, "run", "--rpc", "a prompt"], { encoding: "utf8" });
	assert.equal(probe.status, 1, probe.stderr);
	assert.match(probe.stderr, /--rpc needs --gateway/);
});

// One stub body for both spawn shapes the driver uses (theta and pi): it
// records the argv and cwd it was spawned with beside its own file — node
// resolves the entry through the bin/ symlink to this file's real location —
// then speaks just enough of the RPC extension-UI protocol: ask one confirm,
// echo the answer, settle, answer the final-text request. The driver under
// test is the real one, and the stub reads its stdin through the driver's
// own exported drainJsonl — the wire format has one reader, not two copies
// of the same loop.
const rpcStubScript = () =>
	[
		"import { writeFileSync } from 'node:fs';",
		`import { drainJsonl } from ${JSON.stringify(jsonlHelperUrl)};`,
		"const recordUrl = new URL('./record.json', import.meta.url);",
		"const answers = [];",
		"const record = () => writeFileSync(recordUrl, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), answers }) + '\\n');",
		"record();",
		"let buffer = '';",
		"process.stdin.setEncoding('utf8');",
		"process.stdin.on('data', (chunk) => {",
		"	buffer = drainJsonl(buffer, chunk, (rec) => {",
		"		if (rec.type === 'prompt') {",
		"			process.stdout.write(JSON.stringify({ type: 'extension_ui_request', id: 'conf-1', method: 'confirm' }) + '\\n');",
		"		} else if (rec.type === 'extension_ui_response') {",
		"			answers.push(rec);",
		"			record();",
		"			process.stdout.write(JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'done' } }) + '\\n');",
		"			process.stdout.write(JSON.stringify({ type: 'agent_settled' }) + '\\n');",
		"		} else if (rec.id === 'final') {",
		"			process.stdout.write(JSON.stringify({ type: 'response', command: 'get_last_assistant_text', success: true, data: 'done' }) + '\\n');",
		"		}",
		"	});",
		"});",
	].join("\n");

// Both stub shapes seed the record file up front, so a spawn that dies
// before its first record() still leaves an empty file, not an ENOENT.
async function seedRecord(dir) {
	await writeFile(path.join(dir, "record.json"), "");
}

async function stubCheckout() {
	const dir = await mkdtemp(path.join(tmpdir(), "rig-drv-"));
	await writeFile(path.join(dir, "theta.mjs"), rpcStubScript());
	await seedRecord(dir);
	// The driver spawns `node bin/theta.mjs` — a bin/ symlink to the stub.
	await mkdir(path.join(dir, "bin"));
	await symlink(path.join(dir, "theta.mjs"), path.join(dir, "bin", "theta.mjs"));
	return dir;
}

// A stub pi behind a private PATH entry: the --cwd leg spawns `pi` by name,
// so the stub takes the launcher's place — a shebang wrapper that loads the
// same stub body, recording beside it.
async function stubPiDir() {
	const dir = await mkdtemp(path.join(tmpdir(), "rig-pi-"));
	const body = path.join(dir, "pi-body.mjs");
	await writeFile(body, rpcStubScript());
	await seedRecord(dir);
	await writeFile(path.join(dir, "pi"), `#!/usr/bin/env node\nimport(${JSON.stringify(pathToFileURL(body).href)});\n`);
	await chmod(path.join(dir, "pi"), 0o755);
	return dir;
}

test("rpc driver answers the confirm and captures the settled session", async (t) => {
	const checkout = await stubCheckout();
	const sessionDir = await mkdtemp(path.join(tmpdir(), "rig-drvsess-"));
	const recordPath = path.join(checkout, "record.json");
	t.after(() => Promise.all([rm(checkout, { recursive: true, force: true }), rm(sessionDir, { recursive: true, force: true })]));

	const run = spawnSync(process.execPath, [driverPath, checkout, sessionDir, "a gated prompt", "allow"], {
		encoding: "utf8",
		env: { ...process.env, RIG_PROVIDER: "prov-x", RIG_MODEL: "model-y" },
	});
	assert.equal(run.status, 0, run.stderr);

	const record = JSON.parse(await readFile(recordPath, "utf8"));
	// The default spawn shape: theta --dev from the checkout, cwd pinned to
	// it (the stub records argv past its own entry, as node hands it over).
	assert.deepEqual(record.argv, [
		"--dev", "--mode", "rpc",
		"--provider", "prov-x", "--model", "model-y",
		"--session-dir", sessionDir,
	]);
	assert.equal(record.cwd, realpathSync(checkout));
	assert.equal(record.answers.length, 1);
	assert.equal(record.answers[0].type, "extension_ui_response");
	assert.equal(record.answers[0].id, "conf-1");
	assert.equal(record.answers[0].confirmed, true);
	assert.equal(record.answers[0].cancelled, undefined);

	const events = (await readFile(path.join(sessionDir, "raw-rpc-events.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
	assert.ok(events.some((e) => e.type === "extension_ui_request" && e.method === "confirm"));
	assert.equal(await readFile(path.join(sessionDir, "stdout.txt"), "utf8"), "done");
	assert.equal(await readFile(path.join(sessionDir, SESSION_FILES.stderr), "utf8"), "");
	assert.equal(await readFile(path.join(sessionDir, SESSION_FILES.prompt), "utf8"), "a gated prompt");
	// The wrapper owns the exit-status file, never the driver.
	await assert.rejects(readFile(path.join(sessionDir, SESSION_FILES.exitStatus)));
});

test("rpc driver can refuse instead: the deny answer cancels the confirm", async (t) => {
	const checkout = await stubCheckout();
	const sessionDir = await mkdtemp(path.join(tmpdir(), "rig-drvsess-"));
	const recordPath = path.join(checkout, "record.json");
	t.after(() => Promise.all([rm(checkout, { recursive: true, force: true }), rm(sessionDir, { recursive: true, force: true })]));

	const run = spawnSync(process.execPath, [driverPath, checkout, sessionDir, "a gated prompt", "deny"], {
		encoding: "utf8",
	});
	assert.equal(run.status, 0, run.stderr);

	const record = JSON.parse(await readFile(recordPath, "utf8"));
	assert.equal(record.answers[0].cancelled, true);
	assert.equal(record.answers[0].confirmed, undefined);
});

// A typo'd verdict must refuse to run — never silently mean allow against
// a real submit.
test("rpc driver refuses a gate answer that is neither allow nor deny", async (t) => {
	const checkout = await stubCheckout();
	const sessionDir = await mkdtemp(path.join(tmpdir(), "rig-drvsess-"));
	t.after(() => Promise.all([rm(checkout, { recursive: true, force: true }), rm(sessionDir, { recursive: true, force: true })]));

	const run = spawnSync(process.execPath, [driverPath, checkout, sessionDir, "a gated prompt", "alow"], {
		encoding: "utf8",
	});
	assert.equal(run.status, 2);
	assert.match(run.stderr, /allow or deny/);
	await assert.rejects(readFile(path.join(sessionDir, "raw-rpc-events.jsonl")));
});

// The four dirs a driver-spawn test stages — the stub pi on a private PATH,
// the vouched checkout, the project cwd, and the session dir — with their
// cleanup in one place (the #164 and #167 driver tests share the shape).
async function driverDirs(t) {
	const piDir = await stubPiDir();
	const checkout = await mkdtemp(path.join(tmpdir(), "rig-drv-"));
	const projectCwd = await mkdtemp(path.join(tmpdir(), "rig-proj-"));
	const sessionDir = await mkdtemp(path.join(tmpdir(), "rig-drvsess-"));
	t.after(() =>
		Promise.all([
			rm(piDir, { recursive: true, force: true }),
			rm(checkout, { recursive: true, force: true }),
			rm(projectCwd, { recursive: true, force: true }),
			rm(sessionDir, { recursive: true, force: true }),
		]),
	);
	return { piDir, checkout, projectCwd, sessionDir };
}

// #164: a session whose evidence lives in an arbitrary project cwd (the S2
// Jev-gate dogfood shape). With --cwd the driver spawns `pi -e <checkout>`
// directly — theta --dev's anchor does not cover arbitrary cwds — and the
// gate confirm, settle, and capture contracts all stay the print leg's.
test("rpc driver takes --cwd: pi -e <checkout> runs in the project cwd", async (t) => {
	const { piDir, checkout, projectCwd, sessionDir } = await driverDirs(t);

	const run = spawnSync(
		process.execPath,
		[driverPath, "--cwd", projectCwd, checkout, sessionDir, "a gated prompt"],
		{
			encoding: "utf8",
			env: { ...process.env, PATH: `${piDir}:${process.env.PATH}`, RIG_PROVIDER: "prov-x", RIG_MODEL: "model-y" },
		},
	);
	assert.equal(run.status, 0, run.stderr);

	const record = JSON.parse(await readFile(path.join(piDir, "record.json"), "utf8"));
	assert.deepEqual(record.argv, [
		"-e", checkout, "--mode", "rpc",
		"--provider", "prov-x", "--model", "model-y",
		"--session-dir", sessionDir,
	]);
	assert.ok(!record.argv.includes("--dev"), "--dev must not ride the project-cwd spawn");
	assert.equal(record.cwd, realpathSync(projectCwd));
	assert.equal(record.answers[0]?.confirmed, true);
	assert.equal(await readFile(path.join(sessionDir, "stdout.txt"), "utf8"), "done");
});

// #167: a project-cwd leg must read the vendored pack bytes it just
// advertised — pi's OS sandbox scopes reads to the session cwd, so the leg
// runs with the sandbox off. The flag rides the direct pi spawn only; a
// bare checkout-cwd run would silently ignore it, so that pairing refuses.
test("rpc driver takes --no-sandbox: the flag rides the pi spawn and pairs only with --cwd", async (t) => {
	const { piDir, checkout, projectCwd, sessionDir } = await driverDirs(t);

	const run = spawnSync(
		process.execPath,
		[driverPath, "--cwd", projectCwd, "--no-sandbox", checkout, sessionDir, "a gated prompt"],
		{
			encoding: "utf8",
			env: { ...process.env, PATH: `${piDir}:${process.env.PATH}`, RIG_PROVIDER: "prov-x", RIG_MODEL: "model-y" },
		},
	);
	assert.equal(run.status, 0, run.stderr);

	const record = JSON.parse(await readFile(path.join(piDir, "record.json"), "utf8"));
	const at = record.argv.indexOf("--no-sandbox");
	assert.notEqual(at, -1, "--no-sandbox must ride the pi spawn");
	assert.equal(record.argv[at - 1], checkout, "the flag sits after the vouched checkout");
	assert.equal(record.argv[at + 1], "--mode");

	// and the bare checkout-cwd pairing refuses loudly instead of ignoring
	const bare = spawnSync(
		process.execPath,
		[driverPath, "--no-sandbox", checkout, sessionDir, "a gated prompt"],
		{ encoding: "utf8", env: { ...process.env, PATH: `${piDir}:${process.env.PATH}` } },
	);
	assert.equal(bare.status, 2);
	assert.match(bare.stderr, /--no-sandbox pairs with --cwd/);
});

// The flag's own failure modes refuse loudly: a missing value up front, and
// a spawn that cannot start (the --cwd target does not exist) reported as a
// clean exit-2 message — never an unhandled-error stack in the evidence leg.
test("rpc driver refuses --cwd misuse cleanly", async (t) => {
	const checkout = await mkdtemp(path.join(tmpdir(), "rig-drv-"));
	const sessionDir = await mkdtemp(path.join(tmpdir(), "rig-drvsess-"));
	t.after(() => Promise.all([rm(checkout, { recursive: true, force: true }), rm(sessionDir, { recursive: true, force: true })]));

	const noValue = spawnSync(process.execPath, [driverPath, "--cwd"], { encoding: "utf8" });
	assert.equal(noValue.status, 2);
	assert.match(noValue.stderr, /--cwd needs a value/);

	// The usage bytes carry the flag — an operator reading the help sees the
	// supported argument, the discovery path's contract included.
	const usage = spawnSync(process.execPath, [driverPath, "--cwd", checkout], { encoding: "utf8" });
	assert.equal(usage.status, 2);
	assert.ok(
		usage.stderr.includes("usage: rpc-driver.mjs [--cwd <dir>] [--no-sandbox] <checkout> <sessionDir> <prompt> [allow|deny]"),
		`usage line must name --cwd: ${usage.stderr}`,
	);

	const run = spawnSync(
		process.execPath,
		[driverPath, "--cwd", path.join(sessionDir, "no-such-dir"), checkout, sessionDir, "a gated prompt"],
		{ encoding: "utf8" },
	);
	assert.equal(run.status, 2, run.stderr);
	assert.match(run.stderr, /could not spawn the session/);
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

// #110: a failing rig run must still remove its container. fail() runs
// process.exit mid-try — no finally unwinds under it — so teardown rides a
// process exit hook. The stub docker records every argv it receives; exec
// answers 1, so the first in-container step fails exactly the way a real
// failed run does.
async function stubDockerDir() {
	const dir = await mkdtemp(path.join(tmpdir(), "rig-stub-"));
	await writeFile(
		path.join(dir, "docker"),
		["#!/bin/sh", 'echo "$@" >> "$STUB_DOCKER_LOG"', "case $1 in", "  exec) exit 1 ;;", "  *) exit 0 ;;", "esac"].join("\n"),
		{ mode: 0o755 },
	);
	return dir;
}

test("runTeardown removes the container and both temp dirs, fire-and-forget", async (t) => {
	const stubDir = await stubDockerDir();
	const logPath = path.join(stubDir, "log");
	const sourceDir = await mkdtemp(path.join(tmpdir(), "rig-td-src-"));
	const providerDir = await mkdtemp(path.join(tmpdir(), "rig-td-pi-"));
	t.after(() =>
		Promise.all([stubDir, sourceDir, providerDir].map((d) => rm(d, { recursive: true, force: true }))),
	);
	const realPath = process.env.PATH;
	process.env.PATH = `${stubDir}:${realPath}`;
	process.env.STUB_DOCKER_LOG = logPath;
	try {
		runTeardown({ containerName: "theta-rig-unit", sourceDir, providerDir });
	} finally {
		process.env.PATH = realPath;
		delete process.env.STUB_DOCKER_LOG;
	}
	assert.equal(existsSync(sourceDir), false, "the staged clone dir survived teardown");
	assert.equal(existsSync(providerDir), false, "the provider config dir survived teardown");
	assert.match(readFileSync(logPath, "utf8"), /^rm -f theta-rig-unit$/m);
});

// The wiring this issue is about: run.mjs itself, failing through fail()'s
// process.exit, must still fire the rm. Machine-gated the way the suite's
// other main()-driving paths are: the host pi provider config must exist,
// and a dirty tree (a pre-commit run's staged state) skips rather than
// fights the launch gate.
const wiringSkipReason = (() => {
	const configPath = path.join(process.env.HOME ?? "", ".pi/agent/models.json");
	if (!existsSync(configPath)) return "no host pi provider config";
	try {
		const config = JSON.parse(readFileSync(configPath, "utf8"));
		if (!config?.providers?.["zai-coding-cn"]) return "default provider not in the host pi config";
	} catch {
		return "host pi config unreadable";
	}
	if (gitStatus(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."))) {
		return "working tree dirty (pre-commit staged state)";
	}
	return false;
})();

test("a failed rig run removes its container on the exit path", { skip: wiringSkipReason }, async (t) => {
	const stubDir = await stubDockerDir();
	const logPath = path.join(stubDir, "log");
	const sessionDir = await mkdtemp(path.join(tmpdir(), "rig-wire-"));
	t.after(() => Promise.all([rm(stubDir, { recursive: true, force: true }), rm(sessionDir, { recursive: true, force: true })]));

	const run = spawnSync(
		process.execPath,
		[runnerPath, "run", "probe", "--session-dir", sessionDir, "--timeout", "5"],
		{
			encoding: "utf8",
			env: { ...process.env, PATH: `${stubDir}:${process.env.PATH}`, STUB_DOCKER_LOG: logPath },
		},
	);
	assert.equal(run.status, 1, `expected the run to fail, got exit ${run.status}\n${run.stderr}`);
	assert.match(run.stderr, /in-container step exited 1/);

	const calls = readFileSync(logPath, "utf8").trim().split("\n");
	const execIndex = calls.findIndex((c) => c.startsWith("exec"));
	const rmIndex = calls.findIndex((c, i) => i > execIndex && c.startsWith("rm -f theta-rig-"));
	assert.ok(execIndex !== -1, "the stub log never saw the failing exec");
	assert.ok(rmIndex !== -1, "no container rm followed the failure — the run leaked its container");
});
