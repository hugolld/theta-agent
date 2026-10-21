import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

// Offline tests for the theta-compute gateway (#51 tracer, #52 generic
// tools), driven at the MCP tool-call boundary: node:test speaks raw MCP
// streamable HTTP (initialize, session, tools/list, tools/call) to a
// FastMCP server spawned from gateway/, with stub Slurm binaries first on
// its PATH. What is asserted is external behavior only: JSON-RPC results
// over the wire, the HTTP status of unauthenticated calls, the audit
// JSONL on disk, files in the staging root, and the argv the stubs
// actually received — never a Python helper. Contract basis: ADR 0004
// and the gateway README's audit-line shape.

const gatewayDir = fileURLToPath(new URL("../gateway", import.meta.url));
const stubBin = fileURLToPath(new URL("fixtures/gateway/bin", import.meta.url));
const TOKEN = "test-token-4f2a";

// The gateway runs from its locked uv environment (gateway/uv.lock). With
// no uv on PATH (unusual), skip rather than fail: CI installs uv.
const uvProbe = spawnSync("uv", ["--version"]);
const skipReason = uvProbe.status === 0 ? false : "no uv found on PATH";

const PROTOCOL_VERSION = "2025-06-18";
const CLIENT_INFO = { name: "node-test", version: "0" };
const READINESS_TIMEOUT_MS = 120_000;

// A free loopback port, claimed and released before the gateway takes it.
function freePort() {
	return new Promise((resolve, reject) => {
		const server = net.createServer();
		server.unref();
		server.on("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address();
			server.close(() => resolve(port));
		});
	});
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// One JSON-RPC request over streamable HTTP. Returns the raw Response so
// callers can assert on status and headers (the 401 path has no body).
async function rpc(baseUrl, { method, params, id, token, sessionId }) {
	const body = { jsonrpc: "2.0", method };
	if (params !== undefined) body.params = params;
	if (id !== undefined) body.id = id;
	return fetch(`${baseUrl}/mcp`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
			...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
			...(sessionId === undefined ? {} : { "mcp-session-id": sessionId }),
		},
		body: JSON.stringify(body),
	});
}

// The JSON-RPC messages in one response: a bare JSON object, or every
// `data:` payload when the server answered server-sent events.
async function rpcMessages(response) {
	const raw = await response.text();
	if (raw === "") return [];
	const contentType = response.headers.get("content-type") ?? "";
	if (contentType.includes("text/event-stream")) {
		return raw
			.split("\n")
			.filter((line) => line.startsWith("data:"))
			.map((line) => JSON.parse(line.slice("data:".length).trim()));
	}
	return [JSON.parse(raw)];
}

// One gateway process in a scratch dir (audit log and stub-argv log live
// there), killed with its process group when the test ends however it
// ends. Resolves once an authenticated initialize has succeeded, with a
// client bound to that session.
async function startGateway(t, { env = {} } = {}) {
	const port = await freePort();
	const scratch = await mkdtemp(path.join(tmpdir(), "theta-gateway-"));
	const auditLog = path.join(scratch, "audit.jsonl");
	const argvLog = path.join(scratch, "stub-argv.log");
	// The staging root is created and resolved before spawn: the gateway
	// sandbox-resolves every path it touches, and on macOS the temp dir
	// sits behind the /var -> /private/var symlink — asserted paths must
	// match the resolved form the gateway reports.
	await mkdir(path.join(scratch, "staging"), { recursive: true });
	const stagingRoot = await realpath(path.join(scratch, "staging"));
	// Detached: uv runs python as its child, so the whole group takes the
	// kill signal together.
	const child = spawn("uv", ["run", "--locked", "python", "-m", "theta_compute"], {
		cwd: gatewayDir,
		env: {
			...process.env,
			PATH: `${stubBin}:${process.env.PATH ?? ""}`,
			THETA_COMPUTE_TOKEN: TOKEN,
			THETA_COMPUTE_USER: "test-user",
			THETA_COMPUTE_AUDIT_LOG: auditLog,
			THETA_COMPUTE_STAGING_ROOT: stagingRoot,
			THETA_COMPUTE_HOST: "127.0.0.1",
			THETA_COMPUTE_PORT: String(port),
			THETA_GATEWAY_STUB_ARGV: argvLog,
			...env,
		},
		stdio: ["ignore", "ignore", "pipe"],
		detached: true,
	});
	let stderr = "";
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
	});
	t.after(() => {
		try {
			process.kill(-child.pid, "SIGTERM");
		} catch {
			child.kill("SIGTERM");
		}
		rm(scratch, { recursive: true, force: true });
	});

	const baseUrl = `http://127.0.0.1:${port}`;
	const deadline = Date.now() + READINESS_TIMEOUT_MS;
	let sessionId;
	for (;;) {
		if (child.exitCode !== null) {
			assert.fail(`gateway exited ${child.exitCode} before listening\n${stderr}`);
		}
		try {
			const probe = await rpc(baseUrl, {
				method: "initialize",
				params: {
					protocolVersion: PROTOCOL_VERSION,
					capabilities: {},
					clientInfo: CLIENT_INFO,
				},
				id: 0,
				token: TOKEN,
			});
			if (probe.status === 200) {
				sessionId = probe.headers.get("mcp-session-id");
				assert.ok(sessionId, "initialize answered 200 without a session id");
				await rpc(baseUrl, {
					method: "notifications/initialized",
					sessionId,
					token: TOKEN,
				});
				break;
			}
		} catch {
			// not listening yet
		}
		if (Date.now() > deadline) {
			assert.fail(`gateway not ready within ${READINESS_TIMEOUT_MS}ms\n${stderr}`);
		}
		await sleep(150);
	}

	let nextId = 1;
	const request = async (method, params) => {
		const response = await rpc(baseUrl, { method, params, id: nextId++, token: TOKEN, sessionId });
		assert.equal(response.status, 200, `${method} over the boundary`);
		const messages = await rpcMessages(response);
		const message = messages.find((candidate) => candidate.id !== undefined);
		assert.ok(message, `${method} answered with a JSON-RPC message`);
		assert.equal(message.error, undefined, `${method} errored: ${JSON.stringify(message.error)}`);
		return message.result;
	};
	const callTool = (name, args) => request("tools/call", { name, arguments: args });
	return { baseUrl, auditLog, argvLog, stagingRoot, request, callTool };
}

