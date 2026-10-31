import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, mkdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseFlags, prepareProviderConfig, prepareGatewayConfig } from "./rig/run.mjs";

const dockerfile = await readFile(fileURLToPath(new URL("./rig/Dockerfile", import.meta.url)), "utf8");
const runnerPath = fileURLToPath(new URL("./rig/run.mjs", import.meta.url));
const driverPath = fileURLToPath(new URL("./rig/rpc-driver.mjs", import.meta.url));

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

// A stub checkout whose bin/theta.mjs speaks just enough of the RPC
// extension-UI protocol: it asks one confirm, echoes the answer it received
// to a record file, then settles. The driver under test is the real one.
const STUB_THETA = [
	"import { writeFileSync } from 'node:fs';",
	"// The driver spawns its child with a minimal explicit env, so the stub",
	"// records beside its own file — node resolves the entry through the",
	"// bin/ symlink to this file's real location.",
	"const recordUrl = new URL('./record.json', import.meta.url);",
	"const answers = [];",
	"let buffer = '';",
	"process.stdin.setEncoding('utf8');",
	"process.stdin.on('data', (chunk) => {",
	"	buffer += chunk;",
	"	let i;",
	"	while ((i = buffer.indexOf('\\n')) !== -1) {",
	"		const line = buffer.slice(0, i);",
	"		buffer = buffer.slice(i + 1);",
	"		if (line === '') continue;",
	"		let rec; try { rec = JSON.parse(line); } catch { continue; }",
	"		if (rec.type === 'prompt') {",
	"			process.stdout.write(JSON.stringify({ type: 'extension_ui_request', id: 'conf-1', method: 'confirm' }) + '\\n');",
	"		} else if (rec.type === 'extension_ui_response') {",
	"			answers.push(rec);",
	"			writeFileSync(recordUrl, JSON.stringify(answers) + '\\n');",
	"			process.stdout.write(JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'done' } }) + '\\n');",
	"			process.stdout.write(JSON.stringify({ type: 'agent_settled' }) + '\\n');",
	"		} else if (rec.id === 'final') {",
	"			process.stdout.write(JSON.stringify({ type: 'response', command: 'get_last_assistant_text', success: true, data: 'done' }) + '\\n');",
	"		}",
	"	}",
	"});",
].join("\n");

async function stubCheckout() {
	const dir = await mkdtemp(path.join(tmpdir(), "rig-drv-"));
	await writeFile(path.join(dir, "theta.mjs"), STUB_THETA);
	await writeFile(path.join(dir, "record.json"), "");
	// The driver spawns `node bin/theta.mjs` — a bin/ symlink to the stub.
	await mkdir(path.join(dir, "bin"));
	await symlink(path.join(dir, "theta.mjs"), path.join(dir, "bin", "theta.mjs"));
	return dir;
}

test("rpc driver answers the confirm and captures the settled session", async (t) => {
	const checkout = await stubCheckout();
	const sessionDir = await mkdtemp(path.join(tmpdir(), "rig-drvsess-"));
	const recordPath = path.join(checkout, "record.json");
	t.after(() => Promise.all([rm(checkout, { recursive: true, force: true }), rm(sessionDir, { recursive: true, force: true })]));

	const run = spawnSync(process.execPath, [driverPath, checkout, sessionDir, "a gated prompt", "allow"], {
		encoding: "utf8",
	});
	assert.equal(run.status, 0, run.stderr);

	const answered = JSON.parse(await readFile(recordPath, "utf8"));
	assert.equal(answered.length, 1);
	assert.equal(answered[0].type, "extension_ui_response");
	assert.equal(answered[0].id, "conf-1");
	assert.equal(answered[0].confirmed, true);
	assert.equal(answered[0].cancelled, undefined);

	const events = (await readFile(path.join(sessionDir, "raw-rpc-events.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
	assert.ok(events.some((e) => e.type === "extension_ui_request" && e.method === "confirm"));
	assert.equal(await readFile(path.join(sessionDir, "stdout.txt"), "utf8"), "done");
	assert.equal(await readFile(path.join(sessionDir, "stderr.txt"), "utf8"), "");
	assert.equal(await readFile(path.join(sessionDir, "prompt.txt"), "utf8"), "a gated prompt");
	// The wrapper owns the exit-status file, never the driver.
	await assert.rejects(readFile(path.join(sessionDir, "exit-status")));
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

	const answered = JSON.parse(await readFile(recordPath, "utf8"));
	assert.equal(answered[0].cancelled, true);
	assert.equal(answered[0].confirmed, undefined);
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
