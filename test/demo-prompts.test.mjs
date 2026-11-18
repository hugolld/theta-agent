// The demo prompt templates' pins (spec #184, demo doctrine B3): shipped
// prose that becomes a live user message — `/demo-lit-triage` in the
// seminar script — so the bar is the capture doctrine's, owned here as
// suite pins rather than review vigilance. The class pins, one bar for
// every direct `.md` child of prompts/ (the manifest's directory entry):
// pure ASCII (the dogfood rule — the scripted templates own it "by
// construction", and this makes that by test), the steering sentences
// verbatim from the scenario list's home (test/eval/scenarios.mjs — the
// one home the benchmark prompts share, so a capture prompt and the demo
// prompt keep one steering vocabulary), zero variance (no argument
// substitution syntax — a scripted run means the bytes are fixed),
// frontmatter that pi's own YAML engine parses with a plain-scalar-safe
// description, and no institutional facts (the public-repo rule: cluster
// accounts and host names never enter shipped prose).

import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { test } from "node:test";
import { PLAIN_COMMAND, READ_HEADROOM } from "./eval/scenarios.mjs";
import { parseFrontmatter } from "./helpers/frontmatter.mjs";

// Direct children only — exactly what pi's conventional prompt directory
// loads. A stray non-markdown child would ship in the tarball (files
// carries prompts/) without ever becoming a command, so it refuses here.
const templateNames = (await readdir(new URL("../prompts/", import.meta.url), { withFileTypes: true }))
	.filter((entry) => entry.isFile())
	.map((entry) => entry.name);

async function readTemplate(name) {
	const text = await readFile(new URL(`../prompts/${name}`, import.meta.url), "utf8");
	// The body is everything past the frontmatter block, stripped the same
	// way the shared helper matches it.
	const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "");
	return { text, body };
}

test("every shipped template is a direct .md child of prompts/", () => {
	assert.ok(templateNames.length > 0, "prompts/ carries no templates");
	for (const name of templateNames) {
		assert.match(name, /\.md$/, `${name}: not a markdown file — prompts/ holds only direct .md children`);
	}
});

test("template frontmatter parses with a plain-scalar-safe description", async () => {
	for (const name of templateNames) {
		const { text } = await readTemplate(name);
		// Throws on unparseable frontmatter — pi's own failure mode is the
		// silent one (it drops the template), so the suite is the loud path.
		const frontmatter = parseFrontmatter(text);
		assert.equal(typeof frontmatter.description, "string", `${name}: description missing`);
		assert.ok(
			frontmatter.description.length > 0 && frontmatter.description.length <= 1024,
			`${name}: description must be 1..1024 chars, got ${frontmatter.description.length}`,
		);
		assert.ok(
			!frontmatter.description.includes(": "),
			`${name}: description must stay plain-scalar-safe (no ": " in the value)`,
		);
	}
});

test("the demo prompts are pure ASCII", async () => {
	for (const name of templateNames) {
		const { text } = await readTemplate(name);
		assert.ok(
			/^[\s\x20-\x7E]*$/.test(text),
			`${name}: non-ASCII bytes present — the dogfood rule binds the demo prompt`,
		);
	}
});

test("a scripted run takes no arguments — zero variance", async () => {
	for (const name of templateNames) {
		const { text, body } = await readTemplate(name);
		assert.ok(
			!/\$\d|\$@|\$\{|ARGUMENTS/.test(body),
			`${name}: argument substitution syntax present — a scripted run's bytes are fixed`,
		);
		const frontmatter = parseFrontmatter(text);
		assert.ok(
			frontmatter["argument-hint"] === undefined,
			`${name}: argument-hint present — the scripted templates take no arguments`,
		);
	}
});

test("the steering sentences ride verbatim from the scenario list's home", async () => {
	for (const name of templateNames) {
		const { body } = await readTemplate(name);
		assert.ok(body.includes(READ_HEADROOM), `${name}: the read-headroom sentence is missing or drifted`);
		assert.ok(body.includes(PLAIN_COMMAND), `${name}: the plain-command sentence is missing or drifted`);
	}
});

test("the lit-triage template carries the benchmark shape's record steer", async () => {
	const { body } = await readTemplate("demo-lit-triage.md");
	assert.match(body, /primary studies/, "the search steer must name primary studies");
	assert.ok(
		body.includes("record what you kept for the project so a later session can build on it"),
		"the record-for-project steer is missing — the loop must land in the notebook for the cards to appear",
	);
});

// Institutional facts (the CLAUDE.md rule): cluster accounts, SSH aliases,
// and node names never enter public surfaces. The shapes cover the private
// vocabulary; shipped demo prose has no legitimate use for any of them.
const INSTITUTIONAL_FACTS = [/\bu\d{7,}\b/, /hebmu/, /\bgpu\d+\b/];

test("no institutional facts ride the shipped templates", async () => {
	for (const name of templateNames) {
		const { text } = await readTemplate(name);
		for (const pattern of INSTITUTIONAL_FACTS) {
			assert.ok(!pattern.test(text), `${name}: institutional-fact pattern ${pattern} matched`);
		}
	}
});
