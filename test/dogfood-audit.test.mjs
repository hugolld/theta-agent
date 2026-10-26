import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	ge,
	decodeXmlEntities,
	extractLocations,
	resolveAdvertisedSkill,
	resolveCheckoutScript,
	shellTokens,
	commandResolvesToScript,
	isIsoDate,
	resolveNotebookDir,
	auditNotebook,
	formatCleanLine,
	CLEAN_LINE_PATTERN,
	auditSession,
	ATTESTATION_LEGS,
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
		/exactly 1 well-formed available_skills block, found 0/,
	);
	assert.throws(
		() =>
			extractLocations(
				text +
					"<available_skills><skill><name>ghost</name><location>/x/ghost/SKILL.md</location></skill></available_skills>",
			),
		/exactly 1 well-formed available_skills block, found 2/,
	);
	assert.throws(
		() => extractLocations("<available_skills><skill><name>a</name></skill></available_skills>"),
		/malformed skill record: 1 name tags, 0 location tags/,
	);
	assert.throws(
		() =>
			extractLocations(
				"<available_skills><skill><name>a</name><location>/x/a/SKILL.md</location></skill>",
			),
		/exactly 1 well-formed available_skills block/,
	);
	assert.throws(
		() =>
			extractLocations(
				'<available_skills><skill><name>a</name><location>/x/a/SKILL.md</location></skill></available_skills><skill><name>stray</name></skill>',
			),
		/stray or unclosed <skill> records/,
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
function initFixtureRepo(repo, expectedSkills) {
	fs.mkdirSync(path.join(repo, "test"), { recursive: true });
	fs.writeFileSync(
		path.join(repo, "test", "expected-skills.json"),
		JSON.stringify(expectedSkills),
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
	// Canonical from birth: mount aliases (/var vs /private/var on macOS)
	// must not leak lexical paths into containment comparisons.
	return fs.realpathSync(repo);
}

function makeTempRepo(t) {
	const repo = fs.mkdtempSync(path.join(os.tmpdir(), "dogfood-repo-"));
	t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
	fs.mkdirSync(path.join(repo, "skills", "literature-review"), {
		recursive: true,
	});
	fs.writeFileSync(
		path.join(repo, "skills", "literature-review", "SKILL.md"),
		"skill content\n",
	);
	fs.mkdirSync(path.join(repo, "skills", "literature-review", "scripts"), {
		recursive: true,
	});
	fs.writeFileSync(
		path.join(repo, "skills", "literature-review", "scripts", "search.py"),
		"# connector script\n",
	);
	// direct execution needs the execute bit
	fs.chmodSync(
		path.join(repo, "skills", "literature-review", "scripts", "search.py"),
		0o755,
	);
	return initFixtureRepo(repo, {
		vendored: [{ name: "literature-review", "tree-sha256": "x" }],
		"self-authored": [],
	});
}

const repoHead = (repo) =>
	execSync("git rev-parse HEAD", { cwd: repo }).toString().trim();
const repoManifestSha = (repo) =>
	createHash("sha256")
		.update(fs.readFileSync(path.join(repo, "package.json")))
		.digest("hex");

// Golden-fixture repo construction (#39 retro from #38): the golden tests —
// the sanitized real-pi transcript and the notebook-audit fixture scenarios
// — build the same repo shape (skill trees + inventory + manifest, one
// initial commit, canonical path), so they share initFixtureRepo instead of
// each hand-rolling ~25 lines.
function goldenRepo(t, { skills, expectedSkills, gitignore = false } = {}) {
	const repo = fs.mkdtempSync(path.join(os.tmpdir(), "dogfood-golden-"));
	t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
	for (const skill of skills) {
		fs.cpSync(path.resolve("skills", skill), path.join(repo, "skills", skill), {
			recursive: true,
		});
	}
	if (gitignore) fs.writeFileSync(path.join(repo, ".gitignore"), ".theta/\n");
	return initFixtureRepo(repo, expectedSkills);
}

// A golden session dir for `repo`: the transcript text (machine-path-guarded
// before any substitution, __REPO__ bound to the repo) plus the metadata
// files every audit pins. `fixtureDir`, when given, supplies the six
// operator-recorded files a committed scenario carries; otherwise the
// standard boot literals both golden tests were written against.
function goldenSession(t, repo, { text, fixtureDir } = {}) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dogfood-session-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	if (/\/Users\/|\/opt\/homebrew/.test(text)) {
		throw new Error("golden fixture contains machine-specific absolute paths");
	}
	fs.writeFileSync(
		path.join(dir, "session.jsonl"),
		text.replaceAll("__REPO__", fs.realpathSync(repo)),
	);
	if (fixtureDir !== undefined) {
		for (const f of [
			"prompt.txt",
			"expected-model",
			"exit-status",
			"stderr.txt",
			"pi-version",
			"node-version",
		]) {
			fs.copyFileSync(path.join(fixtureDir, f), path.join(dir, f));
		}
	} else {
		fs.writeFileSync(path.join(dir, "prompt.txt"), "test prompt");
		fs.writeFileSync(path.join(dir, "expected-model"), "zai-coding-cn glm-5.3-flash\n");
		fs.writeFileSync(path.join(dir, "exit-status"), "0");
		fs.writeFileSync(path.join(dir, "stderr.txt"), "");
		fs.writeFileSync(path.join(dir, "pi-version"), "1.1.0\n");
		fs.writeFileSync(path.join(dir, "node-version"), "v26.11.0\n");
	}
	fs.writeFileSync(path.join(dir, "pre-head"), repoHead(repo));
	fs.writeFileSync(path.join(dir, "manifest-sha256"), repoManifestSha(repo));
	return dir;
}

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
		{ type: "session", cwd: overrides.sessionCwd ?? fs.realpathSync(repo) },
		{
			type: "model_change",
			provider: "zai-coding-cn",
			modelId: "glm-5.3-flash",
		},
		{
			type: "message",
			message: {
				role: "system",
				sections: { skills: skillsText },
			},
		},
		{
			type: "message",
			message: { role: "user", content: [{ type: "text", text: prompt }] },
		},
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
			({
				type: "message",
				message: {
					role: "assistant",
					provider: "zai-coding-cn",
					model: "glm-5.3-flash",
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
			({
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
	if (overrides.bashCommand !== undefined) {
		const bashPair = [
			({
				type: "message",
				message: {
					role: "assistant",
					provider: "zai-coding-cn",
					model: "glm-5.3-flash",
					content: [
						{
							type: "toolCall",
							id: "call_bash",
							name: "bash",
							arguments: { command: overrides.bashCommand, timeout: 60 },
						},
					],
				},
			}),
			({
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "call_bash",
					toolName: overrides.bashToolName ?? "bash",
					isError: overrides.bashIsError ?? false,
					content: [
						{
							type: "text",
							text: overrides.bashResultText ?? "1. query\n2. provenance\n",
						},
					],
				},
			}),
		];
		// a bash call spliced in before the user record was not caused by it
		if (overrides.bashBeforePrompt) records.splice(3, 0, ...bashPair);
		else records.push(...bashPair);
	}
	// a completed one-shot ends with the assistant's response
	records.push(
		({
			type: "message",
			message: {
				role: "assistant",
				provider: "zai-coding-cn",
				model: "glm-5.3-flash",
				stopReason: "stop",
				content: [{ type: "text", text: "summary response\n" }],
			},
		}),
	);
	// linear id/parentId chain, matching real pi transcripts
	if (overrides.extraRecords) records.push(...overrides.extraRecords);
	let prevFx = null;
	records.forEach((rec, idx) => {
		rec.id = `fx${idx}`;
		if (idx > 0) rec.parentId = prevFx;
		prevFx = rec.id;
	});
	fs.writeFileSync(
			path.join(dir, "session.jsonl"),
			records
				.map((r) => JSON.stringify(r))
				.join("\n") + "\n",
		);
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

// Builds the legs array for auditSession from named slots — registry order
// decides attestation order, matching the CLI's positional mapping.
function withLegs(spec) {
	return ATTESTATION_LEGS.filter((l) => spec[l.name] !== undefined).map((l) => ({
		leg: l,
		arg: spec[l.name],
	}));
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
		auditSession(good, repo, withLegs({ skill: "skills/literature-review/SKILL.md" })),
	);
	assert.match(out, /selected-file-opened .*\/skills\/literature-review\/SKILL\.md/);
	const bad = buildSession(t, repo, { toolResultIsError: true });
	assert.throws(
		() => auditIn(repo, () => auditSession(bad, repo, withLegs({ skill: "skills/literature-review/SKILL.md" }))),
		/selected file never opened/,
	);
	const partial = buildSession(t, repo, {
		toolResultIsError: false,
		partialRead: true,
		resultText: "partial\n",
	});
	assert.throws(
		() => auditIn(repo, () => auditSession(partial, repo, withLegs({ skill: "skills/literature-review/SKILL.md" }))),
		/selected file never opened/,
	);
	const fabricated = buildSession(t, repo, {
		toolResultIsError: false,
		resultText: "fabricated content\n",
	});
	assert.throws(
		() => auditIn(repo, () => auditSession(fabricated, repo, withLegs({ skill: "skills/literature-review/SKILL.md" }))),
		/selected file never opened/,
	);
	const wrongTool = buildSession(t, repo, {
		toolResultIsError: false,
		toolName: "other",
	});
	assert.throws(
		() => auditIn(repo, () => auditSession(wrongTool, repo, withLegs({ skill: "skills/literature-review/SKILL.md" }))),
		/selected file never opened/,
	);
	const confusable = buildSession(t, repo, {
		toolResultIsError: false,
		transcriptPrompt: "Use lіterature-review and open its instructions",
	});
	fs.writeFileSync(
		path.join(confusable, "prompt.txt"),
		"Use lіterature-review and open its instructions",
	);
	assert.throws(
		() => auditIn(repo, () => auditSession(confusable, repo, withLegs({ skill: "skills/literature-review/SKILL.md" }))),
		/non-ASCII characters/,
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
		() => auditIn(repo, () => auditSession(camelSteer, repo, withLegs({ skill: "skills/literature-review/SKILL.md" }))),
		/names the selected skill/,
	);
});

test("shellTokens splits commands the way a shell reads them", () => {
	assert.deepEqual(shellTokens(`python3 'skills/a/search.py' --query "two words"`), [
		"python3",
		"skills/a/search.py",
		"--query",
		"two words",
	]);
	assert.deepEqual(shellTokens("a.py;cd /tmp&&b.py | c.py"), [
		"a.py",
		"cd",
		"/tmp",
		"b.py",
		"c.py",
	]);
	assert.deepEqual(shellTokens("echo a # python3 skills/a/search.py"), ["echo", "a"]);
	assert.deepEqual(shellTokens("# whole line\nx.py"), ["x.py"]);
	assert.deepEqual(shellTokens("out=$(pwd)/x.py 2>&1"), ["out=$", "pwd", "/x.py", "1"]);
	assert.deepEqual(shellTokens("py\\thon x"), ["python", "x"]);
	assert.deepEqual(shellTokens("echo 'unclosed"), ["echo", "unclosed"]);
});

test("commandResolvesToScript attests execution positions only", (t) => {
	const repo = fs.realpathSync(makeTempRepo(t));
	const target = `${repo}/skills/literature-review/scripts/search.py`;
	const hits = [
		`python3 ${target} --query "p53" --json`,
		"python3 skills/literature-review/scripts/search.py --pmid 1",
		"python3 'skills/literature-review/scripts/search.py' --query x",
		"cd skills/literature-review && python3 scripts/search.py --query x",
		"cd skills/literature-review; python3 scripts/search.py",
		// a provably-run && chain may carry the cd (non-error overall
		// result proves every chained segment ran and exited 0)
		"git status && cd skills/literature-review && python3 scripts/search.py",
		// the cd is not in the pipeline — only the script invocation is
		"cd skills/literature-review && python3 scripts/search.py | tee out.txt",
		// a command prefix passes the real program through; >& file is a
		// both-streams redirect; a subshell replacement dies with it
		"command python3 skills/literature-review/scripts/search.py",
		`python3 ${target} >& out.txt`,
		"(exec true); python3 skills/literature-review/scripts/search.py",
		"(exec python3); python3 skills/literature-review/scripts/search.py",
		// a file redirect reopens a closed fd before the dup reads it
		"1>&- > log.txt 2>&1 python3 skills/literature-review/scripts/search.py",
		// exec'ing the script itself replaces the shell with it
		"exec python3 skills/literature-review/scripts/search.py",
		// a redirect-only exec keeps the shell — later segments run
		"exec 2>/dev/null; python3 skills/literature-review/scripts/search.py",
		// an exit inside a subshell dies with it
		"(exit 0); python3 skills/literature-review/scripts/search.py",
		// an attestation before the exit still stands — the script ran
		"python3 skills/literature-review/scripts/search.py; exit 0",
		"skills/literature-review/scripts/search.py --query x",
		"timeout 30 python3 skills/literature-review/scripts/search.py",
		"env NCBI_API_KEY=k python3 skills/literature-review/scripts/search.py",
		"time sudo watch python3 skills/literature-review/scripts/search.py",
		"nohup nice stdbuf -oL python3 skills/literature-review/scripts/search.py",
		// cd's own flags precede the directory operand (combined too)
		"cd -P skills/literature-review && python3 scripts/search.py",
		"cd -LP skills/literature-review && python3 scripts/search.py",
		// &> is a combined-output redirection, not backgrounding
		"cd skills/literature-review &>/dev/null && python3 scripts/search.py",
		// a guarded pipeline that runs proves every member ran
		"true && echo x | python3 skills/literature-review/scripts/search.py",
		"set -e\npython3 skills/literature-review/scripts/search.py",
		`python3 ${target} --query x 2>&1 | tee out.txt`,
		// backslash-newline is a line continuation, not a word
		"python3 \\\nskills/literature-review/scripts/search.py --query x",
		// a trailing newline ends the line, not the chain
		"true && python3 skills/literature-review/scripts/search.py\n",
		"cat <<EOF && python3 skills/literature-review/scripts/search.py\nbody\nEOF",
	];
	for (const command of hits) {
		assert.equal(
			commandResolvesToScript(command, target, repo),
			true,
			`expected hit: ${command}`,
		);
	}
	const copyDir = fs.mkdtempSync(path.join(os.tmpdir(), "script-copy-"));
	t.after(() => fs.rmSync(copyDir, { recursive: true, force: true }));
	fs.copyFileSync(target, path.join(copyDir, "search.py"));
	const alias = path.join(os.tmpdir(), `alias-${process.pid}-${Date.now()}.py`);
	fs.symlinkSync(target, alias);
	t.after(() => fs.rmSync(alias, { force: true }));
	const misses = [
		// argument mentions are not execution
		`cat ${target}`,
		`grep -q foo ${target}`,
		`ls ${repo}/skills/literature-review/scripts/`,
		`echo python3 ${target}`,
		// a copy outside the checkout is not the checkout's script
		`python3 ${copyDir}/search.py --query x`,
		// redirection targets and heredoc bodies mention without executing
		`echo hi > ${target}`,
		`cat > /tmp/x.sh <<'EOF'\npython3 ${target}\nEOF`,
		// comments are not commands
		`echo hi # python3 ${target}`,
		// unmodelled expansion fails closed
		"python3 $SCRIPT --query x",
		"python3 $(echo skills/literature-review/scripts/search.py)",
		// a nested command string is one word, not a command
		`bash -c "python3 ${target}"`,
		// short-circuited segments never attest: the overall exit status
		// cannot prove a ||-guarded word ran, and an &&-chained one only
		// when the chain reaches the command's end — newlines directly
		// after &&/|| continue the list
		`true || python3 ${target}`,
		"echo done || python3 skills/literature-review/scripts/search.py",
		"false || python3 skills/literature-review/scripts/search.py",
		`true || false || python3 ${target}`,
		`echo hi || ( false || python3 ${target} )`,
		"true && python3 skills/literature-review/scripts/search.py; echo done",
		"false && python3 skills/literature-review/scripts/search.py || true",
		"false &&\npython3 skills/literature-review/scripts/search.py; echo done",
		"true ||\npython3 skills/literature-review/scripts/search.py; echo done",
		"false && # note\npython3 skills/literature-review/scripts/search.py; echo done",
		// interpreter flags may eat the program word — the search ends
		"python3 - skills/literature-review/scripts/search.py < /dev/null",
		"python3 -W skills/literature-review/scripts/search.py < /dev/null",
		"python3 -u skills/literature-review/scripts/search.py",
		// a subshell's cd dies with it — the parent anchor governs after )
		"(cd skills/literature-review); python3 scripts/search.py",
		// a backgrounded or pipelined cd moves only its subshell
		"cd skills/literature-review & python3 scripts/search.py",
		"cd skills/literature-review > /dev/null & python3 scripts/search.py",
		"cd skills/literature-review | cat; python3 scripts/search.py",
		"cat f | cd skills/literature-review; python3 scripts/search.py",
		// the env-pair exception dies at the chained interpreter: X=1 is
		// python3's script operand, and the target is argv
		"env python3 X=1 skills/literature-review/scripts/search.py",
		// a CDPATH assignment shadows later bare-relative cds
		"export CDPATH=/shadow; cd literature-review && python3 scripts/search.py",
		"CDPATH=/shadow cd literature-review && python3 scripts/search.py",
		// a function definition's () body defines; it does not run
		`f() ( python3 ${target} )`,
		// leading split redirects open the file; they do not run it
		`<> ${target} cat`,
		`>& ${target} true`,
		// a numeric or assignment word would itself be the script operand
		"python3 30 skills/literature-review/scripts/search.py",
		"python3 A=1 skills/literature-review/scripts/search.py",
		// a bare "run" word is a program, not a uv prefix
		"PATH=.:$PATH run python3 skills/literature-review/scripts/search.py",
		"uv run python3 skills/literature-review/scripts/search.py",
		// a numeric or flag word with no wrapper to own it IS the program;
		// its not-found failure can be swallowed by `|| true`
		"30 python3 skills/literature-review/scripts/search.py || true",
		"time -p 30 python3 skills/literature-review/scripts/search.py || true",
		"-v python3 skills/literature-review/scripts/search.py || true",
		// an interpreter word after a plain interpreter is the script
		// operand (python3 opens the file named env), not a chain
		"python3 env skills/literature-review/scripts/search.py || true",
		"bash env skills/literature-review/scripts/search.py || true",
		// an assignment after a wrapper is its program operand
		"nohup X=1 python3 skills/literature-review/scripts/search.py || true",
		// an assignment or redirect may precede a cd inside one pipeline
		// segment — the cd is still subshell-confined
		"cat f | FOO=bar cd skills/literature-review; python3 scripts/search.py || true",
		"cat f | > out cd skills/literature-review; python3 scripts/search.py || true",
		// a pipeline that is a skipped &&/|| operand runs none of its
		// members; the trailing command supplies the exit status
		"false && echo x | python3 skills/literature-review/scripts/search.py; echo done",
		"true || echo y | python3 skills/literature-review/scripts/search.py; echo done",
		"true || ( echo ) | python3 skills/literature-review/scripts/search.py; echo done",
		"grep -q foo bar.txt && cat baz.txt | python3 skills/literature-review/scripts/search.py; echo done",
		// process substitution is unmodelled and refused outright
		`<(echo ${target}) x || true`,
		`>(echo ${target}) x || true`,
		// a word directly after ) completes a command substitution — its
		// output is the real command word, and the audited path is argv;
		// a redirection in between does not clear the close
		`$(echo true) python3 skills/literature-review/scripts/search.py`,
		`$(echo true) > /dev/null python3 skills/literature-review/scripts/search.py`,
		`$((1)) > /dev/null python3 skills/literature-review/scripts/search.py || true`,
		`env $(echo true) python3 skills/literature-review/scripts/search.py`,
		// |& is a pipe variant: a skipped || operand runs no member
		"true || x |& python3 skills/literature-review/scripts/search.py",
		// a separator inside a skipped subshell operand may not drop the
		// inherited guard — none of the group's words ran
		`true || ( echo ; python3 ${target} )`,
		"false && ( echo hi ; python3 skills/literature-review/scripts/search.py ) || true",
		"false && echo $(true; python3 skills/literature-review/scripts/search.py) || true",
		"true || (\n echo hi\n python3 skills/literature-review/scripts/search.py\n)",
		// a pipelined cd via |& is still subshell-confined
		"cd skills/literature-review |& python3 scripts/search.py || true",
		"cat f |& FOO=bar cd skills/literature-review; python3 scripts/search.py || true",
		// a trailing slash (or /., /..) cannot open a file
		`python3 ${target}/ || true`,
		`python3 ${target}/. || echo ok`,
		// bash opens redirections before running the command: a
		// provably-failing redirection stops it, and a rescuing tail
		// still exits 0
		`python3 ${target} > /no/such/dir/f ; echo ok`,
		`python3 ${target} > /no/such/dir/f || echo ok`,
		`python3 ${target} > '' ; echo ok`,
		// directory targets fail with EISDIR, file-as-parent with ENOTDIR,
		// and unwritable paths with EPERM
		`python3 ${target} > /tmp ; echo ok`,
		`python3 ${target} < /tmp ; echo ok`,
		`python3 ${target} > /etc/hosts/f ; echo ok`,
		`python3 ${target} > /etc/hosts ; echo ok`,
		// relative targets resolve against the pinned session cwd
		"python3 skills/literature-review/scripts/search.py > out/nope.txt ; echo ok",
		"python3 skills/literature-review/scripts/search.py < noinput.txt ; echo ok",
		// fd duplication beyond 0-2 is a bad file descriptor
		`python3 ${target} 2>&9 ; echo ok`,
		// a `-` or digit target is a filename unless the operator is >&
		"python3 skills/literature-review/scripts/search.py < - ; echo ok",
		// dup from an fd the same command closed is a bad descriptor —
		// bash aborts the command before the program runs
		"1>&- 2>&1 python3 skills/literature-review/scripts/search.py ; echo ok",
		"2>&- 1>&2 python3 skills/literature-review/scripts/search.py ; echo ok",
		// CR is a word character to bash — the \r stays in the filename
		"python3 skills/literature-review/scripts/search.py\r; echo ok",
		"python3 skills/literature-review/scripts/search.py\r\necho ok",
		// a slash-less command word goes through PATH, not the cwd
		"cd skills/literature-review/scripts; search.py; echo ok",
		// a redirection after ) applies to the whole parenthesized command
		`(python3 ${target}) > /no/such/dir/f ; echo ok`,
		// pushd -n never changes the directory
		"pushd -n skills/literature-review ; python3 scripts/search.py",
		// bash rejects unknown cd/pushd options — the cd never ran
		"cd -Q skills/literature-review; python3 scripts/search.py; echo ok",
		"pushd -Q skills/literature-review; python3 scripts/search.py; echo ok",
		// a pushd ±N operand never changes the directory either
		"pushd -0 skills/literature-review; python3 scripts/search.py; echo ok",
		// exec with a redirect-only list closes fds for the whole shell —
		// a later segment's dup aborts the command
		"exec 1>&-; python3 skills/literature-review/scripts/search.py 2>&1; true",
		// exit and exec end the shell: no later segment runs
		"exit 0; python3 skills/literature-review/scripts/search.py",
		"exit 0 && python3 skills/literature-review/scripts/search.py",
		"exec echo hi; python3 skills/literature-review/scripts/search.py",
		// a DEBUG/ERR trap can exit before the command runs
		"trap 'exit 0' DEBUG; python3 skills/literature-review/scripts/search.py",
		// noexec parses without executing anything
		"set -n; python3 skills/literature-review/scripts/search.py",
		"set -o noexec; python3 skills/literature-review/scripts/search.py",
		"set -en\npython3 skills/literature-review/scripts/search.py",
		// bare exec >&- and the fd-move form close fds for the whole shell
		"exec >&-; python3 skills/literature-review/scripts/search.py 2>&1; true",
		"exec 2>&1-; python3 skills/literature-review/scripts/search.py 2>&1; true",
		// a flag eats the exec'd interpreter's operand position — the
		// shell was replaced either way, so later segments are phantom
		"exec python3 -c 'print(1)'; python3 skills/literature-review/scripts/search.py",
		"exec bash -c 'echo hi'; python3 skills/literature-review/scripts/search.py",
		"exec python3; python3 skills/literature-review/scripts/search.py",
		// command/builtin prefixes re-enter the same checks
		"command trap 'exit 0' DEBUG; python3 skills/literature-review/scripts/search.py",
		"command exit 0; python3 skills/literature-review/scripts/search.py",
		"command set -n; python3 skills/literature-review/scripts/search.py",
		// noclobber makes ordinary > redirections fail on existing files;
		// restricted forbids '/' in command names
		"set -C; python3 skills/literature-review/scripts/search.py",
		"set -r; skills/literature-review/scripts/search.py; echo done",
		// a read assigns CDPATH without the = spelling — shadowed like
		// any other CDPATH mention
		`read CDPATH <<< "/tmp/shd"; cd skills/literature-review && python3 scripts/search.py`,
		// a PATH reassignment makes interpreter resolution unknowable
		"PATH=/tmp/evil:$PATH python3 skills/literature-review/scripts/search.py",
		"env PATH=/tmp/evil python3 skills/literature-review/scripts/search.py",
		// glob-shaped redirect targets are ambiguous when they multi-match
		`python3 ${target} > /tmp/*.log ; echo ok`,
		// a fd-prefixed dup with a file word is an ambiguous redirect
		`python3 ${target} 2>&out.txt ; echo ok`,
		// exec'ing a special builtin ends the shell
		"exec cd skills/literature-review; python3 scripts/search.py",
		// builtin runs only shell builtins — never a program
		"builtin python3 skills/literature-review/scripts/search.py || true",
		// mode flags run nothing: command prints the path, sudo -v/-l/-e
		// list or edit instead of executing
		"command -v skills/literature-review/scripts/search.py",
		"command -v python3 skills/literature-review/scripts/search.py",
		"sudo -v python3 skills/literature-review/scripts/search.py",
		"sudo -l python3 skills/literature-review/scripts/search.py",
		"EDITOR=true sudo -e skills/literature-review/scripts/search.py",
		// sudo -p's value is the prompt string — the path word is not a
		// program, and only the trailing command runs
		"sudo -p skills/literature-review/scripts/search.py true",
		// an unknown wrapper flag fails the wrapper before the program
		"command -q python3 skills/literature-review/scripts/search.py; echo ok",
		"nice -Q python3 skills/literature-review/scripts/search.py; echo ok",
		"nohup -Z python3 skills/literature-review/scripts/search.py; echo ok",
		"timeout -Z 30 python3 skills/literature-review/scripts/search.py; echo ok",
		// command-prefixing the exec-close still closes the shell's fd
		"command exec 1>&-; python3 skills/literature-review/scripts/search.py 2>&1; echo done",
		// eval/builtin/source can end or divert the shell from argument
		// position — refused in command position
		"eval exit 0 && python3 skills/literature-review/scripts/search.py",
		"builtin exit 0; python3 skills/literature-review/scripts/search.py",
		"command eval exit 0; python3 skills/literature-review/scripts/search.py",
		"builtin cd /tmp; python3 skills/literature-review/scripts/search.py; true",
		// a spaced `<< --` delimiter is the literal word `--`; only a
		// dash attached to the operator makes the <<- tab-stripping form
		"cat << --\n-\npython3 skills/literature-review/scripts/search.py\n--\ntrue",
		// the <<- terminator strips leading tabs only — a `-EOF` line is
		// body text, whatever the audit's spelling of the delimiter
		"cat <<-EOF\n-EOF\npython3 skills/literature-review/scripts/search.py\nEOF\ntrue",
		"cat <<- 'EOF'\npython3 skills/literature-review/scripts/search.py\nEOF",
		"cat <<-X\npython3 skills/literature-review/scripts/search.py\nX",
		// timeout takes exactly one duration operand
		"timeout 2 30 python3 skills/literature-review/scripts/search.py",
		// a background-looking &> redirect moves the parent cwd — the
		// relative word then resolves under the cd target, not the checkout
		"cd /tmp &>/dev/null && python3 skills/literature-review/scripts/search.py",
		// a backtick substitution is opaque; its hidden cd cannot divert
		// the anchor to the checkout's copy
		"echo `cd /tmp; python3 skills/literature-review/scripts/search.py`",
		// control flow is refused outright — whether the body ran is what
		// the attestation would have to prove
		"if [ -f results.json ]; then\npython3 skills/literature-review/scripts/search.py\nfi",
		"while false; do\npython3 skills/literature-review/scripts/search.py\ndone",
		"case nope in match) python3 skills/literature-review/scripts/search.py;; esac",
		"for i in; do\npython3 skills/literature-review/scripts/search.py\ndone",
		// a heredoc body ends at a raw line holding only the delimiter —
		// quoted, padded, and mid-line lookalikes are body text
		`cat > /tmp/x.sh <<'EOF'\necho X EOF\npython3 skills/literature-review/scripts/search.py\nEOF`,
		`cat > /tmp/x.sh <<'EOF'\n"EOF"\npython3 skills/literature-review/scripts/search.py\nEOF`,
		`cat <<A <<B\nx\nA\npython3 skills/literature-review/scripts/search.py\nB`,
		// a cd through an unresolvable expansion loses the anchor
		"cd $SKILL_DIR && python3 scripts/search.py",
		"cd ~/elsewhere && python3 skills/literature-review/scripts/search.py",
		// a resolvable guarded cd moves the anchor when provable — the
		// relative word then resolves under /tmp, not the checkout
		"true && cd /tmp && python3 scripts/search.py",
	];
	for (const command of misses) {
		assert.equal(
			commandResolvesToScript(command, target, repo),
			false,
			`expected miss: ${command}`,
		);
	}
	// an alias of the checkout's copy executes the same bytes
	assert.equal(commandResolvesToScript(`python3 ${alias}`, target, repo), true);
	// a direct command word needs the execute bit and a slash: the
	// checkout's non-executable files are interpreter operands only
	const norexec = path.join(repo, "norexec.py");
	fs.writeFileSync(norexec, "# not executable\n");
	assert.equal(
		commandResolvesToScript("norexec.py; echo ok", fs.realpathSync(norexec), repo),
		false,
	);
	assert.equal(
		commandResolvesToScript("./norexec.py; echo ok", fs.realpathSync(norexec), repo),
		false,
	);
});

test("resolveCheckoutScript accepts only existing files inside the checkout", (t) => {
	const repo = makeTempRepo(t);
	const real = fs.realpathSync(repo);
	const rel = "skills/literature-review/scripts/search.py";
	assert.equal(resolveCheckoutScript(repo, rel), `${real}/skills/literature-review/scripts/search.py`);
	assert.equal(
		resolveCheckoutScript(repo, `./${rel}`),
		`${real}/skills/literature-review/scripts/search.py`,
	);
	assert.throws(
		() => resolveCheckoutScript(repo, "/etc/hosts"),
		/must be a file inside the checkout/,
	);
	assert.throws(
		() => resolveCheckoutScript(repo, "skills/literature-review"),
		/must be a file inside the checkout/,
	);
	assert.throws(
		() => resolveCheckoutScript(repo, "skills/literature-review/scripts/nope.py"),
		/does not resolve on disk/,
	);
});

test("auditSession attests script execution when the checkout's script ran", (t) => {
	const repo = makeTempRepo(t);
	const real = fs.realpathSync(repo);
	const abs = `${real}/skills/literature-review/scripts/search.py`;
	const arg = "skills/literature-review/scripts/search.py";

	// pass: read + executed script, both attestations in one invocation
	const ran = buildSession(t, repo, {
		toolResultIsError: false,
		bashCommand: `python3 ${abs} --query "p53 AND therapy" --json`,
	});
	const out = auditIn(repo, () =>
		auditSession(ran, repo, withLegs({ skill: "skills/literature-review/SKILL.md", script: arg })),
	);
	assert.ok(out.includes(`script-executed ${abs}`), out);
	assert.match(out, /script-content [0-9a-f]{64}/);
	assert.ok(out.indexOf("script-executed") > out.indexOf("selected-file-opened"));

	// the doctrine's own invocation shape (cd + relative path) attests
	const doctrine = buildSession(t, repo, {
		bashCommand: "cd skills/literature-review && python3 scripts/search.py --query p53",
	});
	const doctrineOut = auditIn(repo, () => auditSession(doctrine, repo, withLegs({ script: arg })));
	assert.ok(doctrineOut.includes(`script-executed ${abs}`));

	// script not run: nothing in the session executed it
	const notRun = buildSession(t, repo, { toolResultIsError: false });
	assert.throws(
		() => auditIn(repo, () => auditSession(notRun, repo, withLegs({ script: arg }))),
		/checkout script never executed/,
	);

	// error result: the bash call resolved to the script but failed
	const errored = buildSession(t, repo, {
		bashCommand: `python3 ${abs} --query x`,
		bashIsError: true,
	});
	assert.throws(
		() => auditIn(repo, () => auditSession(errored, repo, withLegs({ script: arg }))),
		/checkout script execution failed/,
	);

	// non-checkout copy executed: same bytes, wrong tree — does not attest
	const copyDir = fs.mkdtempSync(path.join(os.tmpdir(), "script-copy-"));
	t.after(() => fs.rmSync(copyDir, { recursive: true, force: true }));
	fs.copyFileSync(abs, path.join(copyDir, "search.py"));
	const copied = buildSession(t, repo, {
		bashCommand: `python3 ${copyDir}/search.py --query x`,
	});
	assert.throws(
		() => auditIn(repo, () => auditSession(copied, repo, withLegs({ script: arg }))),
		/checkout script never executed/,
	);

	// a bash call spliced in before the prompt was not caused by the task
	const spliced = buildSession(t, repo, {
		bashCommand: `python3 ${abs}`,
		bashBeforePrompt: true,
	});
	assert.throws(
		() => auditIn(repo, () => auditSession(spliced, repo, withLegs({ script: arg }))),
		/checkout script never executed/,
	);

	// a prompt naming the script steers instead of routing
	const steered = buildSession(t, repo, {
		bashCommand: `python3 ${abs}`,
		transcriptPrompt: "run scripts/search.py and show me the output",
	});
	fs.writeFileSync(
		path.join(steered, "prompt.txt"),
		"run scripts/search.py and show me the output",
	);
	assert.throws(
		() => auditIn(repo, () => auditSession(steered, repo, withLegs({ script: arg }))),
		/names the selected script/,
	);

	// the script argument itself must be a checkout file
	const plain = buildSession(t, repo, {});
	assert.throws(
		() => auditIn(repo, () => auditSession(plain, repo, withLegs({ script: "/etc/hosts" }))),
		/must be a file inside the checkout/,
	);
	assert.throws(
		() => auditIn(repo, () => auditSession(plain, repo, withLegs({ script: "nope/missing.py" }))),
		/does not resolve on disk/,
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
		/exactly 1 well-formed available_skills block/,
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

	const lengthCapped = buildSession(t, repo, {
		extraRecords: [
			{
				type: "message",
				message: {
					role: "assistant",
					provider: "zai-coding-cn",
					model: "glm-5.3-flash",
					stopReason: "length",
					content: [{ type: "text", text: "partial response\n" }],
				},
			},
		],
	});
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
	const locs = invNamesToLocs(["literature-review"], hostDir);
	const records = [
		({ type: "session", cwd: fs.realpathSync(repo) }),
		({
			type: "model_change",
			provider: "zai-coding-cn",
			modelId: "glm-5.3-flash",
		}),
		({
			type: "message",
			message: {
				role: "system",
				sections: { skills: `<available_skills>${locs}</available_skills>` },
			},
		}),
		({
			type: "message",
			message: { role: "user", content: [{ type: "text", text: "test prompt" }] },
		}),
		({
			type: "message",
			message: {
				role: "assistant",
				provider: "zai-coding-cn",
				model: "glm-5.3-flash",
				stopReason: "stop",
				content: [{ type: "text", text: "summary response\n" }],
			},
		}),
	];
	let prevHost = null;
	records.forEach((rec, idx) => {
		rec.id = `host${idx}`;
		if (idx > 0) rec.parentId = prevHost;
		prevHost = rec.id;
	});
	fs.writeFileSync(
		path.join(dir, "session.jsonl"),
		records.map((r) => JSON.stringify(r)).join("\n") + "\n",
	);
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

function invNamesToLocs(names, hostDir) {
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
// records. The repo carries the whole shipped library, its inventory
// derived from the same test/expected-skills.json so the two cannot drift:
// the auditor requires every shipped skill to be advertised, so each new
// skill extends the fixture's skills section (the event structure stays the
// real 2026-10-10 capture).
test("auditSession accepts a sanitized real pi transcript (golden)", (t) => {
	const realExpected = JSON.parse(
		fs.readFileSync(path.resolve("test", "expected-skills.json")),
	);
	const repo = goldenRepo(t, {
		skills: [
			...realExpected.vendored.map((s) => s.name),
			...realExpected["self-authored"],
		],
		expectedSkills: realExpected,
	});

	const rawFixture = fs.readFileSync(
		"test/fixtures/real-pi-transcript.jsonl",
		"utf8",
	);
	// The portability guard inspects the raw fixture bytes before any
	// substitution: machine-specific absolute paths must never be committed.
	if (/\/Users\/|\/opt\/homebrew/.test(rawFixture)) {
		throw new Error("golden fixture contains machine-specific absolute paths");
	}
	const hostPiLib = fs.mkdtempSync(path.join(os.tmpdir(), "golden-pi-lib-"));
	t.after(() => fs.rmSync(hostPiLib, { recursive: true, force: true }));
	for (const rel of [
		"@earendil-works/pi-coding-agent/README.md",
		"@earendil-works/pi-coding-agent/docs",
		"@earendil-works/pi-coding-agent/examples",
	]) {
		fs.mkdirSync(path.join(hostPiLib, rel), { recursive: true });
	}
	const real = fs.realpathSync(repo);
	let golden = rawFixture.replaceAll("__REPO__", real);
	// Materialize the host-skill files the real session had advertised: pi
	// runs with the operator's host skills, and the fixture must carry no
	// machine-specific absolute paths.
	const hostRoot = fs.mkdtempSync(path.join(os.tmpdir(), "golden-host-"));
	t.after(() => fs.rmSync(hostRoot, { recursive: true, force: true }));
	for (const m of golden.matchAll(/__HOST_SKILLS__\/([^"']+?\/SKILL\.md)/g)) {
		const hostSkill = path.join(hostRoot, "skills", m[1]);
		fs.mkdirSync(path.dirname(hostSkill), { recursive: true });
		fs.writeFileSync(hostSkill, "host skill content\n");
	}
	golden = golden
		.replaceAll("__HOST_SKILLS__", path.join(hostRoot, "skills"))
		.replaceAll("__HOST_PI_LIB__", path.join(hostPiLib, "@earendil-works/pi-coding-agent"));
	const dir = goldenSession(t, repo, { text: golden });
	const out = auditIn(repo, () => auditSession(dir, repo));
	assert.match(out, /^clean /);
	assert.match(out, /provider zai-coding-cn/);
	// The golden transcript mentions checkout paths in bash commands only
	// as grep/ls/wc ARGUMENTS — real-pi command shapes that must NOT
	// attest as script execution.
	assert.throws(
		() =>
			auditIn(repo, () =>
				auditSession(
					dir,
					repo,
					withLegs({ script: "skills/literature-review/references/core_workflow.md" }),
				),
			),
		/checkout script never executed/,
	);
});

// ---------------------------------------------------------------------------
// Notebook-written attestation seam tests (#38). The evidence bytes are the
// committed connector-output fixture — the recorder's whole contract is to
// store exactly that shape, content-addressed, so the golden snapshot the
// pass cases use is a real one.
const evidenceBytes = fs.readFileSync("test/fixtures/notebook/pubmed-search.json");
const snapshotHash = createHash("sha256").update(evidenceBytes).digest("hex");
const snapshotAddr = `evidence/${snapshotHash}.json`;

// A scratch .theta directory: notebook.jsonl text plus snapshot files (named
// by content unless the case deliberately corrupts the addressing).
function makeThetaDir(t, { notebookText, snapshots = [], orphans = [] } = {}) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "theta-dir-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	if (notebookText !== undefined) {
		fs.writeFileSync(path.join(dir, "notebook.jsonl"), notebookText);
	}
	if (snapshots.length > 0 || orphans.length > 0) {
		fs.mkdirSync(path.join(dir, "evidence"));
	}
	for (const [name, content] of snapshots) {
		fs.writeFileSync(path.join(dir, "evidence", name), content);
	}
	for (const name of orphans) {
		fs.writeFileSync(path.join(dir, "evidence", name), "orphan bytes\n");
	}
	// canonical, like makeTempRepo — see its comment
	return fs.realpathSync(dir);
}

const baseItem = {
	source: "pubmed",
	endpoints: ["esearch.fcgi", "esummary.fcgi"],
	query: "CRISPR gene therapy",
	retrieved: "2026-10-18",
	grade: "asserted",
	snapshot: snapshotAddr,
};
const baseEntry = {
	id: "hyp-0001",
	type: "hypothesis",
	date: "2026-10-19",
	text: "CRISPR-based gene editing can restore immune cell function in aged organisms",
	evidence: [baseItem],
};

// One notebook line: the base entry with per-case mutations applied.
function entryLine(mut = () => {}) {
	const entry = structuredClone(baseEntry);
	mut(entry);
	return JSON.stringify(entry);
}
// A mutation that targets the entry's evidence item instead of the entry.
function itemMut(mut = () => {}) {
	return (entry) => {
		const item = structuredClone(baseItem);
		mut(item);
		entry.evidence[0] = item;
	};
}

test("isIsoDate accepts only real calendar dates in YYYY-MM-DD form", () => {
	assert.equal(isIsoDate("2026-10-19"), true);
	assert.equal(isIsoDate("2024-02-29"), true); // leap year
	assert.equal(isIsoDate("2000-02-29"), true); // 400-rule leap year
	for (const bad of [
		"2026-02-29", // not a leap year
		"2026-02-30",
		"2026-13-01",
		"2026-00-10",
		"2026-10-00",
		"2026-10-1", // unpadded
		"26-10-01",
		"2026/10/01",
		"2026-10-19T00:00:00Z",
		"",
		"not-a-date",
		20261019,
		null,
		undefined,
	]) {
		assert.equal(isIsoDate(bad), false, `expected reject: ${JSON.stringify(bad)}`);
	}
});

test("auditNotebook attests a recorder-shaped notebook with its snapshots", (t) => {
	const text = `${entryLine()}\n`;
	const dir = makeThetaDir(t, {
		notebookText: text,
		snapshots: [[`${snapshotHash}.json`, evidenceBytes]],
	});
	const report = auditNotebook(dir);
	assert.equal(report.entries, 1);
	assert.equal(report.snapshots, 1);
	// the attested digest is of the raw notebook bytes
	assert.equal(
		createHash("sha256").update(report.notebookBuf).digest("hex"),
		createHash("sha256").update(text, "utf8").digest("hex"),
	);

	// two entries, one shared snapshot: the recorder's dedupe shape
	const two = makeThetaDir(t, {
		notebookText:
			`${entryLine()}\n` +
			entryLine((e) => {
				e.id = "hyp-0002";
				e.text = "Base editing avoids the double-strand breaks that limit HDR in HSCs";
			}) +
			"\n",
		snapshots: [[`${snapshotHash}.json`, evidenceBytes]],
	});
	const twoReport = auditNotebook(two);
	assert.equal(twoReport.entries, 2);
	assert.equal(twoReport.snapshots, 1);

	// an orphan snapshot is the recorder's documented crash shape, not a fault
	const orphan = makeThetaDir(t, {
		notebookText: `${entryLine()}\n`,
		snapshots: [[`${snapshotHash}.json`, evidenceBytes]],
		orphans: ["deadbeef.json"],
	});
	assert.equal(auditNotebook(orphan).entries, 1);
});

test("auditNotebook fails closed on missing, empty, or unparseable notebooks", (t) => {
	const missing = makeThetaDir(t, {});
	assert.throws(() => auditNotebook(missing), /notebook\.jsonl/);

	const empty = makeThetaDir(t, { notebookText: "" });
	assert.throws(() => auditNotebook(empty), /no entries/);

	const blank = makeThetaDir(t, { notebookText: `${entryLine()}\n\n` });
	assert.throws(() => auditNotebook(blank), /blank/);

	const notJson = makeThetaDir(t, { notebookText: "this is not json\n" });
	assert.throws(() => auditNotebook(notJson), /not JSON/);

	const arrayLine = makeThetaDir(t, { notebookText: "[]\n" });
	assert.throws(() => auditNotebook(arrayLine), /JSON object/);

	// lossy bytes must not decode into passing evidence
	const corrupt = makeThetaDir(t, { notebookText: `${entryLine()}\n` });
	fs.writeFileSync(
		path.join(corrupt, "notebook.jsonl"),
		Buffer.concat([
			Buffer.from(entryLine().slice(0, 20), "utf8"),
			Buffer.from([0xff, 0xfe]),
			Buffer.from("\n", "utf8"),
		]),
	);
	assert.throws(() => auditNotebook(corrupt), /corrupt/);
});

test("auditNotebook enforces the typed entry shape", (t) => {
	const cases = [
		{
			name: "id not sequenced",
			mut: (e) => {
				e.id = "hyp-0010";
			},
			re: /id/,
		},
		{
			name: "id wrong prefix",
			mut: (e) => {
				e.id = "obs-0001";
			},
			re: /id/,
		},
		{
			name: "id gap",
			notebook:
				`${entryLine()}\n` +
				entryLine((e) => {
					e.id = "hyp-0003";
					e.text = "second";
				}) +
				"\n",
			re: /id/,
		},
		{
			name: "type carrying another type's id prefix",
			mut: (e) => {
				e.type = "observation";
			},
			re: /id/,
		},
		{
			name: "unknown type",
			mut: (e) => {
				e.type = "note";
			},
			re: /type/,
		},
		{
			name: "undated entry",
			mut: (e) => {
				delete e.date;
			},
			re: /date/,
		},
		{
			name: "impossible date",
			mut: (e) => {
				e.date = "2026-02-30";
			},
			re: /date/,
		},
		{
			name: "date not a string",
			mut: (e) => {
				e.date = 20261019;
			},
			re: /date/,
		},
		{
			name: "no text",
			mut: (e) => {
				delete e.text;
			},
			re: /text/,
		},
		{
			name: "empty text",
			mut: (e) => {
				e.text = "  ";
			},
			re: /text/,
		},
		{
			name: "evidence missing",
			mut: (e) => {
				delete e.evidence;
			},
			re: /evidence/,
		},
		{
			name: "evidence empty list",
			mut: (e) => {
				e.evidence = [];
			},
			re: /evidence/,
		},
		{
			name: "evidence not a list",
			mut: (e) => {
				e.evidence = "pubmed";
			},
			re: /evidence/,
		},
		{
			name: "item not an object",
			mut: (e) => {
				e.evidence = ["pubmed"];
			},
			re: /evidence item/,
		},
		{
			name: "item missing source",
			mut: itemMut((i) => {
				delete i.source;
			}),
			re: /source/,
		},
		{
			name: "item source not a string",
			mut: itemMut((i) => {
				i.source = 1;
			}),
			re: /source/,
		},
		{
			name: "item endpoints empty",
			mut: itemMut((i) => {
				i.endpoints = [];
			}),
			re: /endpoints/,
		},
		{
			name: "item endpoints not a list",
			mut: itemMut((i) => {
				i.endpoints = "esearch.fcgi";
			}),
			re: /endpoints/,
		},
		{
			name: "item endpoint not a string",
			mut: itemMut((i) => {
				i.endpoints = ["esearch.fcgi", 2];
			}),
			re: /endpoints/,
		},
		{
			name: "item query neither string nor null",
			mut: itemMut((i) => {
				i.query = 5;
			}),
			re: /query/,
		},
		{
			name: "item missing retrieved",
			mut: itemMut((i) => {
				delete i.retrieved;
			}),
			re: /retrieved/,
		},
		{
			name: "item retrieved not a calendar date",
			mut: itemMut((i) => {
				i.retrieved = "18/10/2026";
			}),
			re: /retrieved/,
		},
		{
			name: "item grade outside the vocabulary",
			mut: itemMut((i) => {
				i.grade = "high";
			}),
			re: /grade/,
		},
		{
			name: "item snapshot not content-addressed",
			mut: itemMut((i) => {
				i.snapshot = "evidence/search.json";
			}),
			re: /snapshot/,
		},
		{
			name: "item snapshot outside evidence/",
			mut: itemMut((i) => {
				i.snapshot = `snapshots/${snapshotHash}.json`;
			}),
			re: /snapshot/,
		},
	];
	for (const { name, mut, notebook, re } of cases) {
		const dir = makeThetaDir(t, {
			notebookText: notebook ?? `${entryLine(mut)}\n`,
			snapshots: [[`${snapshotHash}.json`, evidenceBytes]],
		});
		assert.throws(() => auditNotebook(dir), re, `expected failure: ${name}`);
	}
});

test("auditNotebook binds each entry item to the snapshot it cites", (t) => {
	const cases = [
		{
			name: "dangling snapshot",
			snapshots: [],
			re: /does not exist/,
		},
		{
			name: "content does not hash to the address",
			snapshots: [[`${snapshotHash}.json`, Buffer.concat([evidenceBytes, Buffer.from(" ")])]],
			re: /sha256/,
		},
		{
			name: "snapshot not JSON",
			snapshots: [[`${snapshotHash}.json`, "not json"]],
			re: /not valid JSON/,
		},
		{
			name: "snapshot missing provenance",
			snapshots: [[`${snapshotHash}.json`, JSON.stringify({ source: "pubmed" })]],
			re: /connector output/,
		},
		{
			name: "item source contradicts the snapshot",
			mut: itemMut((i) => {
				i.source = "arxiv";
			}),
			snapshots: [[`${snapshotHash}.json`, evidenceBytes]],
			re: /source/,
		},
		{
			name: "item retrieved contradicts the snapshot",
			mut: itemMut((i) => {
				i.retrieved = "2026-10-01";
			}),
			snapshots: [[`${snapshotHash}.json`, evidenceBytes]],
			re: /retrieved/,
		},
		{
			name: "item query contradicts the snapshot",
			mut: itemMut((i) => {
				i.query = null;
			}),
			snapshots: [[`${snapshotHash}.json`, evidenceBytes]],
			re: /query/,
		},
		{
			name: "item endpoints drop a called endpoint",
			mut: itemMut((i) => {
				i.endpoints = ["esearch.fcgi"];
			}),
			snapshots: [[`${snapshotHash}.json`, evidenceBytes]],
			re: /endpoints/,
		},
	];
	for (const { name, mut, snapshots, re } of cases) {
		const dir = makeThetaDir(t, {
			notebookText: `${entryLine(mut)}\n`,
			snapshots,
		});
		assert.throws(() => auditNotebook(dir), re, `expected failure: ${name}`);
	}
});

// The job-record evidence shape (M4 S5, ADR 0004): a method entry whose
// item is the assembled theta-compute job record, its snapshot the record
// verbatim. The base mirrors the recorder's committed job-record fixture —
// the same bytes, so the golden snapshot is a real one.
const jobRecordBytes = fs.readFileSync("test/fixtures/notebook/job-record.json");
const jobRecordHash = createHash("sha256").update(jobRecordBytes).digest("hex");
const jobRecordManifest = JSON.parse(jobRecordBytes).artifacts;
const baseJobItem = {
	source: "theta-compute",
	job_id: "12347",
	template: "alphafold3",
	arguments_digest: JSON.parse(jobRecordBytes).arguments_digest,
	state: "COMPLETED",
	artifacts: structuredClone(jobRecordManifest),
	retrieved: "2026-10-25",
	grade: "re-executed",
	snapshot: `evidence/${jobRecordHash}.json`,
};
const baseJobEntry = {
	id: "mth-0001",
	type: "method",
	date: "2026-10-26",
	text: "AlphaFold3 fold of hen egg white lysozyme on the cluster",
	evidence: [structuredClone(baseJobItem)],
};
function jobLine(mut = () => {}) {
	const entry = structuredClone(baseJobEntry);
	mut(entry);
	return JSON.stringify(entry);
}
function jobItemMut(mut = () => {}) {
	return (entry) => {
		const item = structuredClone(baseJobItem);
		mut(item);
		entry.evidence[0] = item;
	};
}

test("auditNotebook attests a job-record method entry and the two shapes side by side", (t) => {
	const dir = makeThetaDir(t, {
		notebookText: `${jobLine()}\n`,
		snapshots: [[`${jobRecordHash}.json`, jobRecordBytes]],
	});
	const report = auditNotebook(dir);
	assert.equal(report.entries, 1);
	assert.equal(report.snapshots, 1);

	// One notebook, both evidence shapes: the cache keeps the kinds apart.
	const mixed = makeThetaDir(t, {
		notebookText:
			`${entryLine()}\n` +
			jobLine((e) => {
				e.id = "mth-0001";
			}) +
			"\n",
		snapshots: [
			[`${snapshotHash}.json`, evidenceBytes],
			[`${jobRecordHash}.json`, jobRecordBytes],
		],
	});
	const mixedReport = auditNotebook(mixed);
	assert.equal(mixedReport.entries, 2);
	assert.equal(mixedReport.snapshots, 2);

	// The link rides a job-record item like any other (--supports).
	const linked = makeThetaDir(t, {
		notebookText:
			`${entryLine()}\n` +
			jobLine((e) => {
				e.id = "obs-0001";
				e.type = "observation";
				e.grade = "re-executed";
				e.evidence[0].supports = "hyp-0001";
			}) +
			"\n",
		snapshots: [
			[`${snapshotHash}.json`, evidenceBytes],
			[`${jobRecordHash}.json`, jobRecordBytes],
		],
	});
	assert.equal(auditNotebook(linked).entries, 2);
});

test("auditNotebook enforces the typed job-record item shape", (t) => {
	const cases = [
		{
			name: "item job_id not digits",
			mut: jobItemMut((i) => {
				i.job_id = "abc47";
			}),
			re: /job_id/,
		},
		{
			name: "item template missing",
			mut: jobItemMut((i) => {
				delete i.template;
			}),
			re: /template/,
		},
		{
			name: "item template not a string or null",
			mut: jobItemMut((i) => {
				i.template = 3;
			}),
			re: /template/,
		},
		{
			name: "item arguments_digest not a sha256 hex string",
			mut: jobItemMut((i) => {
				i.arguments_digest = "z".repeat(64);
			}),
			re: /arguments_digest/,
		},
		{
			name: "item state empty",
			mut: jobItemMut((i) => {
				i.state = " ";
			}),
			re: /state/,
		},
		{
			name: "item carries a query",
			mut: jobItemMut((i) => {
				i.query = "CRISPR gene therapy";
			}),
			re: /query/,
		},
		{
			name: "item is neither shape (job_id and endpoints missing)",
			mut: jobItemMut((i) => {
				delete i.job_id;
			}),
			re: /job-record item/,
		},
		{
			name: "item is both shapes (endpoints and job_id)",
			mut: jobItemMut((i) => {
				i.endpoints = ["esearch.fcgi"];
			}),
			re: /job-record item/,
		},
	];
	for (const { name, mut, re } of cases) {
		const dir = makeThetaDir(t, {
			notebookText: `${jobLine(mut)}\n`,
			snapshots: [[`${jobRecordHash}.json`, jobRecordBytes]],
		});
		assert.throws(() => auditNotebook(dir), re, `expected failure: ${name}`);
	}
});

test("auditNotebook binds a job-record item to the snapshot it cites", (t) => {
	const goodRecord = JSON.parse(jobRecordBytes);
	// A drifted notebook: the snapshot holds `record` (content-addressed by
	// its own bytes) and the item cites it, carrying `overrides` on the base
	// item when the drift is on the item's side.
	const driftDir = (t, record, overrides = {}) => {
		const bytes = JSON.stringify(record);
		const hash = createHash("sha256").update(bytes).digest("hex");
		const item = {
			...structuredClone(baseJobItem),
			...overrides,
			snapshot: `evidence/${hash}.json`,
		};
		return makeThetaDir(t, {
			notebookText: `${JSON.stringify({ ...structuredClone(baseJobEntry), evidence: [item] })}\n`,
			snapshots: [[`${hash}.json`, bytes]],
		});
	};
	const cases = [
		{
			name: "snapshot gateway contradicts the item source",
			record: { ...goodRecord, gateway: "other-gateway" },
			re: /source/,
		},
		{
			name: "snapshot job_id contradicts the item",
			record: { ...goodRecord, job_id: "99999" },
			re: /job_id/,
		},
		{
			name: "snapshot template contradicts the item",
			record: { ...goodRecord, template: null },
			re: /template/,
		},
		{
			name: "snapshot digest contradicts the item",
			record: { ...goodRecord, arguments_digest: "a".repeat(64) },
			re: /arguments/,
		},
		{
			name: "snapshot state contradicts the item",
			record: { ...goodRecord, state: "FAILED" },
			re: /state/,
		},
		{
			name: "snapshot observed contradicts the item retrieved",
			record: { ...goodRecord, observed: "2026-10-01" },
			re: /retrieved/,
		},
		{
			name: "snapshot manifest contradicts the item",
			record: {
				...goodRecord,
				artifacts: { ...goodRecord.artifacts, files: goodRecord.artifacts.files.slice(0, 1) },
			},
			re: /artifact manifest/,
		},
		{
			name: "snapshot observed not a calendar date",
			record: { ...goodRecord, observed: "2026-02-30" },
			re: /observed/,
		},
		{
			name: "snapshot job_id not digits",
			record: { ...goodRecord, job_id: "12x47" },
			re: /job_id/,
		},
		{
			name: "snapshot manifest carries file contents",
			record: {
				...goodRecord,
				artifacts: {
					...goodRecord.artifacts,
					files: [{ path: "out/model.cif", size: 48211, content_b64: "TT0kCg==" }],
				},
			},
			re: /content_b64/,
		},
		{
			name: "snapshot manifest empty",
			record: { ...goodRecord, artifacts: { ...goodRecord.artifacts, files: [] } },
			re: /artifacts\.files/,
		},
		{
			name: "item grade re-executed without the snapshot's manifest",
			record: (() => {
				const r = structuredClone(goodRecord);
				delete r.artifacts;
				return r;
			})(),
			item: { artifacts: undefined },
			re: /re-executed/,
		},
	];
	for (const { name, record, item, re } of cases) {
		assert.throws(() => auditNotebook(driftDir(t, record, item)), re, `expected failure: ${name}`);
	}

	// The mirror case stays honest: asserted without a manifest passes.
	const noArtifacts = structuredClone(goodRecord);
	delete noArtifacts.artifacts;
	const asserted = driftDir(t, noArtifacts, { artifacts: undefined, grade: "asserted" });
	assert.equal(auditNotebook(asserted).entries, 1);
});

// The batch entry set (#39): per-type base entries over the same shared
// snapshot, assembled into a five-type notebook — the shape the demo run
// produces. Every type that carries evidence uses the same item; the
// observation's item additionally links it to the hypothesis it supports.
const baseMethod = {
	id: "mth-0001",
	type: "method",
	date: "2026-10-19",
	text: "Adenine base editing via ABE, chosen to avoid double-strand breaks in HSCs",
	evidence: [structuredClone(baseItem)],
};
const baseObservation = {
	id: "obs-0001",
	type: "observation",
	date: "2026-10-19",
	text: "Two independent retrievals agree that HDR-mediated repair is rare in HSCs",
	grade: "cross-checked",
	// One recorder call stamps the item and the entry with the same grade
	// (the single --grade flag fills both) — this is the producible shape.
	evidence: [{ ...structuredClone(baseItem), grade: "cross-checked", supports: "hyp-0001" }],
};
const baseDecision = {
	id: "dec-0001",
	type: "decision",
	date: "2026-10-19",
	text: "Drop the HDR-mediated knock-in arm; pursue base editing only",
};
const baseConfidence = {
	id: "cnf-0001",
	type: "confidence",
	date: "2026-10-19",
	hypothesis: "hyp-0001",
	text: "Moderate; the support is literature-only so far",
};

// The five-type notebook, one line per entry, with per-entry mutations.
function batchLines(mut = () => {}) {
	const entries = [
		structuredClone(baseEntry),
		structuredClone(baseMethod),
		structuredClone(baseObservation),
		structuredClone(baseDecision),
		structuredClone(baseConfidence),
	];
	mut(entries);
	return entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
}

test("auditNotebook attests all five entry types with per-type ids and resolving links", (t) => {
	const dir = makeThetaDir(t, {
		notebookText: batchLines(),
		snapshots: [[`${snapshotHash}.json`, evidenceBytes]],
	});
	const report = auditNotebook(dir);
	assert.equal(report.entries, 5);
	// One snapshot file backs every evidence-bearing entry.
	assert.equal(report.snapshots, 1);
});

test("auditNotebook enforces the batch entry shapes", (t) => {
	const cases = [
		{
			name: "observation without its grade",
			mut: (e) => {
				delete e[2].grade;
			},
			re: /grade/,
		},
		{
			name: "observation grade outside the vocabulary",
			mut: (e) => {
				e[2].grade = "high";
			},
			re: /grade/,
		},
		{
			name: "observation item grade diverging from the entry's",
			mut: (e) => {
				e[2].evidence[0].grade = "asserted";
			},
			re: /diverges/,
		},
		{
			name: "hypothesis field on a non-confidence entry",
			mut: (e) => {
				e[0].hypothesis = "hyp-0001";
			},
			re: /only a confidence entry/,
		},
		{
			name: "grade merged onto a hypothesis entry",
			mut: (e) => {
				e[0].grade = "asserted";
			},
			re: /grade/,
		},
		{
			name: "grade merged onto a confidence entry",
			mut: (e) => {
				e[4].grade = "asserted";
			},
			re: /grade/,
		},
		{
			name: "confidence without a judged hypothesis",
			mut: (e) => {
				delete e[4].hypothesis;
			},
			re: /hypothesis/,
		},
		{
			name: "confidence judging an unknown hypothesis",
			mut: (e) => {
				e[4].hypothesis = "hyp-0009";
			},
			re: /names no earlier hypothesis/,
		},
		{
			name: "confidence carrying evidence",
			mut: (e) => {
				e[4].evidence = [structuredClone(baseItem)];
			},
			re: /evidence/,
		},
		{
			name: "observation supporting an unknown hypothesis",
			mut: (e) => {
				e[2].evidence[0].supports = "hyp-0009";
			},
			re: /supports/,
		},
		{
			name: "link riding a hypothesis entry's item",
			mut: (e) => {
				e[0].evidence[0].supports = "hyp-0001";
			},
			re: /supports/,
		},
		{
			name: "hypothesis without evidence",
			mut: (e) => {
				delete e[0].evidence;
			},
			re: /evidence/,
		},
		{
			name: "method with an empty evidence list",
			mut: (e) => {
				e[1].evidence = [];
			},
			re: /evidence/,
		},
		{
			name: "method item missing its source",
			mut: (e) => {
				delete e[1].evidence[0].source;
			},
			re: /source/,
		},
		{
			name: "method id under another type's prefix",
			mut: (e) => {
				e[1].id = "hyp-0002";
			},
			re: /id/,
		},
		{
			name: "per-type id gap",
			notebook:
				batchLines() +
				JSON.stringify({ ...structuredClone(baseObservation), id: "obs-0003" }) +
				"\n",
			re: /id/,
		},
	];
	for (const { name, mut, notebook, re } of cases) {
		const dir = makeThetaDir(t, {
			notebookText: notebook ?? batchLines(mut),
			snapshots: [[`${snapshotHash}.json`, evidenceBytes]],
		});
		assert.throws(() => auditNotebook(dir), re, `expected failure: ${name}`);
	}

	// A link may only name a hypothesis recorded BEFORE the linking entry —
	// the recorder assigns ids at append time, so a forward reference cannot
	// be recorder output.
	const forward = makeThetaDir(t, {
		notebookText:
			batchLines((e) => {
				e[2].evidence[0].supports = "hyp-0002";
			}) +
			entryLine((h) => {
				h.id = "hyp-0002";
				h.text = "A later, second hypothesis";
			}) +
			"\n",
		snapshots: [[`${snapshotHash}.json`, evidenceBytes]],
	});
	assert.throws(() => auditNotebook(forward), /names no earlier hypothesis/);
});

test("auditNotebook refuses a snapshot that escapes the notebook directory", (t) => {
	const outside = fs.mkdtempSync(path.join(os.tmpdir(), "theta-outside-"));
	t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
	fs.writeFileSync(path.join(outside, `${snapshotHash}.json`), evidenceBytes);
	const dir = makeThetaDir(t, { notebookText: `${entryLine()}\n` });
	fs.symlinkSync(outside, path.join(dir, "evidence"), "dir");
	assert.throws(() => auditNotebook(dir), /outside the notebook directory/);
});

test("resolveNotebookDir accepts only directories inside the checkout", (t) => {
	const repo = fs.realpathSync(makeTempRepo(t));
	fs.mkdirSync(path.join(repo, ".theta"));
	assert.equal(resolveNotebookDir(repo, ".theta"), `${repo}/.theta`);
	assert.throws(
		() => resolveNotebookDir(repo, "no-such-dir"),
		/does not resolve on disk/,
	);
	fs.writeFileSync(path.join(repo, "a-file"), "x");
	assert.throws(
		() => resolveNotebookDir(repo, "a-file"),
		/must be a directory inside the checkout/,
	);
});

// A recorder-bearing checkout: the theta-notebook tree (unadvertised — the
// synthetic transcripts advertise only literature-review) plus the .gitignore
// entry that keeps a written notebook outside the clean-tree proof.
function addNotebookSkill(repo) {
	fs.mkdirSync(path.join(repo, "skills", "theta-notebook", "scripts"), {
		recursive: true,
	});
	fs.writeFileSync(
		path.join(repo, "skills", "theta-notebook", "SKILL.md"),
		"notebook skill content\n",
	);
	fs.writeFileSync(
		path.join(repo, "skills", "theta-notebook", "scripts", "notebook.py"),
		"# recorder\n",
	);
	fs.writeFileSync(path.join(repo, ".gitignore"), ".theta/\n");
	execSync("git add -A", { cwd: repo });
	execSync("git -c commit.gpgsign=false commit -qm notebook", { cwd: repo });
	return repo;
}

// A recorder-shaped .theta in the repo: the connector fixture as the snapshot.
function writeNotebookDir(repo) {
	fs.mkdirSync(path.join(repo, ".theta", "evidence"), { recursive: true });
	fs.writeFileSync(path.join(repo, ".theta", "notebook.jsonl"), `${entryLine()}\n`);
	fs.writeFileSync(path.join(repo, ".theta", "evidence", `${snapshotHash}.json`), evidenceBytes);
}

test("auditSession attests notebook-written when the recorder ran and the notebook parses", (t) => {
	const repo = addNotebookSkill(makeTempRepo(t));
	const real = fs.realpathSync(repo);
	const recorderAbs = `${real}/skills/theta-notebook/scripts/notebook.py`;
	const recorderArg = "skills/theta-notebook/scripts/notebook.py";
	const scriptNotebookLegs = withLegs({ script: recorderArg, notebook: ".theta" });

	// pass: executed recorder plus a well-formed, dated, content-addressed
	// notebook — the gitignored .theta keeps the clean-tree proof green
	writeNotebookDir(repo);
	const ran = buildSession(t, repo, {
		bashCommand: `python3 ${recorderAbs} --hypothesis "CRISPR restores immune function" --evidence search.json --grade asserted`,
	});
	const out = auditIn(repo, () => auditSession(ran, repo, scriptNotebookLegs));
	assert.match(out, /script-executed /);
	assert.ok(out.includes(`notebook-written ${real}/.theta`), out);
	assert.match(out, /notebook-entries 1\n/);
	assert.match(out, /notebook-evidence 1\n/);
	assert.match(out, /notebook-digest [0-9a-f]{64}/);
	assert.ok(out.indexOf("notebook-written") > out.indexOf("script-executed"));

	// the notebook argument without the script leg attests nothing
	assert.throws(
		() => auditIn(repo, () => auditSession(ran, repo, withLegs({ notebook: ".theta" }))),
		/requires the script leg/,
	);

	// a script argument that is not the recorder does not carry the leg
	const otherRan = buildSession(t, repo, {
		bashCommand: `python3 ${real}/skills/literature-review/scripts/search.py --query x`,
	});
	assert.throws(
		() =>
			auditIn(repo, () =>
				auditSession(
					otherRan,
					repo,
					withLegs({
						script: "skills/literature-review/scripts/search.py",
						notebook: ".theta",
					}),
				),
			),
		/requires the theta-notebook recorder/,
	);

	// the recorder executed but no notebook was produced
	const noBook = buildSession(t, repo, { bashCommand: `python3 ${recorderAbs}` });
	fs.rmSync(path.join(repo, ".theta"), { recursive: true, force: true });
	assert.throws(
		() => auditIn(repo, () => auditSession(noBook, repo, scriptNotebookLegs)),
		/does not resolve on disk/,
	);

	// a notebook that does not parse fails the leg after the execution passed
	const corrupt = buildSession(t, repo, { bashCommand: `python3 ${recorderAbs}` });
	fs.mkdirSync(path.join(repo, ".theta"), { recursive: true });
	fs.writeFileSync(path.join(repo, ".theta", "notebook.jsonl"), "not json\n");
	assert.throws(
		() => auditIn(repo, () => auditSession(corrupt, repo, scriptNotebookLegs)),
		/not JSON/,
	);

	// a prompt naming the notebook file steers instead of routing
	const steered = buildSession(t, repo, {
		bashCommand: `python3 ${recorderAbs}`,
		transcriptPrompt: "append your finding to .theta/notebook.jsonl yourself",
	});
	fs.writeFileSync(
		path.join(steered, "prompt.txt"),
		"append your finding to .theta/notebook.jsonl yourself",
	);
	assert.throws(
		() => auditIn(repo, () => auditSession(steered, repo, scriptNotebookLegs)),
		/names the notebook file/,
	);
});

// Golden fixture session dirs (#38, widened by the #39 batch): committed
// scenarios under test/fixtures/notebook-audit/ — pass, the all-types
// notebook (one entry of each type, one resolving link), the job-record
// method entry (M4 S5), recorder not run, malformed entry, undated entry —
// run against the real auditor CLI. The
// not-run fixture carries a perfectly well-formed notebook: notebook files
// alone, however clean, attest nothing without the session's executed
// recorder.
test("the leg registry: an empty leg list attests boot only", (t) => {
	const repo = makeTempRepo(t);
	const dir = buildSession(t, repo);
	const out = auditIn(repo, () => auditSession(dir, repo, []));
	assert.match(out, /^clean /);
	for (const line of ["selected-file-opened", "script-executed", "notebook-written"]) {
		assert.ok(!out.includes(line), `empty legs must not attest: ${line}`);
	}
});

test("the auditor CLI refuses more leg arguments than the registry holds", () => {
	const audit = spawnSync(
		process.execPath,
		[
			path.resolve("scripts/audit-dogfood.mjs"),
			"session-dir",
			"a",
			"b",
			"c",
			"d",
		],
		{ encoding: "utf8", timeout: 60_000 },
	);
	assert.equal(audit.status, 1, `stderr: ${audit.stderr}`);
	assert.match(audit.stderr, /usage: audit-dogfood\.mjs/);
});

test("golden fixtures: the auditor CLI is green on pass and red on every failure", (t) => {
	const repo = goldenRepo(t, {
		skills: ["literature-review", "theta-notebook"],
		expectedSkills: {
			vendored: [{ name: "literature-review", "tree-sha256": "x" }],
			"self-authored": ["theta-notebook"],
		},
		gitignore: true,
	});

	const fixRoot = path.resolve("test/fixtures/notebook-audit");
	const cases = [
		{ name: "pass", ok: true, entries: 2, evidence: 1 },
		{ name: "all-types", ok: true, entries: 5, evidence: 1 },
		{ name: "job-record", ok: true, entries: 1, evidence: 1 },
		{ name: "not-run", ok: false, re: /checkout script never executed/ },
		{ name: "malformed", ok: false, re: /line 2/ },
		{ name: "undated", ok: false, re: /date/ },
	];
	for (const { name, ok, re, entries, evidence } of cases) {
		// the notebook tree moves into the repo as .theta (gitignored); the
		// session dir materializes with the repo-bound evidence written in
		fs.rmSync(path.join(repo, ".theta"), { recursive: true, force: true });
		fs.cpSync(path.join(fixRoot, name, "notebook"), path.join(repo, ".theta"), {
			recursive: true,
		});
		const dir = goldenSession(t, repo, {
			text: fs.readFileSync(path.join(fixRoot, name, "session.jsonl"), "utf8"),
			fixtureDir: path.join(fixRoot, name),
		});

		// the demo itself: one auditor CLI invocation per fixture
		const audit = spawnSync(
			process.execPath,
			[
				path.resolve("scripts/audit-dogfood.mjs"),
				dir,
				"-",
				"skills/theta-notebook/scripts/notebook.py",
				".theta",
			],
			{ cwd: repo, encoding: "utf8", timeout: 60_000 },
		);
		if (ok) {
			assert.equal(audit.status, 0, `${name}: stderr: ${audit.stderr}`);
			assert.match(audit.stdout, /script-executed /);
			assert.match(audit.stdout, /notebook-written .*\/\.theta\n/);
			assert.match(audit.stdout, new RegExp(`notebook-entries ${entries}\\n`));
			assert.match(audit.stdout, new RegExp(`notebook-evidence ${evidence}\\n`));
			assert.match(audit.stdout, /notebook-digest [0-9a-f]{64}/);
		} else {
			assert.equal(audit.status, 1, `${name}: expected red, stdout: ${audit.stdout}`);
			assert.match(audit.stderr, re, `${name}: unexpected refusal`);
		}
	}
});

test("clean-line format owner: emitter and gate share one definition", () => {
	const sha = "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c";
	const line = formatCleanLine(sha);
	const matches = [...line.matchAll(CLEAN_LINE_PATTERN)];
	assert.equal(matches.length, 1);
	assert.equal(matches[0][1], sha);
	// Wrong length or non-hex after "clean" is not an attestation token.
	const rejects = (s) =>
		assert.equal([...s.matchAll(CLEAN_LINE_PATTERN)].length, 0, `unexpectedly matched: ${s}`);
	rejects(`clean ${"z".repeat(40)}`);
	rejects(`clean ${"a".repeat(64)}`);
	rejects(`clean ${"a".repeat(39)}`);
});

test("clean-line format owner: dogfood.md examples match the exported pattern", () => {
	const doc = fs.readFileSync(
		new URL("../docs/agents/dogfood.md", import.meta.url),
		"utf8",
	);
	// Every inline span that shows the line's shape (`clean …`) must parse
	// with the exported pattern; the bare keyword `clean` is not a shape.
	const examples = [...doc.matchAll(/`clean\s[^`]*`/g)].map((m) => m[0]);
	assert.ok(examples.length > 0, "dogfood.md carries at least one shaped clean-line example");
	for (const example of examples) {
		assert.ok(
			[...example.matchAll(CLEAN_LINE_PATTERN)].length > 0,
			`dogfood.md example drifted from the exported pattern: ${example}`,
		);
	}
});
