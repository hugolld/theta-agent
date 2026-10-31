import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createJiti } from "jiti";

// The submit gate is the package's tool-call-pipeline permission extension
// (spec #54, ADR 0004), grown into the stacked gate framework by spec #95
// (ADR 0006's client-side instance). The test drives the extension's real
// handler — loaded through jiti, the same loader pi runs extensions with —
// with a stub confirm on the handler context, an injectable gate-log sink,
// and a stub getAllTools mirroring the gateway server's shipped tool
// annotations. Stacked confirms are exercised with interleaved calls (the
// pi 1.4.0 concurrent-dialog case), nested codemode context with
// parentToolCallId-bearing events.
const jiti = createJiti(import.meta.url);
const { createSubmitGate, CONFIRM_SET, GATE_LOG_NAME, GATEWAY_PREFIX, default: registerSubmitGate } =
	await jiti.import("../extensions/submit-gate.ts");

// pi sanitizes registered MCP tool names: every character outside
// [A-Za-z0-9_] becomes `_` (pi's createMcpToolName), so the server's
// hyphen lands as an underscore — the stub must spell the names the way
// pi actually registers them, or it mirrors a bug instead of the contract.
const SERVER = "mcp__theta_compute__";

// The annotations the gateway server declares today (gateway/server.py):
// the four read-only tools, the one transfer tool that is neither
// (stage_files), and the three destructive ones the gate confirms.
const gatewayTool = (name, annotations) => ({
	name: `${SERVER}${name}`,
	annotations,
});
const TOOL_INFOS = [
	gatewayTool("list_environments", { readOnlyHint: true, openWorldHint: false }),
	gatewayTool("job_status", { readOnlyHint: true, openWorldHint: false }),
	gatewayTool("stage_files", { readOnlyHint: false, openWorldHint: false }),
	gatewayTool("submit_job", { readOnlyHint: false, destructiveHint: true, openWorldHint: false }),
	gatewayTool("job_logs", { readOnlyHint: true, openWorldHint: false }),
	gatewayTool("cancel_job", { readOnlyHint: false, destructiveHint: true, openWorldHint: false }),
	gatewayTool("fetch_artifacts", { readOnlyHint: true, openWorldHint: false }),
	gatewayTool("run_alphafold3", { readOnlyHint: false, destructiveHint: true, openWorldHint: false }),
];

// A stub handler context whose confirm records its arguments and answers
// with the test's scripted boolean. The sessionManager is absent unless a
// test supplies one — the gate log's default sink must tolerate that (an
// in-memory context logs nowhere), which is also the stub's job to pin.
function stubContext(answer, sessionManager) {
	const calls = [];
	return {
		calls,
		ui: {
			confirm: async (...args) => {
				calls.push(args);
				return answer;
			},
		},
		...(sessionManager !== undefined ? { sessionManager } : {}),
	};
}

const makeEvent = (toolName, input = {}, parentToolCallId) => ({
	type: "tool_call",
	toolCallId: "t1",
	...(parentToolCallId !== undefined ? { parentToolCallId } : {}),
	toolName,
	input,
});

const escapeRegExp = (core) => core.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const makeGate = () => createSubmitGate({ getAllTools: () => TOOL_INFOS });

// The S4 retro's pin: the gate's prefix must match the tool names pi
// actually registers. The stub above spells the sanitized form by hand —
// this test compares it against pi's own createMcpToolName, so a prefix
// edited wrong (the #74 review bug: a hyphen where pi registers an
// underscore) or a pi sanitization change goes red here instead of
// shipping an inert gate. The deep module is not a root export of
// pi-coding-agent; the resolved path rides the installed tree the suite
// already tests against.
test("the gate's prefix matches the names pi registers for the server", async () => {
	const indexUrl = import.meta.resolve("@earendil-works/pi-coding-agent");
	const toolsJs = pathToFileURL(
		path.join(path.dirname(fileURLToPath(indexUrl)), "extensions", "mcp", "tools.js"),
	);
	const { createMcpToolName } = await import(toolsJs);
	for (const tool of ["submit_job", "cancel_job", "run_alphafold3", "job_status"]) {
		const registered = createMcpToolName("theta-compute", tool);
		assert.ok(
			registered.startsWith(GATEWAY_PREFIX),
			`${registered} does not carry the gate's prefix ${GATEWAY_PREFIX}`,
		);
	}
});

