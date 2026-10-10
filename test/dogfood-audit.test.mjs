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
	assert.equal(ge("1.0.0-alpha.1", "1.0.0-alpha.beta"), false);
	assert.equal(ge("1.0.0-alpha.beta", "1.0.0-alpha.1"), true);
	assert.equal(ge("1.0.0-alpha.1", "1.0.0-alpha"), true);
	assert.equal(ge("1.1.0+build", "0.99"), true);
});

test("ge compares large numeric prerelease identifiers losslessly", () => {
	assert.equal(ge("1.0.0-9007199254740993", "1.0.0-9007199254740992"), true);
	assert.equal(ge("1.0.0-9007199254740992", "1.0.0-9007199254740993"), false);
});

test("ge compares large numeric core components losslessly", () => {
	assert.equal(ge("9007199254740993.0.0", "9007199254740992.0.0"), true);
	assert.equal(ge("9007199254740992.0.0", "9007199254740993.0.0"), false);
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
	assert.equal(ge("1.0.0+build.1", "0.99"), true);
});

test("ge fails closed on malformed build metadata", () => {
	assert.equal(ge("1.0.0+.", "0.99"), false);
	assert.equal(ge("1.0.0+build..1", "0.99"), false);
});

test("decodeXmlEntities decodes pi's entity set", () => {
	assert.equal(
		decodeXmlEntities("Theta&apos;s &quot;how&quot; &amp; &lt;b&gt; &#39;x&#39;"),
		"Theta's \"how\" & <b> 'x'",
	);
});

