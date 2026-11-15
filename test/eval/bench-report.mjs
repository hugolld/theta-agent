// The benchmark report step (spec #135, ADR 0007): the host-side half
// of grading. The objective half (bench-grade.mjs) ran in-container
// against the task workspace; this step runs where the judge's
// credential lives — host-side, reading the host pi config — because a
// benchmark leg carries only the provider key into the rig, and the
// classifier's key is not that key. It merges three inputs into the
// machine-readable report file beside the recorded exit status: the
// objective check results, the classify() verdict on the one
// subjective check, and the session's native usage ledger.
//
// The usage ledger mirrors pi's own aggregation (dist/core/agent-session.js
// getSessionStats + dist/core/usage-totals.js getUsageCostBreakdown on the
// installed 1.4.0): usage entries, compaction and branch-summary usage,
// toolResult messages that carry usage, and every assistant message —
// cost summed from each record's cost.total, the token total from the
// four components. Those helpers are not in the package's public export
// surface, so the rule set is mirrored here and cited; the pinned test
// against a committed fixture keeps the mirror honest, and a pi bump
// that changes ledger semantics reds it.
//
// The judge never crashes the leg: classify() answers with a stopReason
// (pi's contract — it does not reject), a judge error lands as a failed
// check plus a leg failure, and the report records what happened.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseSessionEntries } from "@earendil-works/pi-coding-agent";
import { TRANSCRIPT_NAME } from "../../scripts/session-evidence.mjs";

// The eval-mode artifact names (one home; the rig runner and the tests
// import these instead of hand-typing names).
export const BENCH_FILES = Object.freeze({
	grades: "bench-grades.json",
	report: "bench-report.json",
	answer: "answer.txt",
});

// A blank usage record, pi's createUsageTotals shape.
function blankTotals() {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

function addUsage(totals, usage) {
	totals.input += usage.input ?? 0;
	totals.output += usage.output ?? 0;
	totals.cacheRead += usage.cacheRead ?? 0;
	totals.cacheWrite += usage.cacheWrite ?? 0;
	totals.cost += usage.cost?.total ?? 0;
}

// The per-entry rule set, pi's getUsageCostBreakdown exactly: assistant
// messages attribute provider/responseModel ?? model; usage entries
// carry their own attribution; toolResult usage and compaction or
// branch-summary usage land in one "Tools/summaries" bucket.
function usageOfEntry(entry) {
	if (entry.type === "message" && entry.message.role === "assistant") {
		return { key: `${entry.message.provider}/${entry.message.responseModel ?? entry.message.model}`, usage: entry.message.usage };
	}
	if (entry.type === "usage") {
		return { key: `${entry.provider}/${entry.model}`, usage: entry.usage };
	}
	if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.usage) {
		return { key: "Tools/summaries", usage: entry.message.usage };
	}
	if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
		return { key: "Tools/summaries", usage: entry.usage };
	}
	return null;
}

// The ledger's pure core (pinned by bench-report.test.mjs against a
// committed fixture): per-key totals plus the session-wide totals.
export function sumEntries(entries) {
	const byKey = new Map();
	const totals = blankTotals();
	for (const entry of entries) {
		const attributed = usageOfEntry(entry);
		if (!attributed?.usage) continue;
		const bucket = byKey.get(attributed.key) ?? blankTotals();
		addUsage(bucket, attributed.usage);
		byKey.set(attributed.key, bucket);
		addUsage(totals, attributed.usage);
	}
	return {
		byModel: Object.fromEntries(
			[...byKey.entries()]
				.map(([key, value]) => [
					key,
					{ ...value, totalTokens: value.input + value.output + value.cacheRead + value.cacheWrite },
				])
				// Codepoint order, not locale order: the report is committed
				// evidence, and localeCompare varies with the host's ICU.
				.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
		),
		totals: { ...totals, totalTokens: totals.input + totals.output + totals.cacheRead + totals.cacheWrite },
	};
}