test("ungated gateway calls pass through without touching the confirm", async () => {
	const gate = makeGate();
	// Read-only tools, plus stage_files — neither read-only nor destructive,
	// still ungated: only the destructive hint confirms.
	for (const name of ["job_status", "job_logs", "list_environments", "stage_files", "fetch_artifacts"]) {
		const ctx = stubContext(false);
		const result = await gate(makeEvent(`${SERVER}${name}`), ctx);
		assert.equal(result, undefined, `${name} should pass through`);
		assert.deepEqual(ctx.calls, [], `${name} must not prompt`);
	}
});

test("every destructive gateway call prompts, and approval passes it through", async () => {
	const gate = makeGate();
	for (const [name, input] of [
		["submit_job", { run_name: "af3-run-1" }],
		["cancel_job", { job_id: "1851277" }],
		["run_alphafold3", { run_name: "af3-run-2", fold_input: {} }],
	]) {
		const ctx = stubContext(true);
		const result = await gate(makeEvent(`${SERVER}${name}`, input), ctx);
		assert.equal(result, undefined, `${name} approved should pass through`);
		assert.equal(ctx.calls.length, 1, `${name} must prompt exactly once`);
		const [title, message] = ctx.calls[0];
		assert.equal(typeof title, "string");
		assert.match(message, new RegExp(escapeRegExp(name)));
	}
});

test("a refused destructive call is blocked with a reason naming the gate", async () => {
	const gate = makeGate();
	for (const name of ["submit_job", "cancel_job", "run_alphafold3"]) {
		const ctx = stubContext(false);
		const result = await gate(makeEvent(`${SERVER}${name}`), ctx);
		assert.deepEqual(Object.keys(result ?? {}).sort(), ["block", "reason"]);
		assert.equal(result.block, true, `${name} refused must be blocked`);
		assert.match(result.reason, /submit gate/);
		assert.match(result.reason, new RegExp(escapeRegExp(name)));
	}
});

test("the confirm message carries the call's target", async () => {
	const gate = makeGate();
	const ctx = stubContext(true);
	await gate(makeEvent(`${SERVER}submit_job`, { run_name: "af3-run-1" }), ctx);
	assert.match(ctx.calls[0][1], /af3-run-1/);
	const ctx2 = stubContext(true);
	await gate(makeEvent(`${SERVER}cancel_job`, { job_id: "1851277" }), ctx2);
	assert.match(ctx2.calls[0][1], /1851277/);
});

test("every non-gateway call passes through ungated", async () => {
	const gate = makeGate();
	for (const toolName of [
		"bash",
		"write",
		"mcp__other_server__submit_job",
		`${SERVER}not_a_registered_tool`,
	]) {
		const ctx = stubContext(false);
		const result = await gate(makeEvent(toolName), ctx);
		assert.equal(result, undefined, `${toolName} is not the gateway's to gate`);
		assert.deepEqual(ctx.calls, [], `${toolName} must not prompt`);
	}
});

// ---------------------------------------------------------------------------
// Gate framework (spec #95): the confirm set made literal and pinned to
// the server's annotations, drift refusals, nested-call attribution, the
// gate log, and stacked confirms under interleaving.

test("the confirm set is the literal three-tool set the server declares destructive", () => {
	assert.deepEqual([...CONFIRM_SET].sort(), ["cancel_job", "run_alphafold3", "submit_job"]);
	// The stub above mirrors the shipped annotations; the drift check pins
	// the two together at call time — this pins them in the suite, so a
	// change on either side crosses this line before it ships.
	for (const tool of TOOL_INFOS) {
		const short = tool.name.slice(SERVER.length);
		assert.equal(
			CONFIRM_SET.has(short),
			tool.annotations?.destructiveHint === true,
			`${short}: the confirm set and the destructive annotations must agree`,
		);
	}
});

