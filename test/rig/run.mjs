#!/usr/bin/env node
// Runner for the clean-room rig (ADR 0005). Development stays on the host;
// this tool moves *running* theta under test into a disposable Linux
// container where a session can damage at most its own scratch space.
//
//   node test/rig/run.mjs build                     build the rig image
//   node test/rig/run.mjs run "prompt text"         one-shot dogfood + audit
//   node test/rig/run.mjs shell                     interactive bash in a rig
//
// `run` reproduces the one-shot recipe from docs/agents/dogfood.md inside
// the container: fresh clone of the pinned HEAD as the session's checkout,
// evidence dir mounted at /session so the transcript and process files land
// on the host, the auditor executed in-container where every path it binds
// is self-consistent. The provider key is the one credential the rig gets —
// extracted to a temp dir from the host pi config, mounted read-only, copied
// into the container's ephemeral home, never printed.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gitStatus, manifestSha256 } from "../../scripts/dogfood-gates.mjs";

const rigDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(rigDir, "../..");
const image = "theta-rig:test";
const container = `theta-rig-${process.pid}`;
const defaultProvider = "zai-coding-cn";
const defaultModel = "glm-5.3-flash";

let sessionDir;
let headSha;
let sourceDir;

function fail(message) {
	console.error(`rig: ${message}`);
	process.exit(1);
}

// spawnSync's env option replaces the environment rather than merging, so
// an opts.env that rode alone would wipe PATH and every spawn after it would
// die ENOENT. Always inherit, then overlay.
function run(cmd, args, opts = {}) {
	const result = spawnSync(cmd, args, {
		encoding: "utf8",
		...opts,
		env: { ...process.env, ...opts.env },
	});
	if (result.error) fail(`cannot run ${cmd}: ${result.error.message}`);
	return result;
}

// Resource Saver pauses the VM after idle; the first call can take tens of
// seconds to wake it. Wait it out instead of reporting a false failure.
function docker(...args) {
	const result = run("docker", args);
	if (result.status !== 0) fail(`docker ${args[0]} exited ${result.status}`);
	return result.stdout;
}

function waitForDaemon() {
	for (let i = 0; i < 30; i++) {
		if (run("docker", ["info"], { stdio: "ignore" }).status === 0) return;
		if (i === 0) console.error("rig: waiting for the Docker daemon (Resource Saver wake)");
		run("sleep", ["3"], { stdio: "ignore" });
	}
	fail("Docker daemon did not answer within 90s — start Docker Desktop");
}

function parseFlags(argv) {
	const flags = { timeout: 300, provider: defaultProvider, model: defaultModel };
	const rest = [];
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--provider" || arg === "--model") {
			const value = argv[++i];
			if (value === undefined) fail(`${arg} needs a value`);
			flags[arg.slice(2)] = value;
		} else if (arg === "--timeout") {
			const value = argv[++i];
			if (value === undefined || !/^\d+$/.test(value) || Number(value) < 1) {
				fail("--timeout needs a positive integer");
			}
			flags.timeout = Number(value);
		} else if (arg === "--session-dir") {
			const value = argv[++i];
			if (value === undefined) fail("--session-dir needs a value");
			flags.sessionDir = value;
		} else {
			rest.push(arg);
		}
	}
	return { flags, rest };
}

// The one credential the rig receives: the target provider's entry from the
// host pi config, alone in a 0600 temp dir. Never logged, removed at exit.
export function prepareProviderConfig(provider, configPath = path.join(process.env.HOME, ".pi/agent/models.json")) {
	let hostConfig;
	try {
		hostConfig = JSON.parse(readFileSync(configPath, "utf8"));
	} catch {
		fail("cannot read ~/.pi/agent/models.json — no provider config on this host");
	}
	const entry = hostConfig?.providers?.[provider];
	if (!entry || typeof entry !== "object") fail(`provider ${provider} not in ~/.pi/agent/models.json`);
	const dir = mkdtempSync(path.join(tmpdir(), "rig-pi-"));
	mkdirSync(path.join(dir, "agent"), { recursive: true });
	writeFileSync(
		path.join(dir, "agent/models.json"),
		JSON.stringify({ providers: { [provider]: entry } }, null, "\t") + "\n",
		{ mode: 0o600 },
	);
	return dir;
}

function execIn(command, opts = {}) {
	const env = Object.entries(opts.env ?? {}).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
	const result = run(
		"docker",
		["exec", ...env, ...(opts.tty ? ["-it"] : []), container, "bash", "-c", command],
		opts,
	);
	if (result.status !== 0) {
		fail(`in-container step exited ${result.status}: ${command}\n${result.stderr}`);
	}
	return result.stdout;
}

// A worktree's .git is a pointer file naming a host path, which does not
// survive the mount — so the clone source is always a scratch clone staged
// host-side, where the pointer resolves. The container then clones /pkg-src,
// a plain repo, at the pinned HEAD.
function stageCloneSource() {
	const dir = mkdtempSync(path.join(tmpdir(), "rig-src-"));
	const staged = run("git", ["clone", "--quiet", "--no-hardlinks", repoRoot, dir]);
	if (staged.status !== 0) fail(`cannot stage a clone of ${repoRoot}: ${staged.stderr}`);
	return dir;
}