// A file's non-empty lines; an absent file reads as no lines yet.
async function readLines(file) {
	let raw;
	try {
		raw = await readFile(file, "utf8");
	} catch {
		return [];
	}
	return raw.split("\n").filter((line) => line !== "");
}

// The audit JSONL, parsed.
const readAudit = async (auditLog) => (await readLines(auditLog)).map((line) => JSON.parse(line));

// The argv groups the stubs received: one NUL-separated group per line.
const readArgv = async (argvLog) => (await readLines(argvLog)).map((line) => line.split("\0"));

// A tool result's text content, joined — the refusal and error messages.
const toolText = (result) => result.content.map((part) => part.text).join("\n");

// Canonical JSON as the gateway digests it: sorted keys, no whitespace.
function canonicalJson(value) {
	if (Array.isArray(value)) return value.map(canonicalJson);
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(
			Object.keys(value)
				.sort()
				.map((key) => [key, canonicalJson(value[key])]),
		);
	}
	return value;
}

const argumentDigest = (args) =>
	`sha256:${createHash("sha256").update(JSON.stringify(canonicalJson(args)), "utf8").digest("hex")}`;

// In-band payloads cross the wire as base64 (#52).
const b64 = (text) => Buffer.from(text, "utf8").toString("base64");
const unb64 = (encoded) => Buffer.from(encoded, "base64").toString("utf8");

// The stub-argv log as {program, args} pairs — basename-checked so the
// resolved stub path never matters.
async function readArgvCalls(argvLog) {
	const groups = await readArgv(argvLog);
	return groups.map(([program, ...args]) => ({ program: path.basename(program), args }));
}

// A path exists on disk.
async function exists(file) {
	try {
		await stat(file);
		return true;
	} catch {
		return false;
	}
}

// Every audit line's fixed fields, checked apart from the timestamp,
// which must merely be a UTC second-resolution ISO instant.
function assertAuditLine(line, expected) {
	const { ts, ...rest } = line;
	assert.match(ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/, "ts is a UTC ISO instant");
	assert.deepEqual(rest, expected);
}

test("an unauthenticated call is refused before any tool or audit line", { skip: skipReason }, async (t) => {
	const gateway = await startGateway(t);

	for (const { name, token } of [
		{ name: "no token", token: undefined },
		{ name: "wrong token", token: "not-the-token" },
	]) {
		const response = await rpc(gateway.baseUrl, {
			method: "initialize",
			params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO },
			id: 1,
			token,
		});
		assert.equal(response.status, 401, `${name}: HTTP 401`);
		assert.match(response.headers.get("www-authenticate") ?? "", /^Bearer/, `${name}: challenged`);
	}
	// A refusal at the transport is not a tool call: no audit line, and
	// no stub invocation.
	assert.deepEqual(await readAudit(gateway.auditLog), []);
	assert.deepEqual(await readArgv(gateway.argvLog), []);
});

