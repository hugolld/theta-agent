import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "@earendil-works/pi-ai";
import {
	defineTool,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	type GateCheck,
	type GateContext,
	type GateLogSink,
	runGateChecks,
	writeGateDecision,
} from "./lib/gate-framework.ts";
import { isPlanPath, planRevisionOf } from "./lib/plan-object.ts";

/**
 * The plan-review gate (spec #203): the research loop's stop between
 * Design and Execute, enforced as the second instance of the M5 gate
 * framework — fail-closed, revision-bound, and logged in the same session
 * dir `gate.jsonl` as the submit gate, one ledger rendering both. The
 * loop's doctrine calls this tool (`theta_plan_review`) at the stop,
 * passing the plan object's recorded path; the pipeline-predicate
 * alternative was considered and set aside (no predicate catches inline
 * execution, and the stop's enforcement point is the loop's own doctrine,
 * spec #204's text).
 *
 * The check stack, in order:
 *
 * 1. `durable-approval` — the plan file is digested on disk (the plan
 *    revision, lib/plan-object.ts's recipe), then the project notebook is
 *    read for the latest decision entry citing the same path and
 *    revision. An approved citation satisfies the stop with no dialog —
 *    the durable-approval rule; a refusal is provenance the same way, so
 *    the latest refused citation refuses the stop without a dialog. A
 *    corrupt ledger refuses loudly rather than prompting over it; a
 *    missing notebook simply leaves no approval to find.
 * 2. `confirm` — the one dialog that names the plan, its revision, and
 *    the digest. The dialog is the one place to answer; surfaces hold no
 *    control of their own.
 *
 * Fail-closed by construction: no approval at this revision, an
 * unanswered or refused dialog, a missing plan file, or a malformed path
 * all refuse — no Execute, this run — and every refusal names the gate so
 * the model asks the user instead of retrying unprompted. One log line
 * records each decided stop; the usage-class refusals (a malformed path,
 * a missing plan) refuse before the stack and log nothing, like every
 * ungated call. Mode degradation follows the M5 precedent: print and json
 * modes' no-op UI denies every confirm, so the stop refuses there; RPC
 * answers headlessly (the rig driver, test/rig/rpc-driver.mjs).
 *
 * The gate logs its decision; the loop records the `decision` entry
 * through the recorder after an approval (spec #204's doctrine). If the
 * model forgets to record, the next stop re-prompts — fail-closed, safe
 * by construction.
 */

/** The tool the loop calls at the stop — the gate's trigger surface. */
export const PLAN_REVIEW_TOOL_NAME = "theta_plan_review";

/** The notebook's location under the session cwd — the recorder's own. */
const NOTEBOOK_RELATIVE = path.join(".theta", "notebook.jsonl");

/** What one plan-review stop's checks can see. */
interface PlanReviewEnv {
	ctx: PlanReviewContext;
	planPath: string;
	digest: string;
}

/** The context the stop needs: the framework's, plus the session cwd. */
type PlanReviewContext = GateContext & Pick<ExtensionContext, "cwd">;

/**
 * The durable-approval check: the latest decision entry citing this plan
 * at this revision decides the stop before any dialog opens.
 */
