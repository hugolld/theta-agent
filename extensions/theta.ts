import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Theta — science co-researcher extension for the pi coding agent.
 * Status: 0.0.2 skeleton. Connector/compute tools arrive in later milestones.
 */
export default function (pi: ExtensionAPI) {
	pi.registerCommand("theta", {
		description: "Show Theta agent status and roadmap",
		handler: async (_args, ctx) => {
			ctx.ui.notify("Theta 0.0.2 — launcher release", "info");
			ctx.ui.notify(
				"Planned: science skills (M1), literature connectors (M2), provenance (M3), Slurm compute gateway (M4), safety (M5), eval suite (M6)",
				"info",
			);
		},
	});
}