test("tools/list exposes the seven tools with their hints", { skip: skipReason }, async (t) => {
	const gateway = await startGateway(t);

	const result = await gateway.request("tools/list", {});
	// The MCP wire format names annotation hints in camelCase. Only the
	// spend-and-destroy pair (submit, cancel) declares destructive; the
	// read-only quartet stays prompt-free (spec #49).
	const hint = (tool, key) => tool.annotations?.[key] === true;
	const listed = result.tools
		.map((tool) => ({
			name: tool.name,
			read_only: hint(tool, "readOnlyHint"),
			destructive: hint(tool, "destructiveHint"),
		}))
		.sort((a, b) => a.name.localeCompare(b.name));
	assert.deepEqual(listed, [
		{ name: "cancel_job", read_only: false, destructive: true },
		{ name: "fetch_artifacts", read_only: true, destructive: false },
		{ name: "job_logs", read_only: true, destructive: false },
		{ name: "job_status", read_only: true, destructive: false },
		{ name: "list_environments", read_only: true, destructive: false },
		{ name: "stage_files", read_only: false, destructive: false },
		{ name: "submit_job", read_only: false, destructive: true },
	]);
});

test("list_environments answers the recorded sinfo rows at the boundary", { skip: skipReason }, async (t) => {
	const gateway = await startGateway(t);

	const result = await gateway.callTool("list_environments", {});
	assert.equal(result.isError, false);
	assert.deepEqual(result.structuredContent, {
		environments: [
			{
				partition: "gpu",
				default: true,
				availability: "up",
				time_limit: "infinite",
				nodes: 2,
				state: "idle",
				node_list: "gpu[01-02]",
			},
			{
				partition: "gpu",
				default: true,
				availability: "up",
				time_limit: "infinite",
				nodes: 2,
				state: "alloc",
				node_list: "gpu[03-04]",
			},
			{
				partition: "cpu",
				default: false,
				availability: "up",
				time_limit: "7-00:00:00",
				nodes: 8,
				state: "idle",
				node_list: "c[01-08]",
			},
		],
	});

	// One audit line for the call, in the documented shape.
	const audit = await readAudit(gateway.auditLog);
	assert.equal(audit.length, 1);
	assertAuditLine(audit[0], {
		user: "test-user",
		tool: "list_environments",
		args_sha256: argumentDigest({}),
		decision: "ALLOW",
		job_id: null,
		reason: null,
	});

	// sinfo ran as an argv array: the stub's program path, then each
	// argument verbatim — never a shell string.
	const groups = await readArgv(gateway.argvLog);
	assert.equal(groups.length, 1);
	const [program, ...args] = groups[0];
	assert.equal(path.basename(program), "sinfo");
	assert.deepEqual(args, ["--noheader", "--format", "%P|%a|%l|%D|%t|%N"]);
	assert.ok(
		groups.flat().every((field) => !["sh", "bash", "-c"].includes(field)),
		"no shell sits between gateway and Slurm",
	);
});

test("job_status reports the recorded running job", { skip: skipReason }, async (t) => {
	const gateway = await startGateway(t);

	const result = await gateway.callTool("job_status", { job_id: "424242" });
	assert.equal(result.isError, false);
	assert.deepEqual(result.structuredContent, {
		found: true,
		job_id: "424242",
		state: "RUNNING",
		name: "pep5-af3",
		partition: "gpu",
		time_used: "12:34",
		reason: "(None)",
	});

	const audit = await readAudit(gateway.auditLog);
	assert.equal(audit.length, 1);
	assertAuditLine(audit[0], {
		user: "test-user",
		tool: "job_status",
		args_sha256: argumentDigest({ job_id: "424242" }),
		decision: "ALLOW",
		job_id: "424242",
		reason: null,
	});

	const groups = await readArgv(gateway.argvLog);
	assert.equal(groups.length, 1);
	const [program, ...args] = groups[0];
	assert.equal(path.basename(program), "squeue");
	assert.deepEqual(args, ["--noheader", "--format", "%i|%T|%j|%P|%M|%R", "--job", "424242"]);
});

test("a well-formed id not in the queue is an answer, not an error", { skip: skipReason }, async (t) => {
	const gateway = await startGateway(t);

	const result = await gateway.callTool("job_status", { job_id: "999999" });
	assert.equal(result.isError, false);
	assert.deepEqual(result.structuredContent, { found: false, job_id: "999999" });

	const audit = await readAudit(gateway.auditLog);
	assert.equal(audit.length, 1);
	assertAuditLine(audit[0], {
		user: "test-user",
		tool: "job_status",
		args_sha256: argumentDigest({ job_id: "999999" }),
		decision: "ALLOW",
		job_id: "999999",
		reason: null,
	});
});

