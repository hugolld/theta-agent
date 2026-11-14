// Unit tests for the replay net's shape assertion (spec #134): the
// per-scenario expected shape, extracted from the net test so the checks
// the S1 scenarios add — extra skill opens, an optional recorder script,
// a refused gateway call — have a seam that tests without a fixture. The
// entries here are hand-built in pi's parsed-entry shape (the same shape
// parseSessionEntries returns), never a Theta re-implementation of the
// parser: the parser itself stays pinned by the net against real
// fixtures.

import assert from "node:assert/strict";
import { test } from "node:test";
import { assertShape } from "./shape.mjs";

// --- hand-built entries in pi's parsed shape -----------------------------

const skillsSection = (name) =>
	`<available_skills>\n  <skill>\n    <name>${name}</name>\n  </skill>\n</available_skills>`;
const sysEntry = (skills) => ({ type: "message", message: { role: "system", sections: { skills } } });
const userEntry = () => ({ type: "message", message: { role: "user", content: [{ type: "text", text: "go" }] } });
const callEntry = (id, name, args) => ({
	type: "message",
	message: { role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] },
});
const resultEntry = (callId, isError, text = "ok") => ({
	type: "message",
	message: { role: "toolResult", toolCallId: callId, isError, content: [{ type: "text", text }] },
});
const finalEntry = () => ({
	type: "message",
	message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" },
});

// The minimal session every base shape needs: the skill advertised, the
// SKILL.md read with a paired non-error result, a final assistant text.
// `extra` carries any further calls/results, which land before the final
// text — a real session never ends on a tool result.
function baseEntries(
	name = "demo",
	skillPath = "skills/demo/SKILL.md",
	extra = [],
) {
	return [
		sysEntry(skillsSection(name)),
		userEntry(),
		callEntry("c1", "read", { path: `/home/theta/theta/${skillPath}` }),
		resultEntry("c1", false),
		...extra,
		finalEntry(),
	];
}

const baseShape = { advertisesSkill: "demo", opensSkill: "skills/demo/SKILL.md" };

// --- the base shape -------------------------------------------------------

test("the base shape passes on the minimal session", () => {
	assertShape(baseEntries(), baseShape);
});

test("the shape reds when the skill is never advertised", () => {
	assert.throws(
		() => assertShape(baseEntries("other"), baseShape),
		/never advertised skill demo/,
	);
});

test("the shape reds on an error-paired read of the SKILL.md", () => {
	const entries = baseEntries();
	entries[3] = resultEntry("c1", true, "too big");
	assert.throws(
		() => assertShape(entries, baseShape),
		/no paired non-error read of skills\/demo\/SKILL\.md/,
	);
});

test("the shape reds on an unpaired read", () => {
	const entries = baseEntries().filter((_, i) => i !== 3);
	assert.throws(() => assertShape(entries, baseShape), /no paired non-error read/);
});

// --- the final-text check ---------------------------------------------------

test("the shape reds when the recording ends in a tool call, not text", () => {
	const entries = baseEntries();
	entries[entries.length - 1] = callEntry("c2", "bash", { command: "ls" });
	assert.throws(
		() => assertShape(entries, baseShape),
		/does not end in a final assistant text message/,
	);
});

// --- opensSkillsToo: a further skill open, the orchestrator's routed
// vendored skill (spec #134) -------------------------------------------------

test("opensSkillsToo passes when the further skill is also read non-error", () => {
	assertShape(
		baseEntries("demo", "skills/demo/SKILL.md", [
			callEntry("c3", "read", { path: "/home/theta/theta/skills/routed/SKILL.md" }),
			resultEntry("c3", false),
		]),
		{
			...baseShape,
			opensSkillsToo: ["skills/routed/SKILL.md"],
		},
	);
});

test("opensSkillsToo reds when the further skill never opened", () => {
	assert.throws(
		() =>
			assertShape(baseEntries(), {
				...baseShape,
				opensSkillsToo: ["skills/routed/SKILL.md"],
			}),
		/no paired non-error read of skills\/routed\/SKILL\.md/,
	);
});

// --- runsScript is optional; present, it keeps the S0 grammar ---------------

test("a shape without runsScript needs no bash call", () => {
	// baseEntries carries no bash call at all — passing is the assertion.
	assertShape(baseEntries(), baseShape);
});

test("runsScript passes on a direct invocation", () => {
	assertShape(
		baseEntries("demo", "skills/demo/SKILL.md", [
			callEntry("c4", "bash", {
				command: "python3 /home/theta/theta/skills/demo/scripts/tool.py --run",
			}),
			resultEntry("c4", false),
		]),
		{ ...baseShape, runsScript: "skills/demo/scripts/tool.py" },
	);
});

test("runsScript passes on the cd-anchored form real sessions use", () => {
	assertShape(
		baseEntries("demo", "skills/demo/SKILL.md", [
			callEntry("c5", "bash", {
				command: "cd /home/theta/theta/skills/demo/scripts && python3 tool.py --run",
			}),
			resultEntry("c5", false),
		]),
		{ ...baseShape, runsScript: "skills/demo/scripts/tool.py" },
	);
});

