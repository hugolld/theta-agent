import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { createJiti } from "jiti";
import { recordedNotify } from "./helpers/recorded-notify.mjs";
import { recordedRegister } from "./helpers/registered-command.mjs";

// The /roadmap command (spec #186, demo doctrine B4 —
// docs/agents/demo.md): the owner-reviewed future-plans card drawn on
// demand — static bytes, no file reads, no dynamic state. The review's
// teeth are here as suite pins: the card mapping freezes the reviewed
// bytes verbatim (any drift reds), the mode degradation pins the demo
// doctrine's constraint — the custom surface in interactive mode, one
// notify in RPC, the swallowed no-op in print and JSON — and the
// theta.ts handover pins /roadmap as the single roadmap home. Loaded
// through jiti, the loader pi runs extensions with.
const jiti = createJiti(import.meta.url);
const { default: registerRoadmapCommand, roadmapCard, ROADMAP_COMMAND_NAME } = await jiti.import(
	"../extensions/roadmap-command.ts",
);

// The reviewed card, settled 2026-11-19 (issue #186): every line
// vault-grounded, no calendar dates, future-only — the bytes this suite
// freezes against the source's mapping.
const REVIEWED_CARD = [
	"Theta - the road ahead",
	"",
	"Web workbench (M7b)",
	"  The same research loop in the browser,",
	"  with no terminal needed.",
	"  In design; not started yet.",
	"",
	"Cloud deployment study",
	"  Asking whether Theta itself can run on cloud",
	"  infrastructure instead of the lab's own machines.",
	"  Under evaluation - no commitment yet.",
	"",
	"Packaging (M8)",
	"  One-command install on the lab's own machines,",
	"  with Windows support after that.",
];

function registeredCommand() {
	const registered = recordedRegister(registerRoadmapCommand);
	assert.equal(registered.length, 1);
	return registered[0];
}

// --- the card mapping --------------------------------------------------------

test("the card mapping renders the reviewed bytes verbatim — drift reds by test", () => {
	assert.deepEqual(roadmapCard(), REVIEWED_CARD);
});

// --- the registration and the interactive draw -------------------------------

test("the command registers as /roadmap, its description naming the beats", () => {
	const command = registeredCommand();
	assert.equal(command.name, ROADMAP_COMMAND_NAME);
	assert.equal(command.name, "roadmap");
	assert.equal(
		command.options.description,
		"Show the road ahead: the web workbench, the cloud deployment study, packaging",
	);
});

test("interactive mode draws the card on the custom surface and never notifies", async () => {
	const command = registeredCommand();
	const factories = [];
	const ctx = {
		mode: "tui",
		ui: {
			custom: (factory) => {
				factories.push(factory);
				return Promise.resolve(undefined);
			},
			// no notify on this stub: the interactive path must not touch it
		},
	};
	await command.options.handler("", ctx);
	assert.equal(factories.length, 1);
	// Draw the composed card: the real Box/Text/Spacer stack under an
	// identity theme — every reviewed line must render, and the blank
	// separators must render too (a Text child swallows blank bytes, so
	// the separators ride Spacer lines; the line count catches a
	// swallowed one). The Box adds its own padding line top and bottom.
	const dones = [];
	const component = factories[0](
		undefined, // the tui instance — the card reads none of it
		{ bg: (_token, text) => text, bold: (text) => text },
		{
			matches: (data, action) =>
				(action === "tui.select.confirm" && data === "\r") ||
				(action === "tui.select.cancel" && data === "\x1b"),
		},
		() => dones.push(true),
	);
	const rendered = component.render(80);
	assert.equal(rendered.length, REVIEWED_CARD.length + 2);
	const flat = rendered.join("\n");
	for (const line of REVIEWED_CARD) {
		assert.ok(flat.includes(line), `the card must draw its reviewed line: ${JSON.stringify(line)}`);
	}
	// A confirm key closes the card.
	component.handleInput("\r");
	assert.equal(dones.length, 1);
});

// --- the degradation ---------------------------------------------------------

test("outside interactive mode the card degrades to one notify — RPC forwards it, print and JSON swallow it", async () => {
	const command = registeredCommand();
	for (const mode of ["rpc", "print", "json"]) {
		const { calls, notify } = recordedNotify();
		// The only UI method this context offers is notify — a custom() or
		// dialog call would throw against the stub, the degradation pin.
		const ctx = { mode, ui: { notify } };
		await command.options.handler("", ctx);
		assert.deepEqual(calls, [{ message: roadmapCard().join("\n"), level: "info" }], mode);
	}
});

// --- the theta.ts handover ---------------------------------------------------

test("the theta.ts handover: /roadmap is the single roadmap home — no roadmap line left in /theta", async () => {
	const source = await readFile(new URL("../extensions/theta.ts", import.meta.url), "utf8");
	// The description's roadmap claim left with the handover; any return
	// of the token is drift.
	assert.ok(!/roadmap/i.test(source), "extensions/theta.ts still mentions the roadmap — /roadmap owns it now");
	// The dropped next-milestone notify carries no "roadmap" token of its
	// own, so its bytes need their own absence pin — else a re-add stays
	// green under the token pin above.
	assert.ok(
		!source.includes("Next: the standalone theta shell on pi's headless core (M7)"),
		"the stale next-milestone notify line returned to /theta",
	);
});