test("a malformed job id is denied at the guard and never reaches Slurm", { skip: skipReason }, async (t) => {
	const gateway = await startGateway(t);
	const attacks = [
		"4242; touch /tmp/theta-pwned",
		"4242 && cat /etc/passwd",
		"4242 $(id)",
		"42|wc -l",
		"42 --all",
		"abc",
		"",
	];

	const argvBefore = (await readArgv(gateway.argvLog)).length;
	for (const job_id of attacks) {
		const result = await gateway.callTool("job_status", { job_id });
		assert.equal(result.isError, true, `job id ${job_id}: refused`);
		assert.match(toolText(result), /job id/i, `job id ${job_id}: the refusal names it`);
	}
	// No subprocess ran for any refused argument.
	assert.equal((await readArgv(gateway.argvLog)).length, argvBefore);

	const audit = await readAudit(gateway.auditLog);
	assert.equal(audit.length, attacks.length, "one DENY line per refused call");
	assert.deepEqual(
		audit.map((line) => line.job_id),
		attacks,
		"the rejected values ride the audit lines verbatim",
	);
	for (const line of audit) {
		assert.equal(line.decision, "DENY");
		assert.match(line.reason, /invalid job id/);
		assert.equal(line.user, "test-user");
		assert.equal(line.tool, "job_status");
	}
	assert.equal(audit[0].args_sha256, argumentDigest({ job_id: attacks[0] }));
});

test("a Slurm-side failure is an allowed call that failed", { skip: skipReason }, async (t) => {
	const gateway = await startGateway(t);

	const result = await gateway.callTool("job_status", { job_id: "555001" });
	assert.equal(result.isError, true);
	assert.match(toolText(result), /squeue exited 2.*Socket timed out/);

	// The access was allowed and dispatched; the failure is the reason.
	const audit = await readAudit(gateway.auditLog);
	assert.equal(audit.length, 1);
	assertAuditLine(audit[0], {
		user: "test-user",
		tool: "job_status",
		args_sha256: argumentDigest({ job_id: "555001" }),
		decision: "ALLOW",
		job_id: "555001",
		reason: "tool error: squeue exited 2: slurm_load_jobs error: Socket timed out on fd 4",
	});
});

test("a Slurm call past the timeout fails instead of hanging", { skip: skipReason }, async (t) => {
	const gateway = await startGateway(t, { env: { THETA_COMPUTE_SLURM_TIMEOUT: "1" } });

	const startedAt = Date.now();
	const result = await gateway.callTool("job_status", { job_id: "555002" });
	assert.ok(Date.now() - startedAt < 15_000, "the call returned, not hung");
	assert.equal(result.isError, true);
	assert.match(toolText(result), /timed out after 1s/);

	const audit = await readAudit(gateway.auditLog);
	assert.equal(audit.length, 1);
	assert.equal(audit[0].decision, "ALLOW");
	assert.match(audit[0].reason, /tool error: squeue timed out after 1s/);
});

test("the audit log rotates by size, keeping one prior generation", { skip: skipReason }, async (t) => {
	const gateway = await startGateway(t, { env: { THETA_COMPUTE_AUDIT_MAX_BYTES: "120" } });

	for (let i = 0; i < 3; i += 1) {
		await gateway.callTool("list_environments", {});
	}

	const rotated = `${gateway.auditLog}.1`;
	const previous = (await readAudit(rotated)).map((line) => line.decision);
	const current = (await readAudit(gateway.auditLog)).map((line) => line.decision);
	assert.equal(previous.length, 1, "the prior generation holds the lines before the last rotation");
	assert.equal(current.length, 1, "a fresh file started at the last rotation");
	assert.deepEqual([...previous, ...current].every((d) => d === "ALLOW"), true);
});

test("stage_files lands validated files in the run directory", { skip: skipReason }, async (t) => {
	const gateway = await startGateway(t);
	const foldInput = '{"sequences": []}';
	const msa = ">seq\nAAA";
	const args = {
		run_name: "pep5-inputs",
		files: [
			{ path: "fold_input.json", content_b64: b64(foldInput) },
			{ path: "data/msa.a3m", content_b64: b64(msa) },
		],
	};

	const result = await gateway.callTool("stage_files", args);
	assert.equal(result.isError, false);
	assert.deepEqual(result.structuredContent, {
		run_name: "pep5-inputs",
		run_dir: path.join(gateway.stagingRoot, "pep5-inputs"),
		staged: [
			{ path: "fold_input.json", bytes: Buffer.byteLength(foldInput) },
			{ path: "data/msa.a3m", bytes: Buffer.byteLength(msa) },
		],
	});

	// The files are on disk, byte-for-byte, in the sandboxed run directory.
	assert.equal(
		await readFile(path.join(gateway.stagingRoot, "pep5-inputs/data/msa.a3m"), "utf8"),
		msa,
	);

	// Staging is a filesystem transfer: no Slurm binary ran.
	assert.deepEqual(await readArgv(gateway.argvLog), []);

	const audit = await readAudit(gateway.auditLog);
	assert.equal(audit.length, 1);
	assertAuditLine(audit[0], {
		user: "test-user",
		tool: "stage_files",
		args_sha256: argumentDigest(args),
		decision: "ALLOW",
		job_id: null,
		reason: null,
	});
});