test("runsScript reds when the script never ran", () => {
	assert.throws(
		() => assertShape(baseEntries(), { ...baseShape, runsScript: "skills/demo/scripts/tool.py" }),
		/no bash call runs skills\/demo\/scripts\/tool\.py/,
	);
});

// --- gateRefusal: a gateway call the submit gate blocked (spec #134) -------

const GATEWAY_TOOL = "mcp__theta_compute__submit_job";

test("gateRefusal passes on an error-paired gateway call", () => {
	assertShape(
		baseEntries("demo", "skills/demo/SKILL.md", [
			callEntry("c6", GATEWAY_TOOL, { run_name: "smoke-check" }),
			resultEntry("c6", true, 'submit_job for run "smoke-check" was refused by the submit gate'),
		]),
		{ ...baseShape, gateRefusal: "submit_job" },
	);
});

test("gateRefusal reds when the gateway call was approved, not refused", () => {
	assert.throws(
		() =>
			assertShape(
				baseEntries("demo", "skills/demo/SKILL.md", [
					callEntry("c6", GATEWAY_TOOL, { run_name: "smoke-check" }),
					resultEntry("c6", false),
				]),
				{ ...baseShape, gateRefusal: "submit_job" },
			),
		/no refused gateway call submit_job/,
	);
});

test("gateRefusal reds when the gateway call never happened", () => {
	assert.throws(
		() => assertShape(baseEntries(), { ...baseShape, gateRefusal: "submit_job" }),
		/no refused gateway call submit_job/,
	);
});

test("gateRefusal reds on a refusal of some other gateway tool than declared", () => {
	const entries = [
		...baseEntries(),
		callEntry("c6", "mcp__theta_compute__cancel_job", { job_id: "123" }),
		resultEntry("c6", true, "refused"),
	];
	assert.throws(
		() => assertShape(entries, { ...baseShape, gateRefusal: "submit_job" }),
		/no refused gateway call submit_job/,
	);
});

// The codemode path (the compute doctrine's normal case): pi keeps the
// nested calls in the bounded record on the calling tool's result — name,
// status, and the gate's refusal as `error` — and the nested id never
// enters the transcript as a toolCall record. The refusal rides the
// gate's own wording, so an ordinary error cannot pose as one.
const nestedRefusal = (parentId, error) => ({
	type: "message",
	message: {
		role: "toolResult",
		toolCallId: parentId,
		isError: true,
		content: [{ type: "text", text: `Script error: ${error}` }],
		nestedCalls: {
			calls: [
				{
					id: `${parentId}/1`,
					name: GATEWAY_TOOL,
					status: "error",
					arguments: { run_name: "smoke-check" },
					error,
				},
			],
			complete: true,
		},
	},
});

test("gateRefusal passes on a codemode-nested refusal — the bounded record carries it", () => {
	assertShape(
		baseEntries("demo", "skills/demo/SKILL.md", [
			callEntry("c7", "codemode", { code: "await tools.mcp__theta_compute__submit_job({})" }),
			nestedRefusal(
				"c7",
				'submit_job for run "smoke-check" (nested under tool call c7) was refused by the submit gate — ask the user',
			),
		]),
		{ ...baseShape, gateRefusal: "submit_job" },
	);
});

test("gateRefusal reds on a nested gateway error that is not a gate refusal", () => {
	assert.throws(
		() =>
			assertShape(
				baseEntries("demo", "skills/demo/SKILL.md", [
					callEntry("c7", "codemode", { code: "await tools.mcp__theta_compute__submit_job({})" }),
					nestedRefusal("c7", "connection refused by the gateway host"),
				]),
				{ ...baseShape, gateRefusal: "submit_job" },
			),
		/no refused gateway call submit_job/,
	);
});

test("gateRefusal reds on a nested gateway call that succeeded", () => {
	const entries = baseEntries("demo", "skills/demo/SKILL.md", [
		callEntry("c7", "codemode", { code: "await tools.mcp__theta_compute__submit_job({})" }),
		{
			type: "message",
			message: {
				role: "toolResult",
				toolCallId: "c7",
				isError: false,
				content: [{ type: "text", text: "submitted" }],
				nestedCalls: {
					calls: [
						{ id: "c7/1", name: GATEWAY_TOOL, status: "ok", arguments: { run_name: "smoke-check" } },
					],
					complete: true,
				},
			},
		},
	]);
	assert.throws(
		() => assertShape(entries, { ...baseShape, gateRefusal: "submit_job" }),
		/no refused gateway call submit_job/,
	);
});

test("gateRefusal reds on a flat gateway error without the gate's wording", () => {
	assert.throws(
		() =>
			assertShape(
				baseEntries("demo", "skills/demo/SKILL.md", [
					callEntry("c6", GATEWAY_TOOL, { run_name: "smoke-check" }),
					resultEntry("c6", true, "connection refused by the gateway host"),
				]),
				{ ...baseShape, gateRefusal: "submit_job" },
			),
		/no refused gateway call submit_job/,
	);
});