function startContainer(providerDir) {
	docker("rm", "-f", container); // a leftover from a killed run
	const mounts = ["-v", `${sourceDir}:/pkg-src:ro`, "-v", `${providerDir}:/pi-ro:ro`];
	if (sessionDir) mounts.push("-v", `${sessionDir}:/session`);
	docker("run", "-d", "--name", container, ...mounts, image, "sleep", "infinity");
	execIn(`git clone --quiet /pkg-src "$HOME/theta" && git -C "$HOME/theta" checkout --quiet --detach ${headSha}`);
	execIn("mkdir -p ~/.pi/agent && cp /pi-ro/agent/models.json ~/.pi/agent/models.json && chmod 600 ~/.pi/agent/models.json");
}

// The auditor binds cwd to the checkout, so run it from /theta and capture
// the attestation for the evidence dir; printed output is the record.
function audit() {
	const attestation = execIn('cd "$HOME/theta" && node scripts/audit-dogfood.mjs /session');
	writeFileSync(path.join(sessionDir, "attestation.txt"), attestation);
	console.log(attestation);
}

function main() {
	const [subcommand, ...argv] = process.argv.slice(2);
	if (subcommand === undefined || subcommand === "help" || subcommand === "--help") {
		console.log("usage: run.mjs build | run [--provider P] [--model M] [--timeout S] [--session-dir D] <prompt> | shell");
		return;
	}
	const { flags, rest } = parseFlags(argv);
	waitForDaemon();

	if (subcommand === "build") {
		docker("build", "-t", image, rigDir);
		console.log(`rig: ${image} built`);
		return;
	}
	if (subcommand !== "run" && subcommand !== "shell") fail(`unknown subcommand: ${subcommand}`);

	let status;
	try {
		status = gitStatus(repoRoot);
	} catch (error) {
		fail(`cannot read git status: ${error.message}`);
	}
	if (status) fail("working tree dirty — commit first");
	headSha = run("git", ["-C", repoRoot, "rev-parse", "HEAD"]).stdout.trim();

	let providerDir;
	try {
		providerDir = prepareProviderConfig(flags.provider);
		sourceDir = stageCloneSource();

		if (subcommand === "run") {
			const prompt = rest.join(" ");
			if (!prompt) fail("run needs a prompt");
			if (/[^\x00-\x7F]/.test(prompt)) fail("prompt must be pure ASCII (the auditor rejects the rest)");
			sessionDir = flags.sessionDir ?? path.join(
				process.env.HOME, ".theta-evidence", `rig-${headSha.slice(0, 7)}-${Date.now()}`,
			);
			mkdirSync(sessionDir, { recursive: true });
			writeFileSync(path.join(sessionDir, "pre-head"), headSha);
			writeFileSync(path.join(sessionDir, "prompt.txt"), prompt);
			writeFileSync(path.join(sessionDir, "expected-model"), `${flags.provider} ${flags.model}\n`);
			writeFileSync(path.join(sessionDir, "manifest-sha256"), manifestSha256(repoRoot));
		}

		startContainer(providerDir);

		if (subcommand === "shell") {
			run("docker", ["exec", "-it", container, "bash"], { stdio: "inherit" });
			return;
		}

		// The runtime record the audit re-verifies.
		execIn("pi --version > /session/pi-version && node --version > /session/node-version");

		// GNU timeout stands in for the host recipe's hand-rolled watchdog:
		// SIGTERM at the bound, SIGKILL 15s later, 124 recorded on timeout.
		// The exit status lands as a file, exactly as the host recipe writes
		// it — stdout belongs to the model's reply, and nothing glues onto it.
		execIn(
			`cd "$HOME/theta" && timeout --signal=TERM --kill-after=15 ${flags.timeout} ` +
			`node bin/theta.mjs --dev --provider ${flags.provider} --model ${flags.model} ` +
			`--session-dir /session --print "$RIG_PROMPT" < /dev/null 2> /session/stderr.txt; echo $? > /session/exit-status`,
			{ env: { RIG_PROMPT: rest.join(" ") } },
		);
		const exitStatus = Number.parseInt(
			readFileSync(path.join(sessionDir, "exit-status"), "utf8").trim(),
			10,
		);
		if (!Number.isInteger(exitStatus)) fail("cannot read the session exit-status file");
		if (exitStatus === 124) writeFileSync(path.join(sessionDir, "watchdog"), "fired\n");
		if (exitStatus !== 0) fail(`session exited ${exitStatus} — evidence in ${sessionDir}`);

		audit();
		console.log(`rig: evidence in ${sessionDir}`);
	} finally {
		run("docker", ["rm", "-f", container], { stdio: "ignore" });
		rmSync(sourceDir ?? "", { recursive: true, force: true });
		rmSync(providerDir ?? "", { recursive: true, force: true });
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main();
}
