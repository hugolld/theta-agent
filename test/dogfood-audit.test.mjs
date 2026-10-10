import test from "node:test";
import assert from "node:assert/strict";
import {
	ge,
	decodeXmlEntities,
	extractLocations,
} from "../scripts/audit-dogfood.mjs";

test("ge enforces the pi and node version floors", () => {
	assert.equal(ge("0.99.2", "0.99"), true);
	assert.equal(ge("1.1.0", "0.99"), true);
	assert.equal(ge("26.11.0", "22"), true);
	assert.equal(ge("22", "22"), true);
	assert.equal(ge("0.98", "0.99"), false);
	assert.equal(ge("21.9.9", "22"), false);
});

test("ge fails closed on malformed versions", () => {
	assert.equal(ge("0.99.0-beta", "0.99"), false);
});

test("decodeXmlEntities decodes pi's entity set", () => {
	assert.equal(
		decodeXmlEntities("Theta&apos;s &quot;how&quot; &amp; &lt;b&gt; &#39;x&#39;"),
		"Theta's \"how\" & <b> 'x'",
	);
});

test("extractLocations returns decoded locations or null", () => {
	const text =
		"<available_skills><skill><name>a</name>" +
		"<location>/x/skills/a/SKILL.md</location>" +
		"<location>/x/skills/b&apos;s/SKILL.md</location>" +
		"</skill></available_skills>";
	const locs = extractLocations(text);
	assert.equal(locs.size, 2);
	assert.ok(locs.has("/x/skills/a/SKILL.md"));
	assert.ok(locs.has("/x/skills/b's/SKILL.md"));
	assert.equal(extractLocations("no section here"), null);
});