test("extractLocations returns decoded records and rejects other counts", () => {
	const text =
		"<available_skills><skill><name>a</name>" +
		"<location>/x/skills/a/SKILL.md</location>" +
		"</skill>" +
		"<skill><name>b&apos;s</name>" +
		"<location>/x/skills/b&apos;s/SKILL.md</location>" +
		"</skill></available_skills>";
	const recs = extractLocations(text);
	assert.equal(recs.length, 2);
	assert.deepEqual(recs[0], { name: "a", location: "/x/skills/a/SKILL.md" });
	assert.deepEqual(recs[1], { name: "b's", location: "/x/skills/b's/SKILL.md" });
	assert.throws(
		() => extractLocations("no section here"),
		/exactly 1 available_skills block, found 0/,
	);
	assert.throws(
		() =>
			extractLocations(
				text +
					"<available_skills><skill><name>ghost</name><location>/x/ghost/SKILL.md</location></skill></available_skills>",
			),
		/exactly 1 available_skills block, found 2/,
	);
	assert.throws(
		() => extractLocations("<available_skills><skill><name>a</name></skill></available_skills>"),
		/missing name or location/,
	);
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

// Integration fixtures: a synthetic git repo and session directory, fully
// isolated from the developer's checkout state — npm test stays reliable
// before committing.
function makeTempRepo(t) {
	const repo = fs.mkdtempSync(path.join(os.tmpdir(), "dogfood-repo-"));
	t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
	const run = (cmd) => execSync(cmd, { cwd: repo }).toString();
	fs.mkdirSync(path.join(repo, "skills", "literature-review"), {
		recursive: true,
	});
	fs.writeFileSync(
		path.join(repo, "skills", "literature-review", "SKILL.md"),
		"skill content\n",
	);
	fs.mkdirSync(path.join(repo, "test"), { recursive: true });
	fs.writeFileSync(
		path.join(repo, "test", "expected-skills.json"),
		JSON.stringify({
			vendored: [{ name: "literature-review", "tree-sha256": "x" }],
			"self-authored": [],
		}),
	);
	fs.writeFileSync(
		path.join(repo, "package.json"),
		JSON.stringify({ pi: { skills: ["./skills"] } }),
	);
	run("git init -q");
	run("git config user.email test@example.com");
	run("git config user.name test");
	run("git config commit.gpgsign false");
	run("git config core.hooksPath /dev/null");
	run("git add -A");
	run("git -c commit.gpgsign=false commit -qm init");
	return repo;
}

const repoHead = (repo) =>
	execSync("git rev-parse HEAD", { cwd: repo }).toString().trim();
const repoManifestSha = (repo) =>
	createHash("sha256")
		.update(fs.readFileSync(path.join(repo, "package.json")))
		.digest("hex");

function buildSession(t, repo, overrides = {}) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dogfood-session-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const names = overrides.advertisedNames ?? ["literature-review"];
	let entries = names
		.map(
			(n) =>
				`<skill><name>${n}</name><location>${repo}/skills/${n}/SKILL.md</location></skill>`,
		)
		.join("\n");
	if (!overrides.noHostSkill) {
		const hostDir = fs.mkdtempSync(path.join(os.tmpdir(), "host-skill-"));
		t.after(() => fs.rmSync(hostDir, { recursive: true, force: true }));
		const hostFile = path.join(hostDir, "SKILL.md");
		fs.writeFileSync(hostFile, "host skill content\n");
		entries += `\n<skill><name>host-skill</name><location>${hostFile}</location></skill>`;
	}
	const wrapped = `<available_skills>${entries}</available_skills>`;
	const skillsText = overrides.secondSkillsBlock
		? `${wrapped}<available_skills><skill><name>ghost</name><location>/tmp/ghost/SKILL.md</location></skill></available_skills>`
		: wrapped;
	const prompt = overrides.transcriptPrompt ?? "test prompt";
	const records = [
		JSON.stringify({ type: "session", cwd: overrides.sessionCwd ?? fs.realpathSync(repo) }),
		JSON.stringify({
			type: "model_change",
			provider: "zai-coding-cn",
			modelId: "glm-5.3-flash",
		}),
		JSON.stringify({
			type: "message",
			message: {
				role: "system",
				sections: { skills: skillsText },
			},
		}),
		JSON.stringify({
			type: "message",
			message: { role: "user", content: [{ type: "text", text: prompt }] },
		}),
	];
	if (overrides.toolResultIsError !== undefined) {
		const target = `${repo}/skills/literature-review/SKILL.md`;
		const callArguments = { path: target };
		if (overrides.partialRead) {
			callArguments.offset = 1;
			callArguments.limit = 1;
		} else if (!overrides.noReadRange) {
			// pi passes explicit offset/limit even for full-file reads
			callArguments.offset = 1;
			callArguments.limit = 2000;
		}
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
							arguments: callArguments,
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
					toolName: overrides.toolName ?? "read",
					isError: overrides.toolResultIsError,
					content: [
						{
							type: "text",
							text: overrides.resultText ?? "skill content\n",
						},
					],
				},
			}),
		);
	}
	// a completed one-shot ends with the assistant's response
	records.push(
		JSON.stringify({
			type: "message",
			message: {
				role: "assistant",
				stopReason: "stop",
				content: [{ type: "text", text: "summary response\n" }],
			},
		}),
	);
	fs.writeFileSync(path.join(dir, "session.jsonl"), records.join("\n") + "\n");
	fs.writeFileSync(path.join(dir, "prompt.txt"), "test prompt");
	fs.writeFileSync(
		path.join(dir, "expected-model"),
		overrides.expectedModel ?? "zai-coding-cn glm-5.3-flash\n",
	);
	fs.writeFileSync(path.join(dir, "exit-status"), overrides.exit ?? "0");
	fs.writeFileSync(path.join(dir, "stderr.txt"), overrides.stderr ?? "");
	fs.writeFileSync(path.join(dir, "pi-version"), overrides.piVersion ?? "1.1.0\n");
	fs.writeFileSync(
		path.join(dir, "node-version"),
		overrides.nodeVersion ?? "v26.11.0\n",
	);
	fs.writeFileSync(path.join(dir, "pre-head"), overrides.preHead ?? repoHead(repo));
	fs.writeFileSync(path.join(dir, "manifest-sha256"), repoManifestSha(repo));
	if (overrides.watchdog) fs.writeFileSync(path.join(dir, "watchdog"), "fired");
	return dir;
}

function auditIn(cwd, fn) {
	const prev = process.cwd();
	process.chdir(cwd);
	try {
		return fn();
	} finally {
		process.chdir(prev);
	}
}

test("auditSession attests a well-formed boot session", (t) => {
	const repo = makeTempRepo(t);
	const dir = buildSession(t, repo);
	const out = auditIn(repo, () => auditSession(dir, repo));
	assert.match(out, /^clean /);
	assert.match(out, /provider zai-coding-cn/);
	assert.match(out, /model glm-5.3-flash/);
});

test("auditSession ignores host skills advertised from outside the repo", (t) => {
	const repo = makeTempRepo(t);
	const dir = buildSession(t, repo);
	assert.doesNotThrow(() => auditIn(repo, () => auditSession(dir, repo)));
});

