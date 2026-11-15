#!/usr/bin/env node
// Runner for the clean-room rig (ADR 0005). Development stays on the host;
// this tool moves *running* theta under test into a disposable Linux
// container where a session can damage at most its own scratch space.
//
//   node test/rig/run.mjs build                     build the rig image
//   node test/rig/run.mjs run "prompt text"         one-shot dogfood + audit
//   node test/rig/run.mjs eval <task-id>            one benchmark task, graded
//   node test/rig/run.mjs shell                     interactive bash in a rig
//
// `run` reproduces the one-shot recipe from docs/agents/dogfood.md inside
// the container: fresh clone of the pinned HEAD as the session's checkout,
// evidence dir mounted at /session so the transcript and process files land
// on the host, the auditor executed in-container where every path it binds
// is self-consistent. `--leg` passes spot-check leg arguments (skill,
// script, notebook) to that in-container auditor, so the attestation is
// captured clean-room too. Two credentials, and only these, enter the rig:
// the provider key always, and — on a `--gateway` leg — the gateway token,
// each extracted to a temp dir from the host pi config, mounted read-only,
// copied into the container's ephemeral home, never printed. The cluster
// SSH key never enters: the gateway is reached through the host-side
// port-forward, which the preflight verifies from inside the container
// before the session launches. `--rpc` runs the confirm-answering driver
// (test/rig/rpc-driver.mjs) instead of `--print`, so a gated submit can
// cross the submit gate in a headless run.
//
// `eval` is the benchmark layer's mode (spec #135, ADR 0007): one task
// from the checked-in list (test/eval/bench-tasks.mjs) runs end-to-end
// and grades from one command. It refuses `--gateway` and `--rpc` — no
// gateway token path exists on a benchmark leg; the provider key is the
// only credential that enters. The session runs print-mode in a fresh
// task workspace (`$HOME/task`), so exit codes carry truncation
// failures the way the dogfood leg's do; the objective grader runs
// in-container against the workspace (workspace-as-oracle), and the
// report step runs host-side — the classify() judge's credential lives
// on the host and never enters the rig. Compaction stays native.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gitStatus, manifestSha256, run as spawnRun } from "../../scripts/dogfood-gates.mjs";
import { SESSION_FILES } from "../../scripts/session-evidence.mjs";
import { benchTaskById } from "../eval/bench-tasks.mjs";
import { BENCH_FILES, buildReport, resolveJudge, runJudge, sumSessionUsage } from "../eval/bench-report.mjs";

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

// The shared spawn shape does the env-inheriting; this wrapper adds the
// rig's own failure rule — a child that could not start at all ends the run.
function run(cmd, args, opts = {}) {
	const result = spawnRun(cmd, args, opts);
	if (result.error) fail(`cannot run ${cmd}: ${result.error.message}`);
	return result;
}

