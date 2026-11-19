import { Box, Spacer, Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * The /roadmap command (spec #186, demo doctrine B4 —
 * docs/agents/demo.md): the future-plans card drawn on demand — the
 * seminar script's step 5, the demo's closing beat. The card is the
 * owner-reviewed prose (settled 2026-11-19, every line vault-grounded):
 * no calendar dates — qualitative status only — future-only, milestone
 * tags on the milestone beats, the cloud beat a study with its explicit
 * no-commitment line, packaging framed as researcher benefit. Static
 * bytes: no file reads, no dynamic state — the reviewed words are the
 * product, so they live here as data and drift reds by test.
 *
 * The demo doctrine's mode constraint: complete in interactive mode,
 * where the handler draws the card as a Box composition on the
 * custom-UI surface (ctx.ui.custom(), the B1 renderer's Box/Text
 * pattern); RPC forwards notifications but not custom components, so
 * the degradation is notify-only — one notify carrying the card's plain
 * text (the B2 single-notify rule, an info notify a following one
 * overwrites in place); print and JSON are a silent no-op, their no-op
 * UI swallowing the notify. Unstyled chrome: B5 brands the box later.
 */

/** The command's invocation name — /roadmap. */
export const ROADMAP_COMMAND_NAME = "roadmap";

/** The card's header line. */
const ROADMAP_TITLE = "Theta - the road ahead";

/** One future beat: a titled stance with its prose lines, in review order. */
interface RoadmapBeat {
	/** The beat's title — its milestone tag rides inline ("(M7b)"). */
	title: string;
	/** The beat's prose lines, each already review-final. */
	lines: string[];
}

/** The reviewed card's three beats, in review order. */
const ROADMAP_BEATS: RoadmapBeat[] = [
	{
		title: "Web workbench (M7b)",
		lines: [
			"The same research loop in the browser,",
			"with no terminal needed.",
			"In design; not started yet.",
		],
	},
	{
		title: "Cloud deployment study",
		lines: [
			"Asking whether Theta itself can run on cloud",
			"infrastructure instead of the lab's own machines.",
			"Under evaluation - no commitment yet.",
		],
	},
	{
		title: "Packaging (M8)",
		lines: [
			"One-command install on the lab's own machines,",
			"with Windows support after that.",
		],
	},
];

/**
 * One card line with its role: a title line (the header or a beat's
 * title) is the composition's bold face; the blank separators between
 * beats are lines too — a Text child swallows blank bytes, so the
 * composition draws those as Spacer lines instead.
 */
interface RoadmapLine {
	text: string;
	title: boolean;
}

/**
 * The card's lines — the reviewed bytes, flat. One mapping home: the
 * unit test pins these bytes verbatim, the notify degradation sends
 * them joined, and the Box composition walks the same lines for the
 * interactive draw, so no surface can drift from the review.
 */
function roadmapLines(): RoadmapLine[] {
	const lines: RoadmapLine[] = [{ text: ROADMAP_TITLE, title: true }, { text: "", title: false }];
	for (const beat of ROADMAP_BEATS) {
		lines.push({ text: beat.title, title: true });
		for (const line of beat.lines) lines.push({ text: `  ${line}`, title: false });
		lines.push({ text: "", title: false });
	}
	lines.pop(); // the last beat needs no separator after it
	return lines;
}

/** The reviewed card as flat bytes — the mapping the suite pins. */
export function roadmapCard(): string[] {
	return roadmapLines().map((line) => line.text);
}

export default function registerRoadmapCommand(pi: Pick<ExtensionAPI, "registerCommand">): void {
	pi.registerCommand(ROADMAP_COMMAND_NAME, {
		description: "Show the road ahead: the web workbench, the cloud deployment study, packaging",
		handler: async (_args, ctx) => {
			if (ctx.mode === "tui") {
				await ctx.ui.custom((_tui, theme, keybindings, done) => {
					const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
					for (const line of roadmapLines()) {
						if (line.text === "") box.addChild(new Spacer(1));
						else box.addChild(new Text(line.title ? theme.bold(line.text) : line.text, 1, 0));
					}
					return {
						render: (width: number) => box.render(width),
						invalidate: () => box.invalidate(),
						handleInput: (data: string) => {
							if (
								keybindings.matches(data, "tui.select.confirm") ||
								keybindings.matches(data, "tui.select.cancel")
							) {
								done(undefined);
							}
						},
					};
				});
				return;
			}
			ctx.ui.notify(roadmapCard().join("\n"), "info");
		},
	});
}
