// The replay net's typed normalization layer (spec #133, ADR 0007). Raw
// session bytes carry capture-time noise — machine roots, instants, run
// durations, throwaway identifiers, provider attribution — that would
// make a snapshot diff mean machine news, not behavior news. This layer
// rewrites exactly five classes of it, each by type at a structural
// position or a standing-alone substring, never by laundering a whole
// message: five is a design constant (test/eval/normalize.test.mjs pins
// the count and each class), and everything outside the five passes
// through untouched — a diff there is behavior drift, the net's signal.
//
// The tokens: <path>, <timestamp>, <duration>, <provider>, <model>, and
// <id#N> — identifiers are renumbered in first-occurrence walk order, so
// linkage (parentId chains, toolCallId pairing) survives while raw ids
// never enter a snapshot.

import { createHash } from "node:crypto";

export const REWRITE_CLASSES = Object.freeze([
	{
		id: "absolute-paths",
		applies:
			"a POSIX absolute path standing on its own in a string value — not glued to a word, scheme, or URL host — becomes <path>; placeholder-rooted paths (the sanitizer's __REPO__ output) keep their repo-relative structure",
	},
	{
		id: "iso-timestamps",
		applies:
			"an ISO 8601 instant inside a string, and a numeric epoch-millisecond `timestamp` field, become <timestamp>",
	},
	{
		id: "durations",
		applies: "a numeric durationMs field becomes <duration>",
	},
	{
		id: "identifiers",
		applies:
			"string values under id, parentId, targetId, fromId, firstKeptEntryId, toolCallId — session, entry, and tool-call identifiers — become <id#N> in first-occurrence walk order",
	},
	{
		id: "provider-model",
		applies:
			"string values under provider become <provider>, under model and modelId become <model> — attribution is harness news, not behavior news",
	},
]);

const ID_KEYS = new Set(["id", "parentId", "targetId", "fromId", "firstKeptEntryId", "toolCallId"]);
const DURATION_KEYS = new Set(["durationMs"]);
const EPOCH_MS_KEYS = new Set(["timestamp"]);
const PROVIDER_KEYS = new Set(["provider"]);
const MODEL_KEYS = new Set(["model", "modelId"]);

// A path stands on its own when nothing glues onto its left edge: not a
// word character (a URL host, or the __REPO__ placeholder a sanitized
// fixture carries), not a dot or colon (a scheme), not another slash (a
// // authority). URL interiors and relative paths survive untouched —
// they are behavior.
const ABSOLUTE_PATH = /(?<![\w.:@/$-])(?:\/[A-Za-z0-9._+-]+)+\/?/g;
const ISO_INSTANT =
	/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:?\d{2})?/g;

// Deep-copies `root` with the five classes applied. The walk is
// deterministic (array order, object insertion order), so
// first-occurrence identifier numbering is stable for identical input.
export function normalizeTree(root) {
	const identifiers = new Map();
	const intern = (raw) => {
		let token = identifiers.get(raw);
		if (token === undefined) {
			token = `<id#${identifiers.size + 1}>`;
			identifiers.set(raw, token);
		}
		return token;
	};
	const walk = (value, key) => {
		if (Array.isArray(value)) return value.map((item) => walk(item));
		if (value === null || typeof value !== "object") {
			if (typeof value === "string") {
				if (key !== undefined && ID_KEYS.has(key)) return intern(value);
				if (key !== undefined && PROVIDER_KEYS.has(key)) return "<provider>";
				if (key !== undefined && MODEL_KEYS.has(key)) return "<model>";
				return value.replace(ABSOLUTE_PATH, "<path>").replace(ISO_INSTANT, "<timestamp>");
			}
			if (typeof value === "number") {
				if (key !== undefined && DURATION_KEYS.has(key)) return "<duration>";
				if (key !== undefined && EPOCH_MS_KEYS.has(key)) return "<timestamp>";
				return value;
			}
			return value;
		}
		const out = {};
		for (const [childKey, childValue] of Object.entries(value)) {
			out[childKey] = walk(childValue, childKey);
		}
		return out;
	};
	return walk(root, undefined);
}

// Canonical JSON for snapshots and the determinism hash: object keys
// sorted, no whitespace — key order is pi's business, not the net's, and
// a pi version that reorders fields must not red the snapshot as drift.
export function stableStringify(value) {
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	if (value !== null && typeof value === "object") {
		return `{${Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

// The determinism pin's one context hash: pi's reconstruction, normalized
// and canonically serialized, hashed. provider/model attribution and
// timestamps are normalized away, so the hash speaks for message shape.
export function contextHash(context) {
	return createHash("sha256")
		.update(stableStringify(normalizeTree(context)))
		.digest("hex");
}
