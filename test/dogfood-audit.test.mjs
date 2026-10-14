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
	resolveCheckoutScript,
	shellTokens,
	commandResolvesToScript,
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
	assert.match(out, /selected-file-opened .*\/skills\/literature-review\/SKILL\.md/);
	const bad = buildSession(t, repo, { toolResultIsError: true });
	assert.throws(
		() => auditIn(repo, () => auditSession(bad, repo, "skills/literature-review/SKILL.md")),
		/selected file never opened/,
	);
	const partial = buildSession(t, repo, {
		toolResultIsError: false,
		partialRead: true,
		resultText: "partial\n",
	});
	assert.throws(
		() => auditIn(repo, () => auditSession(partial, repo, "skills/literature-review/SKILL.md")),
		/selected file never opened/,
	);
	const fabricated = buildSession(t, repo, {
		toolResultIsError: false,
		resultText: "fabricated content\n",
	});
	assert.throws(
		() => auditIn(repo, () => auditSession(fabricated, repo, "skills/literature-review/SKILL.md")),
		/selected file never opened/,
	);
	const wrongTool = buildSession(t, repo, {
		toolResultIsError: false,
		toolName: "other",
	});
	assert.throws(
		() => auditIn(repo, () => auditSession(wrongTool, repo, "skills/literature-review/SKILL.md")),
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
		() => auditIn(repo, () => auditSession(confusable, repo, "skills/literature-review/SKILL.md")),
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
		() => auditIn(repo, () => auditSession(camelSteer, repo, "skills/literature-review/SKILL.md")),
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
		"skills/literature-review/scripts/search.py --query x",
		"timeout 30 python3 skills/literature-review/scripts/search.py",
		"env NCBI_API_KEY=k python3 skills/literature-review/scripts/search.py",
		"time sudo watch python3 skills/literature-review/scripts/search.py",
		"nohup nice stdbuf -oL python3 skills/literature-review/scripts/search.py",
		// cd's own flags precede the directory operand
		"cd -P skills/literature-review && python3 scripts/search.py",
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
		// CR is a word character to bash — the \r stays in the filename
		"python3 skills/literature-review/scripts/search.py\r; echo ok",
		"python3 skills/literature-review/scripts/search.py\r\necho ok",
		// a slash-less command word goes through PATH, not the cwd
		"cd skills/literature-review/scripts; search.py; echo ok",
		// a redirection after ) applies to the whole parenthesized command
		`(python3 ${target}) > /no/such/dir/f ; echo ok`,
		// pushd -n never changes the directory
		"pushd -n skills/literature-review ; python3 scripts/search.py",
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
		auditSession(ran, repo, "skills/literature-review/SKILL.md", arg),
	);
	assert.ok(out.includes(`script-executed ${abs}`), out);
	assert.match(out, /script-content [0-9a-f]{64}/);
	assert.ok(out.indexOf("script-executed") > out.indexOf("selected-file-opened"));

	// the doctrine's own invocation shape (cd + relative path) attests
	const doctrine = buildSession(t, repo, {
		bashCommand: "cd skills/literature-review && python3 scripts/search.py --query p53",
	});
	const doctrineOut = auditIn(repo, () => auditSession(doctrine, repo, undefined, arg));
	assert.ok(doctrineOut.includes(`script-executed ${abs}`));

	// script not run: nothing in the session executed it
	const notRun = buildSession(t, repo, { toolResultIsError: false });
	assert.throws(
		() => auditIn(repo, () => auditSession(notRun, repo, undefined, arg)),
		/checkout script never executed/,
	);

	// error result: the bash call resolved to the script but failed
	const errored = buildSession(t, repo, {
		bashCommand: `python3 ${abs} --query x`,
		bashIsError: true,
	});
	assert.throws(
		() => auditIn(repo, () => auditSession(errored, repo, undefined, arg)),
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
		() => auditIn(repo, () => auditSession(copied, repo, undefined, arg)),
		/checkout script never executed/,
	);

	// a bash call spliced in before the prompt was not caused by the task
	const spliced = buildSession(t, repo, {
		bashCommand: `python3 ${abs}`,
		bashBeforePrompt: true,
	});
	assert.throws(
		() => auditIn(repo, () => auditSession(spliced, repo, undefined, arg)),
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
		() => auditIn(repo, () => auditSession(steered, repo, undefined, arg)),
		/names the selected script/,
	);

	// the script argument itself must be a checkout file
	const plain = buildSession(t, repo, {});
	assert.throws(
		() => auditIn(repo, () => auditSession(plain, repo, undefined, "/etc/hosts")),
		/must be a file inside the checkout/,
	);
	assert.throws(
		() => auditIn(repo, () => auditSession(plain, repo, undefined, "nope/missing.py")),
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
	const locs = invNamesToLocs(repo, ["literature-review"], hostDir);
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
	// The golden transcript mentions checkout paths in bash commands only
	// as grep/ls/wc ARGUMENTS — real-pi command shapes that must NOT
	// attest as script execution.
	assert.throws(
		() =>
			auditIn(repo, () =>
				auditSession(
					dir,
					repo,
					undefined,
					"skills/literature-review/references/core_workflow.md",
				),
			),
		/checkout script never executed/,
	);
});
