import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	ge,
	decodeXmlEntities,
	extractLocations,
	resolveAdvertisedSkill,
	auditSession,
} from "../scripts/audit-dogfood.mjs";

test("ge enforces the pi and node version floors", () => {
	assert.equal(ge("0.99.2", "0.99"), true);
	assert.equal(ge("1.1.0", "0.99"), true);
	assert.equal(ge("26.11.0", "22"), true);
	assert.equal(ge("22", "22"), true);
	assert.equal(ge("0.98", "0.99"), false);
	assert.equal(ge("21.9.9", "22"), false);
});

test("ge follows SemVer prerelease precedence", () => {
	assert.equal(ge("1.0.0-rc.1", "0.99"), true);
	assert.equal(ge("0.99.1-beta", "0.99"), true);
	assert.equal(ge("0.99.0", "0.99.0-rc.1"), true);
	assert.equal(ge("1.0.0-alpha", "1.0.0"), false);
	assert.equal(ge("1.0.0-alpha", "1.0.0-alpha.1"), false);
	assert.equal(ge("1.0.0-alpha.1", "1.0.0-alpha"), true);
	assert.equal(ge("1.0.0-alpha.1", "1.0.0-alpha.beta"), false);
	assert.equal(ge("1.0.0-alpha.beta", "1.0.0-alpha.1"), true);
	assert.equal(ge("1.1.0+build", "0.99"), true);
});

test("ge fails closed on malformed versions", () => {
	assert.equal(ge("0.99.", "0.99"), false);
	assert.equal(ge("0.99.0-beta", "0.99"), false);
	assert.equal(ge("not-a-version", "0.99"), false);
	assert.equal(ge("01.0.0", "0.99"), false);
	assert.equal(ge("1.0.0-alpha..beta", "0.99"), false);
	assert.equal(ge("1.0.0-01", "0.99"), false);
});

test("ge accepts alphanumeric prerelease identifiers that start with zero", () => {
	assert.equal(ge("1.0.0-0rc", "0.99"), true);
	assert.equal(ge("1.0.0-0-rc", "0.99"), true);
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

test("resolveAdvertisedSkill rejects traversal and non-skill paths", () => {
	const root = "/checkout";
	const expected = new Set(["/checkout/skills/a/SKILL.md"]);
	assert.equal(
		resolveAdvertisedSkill(root, "skills/a/SKILL.md", expected),
		"/checkout/skills/a/SKILL.md",
	);
	assert.equal(
		resolveAdvertisedSkill(root, "./skills/a/SKILL.md", expected),
		"/checkout/skills/a/SKILL.md",
	);
	assert.throws(
		() => resolveAdvertisedSkill(root, "../CLAUDE.local.md", expected),
		/advertised checkout SKILL\.md/,
	);
	assert.throws(
		() => resolveAdvertisedSkill(root, "skills/b/SKILL.md", expected),
		/advertised checkout SKILL\.md/,
	);
});

// Integration fixtures: a synthetic session directory audited against the
// real checkout root, covering the clean pass and every failure mode.
const realRoot = fs.realpathSync(".");
const head = () => execSync("git rev-parse HEAD").toString().trim();
const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const inventory = JSON.parse(
	fs.readFileSync("test/expected-skills.json", "utf8"),
);
const inventoryNames = inventory.vendored
	.map((e) => e.name)
	.concat(inventory["self-authored"]);
const prompt = "test prompt for the dogfood auditor";

function buildSession(t, overrides = {}) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dogfood-fixture-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const root = realRoot;
	const advertised = overrides.advertisedNames ?? inventoryNames;
	let locs = advertised
		.map(
			(n) =>
				`<skill><name>${n}</name><location>${root}/skills/${n}/SKILL.md</location></skill>`,
		)
		.join("\n");
	// pi also advertises the user's host-level skills from outside the
	// checkout; they are the environment, not extras.
	if (!overrides.noHostSkills) {
		const hostDir = fs.mkdtempSync(path.join(os.tmpdir(), "host-skill-"));
		t.after(() => fs.rmSync(hostDir, { recursive: true, force: true }));
		const hostFile = path.join(hostDir, "SKILL.md");
		fs.writeFileSync(hostFile, "host skill content\n");
		locs += `\n<skill><name>host-skill</name><location>${hostFile}</location></skill>`;
	}
	const thePrompt = overrides.prompt ?? prompt;
	const records = [
		JSON.stringify({ type: "session", cwd: root }),
		JSON.stringify({
			type: "model_change",
			provider: "zai-coding-cn",
			modelId: "glm-5.3-flash",
		}),
		JSON.stringify({
			type: "message",
			message: {
				role: "system",
				sections: { skills: `<available_skills>${locs}</available_skills>` },
			},
		}),
		JSON.stringify({
			type: "message",
			message: { role: "user", content: [{ type: "text", text: thePrompt }] },
		}),
	];
	if (overrides.toolResultIsError !== undefined) {
		const target = `${root}/skills/literature-review/SKILL.md`;
		records.push(
			JSON.stringify({
				type: "message",
				message: {
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: "call_test",
							name: "read",
							arguments: { path: target },
						},
					],
				},
			}),
		);
		records.push(
			JSON.stringify({
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "call_test",
					toolName: "read",
					isError: overrides.toolResultIsError,
					content: [{ type: "text", text: "irrelevant" }],
				},
			}),
		);
	}
	fs.writeFileSync(
		path.join(dir, "session.jsonl"),
		records.join("\n") + "\n",
	);
	fs.writeFileSync(path.join(dir, "prompt.txt"), prompt);
	fs.writeFileSync(
		path.join(dir, "expected-model"),
		"zai-coding-cn glm-5.3-flash\n",
	);
	fs.writeFileSync(path.join(dir, "exit-status"), overrides.exit ?? "0");
	fs.writeFileSync(path.join(dir, "stderr.txt"), overrides.stderr ?? "");
	fs.writeFileSync(path.join(dir, "pi-version"), "1.1.0\n");
	fs.writeFileSync(path.join(dir, "node-version"), "v26.11.0\n");
	fs.writeFileSync(path.join(dir, "pre-head"), overrides.preHead ?? head());
	fs.writeFileSync(
		path.join(dir, "manifest-sha256"),
		sha256(fs.readFileSync("package.json", "utf8")),
	);
	if (overrides.watchdog) fs.writeFileSync(path.join(dir, "watchdog"), "fired");
	return dir;
}

