import assert from "node:assert/strict";
import { test } from "node:test";
import { createJiti } from "jiti";

// The submit gate is the package's first tool-call-pipeline extension (spec
// #54, ADR 0004). The test drives the extension's real handler — loaded
// through jiti, the same loader pi runs extensions with — with a stub
// confirm on the handler context and a stub getAllTools mirroring the
// gateway server's shipped tool annotations.
const jiti = createJiti(import.meta.url);
const { createSubmitGate, default: registerSubmitGate } = await jiti.import(
	"../extensions/submit-gate.ts",
);

const SERVER = "mcp__theta-compute__";

// The annotations the gateway server declares today (gateway/server.py);
// the four read-only tools, the two transfer tools that are neither, and
// the three destructive ones the gate confirms.
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
// with the test's scripted boolean.
function stubContext(answer) {
	const calls = [];
	return {
		calls,
		ui: {
			confirm: async (...args) => {
				calls.push(args);
				return answer;
			},
		},
	};
}

const makeGate = () => createSubmitGate({ getAllTools: () => TOOL_INFOS });

test("ungated gateway calls pass through without touching the confirm", async () => {
	const gate = makeGate();
	// Read-only tools, plus stage_files — neither read-only nor destructive,
	// still ungated: only the destructive hint confirms.
	for (const name of ["job_status", "job_logs", "list_environments", "stage_files", "fetch_artifacts"]) {
		const ctx = stubContext(false);
		const result = await gate({ type: "tool_call", toolCallId: "t1", toolName: `${SERVER}${name}`, input: {} }, ctx);
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
		const result = await gate({ type: "tool_call", toolCallId: "t1", toolName: `${SERVER}${name}`, input }, ctx);
		assert.equal(result, undefined, `${name} approved should pass through`);
		assert.equal(ctx.calls.length, 1, `${name} must prompt exactly once`);
		const [title, message] = ctx.calls[0];
		assert.equal(typeof title, "string");
		assert.match(message, new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	}
});

test("a refused destructive call is blocked with a reason naming the gate", async () => {
	const gate = makeGate();
	for (const name of ["submit_job", "cancel_job", "run_alphafold3"]) {
		const ctx = stubContext(false);
		const result = await gate(
			{ type: "tool_call", toolCallId: "t1", toolName: `${SERVER}${name}`, input: {} },
			ctx,
		);
		assert.deepEqual(Object.keys(result ?? {}).sort(), ["block", "reason"]);
		assert.equal(result.block, true, `${name} refused must be blocked`);
		assert.match(result.reason, /submit gate/);
		assert.match(result.reason, new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	}
});

test("the confirm message carries the call's target", async () => {
	const gate = makeGate();
	const ctx = stubContext(true);
	await gate(
		{ type: "tool_call", toolCallId: "t1", toolName: `${SERVER}submit_job`, input: { run_name: "af3-run-1" } },
		ctx,
	);
	assert.match(ctx.calls[0][1], /af3-run-1/);
	const ctx2 = stubContext(true);
	await gate(
		{ type: "tool_call", toolCallId: "t2", toolName: `${SERVER}cancel_job`, input: { job_id: "1851277" } },
		ctx2,
	);
	assert.match(ctx2.calls[0][1], /1851277/);
});

test("every non-gateway call passes through ungated", async () => {
	const gate = makeGate();
	for (const toolName of [
		"bash",
		"write",
		"mcp__other-server__submit_job",
		`${SERVER}not_a_registered_tool`,
	]) {
		const ctx = stubContext(false);
		const result = await gate({ type: "tool_call", toolCallId: "t1", toolName, input: {} }, ctx);
		assert.equal(result, undefined, `${toolName} is not the gateway's to gate`);
		assert.deepEqual(ctx.calls, [], `${toolName} must not prompt`);
	}
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
	const result = await handler(
		{ type: "tool_call", toolCallId: "t1", toolName: `${SERVER}submit_job`, input: {} },
		ctx,
	);
	assert.equal(result.block, true);
});
