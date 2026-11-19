import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Theta — science co-researcher extension for the pi coding agent.
 * Status: 0.6.0. M1 through M5 shipped the theta launcher, the Tier-1
 * research-loop skill library, the theta-lit-search connector, the
 * theta-notebook project notebook, the theta-compute compute gateway
 * (served cluster-side) with the stacked submit gate (submit-gate.ts)
 * confirming its destructive calls, and the M5 safety gates — the
 * deploy-time submit capability and per-principal submit ceiling
 * server-side, the gate log client-side. M6 shipped the eval suite —
 * replay net fixtures pinned per model-visible surface class and
 * benchmark tasks graded workspace-as-oracle in the rig.
 */
export default function (pi: ExtensionAPI) {
	pi.registerCommand("theta", {
		description: "Show Theta agent status",
		handler: async (_args, ctx) => {
			ctx.ui.notify(
				"Theta — M1 through M6 complete: the theta launcher, the Tier-1 research-loop skill library, the theta-lit-search connector, the theta-notebook project notebook, the theta-compute compute gateway behind the stacked submit gate, the M5 safety gates — the submit capability and submit ceiling server-side — and the M6 eval suite, replay net plus benchmark layer",
				"info",
			);
		},
	});
}
