import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
	CLIENT_INFO,
	HELD_REASON,
	PROTOCOL_VERSION,
	assertAuditLine,
	argumentDigest,
	b64,
	exists,
	readArgv,
	readArgvCalls,
	readAudit,
	rpc,
	skipReason,
	startGateway,
	startGatewayExit,
	toolText,
	throttledReason,
	unb64,
} from "./helpers/gateway.mjs";

// Offline tests for the theta-compute gateway's seven generic tools (#51
// tracer, #52), driven at the MCP tool-call boundary against the stub Slurm
// binaries. The shared harness (spawn, probe, audit and argv readers) lives
// in helpers/gateway.mjs; the typed-tool tests in gateway-templates.test.mjs
// use it too. What is asserted is external behavior only — never a Python
// helper. Contract basis: ADR 0004 and the gateway README's audit-line shape.

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
		submit_capability: "on",
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
		submit_capability: "on",
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

test("while the submit capability is off, job-creating calls hold with their own line and nothing runs", { skip: skipReason }, async (t) => {
	const gateway = await startGateway(t, { env: { THETA_COMPUTE_SUBMIT_CAPABILITY: "off" } });

	// The held tool stays listed: the hold is a call-time refusal, not a
	// vanishing surface.
	const listed = await gateway.request("tools/list", {});
	assert.ok(listed.tools.some((tool) => tool.name === "submit_job"), "submit_job stays advertised");

	const args = { run_name: "demo", directives: { partition: "cpu" } };
	const held = await gateway.callTool("submit_job", args);
	assert.equal(held.isError, true);
	const text = toolText(held);
	assert.match(text, /the submit capability is off/, "the refusal names the hold");
	assert.match(text, /out-of-band/, "the refusal names the enable channel");

	// The hold is pre-dispatch: no run directory, no subprocess.
	assert.equal(await exists(path.join(gateway.stagingRoot, "demo")), false, "no run directory written");
	assert.deepEqual(await readArgv(gateway.argvLog), []);

	const audit = await readAudit(gateway.auditLog);
	assert.equal(audit.length, 1);
	assertAuditLine(audit[0], {
		user: "test-user",
		tool: "submit_job",
		args_sha256: argumentDigest(args),
		decision: "HOLD",
		job_id: null,
		reason: HELD_REASON,
		submit_capability: "off",
	});

	// The capability is the outer bound: a call the guard would also
	// refuse answers the hold — one call, one line, the outer one wins.
	const alsoBad = await gateway.callTool("submit_job", { run_name: "demo", directives: { partition: "gpu" } });
	assert.equal(alsoBad.isError, true);
	assert.match(toolText(alsoBad), /the submit capability is off/);
	const auditAfter = await readAudit(gateway.auditLog);
	assert.equal(auditAfter.length, 2);
	assert.equal(auditAfter[1].decision, "HOLD", "the hold outranks the guard refusal");
});

test("during a hold, cancel and the read-only tools stay in service", { skip: skipReason }, async (t) => {
	const gateway = await startGateway(t, { env: { THETA_COMPUTE_SUBMIT_CAPABILITY: "off" } });

	const status = await gateway.callTool("job_status", { job_id: "424242" });
	assert.equal(status.isError, false);

	const cancel = await gateway.callTool("cancel_job", { job_id: "424343" });
	assert.equal(cancel.isError, false);
	assert.deepEqual(cancel.structuredContent, {
		found: true,
		canceled: true,
		job_id: "424343",
		job_name: "theta-test-user-demo",
	});

	// scancel ran: cancelling remediates a runaway, so it stays available.
	const calls = await readArgvCalls(gateway.argvLog);
	assert.deepEqual(
		calls.filter((call) => call.program === "scancel").map((call) => call.args),
		[["424343"]],
	);

	const audit = await readAudit(gateway.auditLog);
	assert.equal(audit.length, 2);
	// The read-only line omits the capability field; the cancel line —
	// mutating — carries the observed off state on its ALLOW.
	assert.equal("submit_capability" in audit[0], false, "job_status carries no capability field");
	assert.equal(audit[1].tool, "cancel_job");
	assert.equal(audit[1].decision, "ALLOW");
	assert.equal(audit[1].submit_capability, "off", "the cancel ALLOW observes the hold");
});