test("a call where the confirm set and the annotations disagree is refused as drift, without a dialog", async () => {
	const gate = createSubmitGate({
		getAllTools: () => [
			// in the set, no longer declared destructive
			gatewayTool("submit_job", { readOnlyHint: false, openWorldHint: false }),
			// declared destructive, not in the set
			gatewayTool("drop_cache", { readOnlyHint: false, destructiveHint: true, openWorldHint: false }),
		],
	});
	for (const [name, phrase] of [
		["submit_job", "the confirm set names it"],
		["drop_cache", "the confirm set does not name it"],
	]) {
		const ctx = stubContext(true); // approval is irrelevant: no dialog opens
		const result = await gate(makeEvent(`${SERVER}${name}`), ctx);
		assert.equal(result.block, true, `${name} must drift-block`);
		assert.match(result.reason, /drifted/);
		assert.match(result.reason, new RegExp(escapeRegExp(phrase)));
		assert.deepEqual(ctx.calls, [], `${name} must not prompt on drift`);
	}
});

test("a nested call carries its parent into the prompt, the refusal, and the gate log", async () => {
	const lines = [];
	const gate = createSubmitGate({ getAllTools: () => TOOL_INFOS }, { log: (l) => lines.push(l) });
	const nestedEvent = makeEvent(
		`${SERVER}submit_job`,
		{ run_name: "af3-nested" },
		"call_codemode_1",
	);
	// pi assigns a nested call's own id as `<parent id>/<n>`
	nestedEvent.toolCallId = "call_codemode_1/2";

	const ctx = stubContext(false);
	const result = await gate(nestedEvent, ctx);
	assert.match(ctx.calls[0][1], /parent call call_codemode_1/);
	assert.match(result.reason, /\(nested under tool call call_codemode_1\)/);
	assert.match(result.reason, /af3-nested/);
	assert.equal(lines.length, 1);
	assert.equal(lines[0].parentToolCallId, "call_codemode_1");
	assert.equal(lines[0].toolCallId, "call_codemode_1/2");
	assert.equal(lines[0].decision, "refused");

	// the approved path logs the parent the same way
	const approved = await gate(nestedEvent, stubContext(true));
	assert.equal(approved, undefined);
	assert.equal(lines.length, 2);
	assert.equal(lines[1].decision, "approved");
	assert.equal(lines[1].parentToolCallId, "call_codemode_1");
	// a direct call logs no parent
	await gate(makeEvent(`${SERVER}submit_job`, { run_name: "direct" }), stubContext(true));
	assert.equal(lines.length, 3);
	assert.equal(lines[2].parentToolCallId, undefined);
});