test("stage_files refuses what the sandbox refuses, writing nothing", { skip: skipReason }, async (t) => {
	const gateway = await startGateway(t);
	const attacks = [
		{ name: "absolute path", files: [{ path: "/etc/passwd", content_b64: b64("x") }] },
		{ name: "parent escape", files: [{ path: "../escape.txt", content_b64: b64("x") }] },
		{ name: "dot segment", files: [{ path: "data/./../../escape.txt", content_b64: b64("x") }] },
		{ name: "bad run name", files: [{ path: "a.txt", content_b64: b64("x") }], run_name: "../evil" },
		{ name: "empty files list", files: [] },
		{ name: "not base64", files: [{ path: "a.txt", content_b64: "!!!not base64!!!" }] },
		{ name: "good file beside a bad path", files: [
			{ path: "good.txt", content_b64: b64("good") },
			{ path: "b/../../escape.txt", content_b64: b64("x") },
		] },
	];

	for (const attack of attacks) {
		const result = await gateway.callTool("stage_files", {
			run_name: attack.run_name ?? "ok-run",
			files: attack.files,
		});
		assert.equal(result.isError, true, `${attack.name}: refused`);
		assert.match(toolText(result), /invalid|expected|only|refus/i, `${attack.name}: the refusal says why`);
	}

	// Nothing was written — not even the good file beside a bad path.
	assert.equal(await exists(path.join(gateway.stagingRoot, "ok-run")), false, "no partial staging");
	assert.equal(await exists(path.join(gateway.stagingRoot, "../escape.txt")), false, "nothing outside the root");
	// No subprocess ran for any refusal.
	assert.deepEqual(await readArgv(gateway.argvLog), []);

	const audit = await readAudit(gateway.auditLog);
	assert.equal(audit.length, attacks.length, "one DENY line per refused call");
	for (const line of audit) {
		assert.equal(line.decision, "DENY");
		assert.equal(line.tool, "stage_files");
		assert.equal(line.job_id, null);
	}
});

test("stage_files over the in-band cap names the out-of-band path", { skip: skipReason }, async (t) => {
	const gateway = await startGateway(t, { env: { THETA_COMPUTE_INBAND_MAX_BYTES: "8" } });

	const result = await gateway.callTool("stage_files", {
		run_name: "over-run",
		files: [{ path: "big.bin", content_b64: b64("123456789") }],
	});
	assert.equal(result.isError, true);
	const text = toolText(result);
	assert.match(text, /in-band cap of 8 bytes/, "the refusal names the cap");
	assert.ok(
		text.includes(`the run directory is ${gateway.stagingRoot}/over-run/`),
		"the refusal names the out-of-band path",
	);
	assert.equal(await exists(path.join(gateway.stagingRoot, "over-run")), false, "nothing staged");

	const audit = await readAudit(gateway.auditLog);
	assert.equal(audit.length, 1);
	assert.equal(audit[0].decision, "DENY");
	assert.match(audit[0].reason, /in-band cap/);
});

test("submit_job renders the guarded script and submits the file path", { skip: skipReason }, async (t) => {
	const gateway = await startGateway(t);
	const args = { run_name: "demo", directives: { time: "01:00:00", partition: "cpu", "cpus-per-task": 4 } };

	const result = await gateway.callTool("submit_job", args);
	assert.equal(result.isError, false);
	const runDir = path.join(gateway.stagingRoot, "demo");
	assert.deepEqual(result.structuredContent, {
		job_id: "777001",
		job_name: "theta-test-user-demo",
		script_path: path.join(runDir, "job.sbatch"),
	});

	// The script on disk: gateway-forced identity and log paths, the
	// allow-listed directives in sorted order, the fixed body.
	const script = await readFile(path.join(runDir, "job.sbatch"), "utf8");
	const lines = script.split("\n");
	assert.equal(lines[0], "#!/bin/bash");
	assert.ok(script.includes(`#SBATCH --job-name=theta-test-user-demo`), "the per-user ownership prefix is forced");
	assert.ok(script.includes(`#SBATCH --output=${runDir}/slurm-%j.out`), "stdout is forced into the run directory");
	assert.ok(script.includes(`#SBATCH --error=${runDir}/slurm-%j.err`), "stderr is forced into the run directory");
	assert.deepEqual(
		lines.filter((line) => line.startsWith("#SBATCH --") && !/job-name|--output|--error/.test(line)),
		["#SBATCH --cpus-per-task=4", "#SBATCH --partition=cpu", "#SBATCH --time=01:00:00"],
		"the client's directives are the only client lines, sorted",
	);
	assert.match(script, /printf 'theta-compute run demo job %s on %s\\n'/, "the body is gateway-fixed");

	// sbatch received a file path only — no shell, no directive arguments.
	const calls = await readArgvCalls(gateway.argvLog);
	assert.deepEqual(calls, [{ program: "sbatch", args: [path.join(runDir, "job.sbatch")] }]);

	const audit = await readAudit(gateway.auditLog);
	assert.equal(audit.length, 1);
	// The minted job id rides the audit line — no argument carried it, but
	// the trail ties the submission to its job.
	assertAuditLine(audit[0], {
		user: "test-user",
		tool: "submit_job",
		args_sha256: argumentDigest(args),
		decision: "ALLOW",
		job_id: "777001",
		reason: null,
	});
});