test("auditSession attests skill use when paired and errors otherwise", (t) => {
	const repo = makeTempRepo(t);
	const good = buildSession(t, repo, { toolResultIsError: false });
	const out = auditIn(repo, () =>
		auditSession(good, repo, "skills/literature-review/SKILL.md"),
	);
	assert.match(out, /used .*\/skills\/literature-review\/SKILL\.md/);
	const bad = buildSession(t, repo, { toolResultIsError: true });
	assert.throws(
		() => auditIn(repo, () => auditSession(bad, repo, "skills/literature-review/SKILL.md")),
		/NOT used/,
	);
	const partial = buildSession(t, repo, {
		toolResultIsError: false,
		partialRead: true,
		resultText: "partial\n",
	});
	assert.throws(
		() => auditIn(repo, () => auditSession(partial, repo, "skills/literature-review/SKILL.md")),
		/NOT used/,
	);
	const fabricated = buildSession(t, repo, {
		toolResultIsError: false,
		resultText: "fabricated content\n",
	});
	assert.throws(
		() => auditIn(repo, () => auditSession(fabricated, repo, "skills/literature-review/SKILL.md")),
		/NOT used/,
	);
	const wrongTool = buildSession(t, repo, {
		toolResultIsError: false,
		toolName: "other",
	});
	assert.throws(
		() => auditIn(repo, () => auditSession(wrongTool, repo, "skills/literature-review/SKILL.md")),
		/NOT used/,
	);
	const camelSteer = buildSession(t, repo, {
		toolResultIsError: false,
		transcriptPrompt: "Use LiteratureReview and open its instructions",
	});
	fs.writeFileSync(
		path.join(camelSteer, "prompt.txt"),
		"Use LiteratureReview and open its instructions",
	);
	assert.throws(
		() => auditIn(repo, () => auditSession(camelSteer, repo, "skills/literature-review/SKILL.md")),
		/names the selected skill/,
	);
});

test("auditSession fails on missing and unresolvable advertised skills", (t) => {
	const repo = makeTempRepo(t);
	const missing = buildSession(t, repo, { advertisedNames: [] });
	assert.throws(
		() => auditIn(repo, () => auditSession(missing, repo)),
		/NOT advertised: literature-review/,
	);
	const ghost = buildSession(t, repo, { advertisedNames: ["ghost-skill"] });
	assert.throws(
		() => auditIn(repo, () => auditSession(ghost, repo)),
		/does not resolve on disk/,
	);
});

test("auditSession flags a checkout skill symlinked outside the repo", (t) => {
	const repo = makeTempRepo(t);
	const outside = fs.mkdtempSync(path.join(os.tmpdir(), "rogue-"));
	t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
	fs.writeFileSync(path.join(outside, "SKILL.md"), "rogue content\n");
	// skills/rogue is a directory symlink to the outside tree; a real
	// checkout would commit it (git stores the symlink), and pi follows it
	// while advertising the lexical in-repo path.
	fs.symlinkSync(outside, path.join(repo, "skills", "rogue"), "dir");
	// a real checkout would have the committed symlink; commit so the
	// clean-tree gate passes and the canonicalization checks are exercised
	execSync("git add -A", { cwd: repo });
	execSync("git -c commit.gpgsign=false commit -qm rogue", { cwd: repo });
	const dir = buildSession(t, repo, { advertisedNames: ["literature-review", "rogue"] });
	assert.throws(
		() => auditIn(repo, () => auditSession(dir, repo)),
		/UNEXPECTED advertised skills/,
	);
});

