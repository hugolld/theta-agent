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
// cross the submit gate in a headless run. `--pool <pack>` (spec #167)
// stages a per-project skills.json into the clone before the session, so
// the session loads that domain pack through the skill pool loader's
// deterministic scan — a state file, never a credential: the pool leg
// stays keyless, and the benchmark mode refuses the flag outright.
//
// `eval` is the benchmark layer's mode (spec #136, on the #135 tracer's
// shape): one task from the checked-in list (test/eval/bench-tasks.mjs)
// runs end-to-end and grades from one command — or `--suite` runs the
// whole checked-in list in one container, one clone, one report. Either
// way it refuses `--gateway` and `--rpc` — no gateway token path exists
// on a benchmark leg; the provider key is the only credential that
// enters. Each session runs print-mode in a fresh task workspace
// (`$HOME/task`), so exit codes carry truncation failures the way the
// dogfood leg's do; the objective grader runs in-container against the
// workspace (workspace-as-oracle), and the judge step runs host-side —
// the classifiers' credentials live on the host and never enter the
// rig. A suite leg writes its evidence under a per-task subdir and the
// run-level report (bench-suite.json) lands at the evidence root once
// every task is graded. Compaction stays native.

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gitStatus, manifestSha256, run as spawnRun } from "../../scripts/dogfood-gates.mjs";
import { SESSION_FILES } from "../../scripts/session-evidence.mjs";
import { BENCH_TASKS, benchTaskById } from "../eval/bench-tasks.mjs";
import { BENCH_FILES, buildReport, buildSuiteReport, resolveJudge, runJudge, sumSessionUsage } from "../eval/bench-report.mjs";

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
	const flags = { timeout: 300, provider: defaultProvider, model: defaultModel, legs: [], gateway: false, rpc: false, suite: false, pool: undefined };
	const rest = [];
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--provider" || arg === "--model" || arg === "--pool") {
			const value = argv[++i];
			if (value === undefined) fail(`${arg} needs a value`);
			flags[arg.slice(2)] = value;
		} else if (arg === "--gateway" || arg === "--rpc" || arg === "--suite") {
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

// The pool leg's staged state (spec #167): a --pool <pack> run writes the
// per-project state file into the clone before the session launches, so
// the session loads the pack through the S1 loader's deterministic scan —
// keyless, no gate, no command: exactly the path the replay net's pool
// scenario captures. The shape is the loader's state v1
// (extensions/skill-pool.ts), single-line JSON; the literals are pinned
// against the loader's own exports by test/rig.test.mjs.
export function poolStateJson(pack) {
	return `${JSON.stringify({
		version: 1,
		classAllow: ["local"],
		packs: { [pack]: { enabled: true, history: [] } },
	})}\n`;
}

// The in-container staging step: the state rides an env var (never the
// bash command line) and lands at the gitignored <clone>/.theta/skills.json
// — the same scratch home the notebook scenario's recorder writes into the
// clone, tolerated by the clean-tree proof by .gitignore design.
export function stagePoolStateCommand() {
	return 'mkdir -p "$HOME/theta/.theta" && printf \'%s\' "$RIG_POOL_STATE" > "$HOME/theta/.theta/skills.json"';
}

function stagePoolState(pack) {
	execIn(stagePoolStateCommand(), { env: { RIG_POOL_STATE: poolStateJson(pack) } });
}

// The --pool value must name a pack directory this repo's pool actually
// carries — refused before any Docker is spent, naming the valid packs.
// Throws (the CLI maps the message to its refusal); pinned by rig.test.mjs.
export function assertPoolPack(pack, root = repoRoot) {
	let entries;
	try {
		entries = readdirSync(path.join(root, "pool"), { withFileTypes: true });
	} catch {
		throw new Error("this repo carries no pool/ — a --pool leg has nothing to load");
	}
	const packs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
	if (!packs.includes(pack)) {
		throw new Error(`--pool must name a pool pack, got "${pack}" — valid packs: ${packs.join(", ")}`);
	}
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

// A benchmark leg refuses every rig extension a dogfood leg can carry:
// no gateway token path exists on a benchmark leg (spec #135), the RPC
// driver exists only to answer the submit gate — which never runs here —
// and a staged pool state is a dogfood-leg concern: a benchmark session
// runs in a bare task workspace, so a --pool value on an eval command
// line is a flag confusion, refused before it is spent. Throws (the CLI
// maps the message to its refusal), so the offline test can pin it
// without exiting the runner. Pinned by bench-rig.test.mjs.
export function assertBenchmarkFlags(flags) {
	if (flags.gateway) throw new Error("--gateway is a dogfood-leg flag — a benchmark leg carries only the provider key");
	if (flags.rpc) throw new Error("--rpc is a dogfood-leg flag — no confirm is ever asked on a benchmark leg");
	if (flags.pool !== undefined) throw new Error("--pool is a dogfood-leg flag — a benchmark session runs in a bare task workspace");
}

// The eval mode's task selection (spec #136): one id runs that task,
// `--suite` runs the whole checked-in list in checked-in order — never
// both. The prompt doctrine is gated here, before anything disposable
// is spent. Throws (the CLI maps the message to its refusal); pinned
// by bench-rig.test.mjs.
export function selectEvalTasks(flags, rest, tasks = BENCH_TASKS) {
	for (const task of tasks) {
		for (const prompt of task.sessions) {
			if (/[^\x00-\x7F]/.test(prompt)) throw new Error("benchmark task prompts must be pure ASCII");
		}
	}
	if (flags.suite) {
		if (rest.length > 0) throw new Error("--suite runs the whole checked-in list — no task id beside it");
		return tasks;
	}
	const taskId = rest[0];
	if (!taskId) throw new Error("eval needs a benchmark task id — the checked-in list is the source (test/eval/bench-tasks.mjs)");
	return [benchTaskById(taskId)];
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

function writeEvidenceBasics(dir, { expectedModel, prompts }) {
	mkdirSync(dir, { recursive: true });
	writeFileSync(path.join(dir, SESSION_FILES.preHead), headSha);
	writeFileSync(path.join(dir, SESSION_FILES.expectedModel), `${expectedModel}\n`);
	writeFileSync(path.join(dir, SESSION_FILES.manifestSha), manifestSha256(repoRoot));
	prompts.forEach((prompt, index) => {
		writeFileSync(path.join(dir, suffixed(SESSION_FILES.prompt, index)), prompt);
	});
}

function recordRuntimeVersions() {
	execIn(`pi --version > /session/${SESSION_FILES.piVersion} && node --version > /session/${SESSION_FILES.nodeVersion}`);
}

function finishSession(dir, exitFile, label) {
	const exitStatus = Number.parseInt(readFileSync(path.join(dir, exitFile), "utf8").trim(), 10);
	if (!Number.isInteger(exitStatus)) fail(`cannot read the session exit-status file (${exitFile})`);
	if (exitStatus === 124) writeFileSync(path.join(dir, SESSION_FILES.watchdog), "fired\n");
	if (exitStatus !== 0) fail(`${label} exited ${exitStatus} — evidence in ${dir}`);
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

// One home for the image asset's basename (the shared-helper rule —
// the staging command and the session argv are the two callers).
function imageBasename(image) {
	return image.split("/").pop();
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
//
// `sessionPath` is the container path this leg's artifacts write to —
// `/session` for a single-task leg, a per-task subdir for a suite leg
// (spec #136: one evidence dir per task under the suite's mount).
// `image` (spec #136) names a committed asset: pi's @path is a
// first-prompt argument resolved from the cwd, so it rides the argv on
// session one and nowhere else.
export function evalSessionCommand({ index, timeout, provider, model, image, sessionPath = "/session" }) {
	const imageArg = image && index === 0 ? ` "@${imageBasename(image)}"` : "";
	return (
		`cd "$HOME/task" && timeout --signal=TERM --kill-after=15 ${timeout} ` +
		`node "$HOME/theta/bin/theta.mjs" --provider ${provider} --model ${model} ` +
		`--session-dir ${sessionPath}${index > 0 ? " --continue" : ""} --print "$RIG_PROMPT"${imageArg} ` +
		`< /dev/null > ${sessionPath}/${suffixed(BENCH_FILES.answer, index)} ` +
		`2> ${sessionPath}/${suffixed(SESSION_FILES.stderr, index)}` +
		`; echo $? > ${sessionPath}/${suffixed(SESSION_FILES.exitStatus, index)}`
	);
}

// The image staging command (spec #136): the asset is committed, so the
// clone already holds it — one cp into the fresh task workspace, under
// its own basename, before the first session starts.
export function stageImageCommand(image) {
	return `cp "$HOME/theta/${image}" "$HOME/task/${imageBasename(image)}"`;
}

// The suite's per-task evidence subdir name (one home, the shared
// helper rule — the runner and the tests read the same shape).
export function suiteTaskDirName(taskId) {
	return `task-${taskId}`;
}

// The in-container objective grading step: the grader runs from the
// clone (committed at the pinned HEAD, no node_modules needed — it is
// pure node:fs by design) against the task workspace, and its
// machine-readable result lands as a file beside the evidence.
export function evalGradeCommand(taskId, sessionPath = "/session") {
	return `cd "$HOME/theta" && node test/eval/bench-grade.mjs ${taskId} "$HOME/task" ${sessionPath}/${BENCH_FILES.grades}`;
}

// Host-side judge preflight (spec #136): every judge slot of every
// selected task resolves against the installed catalog and its provider
// key, before Docker or a clone is spent. One resolve per unique slot —
// the two tiers share a host but never an identity. The judge calls
// themselves run in fresh child processes (test/eval/bench-judge.mjs),
// so nothing downstream needs the resolved models.
async function preflightJudges(tasks) {
	const { ModelRuntime, ModelRegistry } = await import("@earendil-works/pi-coding-agent");
	const registry = new ModelRegistry(await ModelRuntime.create());
	const seen = new Set();
	for (const task of tasks) {
		for (const slot of task.judges) {
			const key = `${slot.provider}/${slot.model}`;
			if (!seen.has(key)) {
				seen.add(key);
				resolveJudge(registry, slot);
			}
		}
	}
}

// The clean-tree gate both rig paths share (one home, the shared-helper
// rule): the rig clones committed HEAD, so a dirty tree would capture
// uncommitted bytes. The refusal names the dirt it holds (#172's retro):
// the porcelain output was read and dropped, and the #167 capture spent
// its refusal rediscovering by hand the offender (an untracked
// node_modules symlink) the message already knew — audit-dogfood's
// attestation-time refusal set the shape.
export function requireCleanTree(root = repoRoot, readStatus = gitStatus) {
	let status;
	try {
		status = readStatus(root);
	} catch (error) {
		throw new Error(`cannot read git status: ${error.message}`);
	}
	if (status) throw new Error(`working tree dirty — commit first:\n${status.trim()}`);
}

// The Docker-and-git prelude both eval paths share (one home, the
// shared-helper rule): daemon wait, the clean-tree gate, the pinned
// HEAD, the provider config, and the exit-hook teardown that owns
// every disposable artifact from here on. Returns the provider config
// dir for startContainer.
function evalStaging(flags) {
	waitForDaemon();
	try {
		requireCleanTree();
	} catch (error) {
		fail(error.message);
	}
	headSha = run("git", ["-C", repoRoot, "rev-parse", "HEAD"]).stdout.trim();
	const providerDir = prepareProviderConfig(flags.provider);
	process.on("exit", () => runTeardown({ containerName: container, sourceDir, providerDir }));
	sourceDir = stageCloneSource();
	return providerDir;
}

// One benchmark task's leg, on a live container (both eval paths are
// callers — the single-task mode and the suite loop share every step):
// fresh workspace, image staging, the session legs, in-container
// grading, then the host-side judges and the per-task report. A failing
// task grade is a successful measurement — the report rides it, the
// caller continues; a session exit fails the leg from finishSession,
// and a judge error lands in the report for the caller's gate
// (gateJudgeErrors — after the run-level report has landed).
async function runBenchTask(task, { taskDir, taskSessionPath, flags }) {
	execIn(`rm -rf "$HOME/task" && mkdir -p "$HOME/task"`);
	execIn(`mkdir -p '${taskSessionPath}'`);
	if (task.image) execIn(stageImageCommand(task.image));

	writeEvidenceBasics(taskDir, { expectedModel: `${flags.provider} ${flags.model}`, prompts: task.sessions });

	for (const [index, prompt] of task.sessions.entries()) {
		execIn(
			evalSessionCommand({
				index,
				timeout: flags.timeout,
				provider: flags.provider,
				model: flags.model,
				image: task.image,
				sessionPath: taskSessionPath,
			}),
			{ env: { RIG_PROMPT: prompt } },
		);
		finishSession(taskDir, suffixed(SESSION_FILES.exitStatus, index), `benchmark session ${index + 1} (${task.id})`);
	}

	execIn(evalGradeCommand(task.id, taskSessionPath));

	const grades = JSON.parse(readFileSync(path.join(taskDir, BENCH_FILES.grades), "utf8"));
	const usage = sumSessionUsage(taskDir);
	const artifact = grades.matched?.[task.classify.on];
	const judgeResults = await Promise.all(
		task.judges.map((slot) =>
			artifact
				? runJudge(slot, task.classify, {
						prompts: task.sessions,
						artifact,
					})
				: { pass: false, skipped: `objective check ${task.classify.on} matched nothing to judge` },
		),
	);
	const report = buildReport({
		task,
		grades,
		judgeCalls: task.judges.map((slot, index) => ({ slot, result: judgeResults[index] })),
		usage,
		head: headSha,
		gradedAt: new Date().toISOString(),
	});
	writeFileSync(path.join(taskDir, BENCH_FILES.report), `${JSON.stringify(report, null, "\t")}\n`);
	for (const check of report.checks) {
		console.log(`bench: ${task.id} ${check.pass ? "PASS" : "FAIL"} ${check.id} — ${check.detail}`);
	}
	for (const judgeRow of report.judges) {
		console.log(
			`bench: ${task.id} ${judgeRow.pass ? "PASS" : "FAIL"} ${judgeRow.id} [${judgeRow.tier} ${judgeRow.provider}/${judgeRow.model}]` +
				(judgeRow.probability !== undefined ? ` p=${judgeRow.probability.toFixed(3)}` : "") +
				(judgeRow.judgeError ? ` (${judgeRow.judgeError})` : ""),
		);
	}
	console.log(
		`bench: task ${report.task} graded ${report.grade}; ${usage.sessions} session(s), ` +
			`${usage.totals.totalTokens} tokens, cost ${usage.totals.cost.toFixed(4)} USD`,
	);
	return report;
}

// The leg-failure gate for judge errors (the S2 doctrine, one home now):
// a judge that actually broke fails the leg, but only after the
// run-level report has landed — never mid-run, with nothing to read.
function gateJudgeErrors(reports) {
	for (const report of reports) {
		for (const judgeRow of report.judges) {
			if (judgeRow.judgeError !== undefined) {
				fail(`the judge errored — the leg failed after the report landed: ${judgeRow.judgeError}`);
			}
		}
	}
}

// One command, end to end, for one task (the #135 tracer's shape,
// preserved): judge preflight host-side, the session legs in the
// container, in-container grading, then the host-side report beside the
// recorded exit status.
async function runEval(task, flags) {
	await preflightJudges([task]);
	const providerDir = evalStaging(flags);

	sessionDir = flags.sessionDir ?? defaultEvidenceDir(`bench-${task.id}`);

	// The gateway flag was refused at parse; the container starts
	// gateway-free by construction here.
	startContainer(providerDir, false);
	recordRuntimeVersions();
	const report = await runBenchTask(task, {
		taskDir: sessionDir,
		taskSessionPath: "/session",
		flags,
	});
	console.log(`rig: evidence in ${sessionDir}`);
	gateJudgeErrors([report]);
}

// The suite (spec #136): one command runs the whole checked-in task
// list — one container, one clone, a per-task evidence subdir and
// report each, and the run-level bench-suite.json at the evidence root.
// A failing task grade is a successful measurement: the loop continues
// and the suite report carries the fail. Session exits and judge errors
// fail the leg, per the single-task contract.
async function runSuite(tasks, flags) {
	// The caller's selection (main's selectEvalTasks result), never a
	// re-read of the module list — one source of what runs, and a future
	// filter in the selection cannot silently diverge from the loop.
	await preflightJudges(tasks);
	const providerDir = evalStaging(flags);

	sessionDir = flags.sessionDir ?? defaultEvidenceDir("bench-suite");
	writeEvidenceBasics(sessionDir, { expectedModel: `${flags.provider} ${flags.model}`, prompts: [] });

	startContainer(providerDir, false);
	recordRuntimeVersions();

	const reports = [];
	for (const task of tasks) {
		console.log(`rig: benchmark task ${task.id} (${task.class})`);
		reports.push(
			await runBenchTask(task, {
				taskDir: path.join(sessionDir, suiteTaskDirName(task.id)),
				taskSessionPath: `/session/${suiteTaskDirName(task.id)}`,
				flags,
			}),
		);
	}
	const suite = buildSuiteReport({
		reports,
		provider: flags.provider,
		model: flags.model,
		head: headSha,
		gradedAt: new Date().toISOString(),
	});
	writeFileSync(path.join(sessionDir, BENCH_FILES.suite), `${JSON.stringify(suite, null, "\t")}\n`);
	console.log(
		`suite: ${suite.totals.passed}/${suite.totals.tasks} tasks pass; ${suite.totals.sessions} session(s), ` +
			`${suite.totals.tokens} tokens, cost ${suite.totals.cost.toFixed(4)} USD (report: ${BENCH_FILES.suite})`,
	);
	console.log(`rig: evidence in ${sessionDir}`);
	gateJudgeErrors(reports);
}

function main() {
	const [subcommand, ...argv] = process.argv.slice(2);
	if (subcommand === undefined || subcommand === "help" || subcommand === "--help") {
		console.log("usage: run.mjs build | run [--provider P] [--model M] [--timeout S] [--session-dir D] [--leg ARG]... [--gateway] [--rpc] [--pool <pack>] <prompt> | eval [--provider P] [--model M] [--timeout S] [--session-dir D] (--suite | <task-id>) | shell [--gateway] [--pool <pack>]");
		return;
	}
	const { flags, rest } = parseFlags(argv);
	// Before the daemon wait, so a flag-only refusal never needs Docker.
	if (flags.rpc && !flags.gateway) fail("--rpc needs --gateway — the confirm driver exists for gated gateway legs");
	if (flags.pool !== undefined) {
		try {
			assertPoolPack(flags.pool);
		} catch (error) {
			fail(error.message);
		}
	}
	if (subcommand === "eval") {
		// Also before the daemon wait: a benchmark flag refusal, a task
		// selection refusal, or a judge preflight failure must not need
		// Docker at all.
		try {
			assertBenchmarkFlags(flags);
			const tasks = selectEvalTasks(flags, rest);
			(flags.suite ? runSuite(tasks, flags) : runEval(tasks[0], flags)).catch((error) => fail(`unexpected failure: ${error?.message ?? error}`));
		} catch (error) {
			fail(error.message);
		}
		return;
	}
	waitForDaemon();

	if (subcommand === "build") {
		docker("build", "-t", image, rigDir);
		console.log(`rig: ${image} built`);
		return;
	}
	if (subcommand !== "run" && subcommand !== "shell") fail(`unknown subcommand: ${subcommand}`);

	try {
		requireCleanTree();
	} catch (error) {
		fail(error.message);
	}
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
			writeEvidenceBasics(sessionDir, {
				expectedModel: `${flags.provider} ${flags.model}`,
				prompts: [prompt],
			});
		}

		startContainer(providerDir, flags.gateway);
		// The staged pool state lands after the clone exists and before any
		// session or shell sees the tree — the deterministic loader path the
		// pool scenario captures (spec #167).
		if (flags.pool !== undefined) stagePoolState(flags.pool);
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
		finishSession(sessionDir, SESSION_FILES.exitStatus, "session");

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
