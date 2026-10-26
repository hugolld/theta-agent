import type {
	ExtensionAPI,
	ExtensionContext,
	ToolCallEvent,
	ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";

/**
 * The submit gate — the package's first tool-call-pipeline extension
 * (spec #54, ADR 0004). Destructive theta-compute gateway calls (the ones
 * its MCP annotations mark destructive: submit_job, cancel_job,
 * run_alphafold3 — every one of them a cluster submission or a cancellation)
 * are confirmed with the user before they reach the gateway; every other
 * call passes through untouched. The gateway itself declares the hints; this
 * gate only reads them, so the server side stays the single source of what
 * is destructive. M5's gate framework extends this shape.
 */

/**
 * pi registers MCP tools as `mcp__<server>__<tool>`, sanitized: every
 * character outside [A-Za-z0-9_] becomes `_` (pi's `createMcpToolName`) —
 * so the hyphen in the server's registered name lands as an underscore
 * here. pi refuses a second server whose name differs only in `-` vs `_`,
 * so this prefix names exactly one server namespace either way.
 */
const GATEWAY_PREFIX = "mcp__theta_compute__";

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

export function createSubmitGate(pi: Pick<ExtensionAPI, "getAllTools">) {
	return async (event: ToolCallEvent, ctx: Pick<ExtensionContext, "ui">): Promise<ToolCallEventResult | undefined> => {
		if (!isGatewayCall(event)) return undefined;
		const annotations = pi
			.getAllTools()
			.find((tool) => tool.name === event.toolName)?.annotations;
		if (annotations?.destructiveHint !== true) return undefined;
		const description = describeCall(event.toolName, event.input);
		const approved = await ctx.ui.confirm(
			"theta-compute submit gate",
			`Allow the gateway call ${description}? This spends or stops cluster work.`,
		);
		if (approved) return undefined;
		return {
			block: true,
			reason: `${description} was refused by the submit gate — ask the user to approve it in the confirm dialog, never retry it unprompted`,
		};
	};
}

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", createSubmitGate(pi));
}