test("submit_job refuses keys, characters, and ceilings outside the guard", { skip: skipReason }, async (t) => {
	const gateway = await startGateway(t);
	const attacks = [
		{ name: "refused key (output)", directives: { output: `${tmpdir()}/pwned` }, refuses: /allow-list/ },
		{ name: "forced key (job-name)", directives: { "job-name": "evil" }, refuses: /allow-list/ },
		{ name: "partition outside the list", directives: { partition: "gpu" }, refuses: /not allowed/ },
		{ name: "time over the ceiling", directives: { time: "25:00:00" }, refuses: /ceiling/ },
		{ name: "mem over the ceiling", directives: { mem: "999999G" }, refuses: /ceiling/ },
		{ name: "ntasks over the ceiling", directives: { ntasks: "17" }, refuses: /ceiling/ },
		{ name: "gres over the ceiling", directives: { gres: "gpu:2" }, refuses: /not allowed/ },
		{ name: "value with script characters", directives: { time: "01:00; rm -rf /" }, refuses: /characters a script line must not/ },
		{ name: "directives not an object", directives: "cpu", refuses: /expected an object/ },
		{ name: "bad run name", directives: {}, run_name: "no spaces", refuses: /run name/ },
	];

	for (const attack of attacks) {
		const result = await gateway.callTool("submit_job", {
			run_name: attack.run_name ?? "demo",
			directives: attack.directives,
		});
		assert.equal(result.isError, true, `${attack.name}: refused`);
		assert.match(toolText(result), attack.refuses, `${attack.name}: the refusal says why`);
	}

	// No script was written and sbatch never ran.
	assert.equal(await exists(path.join(gateway.stagingRoot, "demo")), false, "no script written");
	assert.deepEqual(await readArgv(gateway.argvLog), []);

	const audit = await readAudit(gateway.auditLog);
	assert.equal(audit.length, attacks.length, "one DENY line per refused call");
	for (const line of audit) {
		assert.equal(line.decision, "DENY");
		assert.equal(line.tool, "submit_job");
	}
});

test("a zero-GPU deployment removes gres from the raw path", { skip: skipReason }, async (t) => {
	const gateway = await startGateway(t, { env: { THETA_COMPUTE_MAX_GPUS: "0" } });

	const refused = await gateway.callTool("submit_job", {
		run_name: "demo",
		directives: { gres: "gpu:1" },
	});
	assert.equal(refused.isError, true);
	assert.match(toolText(refused), /allows no GPUs in raw directives/);

	// A deployment with the GPU ceiling at zero still submits CPU jobs.
	const plain = await gateway.callTool("submit_job", {
		run_name: "demo",
		directives: { partition: "cpu" },
	});
	assert.equal(plain.isError, false);
	assert.equal(plain.structuredContent.job_id, "777001");

	const audit = await readAudit(gateway.auditLog);
	assert.deepEqual(audit.map((line) => line.decision), ["DENY", "ALLOW"]);
});

