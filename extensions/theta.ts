import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Theta — science co-researcher extension for the pi coding agent.
 * Status: 0.4.0. M1+M2+M3+M4 shipped the theta launcher, the Tier-1
 * research-loop skill library, the theta-lit-search connector, the
 * theta-notebook project notebook, and the theta-compute compute gateway
 * (served cluster-side) with the submit gate (submit-gate.ts) that
 * confirms its destructive calls.
 */
export default function (pi: ExtensionAPI) {
	pi.registerCommand("theta", {
		description: "Show Theta agent status and roadmap",
		handler: async (_args, ctx) => {
			ctx.ui.notify(
				"Theta — M1+M2+M3+M4 complete: the theta launcher, the Tier-1 research-loop skill library, the theta-lit-search connector, the theta-notebook project notebook, and the theta-compute compute gateway behind the submit gate",
				"info",
			);
			ctx.ui.notify(
				"Next: safety (M5), eval suite (M6)",
				"info",
			);
		},
	});
}