test("auditSession fails on corrupt, mismatched, or stale evidence", (t) => {
	const repo = makeTempRepo(t);

	const corrupt = buildSession(t, repo);
	fs.appendFileSync(path.join(corrupt, "session.jsonl"), "{corrupt\n");
	assert.throws(
		() => auditIn(repo, () => auditSession(corrupt, repo)),
		/corrupt transcript/,
	);

	const moved = buildSession(t, repo, { preHead: "0".repeat(40) });
	assert.throws(
		() => auditIn(repo, () => auditSession(moved, repo)),
		/HEAD moved/,
	);

	const stale = buildSession(t, repo, {
		transcriptPrompt: "a different prompt",
	});
	assert.throws(
		() => auditIn(repo, () => auditSession(stale, repo)),
		/prompt mismatch/,
	);

	const wrongModel = buildSession(t, repo, {
		expectedModel: "other-provider other-model\n",
	});
	assert.throws(
		() => auditIn(repo, () => auditSession(wrongModel, repo)),
		/model mismatch/,
	);

	const failed = buildSession(t, repo, { exit: "1" });
	assert.throws(
		() => auditIn(repo, () => auditSession(failed, repo)),
		/boot not clean/,
	);

	const noisy = buildSession(t, repo, { stderr: "boom\n" });
	assert.throws(
		() => auditIn(repo, () => auditSession(noisy, repo)),
		/boot not clean/,
	);

	const timedOut = buildSession(t, repo, { watchdog: true });
	assert.throws(
		() => auditIn(repo, () => auditSession(timedOut, repo)),
		/watchdog fired/,
	);

	const twoBlocks = buildSession(t, repo, { secondSkillsBlock: true });
	assert.throws(
		() => auditIn(repo, () => auditSession(twoBlocks, repo)),
		/exactly 1 available_skills block/,
	);

	const twoSessions = buildSession(t, repo);
	fs.appendFileSync(
		path.join(twoSessions, "session.jsonl"),
		JSON.stringify({ type: "session", cwd: "/somewhere/else" }) + "\n",
	);
	assert.throws(
		() => auditIn(repo, () => auditSession(twoSessions, repo)),
		/exactly 1 session record/,
	);

	const dirtyRepo = makeTempRepo(t);
	const dirtyDir = buildSession(t, dirtyRepo);
	fs.writeFileSync(path.join(dirtyRepo, "untracked.txt"), "stray\n");
	assert.throws(
		() => auditIn(dirtyRepo, () => auditSession(dirtyDir, dirtyRepo)),
		/working tree dirty/,
	);

	const foreignCwd = buildSession(t, repo, { sessionCwd: "/somewhere/else" });
	assert.throws(
		() => auditIn(repo, () => auditSession(foreignCwd, repo)),
		/session cwd mismatch/,
	);

	const belowFloor = buildSession(t, repo, { piVersion: "0.98.0\n" });
	assert.throws(
		() => auditIn(repo, () => auditSession(belowFloor, repo)),
		/below the supported 0\.99 floor/,
	);

	const lengthCapped = buildSession(t, repo);
	fs.appendFileSync(
		path.join(lengthCapped, "session.jsonl"),
		JSON.stringify({
			type: "message",
			message: {
				role: "assistant",
				stopReason: "length",
				content: [{ type: "text", text: "partial response\n" }],
			},
		}) + "\n",
	);
	assert.throws(
		() => auditIn(repo, () => auditSession(lengthCapped, repo)),
		/incomplete final assistant response: stopReason length/,
	);

	const skipped = makeTempRepo(t);
	const skippedDir = buildSession(t, skipped);
	execSync(
		"git update-index --skip-worktree skills/literature-review/SKILL.md",
		{ cwd: skipped },
	);
	fs.writeFileSync(
		path.join(skipped, "skills/literature-review/SKILL.md"),
		"tampered content\n",
	);
	assert.throws(
		() => auditIn(skipped, () => auditSession(skippedDir, skipped)),
		/skip-worktree|assume-unchanged/,
	);
});

test("auditSession rejects host aliases under inventory names", (t) => {
	const repo = makeTempRepo(t);
	const hostDir = fs.mkdtempSync(path.join(os.tmpdir(), "host-alias-"));
	t.after(() => fs.rmSync(hostDir, { recursive: true, force: true }));
	const hostFile = path.join(hostDir, "SKILL.md");
	// the host alias points at the checkout's own inventory file
	fs.symlinkSync(
		path.join(repo, "skills", "literature-review", "SKILL.md"),
		hostFile,
	);
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dogfood-session-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const locs = invNamesToLocs(repo, ["literature-review"], hostDir);
	const records = [
		JSON.stringify({ type: "session", cwd: fs.realpathSync(repo) }),
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
			message: { role: "user", content: [{ type: "text", text: "test prompt" }] },
		}),
		JSON.stringify({
			type: "message",
			message: {
				role: "assistant",
				stopReason: "stop",
				content: [{ type: "text", text: "summary response\n" }],
			},
		}),
	];
	fs.writeFileSync(path.join(dir, "session.jsonl"), records.join("\n") + "\n");
	fs.writeFileSync(path.join(dir, "prompt.txt"), "test prompt");
	fs.writeFileSync(path.join(dir, "expected-model"), "zai-coding-cn glm-5.3-flash\n");
	fs.writeFileSync(path.join(dir, "exit-status"), "0");
	fs.writeFileSync(path.join(dir, "stderr.txt"), "");
	fs.writeFileSync(path.join(dir, "pi-version"), "1.1.0\n");
	fs.writeFileSync(path.join(dir, "node-version"), "v26.11.0\n");
	fs.writeFileSync(path.join(dir, "pre-head"), repoHead(repo));
	fs.writeFileSync(path.join(dir, "manifest-sha256"), repoManifestSha(repo));
	// A host alias under an inventory name does not prove the package loaded
	// the skill from its own manifest — it must be rejected.
	assert.throws(
		() => auditIn(repo, () => auditSession(dir, repo)),
		/advertised from outside the checkout/,
	);
});