const durableApprovalCheck: GateCheck<PlanReviewEnv> = {
	name: "durable-approval",
	run: async ({ ctx, planPath, digest }) => {
		const file = path.join(ctx.cwd, NOTEBOOK_RELATIVE);
		let content: string;
		try {
			content = await fs.readFile(file, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
		const lines = content.split("\n");
		if (lines.at(-1) === "") lines.pop();
		let latest: { decision: "approved" | "refused" } | undefined;
		for (let i = 0; i < lines.length; i++) {
			// blank lines ride along: the recorder skips them too
			if (lines[i].trim() === "") continue;
			let entry: unknown;
			try {
				entry = JSON.parse(lines[i]);
			} catch {
				return {
					decision: "refused" as const,
					reason: `the notebook at ${NOTEBOOK_RELATIVE} is not valid JSONL (line ${i + 1}) — the plan-review gate refuses rather than prompt over a corrupt provenance ledger; repair the notebook before Execute`,
				};
			}
			if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
				return {
					decision: "refused" as const,
					reason: `the notebook at ${NOTEBOOK_RELATIVE} carries a non-entry line (line ${i + 1}) — the plan-review gate refuses rather than prompt over a corrupt provenance ledger; repair the notebook before Execute`,
				};
			}
			const record = entry as Record<string, unknown>;
			if (
				record.type === "decision" &&
				record.planPath === planPath &&
				record.planRevision === digest &&
				(record.decision === "approved" || record.decision === "refused")
			) {
				latest = { decision: record.decision };
			}
		}
		if (latest === undefined) return undefined;
		return latest.decision === "approved"
			? { decision: "approved" as const }
			: {
					decision: "refused" as const,
					reason: `${planPath} at revision ${digest} was refused by the plan-review gate — the notebook's latest decision for this plan at this revision is a recorded refusal (a refusal is provenance the same way); a new revision needs a new decision. Never proceed the stop unprompted`,
				};
	},
};

/**
 * The confirm check: the one dialog, naming the plan, its revision, and
 * the digest the stop weighed.
 */
const confirmCheck: GateCheck<PlanReviewEnv> = {
	name: "confirm",
	run: async ({ ctx, planPath, digest }) => {
		const approved = await ctx.ui.confirm(
			"theta plan-review gate",
			`Allow Execute for plan ${planPath} at revision ${digest}? The stop gates Execute for this run.`,
		);
		return approved
			? { decision: "approved" as const }
			: {
					decision: "refused" as const,
					reason: `${planPath} at revision ${digest} was refused by the plan-review gate — the dialog's answer declined Execute; ask the user to approve the plan, never proceed the stop unprompted`,
				};
	},
};

/** The stack, in run order: the durable record decides before anything asks. */
const CHECKS: readonly GateCheck<PlanReviewEnv>[] = [
	durableApprovalCheck,
	confirmCheck,
];

export function createPlanReviewTool(options: { log?: GateLogSink } = {}) {
	return defineTool({
		name: PLAN_REVIEW_TOOL_NAME,
		label: "Plan review",
		description: [
			"The plan-review stop between Design and Execute (spec #203). Call it once the run's plan object is written, passing the plan's recorded path.",
			"The gate digests the plan on disk and looks for a recorded approved decision citing that revision — the durable approval, no dialog.",
			"Without one it asks the user to confirm this run may Execute.",
			"A refusal blocks Execute for this run; ask the user, never retry unprompted.",
			"After an approval, record the decision with the theta-notebook recorder so future stops pass without a dialog.",
		].join(" "),
		parameters: Type.Object({
			planPath: Type.String({
				description:
					"The plan object's recorded path — .theta/plans/<plan-id>.md, the form every plan operation reports",
			}),
		}),
		async execute(toolCallId, params, _signal, _onUpdate, ctx) {
			// Grammar first: a path outside the plan-id grammar names no plan
			// object, so it refuses before any read.
			if (!isPlanPath(params.planPath)) {
				throw new Error(
					`${PLAN_REVIEW_TOOL_NAME}: ${JSON.stringify(params.planPath)} is not a plan object path (.theta/plans/<date>-<slug>.md) — pass the path the recorder's plan operations report; never proceed the stop unprompted`,
				);
			}
			// The revision the stop weighs is the file's current digest — read
			// from disk, never assumed. A missing plan refuses: the stop never
			// approves a plan it cannot read.
			let bytes: Buffer;
			try {
				bytes = await fs.readFile(path.join(ctx.cwd, params.planPath));
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") {
					throw new Error(
						`${PLAN_REVIEW_TOOL_NAME}: no plan file at ${params.planPath} — the plan was deleted or never written; the stop refuses rather than approve a plan it cannot read; never proceed the stop unprompted`,
					);
				}
				throw error;
			}
			const digest = planRevisionOf(bytes);
			const decided = await runGateChecks(CHECKS, {
				ctx,
				planPath: params.planPath,
				digest,
			});
			if (decided === undefined) {
				// Unreachable: the confirm check always decides.
				throw new Error(`${PLAN_REVIEW_TOOL_NAME}: the check stack decided nothing`);
			}
			writeGateDecision(ctx, options, {
				check: decided.check,
				verdict: decided.verdict,
				tool: PLAN_REVIEW_TOOL_NAME,
				toolCallId,
			});
			if (decided.verdict.decision !== "approved") {
				throw new Error(decided.verdict.reason);
			}
			const durable = decided.check === "durable-approval";
			return {
				content: [
					{
						type: "text",
						text: durable
							? `plan ${params.planPath} revision ${digest}: approved for Execute — a recorded approved decision cites this revision (the durable approval; no dialog)`
							: `plan ${params.planPath} revision ${digest}: approved for Execute for this run — the user confirmed the stop. Record the decision with the theta-notebook recorder (--decision ... --plan-cite ${planIdOf(params.planPath)} --revision ${digest} --verdict approved) so future stops pass without a dialog`,
					},
				],
				details: { check: decided.check, digest, planPath: params.planPath },
			};
		},
	});
}

/** The plan id inside a grammar-valid plan path — the recorder's citation form. */
function planIdOf(planPath: string): string {
	return path.basename(planPath, ".md");
}

export default function (pi: ExtensionAPI) {
	pi.registerTool(createPlanReviewTool());
}