// Resource Saver pauses the VM after idle; the first call can take tens of
// seconds to wake it. Wait it out instead of reporting a false failure.
function docker(...args) {
	const result = run("docker", args);
	if (result.status !== 0) fail(`docker ${args[0]} exited ${result.status}\n${result.stderr}`);
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

export function parseFlags(argv) {
	const flags = { timeout: 300, provider: defaultProvider, model: defaultModel, legs: [], gateway: false, rpc: false };
	const rest = [];
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--provider" || arg === "--model") {
			const value = argv[++i];
			if (value === undefined) fail(`${arg} needs a value`);
			flags[arg.slice(2)] = value;
		} else if (arg === "--gateway" || arg === "--rpc") {
			flags[arg.slice(2)] = true;
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
		} else if (arg === "--leg") {
			const value = argv[++i];
			if (value === undefined) fail("--leg needs a value");
			flags.legs.push(value);
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

// The second credential a rig leg can admit (spec #96): the theta-compute
// registration from the host pi config. The URL's host is rewritten from
// loopback to host.docker.internal — the container reaches the host-side
// forward through Docker's host alias, never through its own 127.0.0.1 —
// and the entry lands beside the provider config in the same 0600 temp
// dir. The cluster SSH key is not admitted: the forward stays host-side,
// so the token is the only cluster-adjacent credential the rig ever holds.
export function prepareGatewayConfig(providerDir, configPath = path.join(process.env.HOME, ".pi/agent/mcp.json")) {
	let hostConfig;
	try {
		hostConfig = JSON.parse(readFileSync(configPath, "utf8"));
	} catch {
		fail("cannot read ~/.pi/agent/mcp.json — no MCP registration on this host");
	}
	const entry = hostConfig?.mcpServers?.["theta-compute"];
	if (!entry || typeof entry !== "object") fail("no theta-compute registration in ~/.pi/agent/mcp.json");
	if (typeof entry.url !== "string" || typeof entry.headers?.Authorization !== "string") {
		fail("the theta-compute registration needs a url and an Authorization header (the pi mcp add shape)");
	}
	let url;
	try {
		url = new URL(entry.url);
	} catch {
		fail(`the theta-compute url does not parse: ${entry.url}`);
	}
	// Only a loopback registration is admitted: the rig reaches the gateway
	// through the host-side forward, and any other host in the URL would
	// point the container at a network the forward never crosses.
	if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
		fail(`the theta-compute url must name the host-side forward at loopback, not ${url.hostname}`);
	}
	url.hostname = "host.docker.internal";
	const admitted = { ...entry, url: url.toString() };
	mkdirSync(path.join(providerDir, "agent"), { recursive: true });
	writeFileSync(
		path.join(providerDir, "agent/mcp.json"),
		JSON.stringify({ mcpServers: { "theta-compute": admitted } }, null, "\t") + "\n",
		{ mode: 0o600 },
	);
	// The Authorization header rides this 0600 env file into the container
	// (`docker exec --env-file`) so the token never appears in a process's
	// argv — same discipline as the mounted configs, one channel further.
	writeFileSync(
		path.join(providerDir, "agent/gateway.env"),
		`GATEWAY_AUTH=${entry.headers.Authorization}\n`,
		{ mode: 0o600 },
	);
	return admitted;
}

function execIn(command, opts = {}) {
	const env = Object.entries(opts.env ?? {}).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
	// A secret rides the env-file, never an argv element: docker reads the
	// 0600 file host-side, and the process table never sees its value.
	const envFile = opts.envFile ? ["--env-file", opts.envFile] : [];
	const result = run(
		"docker",
		["exec", ...envFile, ...env, ...(opts.tty ? ["-it"] : []), container, "bash", "-c", command],
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

// Docker Desktop resolves the host alias for the container built-in; a
// native-Linux daemon needs the explicit host-gateway mapping (and its
// forward bound to the bridge gateway — the Linux variant dogfood.md
// documents). The flag would override Desktop's own alias with the bridge
// IP, so it is added only where the alias does not resolve already.
function dockerHostNeedsAddHost() {
	const os = run("docker", ["info", "--format", "{{.OperatingSystem}}"]).stdout.trim();
	return !/Docker Desktop/i.test(os);
}

function startContainer(providerDir, withGateway) {
	docker("rm", "-f", container); // a leftover from a killed run
	const mounts = ["-v", `${sourceDir}:/pkg-src:ro`, "-v", `${providerDir}:/pi-ro:ro`];
	if (sessionDir) mounts.push("-v", `${sessionDir}:/session`);
	const addHost = withGateway && dockerHostNeedsAddHost() ? ["--add-host=host.docker.internal:host-gateway"] : [];
	docker("run", "-d", "--name", container, ...addHost, ...mounts, image, "sleep", "infinity");
	execIn(`git clone --quiet /pkg-src "$HOME/theta" && git -C "$HOME/theta" checkout --quiet --detach ${headSha}`);
	execIn("mkdir -p ~/.pi/agent && cp /pi-ro/agent/models.json ~/.pi/agent/models.json && chmod 600 ~/.pi/agent/models.json");
	if (withGateway) execIn("cp /pi-ro/agent/mcp.json ~/.pi/agent/mcp.json && chmod 600 ~/.pi/agent/mcp.json");
}

// The probe script itself, exported for the offline test: it must parse and
// fail loudly with no server behind the URL. It rides an env var into the
// container — never the bash command line — so no shell ever parses it.
export function gatewayPreflightScript() {
	return [
		"const u=process.env.GATEWAY_URL,h=process.env.GATEWAY_AUTH;",
		"Promise.all([fetch(u).then(r=>r.status),fetch(u,{headers:{Authorization:h}}).then(r=>r.status)])",
		".then(([anon,auth])=>{",
		'  if(anon!==401){console.error("gateway preflight: "+u+" answered HTTP "+anon+" without a token, expected 401 — is the host-side forward up?");process.exit(1)}',
		'  if(auth===401){console.error("gateway preflight: the admitted token was refused, 401 — re-register before the run");process.exit(1)}',
		'  if(auth>=500){console.error("gateway preflight: an authorized request answered HTTP "+auth+" — the gateway is unhealthy");process.exit(1)}',
		'  console.log("gateway preflight ok: "+u+" answers 401 without a token and the admitted token is accepted")',
		"})",
		'.catch(e=>{console.error("gateway preflight failed: "+(e.cause?.code??e.message)+" — is the host-side forward up?");process.exit(1)})',
	].join("\n");
}

// The gateway-bearing preflight, run from inside the container against the
// admitted URL: without the token the endpoint must answer 401 (forward up,
// server listening), and with the Authorization header it must answer
// neither 401 (the admitted token still opens the door) nor a 5xx (the
// gateway is in no state to serve a session). A session launched past a
// failed preflight starts without the gateway's tools and improvises
// around the submit gate — so this gate fails the run first. The bash the
// container runs is only `node -e "$RIG_PREFLIGHT"`; the script's content
// is expanded verbatim and never re-parsed, so it carries no shell-quoting
// surface at all, and the token arrives through the 0600 env file.
function preflightGateway(admitted, providerDir) {
	execIn('node -e "$RIG_PREFLIGHT"', {
		env: {
			GATEWAY_URL: admitted.url,
			RIG_PREFLIGHT: gatewayPreflightScript(),
		},
		envFile: path.join(providerDir, "agent/gateway.env"),
	});
}

// The run's teardown, on every exit path. A fail() call mid-run runs
// process.exit, which does not unwind a finally — so a failed run used to
// leak its container and temp dirs (#110: fifteen theta-rig corpses by
// 2026-11-01). The teardown rides a process exit hook instead; exit-hook
// law binds the shape: synchronous only, and a cleanup error must never
// mask the primary failure — so every step is fire-and-forget and a
// container that never started is a harmless failed rm.
export function runTeardown({ containerName, sourceDir, providerDir }) {
	if (containerName) spawnRun("docker", ["rm", "-f", containerName], { stdio: "ignore" });
	// Each removal guarded alone: rmSync's force only suppresses ENOENT, and
	// a throwing removal (EBUSY, EPERM) must neither skip the next step nor
	// flip a successful run's exit — the cleanup-never-masks convention.
	for (const dir of [sourceDir, providerDir]) {
		try {
			rmSync(dir ?? "", { recursive: true, force: true });
		} catch {
			// teardown is best-effort by design
		}
	}
}

// The auditor binds cwd to the checkout, so run it from /theta and capture
// the attestation for the evidence dir; printed output is the record. Leg
// arguments ride shell-quoted — the auditor re-validates each against the
// checkout, so quoting is the runner's only concern.
function audit(legs) {
	const legArgs = legs.map((leg) => `'${leg.replaceAll("'", "'\\''")}'`).join(" ");
	const attestation = execIn(
		`cd "$HOME/theta" && node scripts/audit-dogfood.mjs /session ${legArgs}`.trimEnd(),
	);
	writeFileSync(path.join(sessionDir, "attestation.txt"), attestation);
	console.log(attestation);
}

// A benchmark leg refuses both rig extensions a dogfood leg can carry:
// no gateway token path exists on a benchmark leg (spec #135), and the
// RPC driver exists only to answer the submit gate — which never runs
// here. Throws (the CLI maps the message to its refusal), so the
// offline test can pin it without exiting the runner. Pinned by
// bench-rig.test.mjs.
export function assertBenchmarkFlags(flags) {
	if (flags.gateway) throw new Error("--gateway is a dogfood-leg flag — a benchmark leg carries only the provider key");
	if (flags.rpc) throw new Error("--rpc is a dogfood-leg flag — no confirm is ever asked on a benchmark leg");
}

// The shared leg machinery (one home, the shared-helper rule — the
// `run` and `eval` paths are the two callers, never a copy): the
// evidence dir's default home, the process-fact bundle every leg
// writes before the container starts, the runtime version record, and
// the session exit-status contract (read the file pi's wrapper wrote,
// mark the watchdog sentinel on 124, refuse on any other non-zero —
// stdout belongs to the model's reply, so the status lands as a file).
function defaultEvidenceDir(prefix) {
	return path.join(process.env.HOME, ".theta-evidence", `${prefix}-${Date.now()}`);
}

function writeEvidenceBasics({ expectedModel, prompts }) {
	mkdirSync(sessionDir, { recursive: true });
	writeFileSync(path.join(sessionDir, SESSION_FILES.preHead), headSha);
	writeFileSync(path.join(sessionDir, SESSION_FILES.expectedModel), `${expectedModel}\n`);
	writeFileSync(path.join(sessionDir, SESSION_FILES.manifestSha), manifestSha256(repoRoot));
	prompts.forEach((prompt, index) => {
		writeFileSync(path.join(sessionDir, suffixed(SESSION_FILES.prompt, index)), prompt);
	});
}

function recordRuntimeVersions() {
	execIn(`pi --version > /session/${SESSION_FILES.piVersion} && node --version > /session/${SESSION_FILES.nodeVersion}`);
}

function finishSession(exitFile, label) {
	const exitStatus = Number.parseInt(readFileSync(path.join(sessionDir, exitFile), "utf8").trim(), 10);
	if (!Number.isInteger(exitStatus)) fail(`cannot read the session exit-status file (${exitFile})`);
	if (exitStatus === 124) writeFileSync(path.join(sessionDir, SESSION_FILES.watchdog), "fired\n");
	if (exitStatus !== 0) fail(`${label} exited ${exitStatus} — evidence in ${sessionDir}`);
}

// The multi-session artifact-name rule (one home, the shared-helper
// rule): session 1 keeps the plain name the evidence bundle owns;
// sessions after it insert `-N` before the extension when there is one
// (answer-2.txt), and append at the end when there is not
// (exit-status-2) — so the family stays greppable by name.
export function suffixed(name, index) {
	if (index === 0) return name;
	const suffix = `-${index + 1}`;
	return /\.(?!.*\.)/.test(name) ? name.replace(/(\.[^.]*)$/, `${suffix}$1`) : `${name}${suffix}`;
}

// One benchmark session's command (spec #135), the pure builder the
// offline test pins: cwd is the task workspace (`$HOME/task`), the
// launcher rides the clone's own path WITHOUT `--dev` — the launcher
// loads its own package root as the -e source, which is the clone, and
// `--dev` would refuse because the workspace cwd is not the checkout —
// and the prompt rides RIG_PROMPT, never argv. Sessions after the
// first resume with `--continue` (resume-keeps-tools; the tracer task
// is single-session). Print mode keeps its truncation contract: the
// exit-status file records what pi exited, stdout belongs to the
// model's reply (nothing glues onto it — it lands as answer.txt).
export function evalSessionCommand({ index, timeout, provider, model }) {
	return (
		`cd "$HOME/task" && timeout --signal=TERM --kill-after=15 ${timeout} ` +
		`node "$HOME/theta/bin/theta.mjs" --provider ${provider} --model ${model} ` +
		`--session-dir /session${index > 0 ? " --continue" : ""} --print "$RIG_PROMPT" ` +
		`< /dev/null > /session/${suffixed(BENCH_FILES.answer, index)} ` +
		`2> /session/${suffixed(SESSION_FILES.stderr, index)}` +
		`; echo $? > /session/${suffixed(SESSION_FILES.exitStatus, index)}`
	);
}

// The in-container objective grading step: the grader runs from the
// clone (committed at the pinned HEAD, no node_modules needed — it is
// pure node:fs by design) against the task workspace, and its
// machine-readable result lands as a file beside the evidence.
export function evalGradeCommand(taskId) {
	return `cd "$HOME/theta" && node test/eval/bench-grade.mjs ${taskId} "$HOME/task" /session/${BENCH_FILES.grades}`;
}

// The benchmark leg itself. One command, end to end: judge preflight
// host-side (fail before anything disposable is spent — the judge's
// credential lives on the host and never enters the rig), the session
// legs in the container, in-container grading, then the host-side
// report (classify() judge, UsageEntry totals) beside the recorded
// exit status. A failing task grade is a successful measurement: the
// leg exits non-zero only when the leg failed — session exit, judge
// error, missing report — never because the model measured poorly.
async function runEval(taskId, flags) {
	const task = benchTaskById(taskId);
	for (const prompt of task.sessions) {
		if (/[^\x00-\x7F]/.test(prompt)) fail("benchmark task prompts must be pure ASCII");
	}

	// Host-side judge preflight, before Docker or a clone is spent.
	const { ModelRuntime, ModelRegistry } = await import("@earendil-works/pi-coding-agent");
	const registry = new ModelRegistry(await ModelRuntime.create());
	const judgeModel = resolveJudge(registry, task.judge);

	waitForDaemon();
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
		process.on("exit", () => runTeardown({ containerName: container, sourceDir, providerDir }));
		sourceDir = stageCloneSource();

		sessionDir = flags.sessionDir ?? defaultEvidenceDir(`bench-${task.id}`);
		writeEvidenceBasics({
			expectedModel: `${flags.provider} ${flags.model}`,
			prompts: task.sessions,
		});

		// The gateway flag was refused at parse; the container starts
		// gateway-free by construction here.
		startContainer(providerDir, false);
		recordRuntimeVersions();
		execIn("mkdir -p \"$HOME/task\"");

		for (const [index, prompt] of task.sessions.entries()) {
			execIn(evalSessionCommand({ index, timeout: flags.timeout, provider: flags.provider, model: flags.model }), {
				env: { RIG_PROMPT: prompt },
			});
			finishSession(suffixed(SESSION_FILES.exitStatus, index), `benchmark session ${index + 1}`);
		}

		execIn(evalGradeCommand(task.id));

		// Host-side report: objective grades (written in-container), the
		// classify() verdict, and the native usage ledger over every
		// transcript the leg recorded. A missed objective check is a
		// failed measurement — the classify row is skipped, the grade
		// fails, and the leg still exits zero (docs/agents/eval.md);
		// only a judge that actually broke fails the leg.
		const grades = JSON.parse(readFileSync(path.join(sessionDir, BENCH_FILES.grades), "utf8"));
		const usage = sumSessionUsage(sessionDir);
		const artifact = grades.matched?.[task.classify.on];
		const judgeResult = artifact
			? await runJudge(registry, judgeModel, task.classify, { prompt: task.sessions[0], artifact })
			: {
					pass: false,
					skipped: `objective check ${task.classify.on} matched nothing to judge`,
				};
		const report = buildReport({
			task,
			grades,
			judgeSlot: task.judge,
			judgeResult,
			usage,
			head: headSha,
			gradedAt: new Date().toISOString(),
		});
		writeFileSync(path.join(sessionDir, BENCH_FILES.report), `${JSON.stringify(report, null, "\t")}\n`);
		for (const check of report.checks) {
			console.log(`bench: ${check.pass ? "PASS" : "FAIL"} ${check.id}${check.judgeError ? ` (${check.judgeError})` : ""}`);
		}
		console.log(
			`bench: task ${report.task} graded ${report.grade}; ${usage.sessions} session(s), ` +
				`${usage.totals.totalTokens} tokens, cost ${usage.totals.cost.toFixed(4)} USD ` +
				`(judge ${report.judge.provider}/${report.judge.model}, tier ${report.judge.tier})`,
		);
		console.log(`rig: evidence in ${sessionDir}`);
		if (judgeResult.judgeError !== undefined) {
			fail(`the judge errored — the leg failed after the report landed: ${judgeResult.judgeError}`);
		}
	} catch (error) {
		fail(`unexpected failure: ${error?.message ?? error}`);
	}
}

function main() {
	const [subcommand, ...argv] = process.argv.slice(2);
	if (subcommand === undefined || subcommand === "help" || subcommand === "--help") {
		console.log("usage: run.mjs build | run [--provider P] [--model M] [--timeout S] [--session-dir D] [--leg ARG]... [--gateway] [--rpc] <prompt> | eval [--provider P] [--model M] [--timeout S] [--session-dir D] <task-id> | shell [--gateway]");
		return;
	}
	const { flags, rest } = parseFlags(argv);
	// Before the daemon wait, so a flag-only refusal never needs Docker.
	if (flags.rpc && !flags.gateway) fail("--rpc needs --gateway — the confirm driver exists for gated gateway legs");
	if (subcommand === "eval") {
		// Also before the daemon wait: a benchmark flag refusal or a
		// judge preflight failure must not need Docker at all.
		try {
			assertBenchmarkFlags(flags);
		} catch (error) {
			fail(error.message);
		}
		const taskId = rest[0];
		if (!taskId) fail("eval needs a benchmark task id — the checked-in list is the source (test/eval/bench-tasks.mjs)");
		runEval(taskId, flags).catch((error) => fail(`unexpected failure: ${error?.message ?? error}`));
		return;
	}
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
	let gatewayEntry;
	try {
		providerDir = prepareProviderConfig(flags.provider);
		// From the first disposable artifact on, the exit hook owns
		// teardown — the finally it replaces could not run under fail()'s
		// process.exit (#110).
		process.on("exit", () => runTeardown({ containerName: container, sourceDir, providerDir }));
		if (flags.gateway) gatewayEntry = prepareGatewayConfig(providerDir);
		sourceDir = stageCloneSource();

		if (subcommand === "run") {
			const prompt = rest.join(" ");
			if (!prompt) fail("run needs a prompt");
			if (/[^\x00-\x7F]/.test(prompt)) fail("prompt must be pure ASCII (the auditor rejects the rest)");
			sessionDir = flags.sessionDir ?? defaultEvidenceDir(`rig-${headSha.slice(0, 7)}`);
			writeEvidenceBasics({
				expectedModel: `${flags.provider} ${flags.model}`,
				prompts: [prompt],
			});
		}

		startContainer(providerDir, flags.gateway);
		if (gatewayEntry) preflightGateway(gatewayEntry, providerDir);

		if (subcommand === "shell") {
			run("docker", ["exec", "-it", container, "bash"], { stdio: "inherit" });
			return;
		}

		// The runtime record the audit re-verifies.
		recordRuntimeVersions();

		// GNU timeout stands in for the host recipe's hand-rolled watchdog:
		// SIGTERM at the bound, SIGKILL 15s later, 124 recorded on timeout.
		// The exit status lands as a file, exactly as the host recipe writes
		// it — stdout belongs to the model's reply, and nothing glues onto
		// it. Print mode answers no confirms (the no-op UI denies them); the
		// `--rpc` leg runs the driver instead, which answers the submit
		// gate's confirm headlessly — evidence tooling, never a user path.
		const sessionPrefix = `cd "$HOME/theta" && timeout --signal=TERM --kill-after=15 ${flags.timeout} `;
		const sessionCommand = flags.rpc
			? sessionPrefix +
				`node test/rig/rpc-driver.mjs "$HOME/theta" /session "$RIG_PROMPT" allow ` +
				`2> /session/driver-stderr.txt`
			: sessionPrefix +
				`node bin/theta.mjs --dev --provider ${flags.provider} --model ${flags.model} ` +
				`--session-dir /session --print "$RIG_PROMPT" < /dev/null 2> /session/${SESSION_FILES.stderr}`;
		const sessionEnv = { RIG_PROMPT: rest.join(" ") };
		if (flags.rpc) {
			sessionEnv.RIG_PROVIDER = flags.provider;
			sessionEnv.RIG_MODEL = flags.model;
			sessionEnv.RIG_TIMEOUT = String(flags.timeout);
		}
		execIn(`${sessionCommand}; echo $? > /session/${SESSION_FILES.exitStatus}`, { env: sessionEnv });
		finishSession(SESSION_FILES.exitStatus, "session");

		audit(flags.legs);
		console.log(`rig: evidence in ${sessionDir}`);
	} catch (error) {
		// The exit hook still tears down; this only gives an unexpected
		// crash the runner's one failure story instead of a bare stack.
		fail(`unexpected failure: ${error?.message ?? error}`);
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main();
}
