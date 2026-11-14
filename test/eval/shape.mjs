// The replay net's shape assertion (spec #133, generalized by #134): the
// scenario's expected session shape, checked structurally against a
// parsed recording. The base shape — the skill advertised, its SKILL.md
// opened with a paired non-error read, the session ended in final
// assistant text — is every scenario's; the optional fields add what a
// scenario declares:
//
//   opensSkillsToo  further skill opens, each with a paired non-error
//                   read — the orchestrator's routed vendored skill
//   runsScript      a bash invocation of a skill script (the S0 grammar:
//                   the path named in full, or the cd-anchored form real
//                   sessions use)
//   gateRefusal     a gateway tool call the submit gate blocked. Print
//                   mode answers no confirms, so the refusal is
//                   deterministic and no job can be created. Two paths
//                   carry it: the flat call's error-paired result, or —
//                   the compute doctrine's normal case — a codemode
//                   script's nested call, whose refusal pi records in the
//                   bounded record on the calling tool's result. Either
//                   way the gate's own wording marks it: an error alone
//                   cannot tell the gate's refusal from a gateway or
//                   server error, and this scenario pins the extension's
//                   user-facing strings.
//
// The net-side shape is half the expectation; the capture-time half is
// the auditor legs the rig run passes live (docs/agents/eval.md). Shape
// paths the auditor can attest (opensSkill, runsScript) must be legs;
// the rest are the net's alone.

import assert from "node:assert/strict";
import { createJiti } from "jiti";
import { collectNestedCalls, contentText } from "../../scripts/audit-dogfood.mjs";

// pi registers MCP tool names sanitized: every character outside
// [A-Za-z0-9_] becomes `_` (pi's createMcpToolName), so the gateway
// server's hyphenated name lands as an underscore. The constant has one
// home — extensions/submit-gate.ts exports it; this test-tree module
// consumes it through jiti, the loader pi runs extensions with (the
// submit-gate suite's pattern). A prefix change still moves the
// extensions surface digest and every fixture recaptures.
const { GATEWAY_PREFIX } = await createJiti(import.meta.url).import(
	"../../extensions/submit-gate.ts",
);

// Index a session's tool calls and results once for the shape checks: the
// call map is keyed by tool-call id, the result map by the toolCallId the
// result record carries — the pairing the shape assertions lean on.
function indexCalls(entries) {
	const calls = new Map();
	const results = new Map();
	for (const entry of entries) {
		const message = entry.message;
		if (message?.role === "assistant") {
			for (const item of message.content ?? []) {
				if (item?.type === "toolCall") calls.set(item.id, item);
			}
		}
		if (message?.role === "toolResult") results.set(message.toolCallId, message);
	}
	return { calls, results };
}

export function assertShape(entries, shape) {
	// pi advertises with pretty-printed XML — whitespace between the
	// tags varies, the structure does not.
	const skillRecord = new RegExp(`<skill>\\s*<name>${shape.advertisesSkill}</name>`);
	const advertised = entries.some(
		(entry) =>
			entry.message?.role === "system" &&
			typeof entry.message.sections?.skills === "string" &&
			skillRecord.test(entry.message.sections.skills),
	);
	assert.ok(advertised, `the system record never advertised skill ${shape.advertisesSkill}`);

	const { calls, results } = indexCalls(entries);
	const readNonError = (skillPath) =>
		[...calls.values()].some(
			(call) =>
				call.name === "read" &&
				typeof call.arguments?.path === "string" &&
				call.arguments.path.endsWith(`/${skillPath}`) &&
				results.get(call.id)?.isError === false,
		);
	assert.ok(
		readNonError(shape.opensSkill),
		`no paired non-error read of ${shape.opensSkill} in the recording`,
	);
	for (const skillPath of shape.opensSkillsToo ?? []) {
		assert.ok(readNonError(skillPath), `no paired non-error read of ${skillPath} in the recording`);
	}

	if (shape.runsScript !== undefined) {
		// Containment only: the capture-time auditor leg owns the full
		// execution grammar; the net pins that the session ran the
		// script at all — spelled in full, or cd-anchored into the
		// skill tree (the shape real sessions use).
		const scriptFile = shape.runsScript.split("/").pop();
		const skillRoot = shape.runsScript.split("/").slice(0, 2).join("/");
		const ran = [...calls.values()].some(
			(call) =>
				call.name === "bash" &&
				typeof call.arguments?.command === "string" &&
				(call.arguments.command.includes(shape.runsScript) ||
					(call.arguments.command.includes("cd ") &&
						call.arguments.command.includes(skillRoot) &&
						call.arguments.command.includes(scriptFile))),
		);
		assert.ok(ran, `no bash call runs ${shape.runsScript} (directly or cd-anchored)`);
	}

	if (shape.gateRefusal !== undefined) {
		const gatewayTool = `${GATEWAY_PREFIX}${shape.gateRefusal}`;
		// The gate's own wording (extensions/submit-gate.ts builds the
		// refusal message around it): the marker both paths must carry, so
		// an ordinary error — a gateway down, a server refusal — cannot
		// pass for the gate's decision. A rewording moves the extensions
		// surface digest and recaptures every fixture; this literal then
		// follows the new wording deliberately, in review.
		const refusalMarker = "was refused by the submit gate";
		const flat = [...calls.values()].some(
			(call) =>
				call.name === gatewayTool &&
				results.get(call.id)?.isError === true &&
				contentText(results.get(call.id)?.content).includes(refusalMarker),
		);
		// The nested path through the one fail-closed reader of pi's
		// bounded record (scripts/audit-dogfood.mjs): the refusal rides the
		// entry's `error` field, `status: "error"` marks the failed call.
		const nested = collectNestedCalls(entries).calls.some(
			(entry) =>
				entry.name === gatewayTool &&
				entry.status === "error" &&
				typeof entry.error === "string" &&
				entry.error.includes(refusalMarker),
		);
		assert.ok(
			flat || nested,
			`no refused gateway call ${shape.gateRefusal} in the recording`,
		);
	}

	const last = entries.at(-1);
	assert.ok(
		last?.message?.role === "assistant" &&
			last.message.content?.some((item) => item?.type === "text") &&
			last.message.stopReason === "stop",
		"the recording does not end in a final assistant text message",
	);
}