test("the off state is the deploy env's, not the process's: a restart still holds", { skip: skipReason }, async (t) => {
	const off = { THETA_COMPUTE_SUBMIT_CAPABILITY: "off" };
	const first = await startGateway(t, { env: off });
	const heldOnce = await first.callTool("submit_job", { run_name: "demo", directives: {} });
	assert.equal(heldOnce.isError, true);

	// A second process from the same env holds too — the state survives
	// the restart by construction because it never lived in memory.
	const second = await startGateway(t, { env: off });
	const heldTwice = await second.callTool("submit_job", { run_name: "demo", directives: {} });
	assert.equal(heldTwice.isError, true);
	assert.match(toolText(heldTwice), /the submit capability is off/);
	assert.equal((await readAudit(second.auditLog))[0].decision, "HOLD");
});

test("an explicit on submits like the default and the line observes it", { skip: skipReason }, async (t) => {
	const gateway = await startGateway(t, { env: { THETA_COMPUTE_SUBMIT_CAPABILITY: "on" } });
	const args = { run_name: "demo", directives: { partition: "cpu" } };

	const result = await gateway.callTool("submit_job", args);
	assert.equal(result.isError, false);
	assert.equal(result.structuredContent.job_id, "777001");

	const audit = await readAudit(gateway.auditLog);
	assert.equal(audit.length, 1);
	assertAuditLine(audit[0], {
		user: "test-user",
		tool: "submit_job",
		args_sha256: argumentDigest(args),
		decision: "ALLOW",
		job_id: "777001",
		reason: null,
		submit_capability: "on",
	});
});

test("a submit capability that is neither on nor off refuses to boot", { skip: skipReason }, async (t) => {
	const { code, stderr } = await startGatewayExit(t, {
		env: { THETA_COMPUTE_SUBMIT_CAPABILITY: "banana" },
	});
	assert.equal(code, 1);
	assert.match(stderr, /THETA_COMPUTE_SUBMIT_CAPABILITY='banana' is not 'on' or 'off'/);
});

// One ALLOW submit line in the byte shape the gateway itself writes — for
// pre-seeding a caller-owned audit log: the ceiling derives from the log,
// so lines on disk before any call count like lived ones (#94).
const submitLine = ({ user = "test-user", tool = "submit_job", ageSeconds = 0 } = {}) =>
	JSON.stringify({
		ts: new Date(Date.now() - ageSeconds * 1000).toISOString().replace(/\.\d+Z$/, "Z"),
		user,
		tool,
		args_sha256: `sha256:${"0".repeat(64)}`,
		decision: "ALLOW",
		job_id: "777001",
		reason: null,
	});

// A scratch audit log the test owns, shared with the gateway via the
// THETA_COMPUTE_AUDIT_LOG env override — the ceiling tests' seam for
// lines that predate the process.
const sharedAuditLog = async (t) => {
	const scratch = await mkdtemp(path.join(tmpdir(), "theta-ceiling-"));
	const auditLog = path.join(scratch, "audit.jsonl");
	t.after(() => rm(scratch, { recursive: true, force: true }));
	return auditLog;
};

