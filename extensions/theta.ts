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

/** The shipped brand theme (themes/theta.json), switched to at session start. */
export const THETA_THEME_NAME = "theta";

/** The branded footer segment — static ASCII bytes, set for the whole session. */
export const THETA_STATUS_LINE = "theta - science co-researcher";

export default function (pi: ExtensionAPI) {
	// The brand surface (demo doctrine B5, docs/agents/demo.md): a
	// persistent footer segment plus the session-start theme switch. Both
	// are additive dressing — no built-in surface is replaced. The switch
	// fires only when the user set no theme preference (a saved choice or
	// a --use-theme override both count — the effective settings carry
	// either) and only where a TUI renders it. It must not mutate
	// settings: setTheme(name) persists the choice into the user's
	// settings, so the switch loads the registered theme by name and
	// applies the instance — render-only, marked "<in-memory>" (an
	// unresolvable name yields undefined and the switch silently skips —
	// branding never announces itself, and the demo's visual capture is
	// the proof the theme resolved).
	pi.on("session_start", (_event, ctx) => {
		if (ctx.hasUI) {
			ctx.ui.setStatus("theta", THETA_STATUS_LINE);
		}
		if (ctx.mode === "tui" && !pi.getSettings().theme) {
			const theme = ctx.ui.getTheme(THETA_THEME_NAME);
			if (theme) ctx.ui.setTheme(theme);
		}
	});

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
