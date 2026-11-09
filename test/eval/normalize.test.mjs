// Unit tests for the typed normalization layer (spec #133): the five
// rewrite classes are a design constant — this file pins the count, each
// class's rewrite, and the passthrough of everything outside them. The
// full pins (provenance, snapshot, determinism) live in
// replay-net.test.mjs against the committed fixture.

import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeTree, REWRITE_CLASSES, stableStringify } from "./normalize.mjs";

test("the rewrite registry is exactly the five decided classes", () => {
	assert.deepEqual(
		REWRITE_CLASSES.map((c) => c.id),
		["absolute-paths", "iso-timestamps", "durations", "identifiers", "provider-model"],
	);
	assert.equal(REWRITE_CLASSES.length, 5);
	for (const c of REWRITE_CLASSES) {
		assert.match(c.applies, /\S/); // every class carries its scope prose
	}
});

test("absolute paths standing alone become <path>; URL interiors and placeholder roots survive", () => {
	const normalized = normalizeTree({
		cwd: "/home/theta/theta",
		command: "cd /home/theta/theta && python3 /usr/local/bin/python3 --help",
		url: "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed",
		placeholder: "__REPO__/skills/theta-lit-search/SKILL.md",
		relative: "skills/theta-lit-search/scripts/pubmed.py",
	});
	assert.deepEqual(normalized, {
		cwd: "<path>",
		command: "cd <path> && python3 <path> --help",
		url: "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed",
		placeholder: "__REPO__/skills/theta-lit-search/SKILL.md",
		relative: "skills/theta-lit-search/scripts/pubmed.py",
	});
});

test("ISO instants in strings and epoch-millisecond timestamp fields become <timestamp>", () => {
	const normalized = normalizeTree({
		entryTimestamp: "2026-11-09T12:00:00.123Z",
		prose: "captured 2026-11-09T12:00:00Z and finished 2026-11-09T12:05:00+08:00",
		message: { timestamp: 1733234400000 }, // pi's message-level epoch-ms field
	});
	assert.deepEqual(normalized, {
		entryTimestamp: "<timestamp>",
		prose: "captured <timestamp> and finished <timestamp>",
		message: { timestamp: "<timestamp>" },
	});
});

test("durationMs fields become <duration>; other numbers pass through", () => {
	const normalized = normalizeTree({
		durationMs: 4321,
		usage: { totalTokens: 50321, cost: { total: 0.015 } },
		tokensBefore: 50000,
	});
	assert.deepEqual(normalized, {
		durationMs: "<duration>",
		usage: { totalTokens: 50321, cost: { total: 0.015 } },
		tokensBefore: 50000,
	});
});

test("identifiers renumber in first-occurrence walk order and keep pairing", () => {
	const raw = {
		type: "session",
		id: "01a15bfd-3d8a-7449-bc60-8eed002d2535",
		entries: [
			{ id: "a46a786b", parentId: null },
			{ id: "33ddab28", parentId: "a46a786b" },
			{
				id: "7fdee509",
				parentId: "33ddab28",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "call_123", name: "read" }],
				},
			},
			{
				id: "8ab19c01",
				parentId: "7fdee509",
				message: { role: "toolResult", toolCallId: "call_123", isError: false },
			},
		],
	};
	const normalized = normalizeTree(raw);
	const [first, second, third, fourth] = normalized.entries;
	assert.equal(normalized.id, "<id#1>");
	assert.equal(first.id, "<id#2>");
	assert.equal(first.parentId, null); // null is structure, not an identifier
	assert.equal(second.parentId, "<id#2>"); // the chain still links
	assert.equal(third.message.content[0].id, fourth.message.toolCallId); // call pairing survives
	assert.notEqual(third.id, third.message.content[0].id); // entry ids and call ids stay distinct spaces
});

test("provider and model attribution rewrites whole values by key, never prose substrings", () => {
	const normalized = normalizeTree({
		message: {
			role: "assistant",
			provider: "zai-coding-cn",
			model: "glm-5.3-flash",
			content: [{ type: "text", text: "the zai-coding-cn provider served glm-5.3-flash here" }],
		},
		model_change: { provider: "zai-coding-cn", modelId: "glm-5.3-flash" },
	});
	assert.equal(normalized.message.provider, "<provider>");
	assert.equal(normalized.message.model, "<model>");
	assert.equal(
		normalized.message.content[0].text,
		"the zai-coding-cn provider served glm-5.3-flash here",
	);
	assert.equal(normalized.model_change.provider, "<provider>");
	assert.equal(normalized.model_change.modelId, "<model>");
});

test("normalizeTree returns a copy and never mutates its input", () => {
	const input = { timestamp: "2026-11-09T12:00:00Z", nested: { id: "a46a786b", cwd: "/tmp/x" } };
	const before = JSON.stringify(input);
	normalizeTree(input);
	assert.equal(JSON.stringify(input), before);
});

test("stableStringify sorts object keys and serializes arrays in order", () => {
	assert.equal(
		stableStringify({ b: 1, a: { z: [3, 2, 1], y: null } }),
		'{"a":{"y":null,"z":[3,2,1]},"b":1}',
	);
});