test("past the submit ceiling the next job-creating call throttles with its own line", { skip: skipReason }, async (t) => {
	const gateway = await startGateway(t, { env: { THETA_COMPUTE_SUBMIT_CEILING: "3" } });

	// Under and at the ceiling: three submits spend the budget.
	for (let i = 0; i < 3; i += 1) {
		const result = await gateway.callTool("submit_job", {
			run_name: `run-${i}`,
			directives: { partition: "cpu" },
		});
		assert.equal(result.isError, false, `submit ${i + 1} of 3: allowed`);
	}

	// Over: the fourth answers the throttle.
	const args = { run_name: "run-3", directives: { partition: "cpu" } };
	const throttled = await gateway.callTool("submit_job", args);
	assert.equal(throttled.isError, true);
	const text = toolText(throttled);
	assert.match(text, /the submit ceiling is reached/);
	assert.match(text, /principal test-user/, "the refusal names the principal");
	assert.match(text, /3 submit\(s\)/, "the refusal names the observed count");
	assert.match(text, /3600-second window/, "the refusal names the window");
	assert.equal(text, throttledReason("test-user", 3, 3, 3600), "the refusal's words are the message's");

	// The throttle is pre-dispatch: no fourth sbatch, nothing written.
	const calls = await readArgvCalls(gateway.argvLog);
	assert.deepEqual(calls.map((call) => call.program), ["sbatch", "sbatch", "sbatch"]);
	assert.equal(
		await exists(path.join(gateway.stagingRoot, "run-3")),
		false,
		"nothing written for the throttled call",
	);

	// Cancel and the read-only tools neither spend nor face the ceiling.
	const status = await gateway.callTool("job_status", { job_id: "424242" });
	assert.equal(status.isError, false, "read-only tools stay in service past the ceiling");
	const cancel = await gateway.callTool("cancel_job", { job_id: "424343" });
	assert.equal(cancel.isError, false, "cancel stays in service past the ceiling");

	const audit = await readAudit(gateway.auditLog);
	assert.deepEqual(audit.map((line) => line.decision), [
		"ALLOW",
		"ALLOW",
		"ALLOW",
		"THROTTLE",
		"ALLOW",
		"ALLOW",
	]);
	assertAuditLine(audit[3], {
		user: "test-user",
		tool: "submit_job",
		args_sha256: argumentDigest(args),
		decision: "THROTTLE",
		job_id: null,
		reason: throttledReason("test-user", 3, 3, 3600),
		submit_capability: "on",
		submit_count: 3,
		submit_window_seconds: 3600,
	});
});

test("the ceiling's count is the audit log's: a restart still throttles", { skip: skipReason }, async (t) => {
	const auditLog = await sharedAuditLog(t);
	const env = { THETA_COMPUTE_SUBMIT_CEILING: "2", THETA_COMPUTE_AUDIT_LOG: auditLog };

	const first = await startGateway(t, { env });
	for (let i = 0; i < 2; i += 1) {
		const result = await first.callTool("submit_job", { run_name: `run-${i}`, directives: {} });
		assert.equal(result.isError, false);
	}

	// A second process from the same deploy: the two ALLOW lines on disk
	// are the count — no submit state lived in the first process.
	const second = await startGateway(t, { env });
	const throttled = await second.callTool("submit_job", { run_name: "run-2", directives: {} });
	assert.equal(throttled.isError, true);
	assert.match(toolText(throttled), /the submit ceiling is reached/);
	const audit = await readAudit(auditLog);
	assert.deepEqual(audit.map((line) => line.decision), ["ALLOW", "ALLOW", "THROTTLE"]);
	assert.equal(audit[2].submit_count, 2);
});

test("the derived count is per-principal: another user's submits do not spend this budget", { skip: skipReason }, async (t) => {
	const auditLog = await sharedAuditLog(t);
	// Five in-window submits by another principal: none of them count.
	await writeFile(auditLog, `${Array.from({ length: 5 }, () => submitLine({ user: "someone-else" })).join("\n")}\n`);

	const gateway = await startGateway(t, {
		env: { THETA_COMPUTE_SUBMIT_CEILING: "2", THETA_COMPUTE_AUDIT_LOG: auditLog },
	});
	for (let i = 0; i < 2; i += 1) {
		const result = await gateway.callTool("submit_job", { run_name: `own-${i}`, directives: {} });
		assert.equal(result.isError, false, `own submit ${i + 1}: another principal spent nothing of this budget`);
	}
	const throttled = await gateway.callTool("submit_job", { run_name: "own-2", directives: {} });
	assert.equal(throttled.isError, true);
	const audit = await readAudit(auditLog);
	const throttleLine = audit.at(-1);
	assert.equal(throttleLine.decision, "THROTTLE");
	assert.equal(throttleLine.user, "test-user");
	assert.equal(throttleLine.submit_count, 2, "only this principal's submits counted");
});

