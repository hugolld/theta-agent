import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Theta — science co-researcher extension for the pi coding agent.
 * Status: 0.3.0, M4 in flight. M1+M2+M3 shipped the theta launcher, the
 * Tier-1 research-loop skill library, the theta-lit-search connector, and
 * the theta-notebook project notebook. M4 adds the theta-compute compute
 * gateway (served cluster-side) and the submit gate (submit-gate.ts) that
 * confirms its destructive calls; job records in the notebook and the M4
 * closeout are the remaining M4 strikes.
 */
export default function (pi: ExtensionAPI) {
	pi.registerCommand("theta", {
		description: "Show Theta agent status and roadmap",
		handler: async (_args, ctx) => {
			ctx.ui.notify(
				"Theta — M1+M2+M3 complete: the theta launcher, the Tier-1 research-loop skill library, the theta-lit-search connector, and the theta-notebook project notebook; M4 in flight: the theta-compute gateway behind the submit gate",
				"info",
			);
			ctx.ui.notify(
				"Next: job records in the notebook (M4), safety (M5), eval suite (M6)",
				"info",
			);
		},
	});
}
