import fs from "node:fs";
import path from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
	ToolCallEvent,
	ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";

/**
 * The Submit gate — the package's tool-call-pipeline permission extension
 * (spec #54 → #95, ADR 0004; the gate-framework instance of ADR 0006). A
 * stack of checks judges every theta-compute gateway call before it
 * reaches the gateway; read-only gateway tools run ungated. The confirm
 * set is the three destructive tools BY NAME (the GLOSSARY's literal
 * definition), pinned against the gateway's own MCP annotations — the
 * server stays the single source of what is destructive, and a call where
 * the two disagree is a drift the gate refuses loudly rather than a set
 * it silently re-derives. Codemode-nested calls carry the same tool names
 * through the pipeline (parentToolCallId links the layers), so the stack
 * gates them exactly like direct ones and every log line and refusal
 * names the parent call that spawned them.
 */

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

/**
 * The gate log's file name. The log lands beside the session transcript
 * (the session dir is the evidence channel: `--session-dir` captures it
 * with the run), one JSONL line per gated decision — never for ungated
 * calls, which stay frictionless by design.
 */
export const GATE_LOG_NAME = "gate.jsonl";

/** What a check decided — the gate log's decision vocabulary. */
export type GateDecision = "approved" | "refused" | "drift";

/** One gate log line, fielded like the gateway's audit lines (sorted). */
export interface GateLogLine {
	check: string;
	decision: GateDecision;
	parentToolCallId?: string;
	reason?: string;
	tool: string;
	toolCallId: string;
	ts: string;
}

/** Where gate log lines go; the default appends to the session dir. */
export type GateLogSink = (line: GateLogLine) => void;

/** The context the checks and the log need from the handler's ctx. */
type GateContext = Pick<ExtensionContext, "ui" | "sessionManager">;

/** The looked-up gateway tool whose annotations the checks read. */
interface GatewayTool {
	name: string;
	annotations?: { destructiveHint?: boolean };
}

/**
 * One check in the stack. `undefined` passes the call to the next check
 * (or through the gate, at the stack's end — ungated calls pass every
 * check by construction); a verdict ends the stack: "approved" passes the
 * call through, "refused" and "drift" block it. Checks hold no state
 * across events, so stacked confirms — two destructive calls pending
 * their dialogs at once, resolved in any order — cannot cross wires; pi
 * 1.4.0's concurrent-dialog fix is the floor that makes stacking sound
 * (before it, a second confirm dialog replaced the first and the first
 * promise never settled).
 */
interface GateCheck {
	name: string;
	run: (
		event: ToolCallEvent,
		ctx: GateContext,
		tool: GatewayTool | undefined,
	) => Promise<CheckVerdict | undefined> | CheckVerdict | undefined;
}

interface CheckVerdict {
	decision: GateDecision;
	reason?: string;
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

/** The one-line target of the call, for the prompt and the refusal. */
function describeCall(toolName: string, input: Record<string, unknown>): string {
	const short = toolName.slice(GATEWAY_PREFIX.length);
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
const driftCheck: GateCheck = {
	name: "confirm-set",
	run: (event, _ctx, tool) => {
		const short = event.toolName.slice(GATEWAY_PREFIX.length);
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
const confirmCheck: GateCheck = {
	name: "confirm",
	run: async (event, ctx) => {
		const short = event.toolName.slice(GATEWAY_PREFIX.length);
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
const CHECKS: readonly GateCheck[] = [driftCheck, confirmCheck];

/** The default sink: one appended line beside the session transcript. */
function sessionLogSink(ctx: GateContext): GateLogSink | undefined {
	const sessionFile = ctx.sessionManager.getSessionFile();
	if (sessionFile === undefined) return undefined; // nothing persistent to write beside
	const file = path.join(path.dirname(sessionFile), GATE_LOG_NAME);
	return (line) => fs.appendFileSync(file, `${JSON.stringify(line)}\n`);
}

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
		for (const check of CHECKS) {
			const verdict = await check.run(event, ctx, tool);
			if (verdict === undefined) continue;
			// The log is the audit trail, not the gate: the confirm above is
			// the safety mechanism, so a log that cannot write must never
			// change the decision — the failure is swallowed here.
			const line: GateLogLine = {
				check: check.name,
				decision: verdict.decision,
				parentToolCallId: event.parentToolCallId,
				reason: verdict.reason,
				tool: event.toolName,
				toolCallId: event.toolCallId,
				ts: new Date().toISOString(),
			};
			try {
				// a context with no session manager (an in-memory test
				// stub) resolves to no sink and logs nowhere
				(options.log ?? sessionLogSink(ctx))?.(line);
			} catch {
				// best-effort by design — see above
			}
			return verdict.decision === "approved"
				? undefined
				: { block: true, reason: verdict.reason ?? "refused by the submit gate" };
		}
		return undefined;
	};
}

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", createSubmitGate(pi));
}
