import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { createJiti } from "jiti";
import { tempDir } from "./helpers/temp-dir.mjs";
import { writeNotebook } from "./helpers/notebook-lines.mjs";

// The plan-review gate (spec #203): the research loop's stop between
// Design and Execute, as the gate framework's second instance. The test
// drives the extension's real tool — loaded through jiti, the loader pi
// runs extensions with — with a stub confirm on the execute context, an
// injectable gate-log sink, and a real temp project whose `.theta` holds
// the plan object and the notebook, exactly the disk state the stop
// weighs. The durable-approval rule, the re-prompt on a new revision,
// fail-closed refusals, the shared log grammar, and mode degradation all
// have pins here; the submit gate's own suite pins the extraction's
// other side (its pins run unchanged against the shared framework).
const jiti = createJiti(import.meta.url);
const {
	PLAN_REVIEW_TOOL_NAME,
	createPlanReviewTool,
	default: registerPlanReviewGate,
} = await jiti.import("../extensions/plan-review-gate.ts");
const { planRevisionOf } = await jiti.import("../extensions/plan-object.ts");
const { GATE_LOG_NAME } = await jiti.import("../extensions/submit-gate.ts");

// The vector digest both languages compute (test/fixtures/notebook/
// plan-vector.md, the committed bytes the recorder's suite pins too).
const planVectorBytes = fs.readFileSync(
	new URL("fixtures/notebook/plan-vector.md", import.meta.url),
);

// A real temp project: the plan at its recorded path, the notebook beside
// it, the session cwd the tool reads both through.
const PLAN_RELATIVE = ".theta/plans/2026-11-26-af3-benchmark.md";
const PLAN_BYTES_V1 = "# AF3 benchmark plan\n\nRun the vector at 3 seeds.\n";
const PLAN_BYTES_V2 = "# AF3 benchmark plan\n\nRun the vector at 5 seeds.\n";

function project(t) {
	const dir = tempDir(t, "plan-review-");
	return dir;
}

function writePlan(dir, bytes) {
	fs.mkdirSync(path.join(dir, ".theta", "plans"), { recursive: true });
	fs.writeFileSync(path.join(dir, PLAN_RELATIVE), bytes);
	return planRevisionOf(Buffer.from(bytes));
}

function planDecision(id, digest, verdict) {
	return JSON.stringify({
		id,
		type: "decision",
		date: "2026-11-26",
		text: `Plan review ${verdict}`,
		planPath: PLAN_RELATIVE,
		planRevision: digest,
		decision: verdict,
	});
}

// A stub execute context whose confirm records its arguments and answers
// with the test's scripted boolean — the dialog is the one place to
// answer, and the stub is where the test answers it. print and json
// modes' no-op ui denies every confirm: the `answer: false` stub is that
// degradation, pinned by name below.
function stubContext(cwd, answer, sessionManager) {
	const calls = [];
	return {
		calls,
		cwd,
		ui: {
			confirm: async (...args) => {
				calls.push(args);
				return answer;
			},
		},
		...(sessionManager !== undefined ? { sessionManager } : {}),
	};
}

async function review(dir, ctx, log) {
	const tool = createPlanReviewTool(log && { log });
	return tool.execute("t1", { planPath: PLAN_RELATIVE }, undefined, undefined, ctx);
}

// --- the digest -------------------------------------------------------------

test("the plan revision agrees with the shared test vector", () => {
	assert.equal(planRevisionOf(planVectorBytes), "c6f6084b0e5f");
});

// --- registration -----------------------------------------------------------

test("the tool registers under the spec's pinned name", () => {
	const tool = createPlanReviewTool();
	assert.equal(tool.name, "theta_plan_review");
	assert.equal(PLAN_REVIEW_TOOL_NAME, "theta_plan_review");
	const registered = [];
	registerPlanReviewGate({ registerTool: (tool) => registered.push(tool.name) });
	assert.deepEqual(registered, ["theta_plan_review"]);
});

// --- the stop's fail-closed edges -------------------------------------------

test("a path outside the plan-id grammar refuses before any read", async () => {
	const ctx = stubContext("/nonexistent-project", true);
	for (const [bad, why] of [
		["plans/2026-11-26-af3.md", "no .theta prefix"],
		[".theta/plans/af3.md", "no date in the id"],
		[".theta/plans/2026-13-40-af3.md", "no real calendar day"],
		[".theta/plans/2026-11-26-AF3.md", "slug grammar"],
		[".theta/plans/2026-11-26-af3.md\n", "trailing newline — the anchor trap the recorder's fullmatch fix closed"],
	]) {
		const tool = createPlanReviewTool();
		await assert.rejects(
			tool.execute("t1", { planPath: bad }, undefined, undefined, ctx),
			/not a plan object path/,
			why,
		);
	}
	assert.deepEqual(ctx.calls, [], "a malformed path must not open the dialog");
});