function invNamesToLocs(repo, names, hostDir) {
	// every inventory name is advertised through the host alias file
	return names
		.map(
			(n) =>
				`<skill><name>${n}</name><location>${hostDir}/SKILL.md</location></skill>`,
		)
		.join("\n");
}

// Golden fixture: a sanitized REAL pi transcript (run at the pinned pi
// version, paths rewritten to the fixture repo) must pass the boot audit —
// this pins the parser against real-pi schema drift, not just hand-authored
// records.
test("auditSession accepts a sanitized real pi transcript (golden)", (t) => {
	const repo = fs.mkdtempSync(path.join(os.tmpdir(), "dogfood-golden-"));
	t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
	fs.cpSync(path.resolve("skills"), path.join(repo, "skills"), {
		recursive: true,
	});
	fs.mkdirSync(path.join(repo, "test"), { recursive: true });
	fs.copyFileSync(
		path.resolve("test", "expected-skills.json"),
		path.join(repo, "test", "expected-skills.json"),
	);
	fs.writeFileSync(
		path.join(repo, "package.json"),
		JSON.stringify({ pi: { skills: ["./skills"] } }),
	);
	const run = (cmd) => execSync(cmd, { cwd: repo }).toString();
	run("git init -q");
	run("git config user.email test@example.com");
	run("git config user.name test");
	run("git config commit.gpgsign false");
	run("git config core.hooksPath /dev/null");
	run("git add -A");
	run("git -c commit.gpgsign=false commit -qm init");

	const real = fs.realpathSync(repo);
	let golden = fs
		.readFileSync("test/fixtures/real-pi-transcript.jsonl", "utf8")
		.replaceAll("__REPO__", real);
	// Materialize the host-skill files the real session had advertised: pi
	// runs with the operator's host skills, and the fixture must carry no
	// machine-specific absolute paths.
	if (golden.includes("/Users/")) {
		throw new Error("golden fixture contains machine-specific /Users/ paths");
	}
	const hostRoot = fs.mkdtempSync(path.join(os.tmpdir(), "golden-host-"));
	t.after(() => fs.rmSync(hostRoot, { recursive: true, force: true }));
	for (const m of golden.matchAll(/__HOST_SKILLS__\/([^"']+?\/SKILL\.md)/g)) {
		const hostSkill = path.join(hostRoot, "skills", m[1]);
		fs.mkdirSync(path.dirname(hostSkill), { recursive: true });
		fs.writeFileSync(hostSkill, "host skill content\n");
	}
	golden = golden.replaceAll("__HOST_SKILLS__", path.join(hostRoot, "skills"));
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dogfood-session-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	fs.writeFileSync(path.join(dir, "session.jsonl"), golden);
	fs.writeFileSync(path.join(dir, "prompt.txt"), "test prompt");
	fs.writeFileSync(
		path.join(dir, "expected-model"),
		"zai-coding-cn glm-5.3-flash\n",
	);
	fs.writeFileSync(path.join(dir, "exit-status"), "0");
	fs.writeFileSync(path.join(dir, "stderr.txt"), "");
	fs.writeFileSync(path.join(dir, "pi-version"), "1.1.0\n");
	fs.writeFileSync(path.join(dir, "node-version"), "v26.11.0\n");
	fs.writeFileSync(path.join(dir, "pre-head"), repoHead(repo));
	fs.writeFileSync(path.join(dir, "manifest-sha256"), repoManifestSha(repo));
	const out = auditIn(repo, () => auditSession(dir, repo));
	assert.match(out, /^clean /);
	assert.match(out, /provider zai-coding-cn/);
});
