// The benchmark report step (spec #136, on the #135 tracer's shape):
// the host-side half of grading. The objective half (bench-grade.mjs)
// ran in-container against the task workspace; this step runs where the
// judges' credentials live — host-side, reading the host pi config —
// because a benchmark leg carries only the provider key into the rig,
// and a classifier's key is not that key. It merges three inputs into
// the machine-readable report file beside the recorded exit status: the
// objective check results, one classify() verdict per judge tier on the
// one subjective entry, and the session's native usage ledger.
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
	suite: "bench-suite.json",
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
//
// One bounded retry rides transport-level failures only (measured live
// 2026-11-15: the suite's first run lost three mid-run judge calls to
// `fetch failed` after the first two landed — the pooled keep-alive
// class, not an outage). One retry after a short backoff opens a fresh
// socket. API-level outcomes — a stopReason error, a malformed answer —
// are answers, not transport: they return as judge errors and never
// retry, because a 404 or a 4xx is deterministic and the suite's live
// cluster doctrine ("never a retry loop") stays honored — this is one
// bounded retry on a stateless classifier call, not a loop over a
// connection.
const BOOL_PASS_PROBABILITY = 0.5;
const TRANSPORT_RETRY_DELAY_MS = 2000;

function isTransportError(error) {
	return error instanceof TypeError && error.message === "fetch failed";
}

export async function runJudge(registry, model, classify, state) {
	let settled;
	try {
		settled = await registry.classify(model, { state, questions: { [classify.id]: classify.question } });
	} catch (error) {
		if (!isTransportError(error)) {
			return { pass: false, judgeError: String(error?.message ?? error) };
		}
		await new Promise((resolve) => setTimeout(resolve, TRANSPORT_RETRY_DELAY_MS));
		try {
			settled = await registry.classify(model, { state, questions: { [classify.id]: classify.question } });
		} catch (retryError) {
			return { pass: false, judgeError: String(retryError?.message ?? retryError) };
		}
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

// The report itself (spec #136's two-tier shape, superseding the #135
// single-judge one): the task grade, one judge row per tier, and usage
// totals — beside the recorded exit status the rig already wrote. The
// `checks` list is the objective, workspace-as-oracle rows only; the
// subjective verdicts ride `judges`, one row per judge slot, paired at
// the caller as `judgeCalls` — [{ slot, result }] — so a slot and its
// verdict cannot drift apart by index. The grade passes only when every
// objective check and every tier pass — a tier disagreement is a failed
// grade, loud in the report, never averaged away. A judge row may carry
// `skipped` (the objective check matched nothing to judge — the task
// grade fails, the leg does not: grading failure and leg failure never
// mix) or `judgeError` (the judge itself broke — that fails the leg,
// runEval's gate), and the two ride separate fields.
export function buildReport({ task, grades, judgeCalls, usage, head, gradedAt }) {
	const judges = judgeCalls.map(({ slot, result }) => ({
		id: task.classify.id,
		tier: slot.tier,
		provider: slot.provider,
		model: slot.model,
		pass: result.pass,
		...(result.probability !== undefined ? { probability: result.probability } : {}),
		...(result.skipped !== undefined ? { skipped: result.skipped } : {}),
		...(result.judgeError !== undefined ? { judgeError: result.judgeError } : {}),
		...(result.usage ? { usage: result.usage } : {}),
	}));
	return {
		task: task.id,
		class: task.class,
		grade: [...grades.checks, ...judges].every((row) => row.pass) ? "pass" : "fail",
		sessions: usage.sessions,
		landedHead: head,
		gradedAt,
		judges,
		checks: grades.checks,
		usage: { byModel: usage.byModel, totals: usage.totals },
	};
}

// The suite run artifact (spec #136): one per-run report carrying
// per-task grades, each tier's verdict, and costs. Lean by design — the
// per-task detail (by-model usage, check details, judge probabilities)
// lives in each task's own bench-report.json; this is the file the
// strike's PR body reads. Public-surface numbers come only from the
// independent tier, and publishing them is the owner's editorial act,
// out of band — the artifact records what happened, it does not publish.
export function buildSuiteReport({ reports, provider, model, head, gradedAt }) {
	const tasks = reports.map((report) => ({
		task: report.task,
		class: report.class,
		grade: report.grade,
		sessions: report.sessions,
		judges: report.judges.map(({ tier, provider: judgeProvider, model: judgeModel, pass }) => ({
			tier,
			provider: judgeProvider,
			model: judgeModel,
			pass,
		})),
		checks: {
			passed: report.checks.filter((check) => check.pass).length,
			total: report.checks.length,
		},
		usage: { totals: report.usage.totals },
	}));
	const totals = tasks.reduce(
		(acc, row) => {
			acc.sessions += row.sessions;
			acc.tokens += row.usage.totals.totalTokens;
			acc.cost += row.usage.totals.cost;
			if (row.grade === "pass") acc.passed += 1;
			else acc.failed += 1;
			return acc;
		},
		{ tasks: tasks.length, passed: 0, failed: 0, sessions: 0, tokens: 0, cost: 0 },
	);
	return {
		suite: { provider, model },
		landedHead: head,
		gradedAt,
		tasks,
		totals,
	};
}