test("a missing plan file refuses; the stop never approves a plan it cannot read", async (t) => {
	const dir = project(t);
	const ctx = stubContext(dir, true);
	await assert.rejects(
		review(dir, ctx),
		/no plan file at .*af3-benchmark\.md/,
	);
	assert.deepEqual(ctx.calls, [], "a missing plan must not open the dialog");
});

// --- the durable-approval rule ---------------------------------------------

test("a recorded approved decision at this revision passes the stop with no dialog", async (t) => {
	const dir = project(t);
	const digest = writePlan(dir, PLAN_BYTES_V1);
	writeNotebook(dir, [planDecision("dec-0001", digest, "approved")]);
	const lines = [];
	const ctx = stubContext(dir, true);
	const result = await review(dir, ctx, (l) => lines.push(l));
	assert.equal(ctx.calls.length, 0, "the durable approval must not prompt");
	const text = result.content[0].text;
	assert.match(text, /approved for Execute/);
	assert.match(text, /durable approval/);
	assert.match(text, new RegExp(digest));
	assert.deepEqual(
		lines.map((l) => [l.check, l.decision]),
		[["durable-approval", "approved"]],
	);
});

test("an approval at another revision does not satisfy the stop — the dialog decides", async (t) => {
	const dir = project(t);
	const oldDigest = writePlan(dir, PLAN_BYTES_V1);
	writeNotebook(dir, [planDecision("dec-0001", oldDigest, "approved")]);
	// a plan edit is a new revision: the old approval no longer names it
	const newDigest = planRevisionOf(Buffer.from(PLAN_BYTES_V2));
	assert.notEqual(oldDigest, newDigest);
	fs.writeFileSync(path.join(dir, PLAN_RELATIVE), PLAN_BYTES_V2);

	const approvedLines = [];
	const approved = stubContext(dir, true);
	const result = await review(dir, approved, (l) => approvedLines.push(l));
	assert.equal(approved.calls.length, 1, "a new revision re-prompts");
	assert.match(approved.calls[0][1], new RegExp(newDigest));
	assert.match(result.content[0].text, /approved for Execute/);
	assert.match(result.content[0].text, /--plan-cite 2026-11-26-af3-benchmark/);
	assert.match(result.content[0].text, new RegExp(newDigest));
	assert.deepEqual(
		approvedLines.map((l) => [l.check, l.decision]),
		[["confirm", "approved"]],
	);

	const refusedLines = [];
	const refused = stubContext(dir, false);
	await assert.rejects(review(dir, refused, (l) => refusedLines.push(l)), /refused at the plan-review stop/);
	assert.deepEqual(
		refusedLines.map((l) => [l.check, l.decision]),
		[["confirm", "refused"]],
	);
});

test("the dialog names the plan, its revision, and the digest", async (t) => {
	const dir = project(t);
	const digest = writePlan(dir, PLAN_BYTES_V1);
	const ctx = stubContext(dir, true);
	await review(dir, ctx);
	assert.equal(ctx.calls.length, 1);
	const [title, message] = ctx.calls[0];
	assert.match(String(title), /plan-review gate/);
	assert.match(message, new RegExp(PLAN_RELATIVE.replaceAll("/", "\\/")));
	assert.match(message, new RegExp(digest));
});

test("print and json modes' no-op ui denies the confirm, and the stop refuses", async (t) => {
	const dir = project(t);
	writePlan(dir, PLAN_BYTES_V1);
	const lines = [];
	// answer false is the no-op dialog's deny — the degradation path
	const ctx = stubContext(dir, false);
	await assert.rejects(review(dir, ctx, (l) => lines.push(l)), /never proceed the stop unprompted/);
	assert.deepEqual(
		lines.map((l) => [l.check, l.decision]),
		[["confirm", "refused"]],
	);
});

// --- the notebook's latest citation decides ---------------------------------