// Sum every transcript a benchmark leg recorded (the name grammar picks
// out session transcripts; multi-session legs hold several). One pass:
// the transcripts' entries concatenate and the single-session rule set
// sums them — no second merge arithmetic to drift from the first.
export function sumSessionUsage(sessionDir) {
	const transcripts = readdirSync(sessionDir).filter((f) => TRANSCRIPT_NAME.test(f)).sort();
	if (transcripts.length === 0) {
		throw new Error(`no session transcript in ${sessionDir} — nothing to cost`);
	}
	const entries = transcripts.flatMap((file) =>
		parseSessionEntries(readFileSync(path.join(sessionDir, file), "utf8")),
	);
	return { sessions: transcripts.length, ...sumEntries(entries) };
}

// Resolve the named judge slot against a registry (the rig runner
// preflights with this before the leg burns anything): the model must
// exist and its provider must have working credentials, and each
// refusal names the fix.
export function resolveJudge(registry, judge) {
	const model = registry.getModelOfType("classifier", judge.provider, judge.model);
	if (!model) {
		throw new Error(
			`judge ${judge.provider}/${judge.model} is not in the catalog — check the judge slot in test/eval/bench-tasks.mjs`,
		);
	}
	if (!registry.hasConfiguredAuth(model)) {
		throw new Error(
			`judge ${judge.provider}/${judge.model} has no working credential host-side — set the provider's key in the host pi config (the rig never carries it)`,
		);
	}
	return model;
}

// Run the one subjective check through models.classify() — the same
// call codemode scripts make, driven by the harness. The state carries
// the task statement and the matched workspace artifact (never model
// prose: workspace-as-oracle). Returns a check row; a judge error is a
// failed check with the error recorded, and the caller fails the leg.
// A bool classify() verdict lands as { type: "bool", probability } (pi-ai
// dist/types.d.ts ClassifierBoolAnswer); probability >= 0.5 reads true.
// The threshold lives here, once, beside the shape it thresholds.
const BOOL_PASS_PROBABILITY = 0.5;

export async function runJudge(registry, model, classify, state) {
	let settled;
	try {
		settled = await registry.classify(model, { state, questions: { [classify.id]: classify.question } });
	} catch (error) {
		return { pass: false, judgeError: String(error?.message ?? error) };
	}
	if (settled.stopReason !== "stop") {
		return {
			pass: false,
			judgeError: settled.errorMessage ?? `judge stopReason ${settled.stopReason}`,
			usage: settled.usage,
		};
	}
	const answer = settled.answers?.[classify.id];
	if (answer?.type !== "bool" || typeof answer.probability !== "number") {
		return {
			pass: false,
			judgeError: `judge answered ${JSON.stringify(answer)}, not a bool probability`,
		};
	}
	return {
		pass: answer.probability >= BOOL_PASS_PROBABILITY,
		probability: answer.probability,
		usage: settled.usage,
	};
}

// The report itself: task grade, judge tier, usage totals — beside the
// recorded exit status the rig already wrote (spec #135). A judgeResult
// may carry `skipped` (the objective check matched nothing to judge —
// the task grade fails, the leg does not: grading failure and leg
// failure never mix) or `judgeError` (the judge itself broke — that
// fails the leg, runEval's gate), and the two ride separate fields.
export function buildReport({ task, grades, judgeSlot, judgeResult, usage, head, gradedAt }) {
	const checks = [
		...grades.checks,
		{
			id: task.classify.id,
			kind: "classify",
			pass: judgeResult.pass,
			...(judgeResult.probability !== undefined ? { probability: judgeResult.probability } : {}),
			...(judgeResult.skipped !== undefined ? { skipped: judgeResult.skipped } : {}),
			...(judgeResult.judgeError !== undefined ? { judgeError: judgeResult.judgeError } : {}),
		},
	];
	return {
		task: task.id,
		grade: checks.every((check) => check.pass) ? "pass" : "fail",
		sessions: usage.sessions,
		landedHead: head,
		gradedAt,
		judge: {
			tier: judgeSlot.tier,
			provider: judgeSlot.provider,
			model: judgeSlot.model,
			...(judgeResult.usage ? { usage: judgeResult.usage } : {}),
		},
		checks,
		usage: { byModel: usage.byModel, totals: usage.totals },
	};
}
