import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { createJiti } from "jiti";
import { escapeRegExp } from "./helpers/escape-regexp.mjs";
import { writeNotebook } from "./helpers/notebook-lines.mjs";
import { stubGateContext } from "./helpers/gate-stubs.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

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
const { planRevisionOf } = await jiti.import("../extensions/lib/plan-object.ts");
const { GATE_LOG_NAME } = await jiti.import("../extensions/lib/gate-framework.ts");

// The vector digest both languages compute (test/fixtures/notebook/
// plan-vector.md, the committed bytes the recorder's suite pins too), and
// the committed citation entry (plan-decision.jsonl) whose shapes the
// recorder's and the cards' suites pin — this suite reads the same pair
// so the gate, the third consumer, proves its agreement with them.
const planVectorBytes = fs.readFileSync(
	new URL("fixtures/notebook/plan-vector.md", import.meta.url),
);
const fixtureCitationLine = fs
	.readFileSync(new URL("fixtures/notebook/plan-decision.jsonl", import.meta.url), "utf8")
	.trim();

// A real temp project: the plan at its recorded path, the notebook beside
// it, the session cwd the tool reads both through.
const PLAN_RELATIVE = ".theta/plans/2026-11-26-af3-benchmark.md";
const PLAN_BYTES_V1 = "# AF3 benchmark plan\n\nRun the vector at 3 seeds.\n";
const PLAN_BYTES_V2 = "# AF3 benchmark plan\n\nRun the vector at 5 seeds.\n";

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