test("job_logs tails the run directory's own log files", { skip: skipReason }, async (t) => {
	const gateway = await startGateway(t);
	const logRun = path.join(gateway.stagingRoot, "logrun");
	await mkdir(logRun, { recursive: true });
	await writeFile(path.join(logRun, "slurm-424343.out"), "l1\nl2\nl3\nl4\nl5\n");
	await writeFile(path.join(logRun, "slurm-424343.err"), "e1\ne2\n");

	const found = await gateway.callTool("job_logs", { job_id: "424343", tail_lines: 3 });
	assert.equal(found.isError, false);
	assert.deepEqual(found.structuredContent, {
		found: true,
		job_id: "424343",
		stdout: "l3\nl4\nl5",
		stderr: "e1\ne2",
	});

	const missing = await gateway.callTool("job_logs", { job_id: "888777" });
	assert.equal(missing.isError, false);
	assert.deepEqual(missing.structuredContent, { found: false, job_id: "888777" });

	for (const tail_lines of [0, 1001, "100"]) {
		const result = await gateway.callTool("job_logs", { job_id: "424243", tail_lines });
		assert.equal(result.isError, true, `tail_lines ${tail_lines}: refused`);
		assert.match(toolText(result), /tail_lines/);
	}
	const malformed = await gateway.callTool("job_logs", { job_id: "42;rm" });
	assert.equal(malformed.isError, true);
	assert.match(toolText(malformed), /job id/);

	const audit = await readAudit(gateway.auditLog);
	assert.deepEqual(
		audit.map((line) => [line.tool, line.decision, line.job_id]),
		[
			["job_logs", "ALLOW", "424343"],
			["job_logs", "ALLOW", "888777"],
			...Array(3).fill(["job_logs", "DENY", "424243"]),
			["job_logs", "DENY", "42;rm"],
		],
	);
});

test("cancel_job cancels owned jobs and refuses what is not owned", { skip: skipReason }, async (t) => {
	const gateway = await startGateway(t);

	const owned = await gateway.callTool("cancel_job", { job_id: "424343" });
	assert.equal(owned.isError, false);
	assert.deepEqual(owned.structuredContent, {
		found: true,
		canceled: true,
		job_id: "424343",
		job_name: "theta-test-user-demo",
	});

	const foreign = await gateway.callTool("cancel_job", { job_id: "424242" });
	assert.equal(foreign.isError, true, "a job without the ownership prefix is refused");
	assert.match(toolText(foreign), /prefix/, "the refusal names the ownership rule");

	const gone = await gateway.callTool("cancel_job", { job_id: "999999" });
	assert.equal(gone.isError, false, "nothing to cancel is an answer, not an error");
	assert.deepEqual(gone.structuredContent, { found: false, canceled: false, job_id: "999999" });

	const failing = await gateway.callTool("cancel_job", { job_id: "666001" });
	assert.equal(failing.isError, true, "a scancel-side failure is an error");
	assert.match(toolText(failing), /scancel exited 1/);

	const malformed = await gateway.callTool("cancel_job", { job_id: "42;rm" });
	assert.equal(malformed.isError, true);
	assert.match(toolText(malformed), /job id/);

	// scancel ran only for the owned job and the one that failed at Slurm's
	// side — never for the foreign job or the malformed id.
	const calls = await readArgvCalls(gateway.argvLog);
	assert.deepEqual(
		calls.filter((call) => call.program === "scancel").map((call) => call.args),
		[["424343"], ["666001"]],
	);
	assert.equal(calls.filter((call) => call.program === "squeue").length, 4);

	const audit = await readAudit(gateway.auditLog);
	assert.deepEqual(
		audit.map((line) => [line.decision, line.job_id, line.reason]),
		[
			["ALLOW", "424343", null],
			["ALLOW", "424242", "tool error: job 424242 ('pep5-af3') does not carry this user's ownership prefix (theta-test-user-) — refusing to cancel a job the gateway does not own"],
			["ALLOW", "999999", null],
			["ALLOW", "666001", "tool error: scancel exited 1: scancel: error: Invalid job id specified"],
			["DENY", "42;rm", "invalid job id '42;rm': a v1 job id is digits only"],
		],
	);
});

test("fetch_artifacts returns the whole run or named picks, never partial", { skip: skipReason }, async (t) => {
	const gateway = await startGateway(t);
	const foldInput = '{"sequences": []}';
	const msa = ">seq\nAAA";
	await gateway.callTool("stage_files", {
		run_name: "pep5-inputs",
		files: [
			{ path: "fold_input.json", content_b64: b64(foldInput) },
			{ path: "data/msa.a3m", content_b64: b64(msa) },
		],
	});

	const whole = await gateway.callTool("fetch_artifacts", { run_name: "pep5-inputs" });
	assert.equal(whole.isError, false);
	assert.equal(whole.structuredContent.total_bytes, Buffer.byteLength(foldInput) + Buffer.byteLength(msa));
	assert.deepEqual(
		whole.structuredContent.files.map((file) => [file.path, file.size, unb64(file.content_b64)]),
		[
			["data/msa.a3m", Buffer.byteLength(msa), msa],
			["fold_input.json", Buffer.byteLength(foldInput), foldInput],
		],
	);

	const picks = await gateway.callTool("fetch_artifacts", {
		run_name: "pep5-inputs",
		paths: ["fold_input.json"],
	});
	assert.equal(picks.isError, false);
	assert.deepEqual(
		picks.structuredContent.files.map((file) => file.path),
		["fold_input.json"],
	);

	const missingPick = await gateway.callTool("fetch_artifacts", {
		run_name: "pep5-inputs",
		paths: ["nope.txt"],
	});
	assert.equal(missingPick.isError, true);
	assert.match(toolText(missingPick), /not a file/);

	const unknownRun = await gateway.callTool("fetch_artifacts", { run_name: "never-staged" });
	assert.equal(unknownRun.isError, true);
	assert.match(toolText(unknownRun), /does not exist/);

	const escape = await gateway.callTool("fetch_artifacts", {
		run_name: "pep5-inputs",
		paths: ["../outside"],
	});
	assert.equal(escape.isError, true);
	assert.match(toolText(escape), /staged path|run directory/);

	// The transfer is a filesystem read: no Slurm binary ran.
	assert.deepEqual(await readArgv(gateway.argvLog), []);

	const audit = await readAudit(gateway.auditLog);
	assert.deepEqual(
		audit.map((line) => line.decision),
		["ALLOW", "ALLOW", "ALLOW", "ALLOW", "ALLOW", "DENY"],
	);
});