test("the latest decision at this revision decides — refuse after approve refuses, approve after refuse approves", async (t) => {
	const dir = project(t);
	const digest = writePlan(dir, PLAN_BYTES_V1);
	writeNotebook(dir, [
		planDecision("dec-0001", digest, "approved"),
		planDecision("dec-0002", digest, "refused"),
	]);
	const ctx = stubContext(dir, true);
	await assert.rejects(review(dir, ctx), /latest decision for this plan at this revision is a recorded refusal/);
	assert.deepEqual(ctx.calls, [], "a recorded refusal must not re-prompt");

	const dir2 = project(t);
	writePlan(dir2, PLAN_BYTES_V1);
	writeNotebook(dir2, [
		planDecision("dec-0001", digest, "refused"),
		planDecision("dec-0002", digest, "approved"),
	]);
	const ctx2 = stubContext(dir2, true);
	const result = await review(dir2, ctx2);
	assert.equal(ctx2.calls.length, 0);
	assert.match(result.content[0].text, /durable approval/);
});

test("a decision citing another plan or another revision never matches", async (t) => {
	const dir = project(t);
	const digest = writePlan(dir, PLAN_BYTES_V1);
	writeNotebook(dir, [
		planDecision("dec-0001", "000000000000", "approved"),
		JSON.stringify({
			id: "dec-0002",
			type: "decision",
			date: "2026-11-26",
			text: "Another plan",
			planPath: ".theta/plans/2026-11-26-other-plan.md",
			planRevision: digest,
			decision: "approved",
		}),
		JSON.stringify({
			id: "dec-0003",
			type: "decision",
			date: "2026-11-26",
			text: "Not a citation at all",
		}),
	]);
	const ctx = stubContext(dir, true);
	await review(dir, ctx);
	assert.equal(ctx.calls.length, 1, "no foreign citation satisfies the stop");
});

test("a corrupt notebook refuses rather than prompting over it", async (t) => {
	const dir = project(t);
	const digest = writePlan(dir, PLAN_BYTES_V1);
	writeNotebook(dir, [planDecision("dec-0001", digest, "approved")]);
	fs.appendFileSync(path.join(dir, ".theta", "notebook.jsonl"), "{broken json\n");
	const ctx = stubContext(dir, true);
	await assert.rejects(review(dir, ctx), /not valid JSONL/);
	assert.deepEqual(ctx.calls, [], "a corrupt ledger must not open the dialog");
});

test("a missing notebook simply leaves no approval to find — the dialog decides", async (t) => {
	const dir = project(t);
	writePlan(dir, PLAN_BYTES_V1);
	const ctx = stubContext(dir, true);
	await review(dir, ctx);
	assert.equal(ctx.calls.length, 1);
});

// --- one ledger, both gates -------------------------------------------------

test("the gate log shares the submit gate's file and grammar", async (t) => {
	const dir = project(t);
	const digest = writePlan(dir, PLAN_BYTES_V1);
	writeNotebook(dir, [planDecision("dec-0001", digest, "approved")]);
	const lines = [];
	const ctx = stubContext(dir, true, {
		getSessionFile: () => path.join(dir, "session.jsonl"),
	});
	await review(dir, ctx);
	assert.equal(lines.length, 0, "the injected sink wins over the default");
	// the default sink appended beside the transcript instead
	const logged = fs
		.readFileSync(path.join(dir, GATE_LOG_NAME), "utf8")
		.trim()
		.split("\n")
		.map((l) => JSON.parse(l));
	assert.equal(logged.length, 1);
	const line = logged[0];
	assert.equal(line.tool, "theta_plan_review");
	assert.equal(line.toolCallId, "t1");
	assert.equal(line.check, "durable-approval");
	assert.equal(line.decision, "approved");
	assert.equal(line.reason, undefined);
	assert.match(line.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
	// one ledger: the submit gate's log name is this file's name
	assert.equal(GATE_LOG_NAME, "gate.jsonl");
});

test("a log-write failure never changes the decision", async (t) => {
	const dir = project(t);
	writePlan(dir, PLAN_BYTES_V1);
	const ctx = stubContext(dir, true, { getSessionFile: () => undefined });
	const result = await review(dir, ctx);
	assert.match(result.content[0].text, /approved for Execute/);
});

test("a refused stop lands its reason in the shared ledger", async (t) => {
	const dir = project(t);
	writePlan(dir, PLAN_BYTES_V1);
	const lines = [];
	const ctx = stubContext(dir, false);
	await assert.rejects(review(dir, ctx, (l) => lines.push(l)), /refused at the plan-review stop/);
	assert.equal(lines.length, 1);
	assert.equal(lines[0].decision, "refused");
	assert.match(lines[0].reason, /refused at the plan-review stop/);
	assert.equal(lines[0].tool, "theta_plan_review");
});