async function review(ctx, log, planPath = PLAN_RELATIVE) {
	const tool = createPlanReviewTool(log && { log });
	return tool.execute("t1", { planPath }, undefined, undefined, ctx);
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

test("a path outside the plan-id grammar refuses before any read, and logs nothing", async () => {
	const lines = [];
	const ctx = stubGateContext({ answer: true, cwd: "/nonexistent-project" });
	for (const [bad, why] of [
		["plans/2026-11-26-af3.md", "no .theta prefix"],
		[".theta/plans/af3.md", "no date in the id"],
		[".theta/plans/2026-13-40-af3.md", "no real calendar day"],
		[".theta/plans/2026-11-26-AF3.md", "slug grammar"],
		// parity with the recorder's fullmatch fix: JavaScript's `$` never
		// matches before a trailing newline, so the shape check refuses one —
		// the pin guards the parity if the regex ever moves platforms
		[".theta/plans/2026-11-26-af3.md\n", "trailing newline"],
	]) {
		const tool = createPlanReviewTool({ log: (l) => lines.push(l) });
		await assert.rejects(
			tool.execute("t1", { planPath: bad }, undefined, undefined, ctx),
			/not a plan object path/,
			why,
		);
	}
	assert.deepEqual(ctx.calls, [], "a malformed path must not open the dialog");
	assert.deepEqual(lines, [], "a usage-class refusal logs nothing");
});

test("a missing plan file refuses; the stop never approves a plan it cannot read", async (t) => {
	const dir = tempDir(t, "plan-review-");
	const lines = [];
	const ctx = stubGateContext({ answer: true, cwd: dir });
	await assert.rejects(review(ctx, (l) => lines.push(l)), /no plan file at .*af3-benchmark\.md/);
	assert.deepEqual(ctx.calls, [], "a missing plan must not open the dialog");
	assert.deepEqual(lines, [], "a usage-class refusal logs nothing");
});

// --- the durable-approval rule ---------------------------------------------

test("the committed citation fixture passes the gate: the three readers agree", async (t) => {
	// plan-decision.jsonl cites .theta/plans/2026-11-18-af3-benchmark.md at
	// the vector's digest; the recorder's and the cards' suites pin the
	// entry's shape, this pin makes the gate accept it — one fixture, three
	// consumers, no drift.
	const dir = tempDir(t, "plan-review-fixture-");
	fs.mkdirSync(path.join(dir, ".theta", "plans"), { recursive: true });
	fs.writeFileSync(path.join(dir, ".theta/plans/2026-11-18-af3-benchmark.md"), planVectorBytes);
	writeNotebook(dir, [fixtureCitationLine]);
	const ctx = stubGateContext({ answer: true, cwd: dir });
	const result = await review(ctx, undefined, ".theta/plans/2026-11-18-af3-benchmark.md");
	assert.equal(ctx.calls.length, 0, "the fixture's durable approval must not prompt");
	assert.match(result.content[0].text, /durable approval/);
	assert.match(result.content[0].text, new RegExp(escapeRegExp("c6f6084b0e5f")));
});

test("a recorded approved decision at this revision passes the stop with no dialog", async (t) => {
	const dir = tempDir(t, "plan-review-");
	const digest = writePlan(dir, PLAN_BYTES_V1);
	writeNotebook(dir, [planDecision("dec-0001", digest, "approved")]);
	const lines = [];
	const ctx = stubGateContext({ answer: true, cwd: dir });
	const result = await review(ctx, (l) => lines.push(l));
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
	const dir = tempDir(t, "plan-review-");
	const oldDigest = writePlan(dir, PLAN_BYTES_V1);
	writeNotebook(dir, [planDecision("dec-0001", oldDigest, "approved")]);
	// a plan edit is a new revision: the old approval no longer names it
	const newDigest = planRevisionOf(Buffer.from(PLAN_BYTES_V2));
	assert.notEqual(oldDigest, newDigest);
	fs.writeFileSync(path.join(dir, PLAN_RELATIVE), PLAN_BYTES_V2);

	const approvedLines = [];
	const approved = stubGateContext({ answer: true, cwd: dir });
	const result = await review(approved, (l) => approvedLines.push(l));
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
	const refused = stubGateContext({ answer: false, cwd: dir });
	await assert.rejects(
		review(refused, (l) => refusedLines.push(l)),
		/refused by the plan-review gate/,
	);
	assert.deepEqual(
		refusedLines.map((l) => [l.check, l.decision]),
		[["confirm", "refused"]],
	);
});

test("the dialog names the plan, its revision, and the digest", async (t) => {
	const dir = tempDir(t, "plan-review-");
	const digest = writePlan(dir, PLAN_BYTES_V1);
	const ctx = stubGateContext({ answer: true, cwd: dir });
	await review(ctx);
	assert.equal(ctx.calls.length, 1);
	const [title, message] = ctx.calls[0];
	assert.match(String(title), /plan-review gate/);
	assert.match(message, new RegExp(escapeRegExp(PLAN_RELATIVE)));
	assert.match(message, new RegExp(digest));
	assert.match(message, /gates Execute for this run/);
});

test("print and json modes' no-op ui denies the confirm, and the stop refuses", async (t) => {
	const dir = tempDir(t, "plan-review-");
	writePlan(dir, PLAN_BYTES_V1);
	const lines = [];
	// answer false is the no-op dialog's deny — the degradation path
	const ctx = stubGateContext({ answer: false, cwd: dir });
	await assert.rejects(review(ctx, (l) => lines.push(l)), /never proceed the stop unprompted/);
	assert.deepEqual(
		lines.map((l) => [l.check, l.decision]),
		[["confirm", "refused"]],
	);
});

// --- the notebook's latest citation decides ---------------------------------

test("the latest decision at this revision decides — refuse after approve refuses, approve after refuse approves", async (t) => {
	const dir = tempDir(t, "plan-review-");
	const digest = writePlan(dir, PLAN_BYTES_V1);
	writeNotebook(dir, [
		planDecision("dec-0001", digest, "approved"),
		planDecision("dec-0002", digest, "refused"),
	]);
	const ctx = stubGateContext({ answer: true, cwd: dir });
	await assert.rejects(
		review(ctx),
		/latest decision for this plan at this revision is a recorded refusal/,
	);
	assert.deepEqual(ctx.calls, [], "a recorded refusal must not re-prompt");

	const dir2 = tempDir(t, "plan-review-");
	writePlan(dir2, PLAN_BYTES_V1);
	writeNotebook(dir2, [
		planDecision("dec-0001", digest, "refused"),
		planDecision("dec-0002", digest, "approved"),
	]);
	const ctx2 = stubGateContext({ answer: true, cwd: dir2 });
	const result = await review(ctx2);
	assert.equal(ctx2.calls.length, 0);
	assert.match(result.content[0].text, /durable approval/);
});

test("a decision citing another plan or another revision never matches", async (t) => {
	const dir = tempDir(t, "plan-review-");
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
	const ctx = stubGateContext({ answer: true, cwd: dir });
	await review(ctx);
	assert.equal(ctx.calls.length, 1, "no foreign citation satisfies the stop");
});

test("blank lines ride along; the recorder skips them too", async (t) => {
	const dir = tempDir(t, "plan-review-");
	const digest = writePlan(dir, PLAN_BYTES_V1);
	writeNotebook(dir, [planDecision("dec-0001", digest, "approved"), "", ""]);
	const ctx = stubGateContext({ answer: true, cwd: dir });
	const result = await review(ctx);
	assert.equal(ctx.calls.length, 0);
	assert.match(result.content[0].text, /durable approval/);
});

test("a non-entry line refuses with the gate's name, not a raw parser error", async (t) => {
	const dir = tempDir(t, "plan-review-");
	const digest = writePlan(dir, PLAN_BYTES_V1);
	writeNotebook(dir, [planDecision("dec-0001", digest, "approved")]);
	fs.appendFileSync(path.join(dir, ".theta", "notebook.jsonl"), "null\n");
	const ctx = stubGateContext({ answer: true, cwd: dir });
	await assert.rejects(review(ctx), /non-entry line \(line 2\)/);
	await assert.rejects(review(ctx), /plan-review gate/);
	assert.deepEqual(ctx.calls, [], "a corrupt ledger must not open the dialog");
});

test("a corrupt notebook refuses rather than prompting over it", async (t) => {
	const dir = tempDir(t, "plan-review-");
	const digest = writePlan(dir, PLAN_BYTES_V1);
	writeNotebook(dir, [planDecision("dec-0001", digest, "approved")]);
	fs.appendFileSync(path.join(dir, ".theta", "notebook.jsonl"), "{broken json\n");
	const ctx = stubGateContext({ answer: true, cwd: dir });
	await assert.rejects(review(ctx), /not valid JSONL/);
	assert.deepEqual(ctx.calls, [], "a corrupt ledger must not open the dialog");
});

test("a missing notebook simply leaves no approval to find — the dialog decides", async (t) => {
	const dir = tempDir(t, "plan-review-");
	writePlan(dir, PLAN_BYTES_V1);
	const ctx = stubGateContext({ answer: true, cwd: dir });
	await review(ctx);
	assert.equal(ctx.calls.length, 1);
});

// --- one ledger, both gates -------------------------------------------------

test("an injected sink wins over the default — no gate.jsonl is written beside a session", async (t) => {
	const dir = tempDir(t, "plan-review-");
	const digest = writePlan(dir, PLAN_BYTES_V1);
	writeNotebook(dir, [planDecision("dec-0001", digest, "approved")]);
	const lines = [];
	const ctx = stubGateContext({
		answer: true,
		cwd: dir,
		sessionManager: { getSessionFile: () => path.join(dir, "session.jsonl") },
	});
	await review(ctx, (l) => lines.push(l));
	assert.equal(lines.length, 1, "the injected sink captured the decision");
	assert.equal(fs.existsSync(path.join(dir, GATE_LOG_NAME)), false, "the default sink stayed out");
});

test("the default sink appends the shared grammar beside the session transcript", async (t) => {
	const dir = tempDir(t, "plan-review-");
	const digest = writePlan(dir, PLAN_BYTES_V1);
	writeNotebook(dir, [planDecision("dec-0001", digest, "approved")]);
	const ctx = stubGateContext({
		answer: true,
		cwd: dir,
		sessionManager: { getSessionFile: () => path.join(dir, "session.jsonl") },
	});
	await review(ctx);
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
	const dir = tempDir(t, "plan-review-");
	writePlan(dir, PLAN_BYTES_V1);
	const ctx = stubGateContext({ answer: true, cwd: dir });
	const result = await review(ctx, () => {
		throw new Error("disk gone");
	});
	assert.match(result.content[0].text, /approved for Execute/);
});

test("a refused stop lands its reason in the shared ledger", async (t) => {
	const dir = tempDir(t, "plan-review-");
	writePlan(dir, PLAN_BYTES_V1);
	const lines = [];
	const ctx = stubGateContext({ answer: false, cwd: dir });
	await assert.rejects(review(ctx, (l) => lines.push(l)), /refused by the plan-review gate/);
	assert.equal(lines.length, 1);
	assert.equal(lines[0].decision, "refused");
	assert.match(lines[0].reason, /refused by the plan-review gate/);
	assert.equal(lines[0].tool, "theta_plan_review");
});