test("fetch_artifacts over the cap names the out-of-band path, returning nothing", { skip: skipReason }, async (t) => {
	const gateway = await startGateway(t, { env: { THETA_COMPUTE_INBAND_MAX_BYTES: "4" } });
	const capRun = path.join(gateway.stagingRoot, "caprun");
	await mkdir(capRun, { recursive: true });
	await writeFile(path.join(capRun, "big.bin"), "0123456789");

	const result = await gateway.callTool("fetch_artifacts", { run_name: "caprun" });
	assert.equal(result.isError, true);
	const text = toolText(result);
	assert.match(text, /in-band cap of 4 bytes/, "the refusal names the cap");
	assert.ok(
		text.includes(`the run directory is ${capRun}/`),
		"the refusal names the out-of-band path",
	);
	assert.ok(!result.structuredContent, "an over-cap fetch answers nothing, never a partial list");

	const audit = await readAudit(gateway.auditLog);
	assert.equal(audit.length, 1);
	assert.equal(audit[0].decision, "ALLOW");
	assert.match(audit[0].reason, /in-band cap/);
});

test("fetch_artifacts refuses symlinks out of the staging root", { skip: skipReason }, async (t) => {
	const gateway = await startGateway(t);
	const symRun = path.join(gateway.stagingRoot, "symrun");
	await mkdir(symRun, { recursive: true });
	// A symlink aimed at a real file outside the staging root.
	await symlink(gateway.argvLog, path.join(symRun, "leak"));

	const result = await gateway.callTool("fetch_artifacts", { run_name: "symrun" });
	assert.equal(result.isError, true);
	assert.match(toolText(result), /symlink/, "the refusal names the symlink rule");

	const audit = await readAudit(gateway.auditLog);
	assert.equal(audit.length, 1);
	assert.equal(audit[0].decision, "ALLOW");
	assert.match(audit[0].reason, /symlink/);
});

test("the offline lifecycle: stage, submit, read the logs, fetch the artifacts", { skip: skipReason }, async (t) => {
	const gateway = await startGateway(t);

	const staged = await gateway.callTool("stage_files", {
		run_name: "demo",
		files: [{ path: "input.txt", content_b64: b64("theta staging payload") }],
	});
	assert.equal(staged.isError, false);

	const submitted = await gateway.callTool("submit_job", {
		run_name: "demo",
		directives: { partition: "cpu", time: "00:10:00" },
	});
	assert.equal(submitted.isError, false);
	const { job_id: jobId } = submitted.structuredContent;

	const logs = await gateway.callTool("job_logs", { job_id: jobId });
	assert.equal(logs.isError, false);
	assert.equal(logs.structuredContent.found, true);
	assert.match(logs.structuredContent.stdout, new RegExp(`stub sbatch ran job.sbatch \\(job ${jobId}\\)`));

	const fetched = await gateway.callTool("fetch_artifacts", { run_name: "demo" });
	assert.equal(fetched.isError, false);
	assert.deepEqual(
		fetched.structuredContent.files.map((file) => file.path),
		["input.txt", "job.sbatch", `slurm-${jobId}.out`],
		"the run directory holds the staged input, the rendered script, and the job's log",
	);

	const audit = await readAudit(gateway.auditLog);
	assert.deepEqual(
		audit.map((line) => [line.tool, line.decision, line.job_id, line.reason]),
		[
			["stage_files", "ALLOW", null, null],
			["submit_job", "ALLOW", jobId, null],
			["job_logs", "ALLOW", jobId, null],
			["fetch_artifacts", "ALLOW", null, null],
		],
	);
});
