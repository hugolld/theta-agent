import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Theta — science co-researcher extension for the pi coding agent.
 * Status: 0.3.0. M1+M2+M3 shipped: the theta launcher, the Tier-1 research-loop
 * skill library, the first connector skill (theta-lit-search), and the
 * theta-notebook project notebook. Compute tools arrive in later milestones.
 */
export default function (pi: ExtensionAPI) {
	pi.registerCommand("theta", {
		description: "Show Theta agent status and roadmap",
		handler: async (_args, ctx) => {
			ctx.ui.notify(
				"Theta — M1+M2+M3 complete: the theta launcher, the Tier-1 research-loop skill library, the theta-lit-search connector, and the theta-notebook project notebook",
				"info",
			);
			ctx.ui.notify(
				"Next: Slurm compute gateway (M4), safety (M5), eval suite (M6)",
				"info",
			);
		},
	});
}
