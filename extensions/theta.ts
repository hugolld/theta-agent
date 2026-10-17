import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Theta — science co-researcher extension for the pi coding agent.
 * Status: 0.2.0. M1+M2 shipped: the theta launcher, the Tier-1 research-loop
 * skill library, and the first connector skill (theta-lit-search). Provenance
 * and compute tools arrive in later milestones.
 */
export default function (pi: ExtensionAPI) {
	pi.registerCommand("theta", {
		description: "Show Theta agent status and roadmap",
		handler: async (_args, ctx) => {
			ctx.ui.notify(
				"Theta — M1+M2 complete: the theta launcher, the Tier-1 research-loop skill library, and the theta-lit-search connector",
				"info",
			);
			ctx.ui.notify(
				"Next: provenance (M3), Slurm compute gateway (M4), safety (M5), eval suite (M6)",
				"info",
			);
		},
	});
}
