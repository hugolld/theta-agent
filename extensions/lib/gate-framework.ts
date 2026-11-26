import fs from "node:fs";
import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * The gate framework (spec #95 → #203): the shared pieces of the package's
 * tool-gating extensions — the decision vocabulary, the check stack, the
 * verdict type, the gate log's line shape and sink — extracted from
 * submit-gate.ts on its second use, the plan-review gate. This module is a
 * library, not an extension: it lives under `extensions/lib/`, a directory
 * pi's extension discovery skips (no index file, no pi manifest), so no
 * session loads it as an extension. Each gate keeps its own specifics (its
 * trigger surface, its checks, its result mapping) and takes the
 * framework's two disciplines: a verdict ends the stack and every refusal
 * carries a reason, and the log is the audit trail, never the gate — a
 * log-write failure never changes the decision.
 */

/**
 * The gate log's file name. The log lands beside the session transcript
 * (the session dir is the evidence channel: `--session-dir` captures it
 * with the run), one JSONL line per gated decision — never for ungated
 * calls, which stay frictionless by design. One ledger renders every
 * gate: each line's `tool` names the gate and its `check` the check that
 * decided.
 */
export const GATE_LOG_NAME = "gate.jsonl";

/** What a check decided — the gate log's decision vocabulary. */
export type GateDecision = "approved" | "refused" | "drift";

/**
 * A check's verdict: "approved" passes the call through; a refusing
 * decision carries its reason — the type has no refusing-without-a-reason
 * shape, so no block can reach the model wordless.
 */
export type CheckVerdict =
	| { decision: "approved" }
	| { decision: Exclude<GateDecision, "approved">; reason: string };

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

/** The context the checks and the log need from a handler's ctx. */
export type GateContext = Pick<ExtensionContext, "ui" | "sessionManager">;

/**
 * One check in a gate's stack. `undefined` passes the call to the next
 * check (or through the gate, at the stack's end — ungated calls pass
 * every check by construction); a verdict ends the stack. Checks hold no
 * state across events, so stacked confirms — two dialogs pending their
 * answers at once, resolved in any order — cannot cross wires; pi 1.4.0's
 * concurrent-dialog fix is the floor that makes stacking sound (before
 * it, a second confirm dialog replaced the first and the first promise
 * never settled).
 */
export interface GateCheck<Env> {
	name: string;
	run: (env: Env) => Promise<CheckVerdict | undefined> | CheckVerdict | undefined;
}

/**
 * The stack runner: each check in order, first verdict wins. The
 * framework's stack semantics live here so no gate re-derives them; the
 * caller logs the returned verdict and maps it to its own result shape.
 */
export async function runGateChecks<Env>(
	checks: readonly GateCheck<Env>[],
	env: Env,
): Promise<{ check: string; verdict: CheckVerdict } | undefined> {
	for (const check of checks) {
		const verdict = await check.run(env);
		if (verdict === undefined) continue;
		return { check: check.name, verdict };
	}
	return undefined;
}

/** The default sink: one appended line beside the session transcript. */
export function sessionLogSink(ctx: GateContext): GateLogSink | undefined {
	// a context with no session manager (an in-memory test stub) logs
	// nowhere — a guard, not a swallowed failure
	const sessionFile = ctx.sessionManager?.getSessionFile();
	if (sessionFile === undefined) return undefined; // nothing persistent to write beside
	const file = path.join(path.dirname(sessionFile), GATE_LOG_NAME);
	return (line) => fs.appendFileSync(file, `${JSON.stringify(line)}\n`);
}

/**
 * The log discipline every gate shares: the line assembles with its
 * timestamp, the sink is the injected one or the session dir's, and the
 * write is best-effort — the confirm (or the durable approval) above is
 * the safety mechanism, so a log that cannot write must never change the
 * decision. The failure is swallowed here, by design.
 */
export function writeGateDecision(
	ctx: GateContext,
	options: { log?: GateLogSink },
	entry: { check: string; verdict: CheckVerdict; tool: string; toolCallId: string; parentToolCallId?: string },
): void {
	const line: GateLogLine = {
		check: entry.check,
		decision: entry.verdict.decision,
		parentToolCallId: entry.parentToolCallId,
		reason: entry.verdict.decision === "approved" ? undefined : entry.verdict.reason,
		tool: entry.tool,
		toolCallId: entry.toolCallId,
		ts: new Date().toISOString(),
	};
	try {
		(options.log ?? sessionLogSink(ctx))?.(line);
	} catch {
		// best-effort by design — see above
	}
}