test("submits outside the rolling window do not count", { skip: skipReason }, async (t) => {
	const auditLog = await sharedAuditLog(t);
	// Two submits two hours old: outside the 3600-second window.
	await writeFile(auditLog, `${[submitLine({ ageSeconds: 7200 }), submitLine({ ageSeconds: 7200 })].join("\n")}\n`);

	const gateway = await startGateway(t, {
		env: { THETA_COMPUTE_SUBMIT_CEILING: "2", THETA_COMPUTE_AUDIT_LOG: auditLog },
	});
	// The budget is intact: the window's own submits spend it fresh.
	for (let i = 0; i < 2; i += 1) {
		const result = await gateway.callTool("submit_job", { run_name: `fresh-${i}`, directives: {} });
		assert.equal(result.isError, false, `fresh submit ${i + 1}: the old submits did not count`);
	}
	const throttled = await gateway.callTool("submit_job", { run_name: "fresh-2", directives: {} });
	assert.equal(throttled.isError, true);
	const audit = await readAudit(auditLog);
	assert.equal(audit.at(-1).submit_count, 2, "the count is this window's submits only");
});

test("a call past the ceiling under a hold answers the hold — one call, one line", { skip: skipReason }, async (t) => {
	const auditLog = await sharedAuditLog(t);
	// The budget is already spent and the capability is off: both bounds
	// fail this call, and the capability — the outer one — answers.
	await writeFile(auditLog, `${[submitLine(), submitLine()].join("\n")}\n`);
	const gateway = await startGateway(t, {
		env: {
			THETA_COMPUTE_SUBMIT_CAPABILITY: "off",
			THETA_COMPUTE_SUBMIT_CEILING: "2",
			THETA_COMPUTE_AUDIT_LOG: auditLog,
		},
	});

	const held = await gateway.callTool("submit_job", { run_name: "demo", directives: {} });
	assert.equal(held.isError, true);
	assert.match(toolText(held), /the submit capability is off/, "the hold answered, not the throttle");

	const audit = await readAudit(auditLog);
	assert.equal(audit.length, 3, "one line for the call");
	assertAuditLine(audit[2], {
		user: "test-user",
		tool: "submit_job",
		args_sha256: argumentDigest({ run_name: "demo", directives: {} }),
		decision: "HOLD",
		job_id: null,
		reason: HELD_REASON,
		submit_capability: "off",
	});
	assert.equal("submit_count" in audit[2], false, "the hold line carries no ceiling fields");
});

test("a submit ceiling below one refuses to boot", { skip: skipReason }, async (t) => {
	const { code, stderr } = await startGatewayExit(t, { env: { THETA_COMPUTE_SUBMIT_CEILING: "0" } });
	assert.equal(code, 1);
	assert.match(stderr, /THETA_COMPUTE_SUBMIT_CEILING='0' must be 1 or greater/);
});

test("the middleware's mutating and job-creating sets track tools/list's hints", { skip: skipReason }, async (t) => {
	const gateway = await startGateway(t);

	// The Python sets cannot read the annotations at call time (the
	// middleware context carries no app reference), so this test is the
	// coupling that keeps them from drifting: every listed non-read-only
	// tool is in MUTATING_TOOLS, and the hold set holds the job creators.
	const source = await readFile(new URL("../gateway/theta_compute/server.py", import.meta.url), "utf8");
	const setOf = (name) => {
		const found = source.match(new RegExp(`${name} = frozenset\\(\\{([^}]*)\\}\\)`));
		assert.ok(found, `${name} is a frozenset literal in server.py`);
		return new Set([...found[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]));
	};
	const mutating = setOf("MUTATING_TOOLS");
	const jobCreating = setOf("JOB_CREATING_TOOLS");

	const result = await gateway.request("tools/list", {});
	for (const tool of result.tools) {
		const mutatingListed = tool.annotations?.readOnlyHint !== true;
		assert.equal(
			mutating.has(tool.name),
			mutatingListed,
			`${tool.name}: ${mutatingListed ? "carries" : "omits"} submit_capability per its read-only hint`,
		);
	}
	// The hold set is the job creators only: cancel remediates, staging
	// spends nothing.
	assert.equal(jobCreating.has("submit_job"), true);
	assert.equal(jobCreating.has("run_alphafold3"), true);
	assert.equal(jobCreating.has("cancel_job"), false);
	for (const name of jobCreating) {
		assert.ok(mutating.has(name), `${name} creates jobs but is not in the mutating set`);
	}
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
	// Cancel is a mutating tool: every one of its lines, whatever the
	// decision, carries the observed submit capability.
	assert.ok(
		audit.every((line) => line.submit_capability === "on"),
		"cancel lines carry the observed capability",
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