test("auditSession attests a well-formed boot session", (t) => {
	const dir = buildSession(t);
	const out = auditSession(dir, realRoot);
	assert.match(out, /^clean /);
	assert.match(out, /provider zai-coding-cn/);
	assert.match(out, /model glm-5.3-flash/);
});

test("auditSession ignores host skills advertised from outside the checkout", (t) => {
	const dir = buildSession(t);
	assert.doesNotThrow(() => auditSession(dir, realRoot));
});

test("auditSession attests skill use when paired and errors otherwise", (t) => {
	const good = buildSession(t, { toolResultIsError: false });
	const out = auditSession(good, realRoot, "skills/literature-review/SKILL.md");
	assert.match(out, /used .*\/skills\/literature-review\/SKILL\.md/);
	const bad = buildSession(t, { toolResultIsError: true });
	assert.throws(
		() => auditSession(bad, realRoot, "skills/literature-review/SKILL.md"),
		/NOT used/,
	);
});

test("auditSession fails on missing and unresolvable advertised skills", (t) => {
	assert.throws(
		() => auditSession(buildSession(t, { advertisedNames: inventoryNames.slice(1) }), realRoot),
		/NOT advertised: literature-review/,
	);
	assert.throws(
		() =>
			auditSession(
				buildSession(t, { advertisedNames: [...inventoryNames, "extra-skill"] }),
				realRoot,
			),
		/do not resolve on disk/,
	);
});

test("auditSession fails on corrupt, mismatched, or stale evidence", (t) => {
	const dir = buildSession(t);
	fs.appendFileSync(path.join(dir, "session.jsonl"), "{corrupt\n");
	assert.throws(() => auditSession(dir, realRoot), /corrupt transcript/);

	const moved = buildSession(t, { preHead: "0".repeat(40) });
	assert.throws(() => auditSession(moved, realRoot), /HEAD moved/);

	const stale = buildSession(t, { prompt: "a different prompt" });
	assert.throws(() => auditSession(stale, realRoot), /prompt mismatch/);

	const wrongModel = buildSession(t);
	fs.writeFileSync(
		path.join(wrongModel, "expected-model"),
		"other-provider other-model\n",
	);
	assert.throws(() => auditSession(wrongModel, realRoot), /model mismatch/);

	const failed = buildSession(t, { exit: "1" });
	assert.throws(() => auditSession(failed, realRoot), /boot not clean/);

	const noisy = buildSession(t, { stderr: "boom\n" });
	assert.throws(() => auditSession(noisy, realRoot), /boot not clean/);

	const timedOut = buildSession(t, { watchdog: true });
	assert.throws(() => auditSession(timedOut, realRoot), /watchdog fired/);

	const twoSystem = buildSession(t);
	fs.appendFileSync(
		path.join(twoSystem, "session.jsonl"),
		JSON.stringify({
			type: "message",
			message: { role: "system", sections: { skills: null } },
		}) + "\n",
	);
	assert.throws(
		() => auditSession(twoSystem, realRoot),
		/skills-bearing system record/,
	);
});


