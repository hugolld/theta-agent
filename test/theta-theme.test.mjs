import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { createJiti } from "jiti";
import { recordedRegister } from "./helpers/registered-command.mjs";

// The Theta theme (spec #190, demo doctrine B5 — docs/agents/demo.md):
// the brand surface — `themes/theta.json` (teal brand colors on pi's dark
// base, shipped through the pi manifest) plus the theta.ts status line (a
// persistent branded footer segment and the in-memory session-start theme
// switch that respects an explicit user preference). The palette review's
// teeth are here as suite pins: the theme carries every schema-required
// role in pi's accepted color grammar with the brand roles on the teal
// family, and the switch/status wiring pins the settled activation rule —
// every theta session branded, an explicit theme choice respected, the
// TUI the only mode that switches. Loaded through jiti, the loader pi
// runs extensions with.
const jiti = createJiti(import.meta.url);
const { default: registerTheta, THETA_THEME_NAME, THETA_STATUS_LINE } = await jiti.import(
	"../extensions/theta.ts",
);

const theme = JSON.parse(await readFile(new URL("../themes/theta.json", import.meta.url), "utf8"));

// The roles pi's theme schema requires — pinned against the installed pi
// line's published schema (schemas/theme.schema.json under the pi install
// root); the theme floor is the package floor (pi >= 1.4.0). A role pi
// starts requiring reds here first, in the suite, not at boot.
const REQUIRED_ROLES = [
	"accent",
	"border",
	"borderAccent",
	"borderMuted",
	"success",
	"error",
	"warning",
	"muted",
	"dim",
	"text",
	"thinkingText",
	"selectedBg",
	"userMessageBg",
	"userMessageText",
	"customMessageBg",
	"customMessageText",
	"customMessageLabel",
	"toolPendingBg",
	"toolSuccessBg",
	"toolErrorBg",
	"toolTitle",
	"toolOutput",
	"mdHeading",
	"mdLink",
	"mdLinkUrl",
	"mdCode",
	"mdCodeBlock",
	"mdCodeBlockBorder",
	"mdQuote",
	"mdQuoteBorder",
	"mdHr",
	"mdListBullet",
	"toolDiffAdded",
	"toolDiffRemoved",
	"toolDiffContext",
	"syntaxComment",
	"syntaxKeyword",
	"syntaxFunction",
	"syntaxVariable",
	"syntaxString",
	"syntaxNumber",
	"syntaxType",
	"syntaxOperator",
	"syntaxPunctuation",
	"thinkingOff",
	"thinkingMinimal",
	"thinkingLow",
	"thinkingMedium",
	"thinkingHigh",
	"thinkingXhigh",
	"bashMode",
];

