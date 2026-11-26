import type {
	ExtensionAPI,
	ToolCallEvent,
	ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import {
	type GateCheck,
	type GateContext,
	type GateLogSink,
	runGateChecks,
	writeGateDecision,
	GATE_LOG_NAME,
} from "./gate-framework.ts";

/**
 * The Submit gate — the package's tool-call-pipeline permission extension
 * (spec #54 → #95, ADR 0004; the gate-framework instance of ADR 0006). A
 * stack of checks judges every theta-compute gateway call before it
 * reaches the gateway; read-only gateway tools run ungated. The framework
 * (the decision vocabulary, the stack, the verdicts, the log's line shape
 * and sink) lives in gate-framework.ts since spec #203's extraction; this
 * file keeps the submit gate's specifics — its trigger surface, its two
 * checks, and the pipeline mapping — and is byte-for-byte unchanged in
 * behavior.
 */

// The shared log name re-exports so the gate's own imports (and the pins
// that read them) keep one home to import from.
export { GATE_LOG_NAME };

/**
 * pi registers MCP tools as `mcp__<server>__<tool>`, sanitized: every
 * character outside [A-Za-z0-9_] becomes `_` (pi's `createMcpToolName`) —
 * so the hyphen in the server's registered name lands as an underscore
 * here. pi refuses a second server whose name differs only in `-` vs `_`,
 * so this prefix names exactly one server namespace either way.
 */
export const GATEWAY_PREFIX = "mcp__theta_compute__";

/**
 * The confirm set — the gateway's destructive tools by name: the cluster
 * spenders and the cancellation (GLOSSARY's Submit gate definition, made
 * literal). Codemode-nested calls arrive under the same names, so the set
 * covers them without a second criterion. The gateway server declares
 * exactly these three `destructiveHint` (gateway/server.py); the drift
 * check below refuses a call where its name and the server's declaration
 * disagree, so neither side can drift silently.
 */
export const CONFIRM_SET: ReadonlySet<string> = new Set([
	"submit_job",
	"cancel_job",
	"run_alphafold3",
]);

/** The looked-up gateway tool whose annotations the checks read. */
interface GatewayTool {
	name: string;
	annotations?: { destructiveHint?: boolean };
}

/** What one gateway call's checks can see: the event, the ctx, the tool. */
interface SubmitEnv {
	event: ToolCallEvent;
	ctx: GateContext;
	tool: GatewayTool | undefined;
}

/**
 * The gate only judges calls in the gateway's namespace, and narrowing the
 * union by prefix is exactly what the built-in tools can never match.
 */
function isGatewayCall(
	event: ToolCallEvent,
): event is ToolCallEvent & { toolName: string; input: Record<string, unknown> } {
	return event.toolName.startsWith(GATEWAY_PREFIX);
}

/** The call's name without the gateway prefix — the set's vocabulary. */
function shortToolName(toolName: string): string {
	return toolName.slice(GATEWAY_PREFIX.length);
}

/** The one-line target of the call, for the prompt and the refusal. */
function describeCall(toolName: string, input: Record<string, unknown>): string {
	const short = shortToolName(toolName);
	if (typeof input.run_name === "string") return `${short} for run "${input.run_name}"`;
	if (input.job_id !== undefined) return `${short} for job ${String(input.job_id)}`;
	return short;
}

/** The nested-call attribution that rides prompts, refusals, and logs. */
function nestedUnder(event: ToolCallEvent): string {
	return event.parentToolCallId !== undefined
		? ` (nested under tool call ${event.parentToolCallId})`
		: "";
}

/**
 * The drift check: the confirm set and the server's annotations must name
 * the same destructive tools. A disagreement — a set tool the server no
 * longer marks destructive, or a destructive-marked tool outside the set —
 * blocks the call loudly instead of confirming some third set silently;
 * read-only tools agree on "neither" and pass.
 */
const driftCheck: GateCheck<SubmitEnv> = {
	name: "confirm-set",
	run: ({ event, tool }) => {
		const short = shortToolName(event.toolName);
		const inSet = CONFIRM_SET.has(short);
		const declared = tool?.annotations?.destructiveHint === true;
		if (inSet === declared) return undefined;
		return {
			decision: "drift" as const,
			reason:
				`the gateway ${
					inSet
						? `no longer declares ${short} destructive, but the confirm set names it`
						: `declares ${short} destructive, but the confirm set does not name it`
				} — the annotations and the confirm set drifted; reconcile them before this call can run`,
		};
	},
};

/**
 * The confirm check: the M4 behavior — a confirm-set call is confirmed
 * with the user before it reaches the gateway. Nested calls carry the
 * parent attribution into the dialog, so the user answering sees who is
 * spending the cluster time.
 */
const confirmCheck: GateCheck<SubmitEnv> = {
	name: "confirm",
	run: async ({ event, ctx }) => {
		const short = shortToolName(event.toolName);
		if (!CONFIRM_SET.has(short)) return undefined;
		const description = describeCall(event.toolName, event.input);
		const nested = event.parentToolCallId !== undefined;
		const approved = await ctx.ui.confirm(
			"theta-compute submit gate",
			`Allow the gateway call ${description}? This spends or stops cluster work.${
				nested ? ` The call comes from another tool (parent call ${event.parentToolCallId}).` : ""
			}`,
		);
		return approved
			? { decision: "approved" as const }
			: {
					decision: "refused" as const,
					reason: `${description}${nestedUnder(event)} was refused by the submit gate — ask the user to approve it in the confirm dialog, never retry it unprompted`,
				};
	},
};

/** The stack, in run order: drift refuses before anything asks the user. */
const CHECKS: readonly GateCheck<SubmitEnv>[] = [driftCheck, confirmCheck];

export function createSubmitGate(
	pi: Pick<ExtensionAPI, "getAllTools">,
	options: { log?: GateLogSink } = {},
) {
	return async (
		event: ToolCallEvent,
		ctx: GateContext,
	): Promise<ToolCallEventResult | undefined> => {
		if (!isGatewayCall(event)) return undefined;
		const tool = pi.getAllTools().find((t) => t.name === event.toolName);
		const decided = await runGateChecks(CHECKS, { event, ctx, tool });
		if (decided === undefined) return undefined;
		writeGateDecision(ctx, options, {
			check: decided.check,
			verdict: decided.verdict,
			tool: event.toolName,
			toolCallId: event.toolCallId,
			parentToolCallId: event.parentToolCallId,
		});
		return decided.verdict.decision === "approved"
			? undefined
			: { block: true, reason: decided.verdict.reason };
	};
}

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", createSubmitGate(pi));
}
