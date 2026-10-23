import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The shared harness for the theta-compute gateway boundary tests: one
// gateway process in a scratch dir, spoken to over raw MCP streamable HTTP
// with the stub Slurm binaries first on its PATH. Extracted when the second
// test file (the typed tools) needed the same spawn/probe/read shape — the
// tree-wide helper rule.

export const gatewayDir = fileURLToPath(new URL("../../gateway", import.meta.url));
const stubBin = fileURLToPath(new URL("../fixtures/gateway/bin", import.meta.url));
export const TOKEN = "test-token-4f2a";

// The gateway runs from its locked uv environment (gateway/uv.lock). With
// no uv on PATH (unusual), skip rather than fail: CI installs uv.
const uvProbe = spawnSync("uv", ["--version"]);
export const skipReason = uvProbe.status === 0 ? false : "no uv found on PATH";

export const PROTOCOL_VERSION = "2025-06-18";
export const CLIENT_INFO = { name: "node-test", version: "0" };
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
export async function rpc(baseUrl, { method, params, id, token, sessionId }) {
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
export async function rpcMessages(response) {
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
export async function startGateway(t, { env = {} } = {}) {
	const scratch = await mkdtemp(path.join(tmpdir(), "theta-gateway-"));
	const auditLog = path.join(scratch, "audit.jsonl");
	const argvLog = path.join(scratch, "stub-argv.log");
	// The staging root is created and resolved before spawn: the gateway
	// sandbox-resolves every path it touches, and on macOS the temp dir
	// sits behind the /var -> /private/var symlink — asserted paths must
	// match the resolved form the gateway reports.
	await mkdir(path.join(scratch, "staging"), { recursive: true });
	const stagingRoot = await realpath(path.join(scratch, "staging"));
	const { child, port, stderr, kill } = await spawnGateway({
		env: {
			THETA_COMPUTE_AUDIT_LOG: auditLog,
			THETA_COMPUTE_STAGING_ROOT: stagingRoot,
			THETA_GATEWAY_STUB_ARGV: argvLog,
			...env,
		},
	});
	t.after(() => {
		kill();
		rm(scratch, { recursive: true, force: true });
	});

	const baseUrl = `http://127.0.0.1:${port}`;
	const deadline = Date.now() + READINESS_TIMEOUT_MS;
	let sessionId;
	for (;;) {
		if (child.exitCode !== null) {
			assert.fail(`gateway exited ${child.exitCode} before listening\n${stderr()}`);
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
			assert.fail(`gateway not ready within ${READINESS_TIMEOUT_MS}ms\n${stderr()}`);
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

// One gateway process: the env assembly, the detached spawn, and the
// teardown both start shapes share. Detached because uv runs python as
// its child — the whole group takes the kill signal together. The
// caller owns when kill() runs (its t.after, its ordering with scratch
// cleanup); stderr() reads what has accumulated so far.
function spawnGateway({ env = {} }) {
	return freePort().then((port) => {
		const child = spawn("uv", ["run", "--locked", "python", "-m", "theta_compute"], {
			cwd: gatewayDir,
			env: {
				...process.env,
				PATH: `${stubBin}:${process.env.PATH ?? ""}`,
				THETA_COMPUTE_TOKEN: TOKEN,
				THETA_COMPUTE_USER: "test-user",
				THETA_COMPUTE_HOST: "127.0.0.1",
				THETA_COMPUTE_PORT: String(port),
				...env,
			},
			stdio: ["ignore", "ignore", "pipe"],
			detached: true,
		});
		let captured = "";
		child.stderr.on("data", (chunk) => {
			captured += chunk;
		});
		const stderr = () => captured;
		const kill = () => {
			try {
				process.kill(-child.pid, "SIGTERM");
			} catch {
				child.kill("SIGTERM");
			}
		};
		return { child, port, stderr, kill };
	});
}

// A gateway expected to refuse to boot (a bad deploy env): resolves with
// its exit code and stderr once the process exits. The mirror of
// startGateway for the ConfigError path — nothing ever listens.
export function startGatewayExit(t, { env = {}, timeoutMs = 60_000 } = {}) {
	return new Promise((resolve, reject) => {
		spawnGateway({ env: { THETA_COMPUTE_AUDIT_LOG: "/dev/null", ...env } }).then(
			({ child, stderr, kill }) => {
				const timer = setTimeout(() => {
					kill();
					reject(new Error(`gateway did not exit within ${timeoutMs}ms\n${stderr()}`));
				}, timeoutMs);
				t.after(() => {
					clearTimeout(timer);
					kill();
				});
				child.on("exit", (code) => {
					clearTimeout(timer);
					resolve({ code, stderr: stderr() });
				});
			},
			reject,
		);
	});
}

// A file's non-empty lines; an absent file reads as no lines yet.
export async function readLines(file) {
	let raw;
	try {
		raw = await readFile(file, "utf8");
	} catch {
		return [];
	}
	return raw.split("\n").filter((line) => line !== "");
}

// The audit JSONL, parsed.
export const readAudit = async (auditLog) => (await readLines(auditLog)).map((line) => JSON.parse(line));

// The argv groups the stubs received: one NUL-separated group per line.
export const readArgv = async (argvLog) => (await readLines(argvLog)).map((line) => line.split("\0"));

// A tool result's text content, joined — the refusal and error messages.
export const toolText = (result) => result.content.map((part) => part.text).join("\n");

// Canonical JSON as the gateway digests it: sorted keys, no whitespace.
export function canonicalJson(value) {
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

export const argumentDigest = (args) =>
	`sha256:${createHash("sha256").update(JSON.stringify(canonicalJson(args)), "utf8").digest("hex")}`;

// In-band payloads cross the wire as base64 (#52).
export const b64 = (text) => Buffer.from(text, "utf8").toString("base64");
export const unb64 = (encoded) => Buffer.from(encoded, "base64").toString("utf8");

// The stub-argv log as {program, args} pairs — basename-checked so the
// resolved stub path never matters.
export async function readArgvCalls(argvLog) {
	const groups = await readArgv(argvLog);
	return groups.map(([program, ...args]) => ({ program: path.basename(program), args }));
}

// A path exists on disk.
export async function exists(file) {
	try {
		await stat(file);
		return true;
	} catch {
		return false;
	}
}

// Every audit line's fixed fields, checked apart from the timestamp,
// which must merely be a UTC second-resolution ISO instant.
export function assertAuditLine(line, expected) {
	const { ts, ...rest } = line;
	assert.match(ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/, "ts is a UTC ISO instant");
	assert.deepEqual(rest, expected);
}