// The six color forms pi's theme grammar accepts: 3/6-digit sRGB hex,
// oklch(), okhsl(), a 0-255 ANSI palette index, a var reference, or the
// empty string (the terminal's own default). Everything else is rejected
// at boot with the theme down — this pin reds it in the suite first.
const COLOR_LITERAL = /^(?:#[0-9a-fA-F]{3}|#[0-9a-fA-F]{6}|oklch\([^)]*\)|okhsl\([^)]*\)|(?:[0-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-5])|)$/;

function resolveColor(value, vars, seen = new Set()) {
	if (typeof value === "number") return String(value);
	assert.equal(typeof value, "string", `a color value must be a string (got ${JSON.stringify(value)})`);
	if (COLOR_LITERAL.test(value) && !(value in vars)) return value;
	// A bare word that names a var is a reference; a bare word that is
	// neither a literal form nor a var name is invalid either way, so
	// resolve it as a reference and let the missing-var assert fire.
	assert.ok(value in vars, `unresolvable color value: ${JSON.stringify(value)}`);
	assert.ok(!seen.has(value), `circular var reference through ${JSON.stringify(value)}`);
	return resolveColor(vars[value], vars, new Set([...seen, value]));
}

// --- the theme file ----------------------------------------------------------

test("the theme names itself theta, dark-appearance, and ships as themes/theta.json", () => {
	assert.equal(theme.name, "theta");
	assert.equal(theme.appearance, "dark");
	// pi reserves "system" and the "/" separator; a violation ignores the
	// theme at boot.
	assert.ok(!theme.name.includes("/"));
});

test("the theme carries every schema-required role", () => {
	for (const role of REQUIRED_ROLES) {
		assert.ok(role in theme.colors, `colors.${role} is missing`);
	}
	// Strict theme objects: a token outside the schema's vocabulary is
	// rejected at boot, so no invented roles may ride along.
	const known = new Set([
		...REQUIRED_ROLES,
		"scrollbarTrack",
		"scrollbarThumb",
		"searchMatchBg",
		"searchMatchText",
		"thinkingMax",
	]);
	for (const role of Object.keys(theme.colors)) {
		assert.ok(known.has(role), `colors.${role} is not a schema role`);
	}
});

test("every color value sits in pi's grammar and every var reference resolves without cycles", () => {
	const surfaces = [
		...Object.entries(theme.colors).map(([role, value]) => [`colors.${role}`, value]),
		...Object.entries(theme.export ?? {}).map(([role, value]) => [`export.${role}`, value]),
		...Object.entries(theme.vars ?? {}).map(([name, value]) => [`vars.${name}`, value]),
	];
	assert.ok(surfaces.length > 0);
	for (const [where, value] of surfaces) {
		const resolved = resolveColor(value, theme.vars ?? {});
		assert.match(
			resolved,
			COLOR_LITERAL,
			`${where} resolves outside pi's color grammar (got ${JSON.stringify(resolved)})`,
		);
	}
});

test("the brand roles sit on the teal family — the palette review's settled direction", () => {
	// The brand accent family (selected items, the card-panel label, code
	// accents, list bullets, type names) shares one brand var, and the
	// panel backgrounds sit in the same teal band. Resolved to a literal,
	// the brand hue is teal (OKHSL hue 180-199) — the settled
	// "teal on dark" direction, frozen as bytes.
	for (const role of ["accent", "customMessageLabel", "mdCode", "mdListBullet", "syntaxType"]) {
		assert.equal(theme.colors[role], "teal", `colors.${role} must ride the brand var`);
	}
	for (const role of ["selectedBg", "userMessageBg"]) {
		assert.equal(theme.colors[role], "tealBg", `colors.${role} must ride the brand panel var`);
	}
	// The notebook-card and roadmap-box panel background, and the accent
	// itself, resolve into the teal band (OKHSL hue 180-199).
	for (const role of ["accent", "customMessageBg"]) {
		const resolved = resolveColor(theme.colors[role], theme.vars ?? {});
		const hue = Number(/^okhsl\((\d+)/.exec(resolved)?.[1]);
		assert.ok(
			hue >= 180 && hue <= 199,
			`colors.${role} resolves outside the teal band (hue ${hue})`,
		);
	}
	// The semantic roles keep pi's families — the grade badges and tool
	// boxes must not inherit the brand hue.
	for (const [role, family] of [
		["success", "green"],
		["error", "red"],
		["warning", "yellow"],
	]) {
		assert.equal(theme.colors[role], family, `colors.${role} must stay ${family} (semantic)`);
	}
});

// --- the status line bytes ---------------------------------------------------

test("the status line is the branded ASCII line, verbatim", () => {
	assert.equal(THETA_STATUS_LINE, "theta - science co-researcher");
	// The dogfood ASCII rule, pinned: every byte printable ASCII.
	assert.match(THETA_STATUS_LINE, /^[\x20-\x7E]+$/);
	assert.equal(THETA_STATUS_LINE, THETA_STATUS_LINE.trim());
});

test("the extension's theme name matches the shipped theme file", () => {
	assert.equal(THETA_THEME_NAME, "theta");
	assert.equal(THETA_THEME_NAME, theme.name);
});

// --- the session_start wiring ------------------------------------------------

function registeredSessionStart({ theme } = {}) {
	const subscriptions = [];
	const commands = recordedRegister(registerTheta, {
		on: (event, handler) => subscriptions.push({ event, handler }),
		// getSettings lives on the ExtensionAPI object, not the event ctx —
		// the extension reads the preference through its own factory handle.
		getSettings: () => (theme === undefined ? {} : { theme }),
	});
	const starts = subscriptions.filter((s) => s.event === "session_start");
	assert.equal(starts.length, 1, "exactly one session_start subscription");
	return { handler: starts[0].handler, commands };
}

function stubCtx({ mode = "tui", setThemeResult = { success: true } } = {}) {
	const calls = { setTheme: [], setStatus: [] };
	// pi's own docs prescribe guarding fire-and-forget methods (setStatus
	// among them) on ctx.hasUI — false in print and JSON, where pi installs
	// a no-op UI. The stub carries no ui surface at all for those modes, so
	// a call past the guard throws: the pin is that theta.ts keeps the
	// documented guard, not that pi lacks the methods.
	const hasUI = mode === "tui" || mode === "rpc";
	const ctx = {
		mode,
		hasUI,
	};
	if (hasUI) {
		ctx.ui = {
			setTheme: (name) => {
				calls.setTheme.push(name);
				return setThemeResult;
			},
			setStatus: (key, text) => calls.setStatus.push({ key, text }),
		};
	}
	return { ctx, calls };
}

test("a TUI session with no theme preference is branded: the switch fires and the footer segment lands", async () => {
	const { handler } = registeredSessionStart();
	const { ctx, calls } = stubCtx({ mode: "tui" });
	await handler({ type: "session_start", reason: "startup" }, ctx);
	assert.deepEqual(calls.setTheme, ["theta"]);
	assert.deepEqual(calls.setStatus, [{ key: "theta", text: THETA_STATUS_LINE }]);
});

test("an explicit theme preference is respected — saved choice or light/dark pair, no switch", async () => {
	for (const theme of ["dark", "light/dark"]) {
		const { handler } = registeredSessionStart({ theme });
		const { ctx, calls } = stubCtx({ mode: "tui" });
		await handler({ type: "session_start", reason: "startup" }, ctx);
		assert.deepEqual(calls.setTheme, [], `a saved ${theme} preference must not be overridden`);
		// The footer segment is preference-independent dressing.
		assert.deepEqual(calls.setStatus, [{ key: "theta", text: THETA_STATUS_LINE }], theme);
	}
});

test("only the TUI switches themes — RPC forwards the status, print and JSON touch no UI", async () => {
	const { handler } = registeredSessionStart();
	// RPC: hasUI true (the forwarded fire-and-forget), but no TUI to theme.
	const rpc = stubCtx({ mode: "rpc" });
	await handler({ type: "session_start", reason: "startup" }, rpc.ctx);
	assert.deepEqual(rpc.calls.setTheme, []);
	assert.deepEqual(rpc.calls.setStatus, [{ key: "theta", text: THETA_STATUS_LINE }]);
	// print and json: no UI at all — an unguarded call throws against
	// the stub (ui is absent on purpose).
	for (const mode of ["print", "json"]) {
		const headless = stubCtx({ mode });
		await handler({ type: "session_start", reason: "startup" }, headless.ctx);
		assert.deepEqual(headless.calls.setTheme, [], mode);
		assert.deepEqual(headless.calls.setStatus, [], mode);
	}
});

test("a failed switch stays silent — branding never announces itself, and never breaks the session", async () => {
	const { handler } = registeredSessionStart();
	const { ctx, calls } = stubCtx({ mode: "tui", setThemeResult: { success: false, error: "not found" } });
	// A rejected or throwing handler would fail this test by itself; the
	// recorded calls prove the session carried on past the failed switch.
	await handler({ type: "session_start", reason: "startup" }, ctx);
	assert.deepEqual(calls.setTheme, ["theta"]);
});

test("the /theta status command still registers beside the theme wiring", () => {
	const { commands } = registeredSessionStart();
	assert.deepEqual(commands.map((c) => c.name), ["theta"]);
});
