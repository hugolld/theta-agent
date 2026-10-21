import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

// Offline tests for the theta-compute gateway (#51 tracer), driven at the
// MCP tool-call boundary: node:test speaks raw MCP streamable HTTP
// (initialize, session, tools/list, tools/call) to a FastMCP server
// spawned from gateway/, with stub Slurm binaries first on its PATH. What
// is asserted is external behavior only: JSON-RPC results over the wire,
// the HTTP status of unauthenticated calls, the audit JSONL on disk, and
// the argv the stubs actually received — never a Python helper. Contract
// basis: ADR 0004 and the gateway README's audit-line shape.

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
	return { baseUrl, auditLog, argvLog, request, callTool };
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

test("tools/list exposes exactly the two read-only tools", { skip: skipReason }, async (t) => {
	const gateway = await startGateway(t);

	const result = await gateway.request("tools/list", {});
	// The MCP wire format names annotation hints in camelCase.
	const listed = result.tools
		.map((tool) => ({ name: tool.name, read_only: tool.annotations?.readOnlyHint }))
		.sort((a, b) => a.name.localeCompare(b.name));
	assert.deepEqual(listed, [
		{ name: "job_status", read_only: true },
		{ name: "list_environments", read_only: true },
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