test("gate log lines carry the decision vocabulary and only the fields that apply", async () => {
	const lines = [];
	const gate = createSubmitGate({ getAllTools: () => TOOL_INFOS }, { log: (l) => lines.push(l) });
	await gate(makeEvent(`${SERVER}submit_job`, { run_name: "r" }), stubContext(true)); // approved
	await gate(makeEvent(`${SERVER}cancel_job`, { job_id: "1851277" }), stubContext(false)); // refused
	const drifted = createSubmitGate(
		{ getAllTools: () => [gatewayTool("submit_job", { readOnlyHint: false, openWorldHint: false })] },
		{ log: (l) => lines.push(l) },
	);
	await drifted(makeEvent(`${SERVER}submit_job`), stubContext(true)); // drift
	assert.deepEqual(
		lines.map((l) => l.decision),
		["approved", "refused", "drift"],
	);
	for (const line of lines) {
		assert.equal(typeof line.ts, "string");
		assert.match(line.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
		assert.ok(line.tool.startsWith(SERVER));
		assert.equal(typeof line.check, "string");
	}
	// approved settles without a reason; refusals name theirs
	assert.equal(lines[0].reason, undefined);
	assert.match(lines[1].reason, /refused by the submit gate/);
	assert.match(lines[2].reason, /drifted/);
});

test("stacked confirms resolve to their own calls under interleaving", async () => {
	const lines = [];
	const gate = createSubmitGate({ getAllTools: () => TOOL_INFOS }, { log: (l) => lines.push(l) });
	// Two confirms whose resolutions the test orders: the second call's
	// dialog settles first while the first's stays pending — the stacked
	// case pi 1.4.0's concurrent-dialog fix made sound.
	const pending = [];
	const ctx = {
		ui: {
			confirm: (_title, message) =>
				new Promise((resolve) => {
					pending.push({ message, resolve });
				}),
		},
	};
	const event = (id, toolName, input) => ({ type: "tool_call", toolCallId: id, toolName, input });
	const a = gate(event("call_a", `${SERVER}submit_job`, { run_name: "run-a" }), ctx);
	const b = gate(event("call_b", `${SERVER}run_alphafold3`, { run_name: "run-b" }), ctx);
	await new Promise((resolve) => setImmediate(resolve)); // both dialogs open
	assert.equal(pending.length, 2);
	assert.match(pending[0].message, /run-a/);
	assert.match(pending[1].message, /run-b/);
	pending[1].resolve(true); // approve the second call first
	assert.equal(await b, undefined);
	pending[0].resolve(false); // then refuse the first
	const refusal = await a;
	assert.equal(refusal.block, true);
	assert.match(refusal.reason, /run-a/);
	// each decision logged its own call, in completion order
	assert.deepEqual(
		lines.map((l) => [l.toolCallId, l.decision]),
		[
			["call_b", "approved"],
			["call_a", "refused"],
		],
	);
});

test("the default log sink appends beside the session transcript, and a missing session logs nowhere", async (t) => {
	const sd = fs.mkdtempSync(path.join(os.tmpdir(), "gate-log-"));
	t.after(() => fs.rmSync(sd, { recursive: true, force: true }));
	const sessionManager = { getSessionFile: () => path.join(sd, "session.jsonl") };
	const gate = createSubmitGate({ getAllTools: () => TOOL_INFOS });
	await gate(makeEvent(`${SERVER}submit_job`, { run_name: "r1" }), stubContext(true, sessionManager));
	await gate(makeEvent(`${SERVER}submit_job`, { run_name: "r2" }), stubContext(false, sessionManager));
	// one intact JSONL line per decision, beside the transcript
	const logged = fs
		.readFileSync(path.join(sd, GATE_LOG_NAME), "utf8")
		.trim()
		.split("\n")
		.map((l) => JSON.parse(l));
	assert.deepEqual(
		logged.map((l) => l.decision),
		["approved", "refused"],
	);
	// no session file and a throwing manager both leave the decision unchanged
	const noFile = stubContext(true, { getSessionFile: () => undefined });
	assert.equal(await gate(makeEvent(`${SERVER}submit_job`, { run_name: "r3" }), noFile), undefined);
	const broken = stubContext(false, { getSessionFile: () => { throw new Error("gone"); } });
	assert.equal((await gate(makeEvent(`${SERVER}submit_job`, { run_name: "r4" }), broken)).block, true);
	assert.equal(fs.readFileSync(path.join(sd, GATE_LOG_NAME), "utf8").trim().split("\n").length, 2);
});

test("the default export registers the gate as the tool_call handler", async () => {
	const registered = [];
	const pi = {
		getAllTools: () => TOOL_INFOS,
		on: (event, handler) => {
			registered.push([event, handler]);
		},
	};
	registerSubmitGate(pi);
	assert.deepEqual(registered.map(([event]) => event), ["tool_call"]);
	const [, handler] = registered[0];
	const ctx = stubContext(false);
	const result = await handler(makeEvent(`${SERVER}submit_job`), ctx);
	assert.equal(result.block, true);
});
