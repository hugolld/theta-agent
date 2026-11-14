// Pins the eval-capture land guard's mechanics (spec #133): a landing may
// bind only digests the session actually saw, so the guard must refuse
// every way the landing tree's surfaces can differ from the session's
// pre-head — committed edits, untracked files, ignored files (the surface
// digests walk the raw filesystem, so an ignored __pycache__ rides a tree
// digest exactly like an edit would), and case-only renames under
// core.ignorecase (macOS default; the digest walks readdirSync names) —
// and must refuse rather than pass vacuously when the evidence's pre-head
// does not resolve. Runs against a throwaway git repo, never this one.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { run } from "../../scripts/dogfood-gates.mjs";
import { initHardenedGitRepo } from "../helpers/git-repo.mjs";
import { assertSurfacesUnmoved, credentialLeaks, redactNodeLists, sanitizeTranscript } from "./capture.mjs";

const scratch = mkdtempSync(path.join(tmpdir(), "eval-land-guard-"));
test.after(() => rmSync(scratch, { recursive: true, force: true }));

function git(...args) {
	const result = run("git", ["-C", scratch, ...args]);
	assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
	return result.stdout;
}

function write(rel, body) {
	const abs = path.join(scratch, rel);
	mkdirSync(path.dirname(abs), { recursive: true });
	writeFileSync(abs, body);
}

// A minimal surface-bearing tree, committed: one skill dir, extensions/,
// and the project-context file — the three paths the guard covers.
write("skills/demo/SKILL.md", "---\nname: demo\ndescription: demo\n---\n");
write("extensions/demo.ts", "export const demo = 1;\n");
write("CLAUDE.md", "# demo\n");
initHardenedGitRepo(scratch);
git("add", "-A");
git("commit", "-m", "capture tree");
const preHead = git("rev-parse", "HEAD").trim();

test("a surface-identical tree passes", () => {
	assertSurfacesUnmoved(scratch, preHead);
});

test("a committed surface edit since the pre-head refuses", () => {
	write("CLAUDE.md", "# demo, edited\n");
	git("add", "-A");
	git("commit", "-m", "surface edit");
	assert.throws(() => assertSurfacesUnmoved(scratch, preHead), /changed since the session's HEAD/);
	write("CLAUDE.md", "# demo\n");
	git("add", "-A");
	git("commit", "-m", "surface restored");
});

test("an untracked file under a surface path refuses", () => {
	write("skills/demo/stray.txt", "stray\n");
	assert.throws(() => assertSurfacesUnmoved(scratch, preHead), /changed since the session's HEAD/);
	rmSync(path.join(scratch, "skills/demo/stray.txt"));
});

test("a case-only rename under a skill tree refuses", () => {
	// Under macOS's default core.ignorecase=true, plain `git status` with a
	// pathspec reports nothing after a case-only rename on disk, while
	// fileTreeDigest walks readdirSync names — the guard's
	// -c core.ignorecase=false probe must not share that blindness. On a
	// case-sensitive filesystem (Linux CI) plain status sees the rename
	// anyway, so the pin asserts only the contract: the guard refuses.
	renameSync(
		path.join(scratch, "skills/demo/SKILL.md"),
		path.join(scratch, "skills/demo/skill.md"),
	);
	assert.throws(() => assertSurfacesUnmoved(scratch, preHead), /changed since the session's HEAD/);
	renameSync(
		path.join(scratch, "skills/demo/skill.md"),
		path.join(scratch, "skills/demo/SKILL.md"),
	);
});

test("an ignored file under a skill tree refuses like an edit would", () => {
	write(".gitignore", "__pycache__/\n");
	git("add", "-A");
	git("commit", "-m", "ignore pycache");
	write("skills/demo/scripts/__pycache__/demo.cpython-313.pyc", "bytes");
	// plain -uall sees nothing; the guard must not share that blindness
	assert.equal(
		run("git", ["-C", scratch, "status", "--porcelain", "-uall", "--", "skills"]).stdout.trim(),
		"",
	);
	assert.throws(() => assertSurfacesUnmoved(scratch, preHead), /changed since the session's HEAD/);
	rmSync(path.join(scratch, "skills/demo/scripts"), { recursive: true, force: true });
});

test("an unresolvable pre-head refuses instead of passing vacuously", () => {
	assert.throws(() => assertSurfacesUnmoved(scratch, "not-a-revision"), /git probe failed/);
});

// The credential sweep (spec #134 review round): the land step refuses a
// capture whose sanitized transcript echoes a provider entry's
// credential. The sweep skips the fields a transcript carries by design —
// `api` is the API-flavor name pi stamps onto every assistant record
// ("api": "openai-completions"), URLs are endpoints — and sub-8-char
// values are too short to be secret-bearing. Every provider entry is in
// scope: the values never print, only the provider and field that leaked.
test("the credential sweep detects a leaked key and names provider and field only", () => {
	const providers = { zai: { apiKey: "sk-really-a-secret-credential" } };
	const leaks = credentialLeaks("text with sk-really-a-secret-credential inside", providers);
	assert.deepEqual(leaks, [{ provider: "zai", field: "apiKey" }]);
});

test("the credential sweep skips the api field — the flavor name every assistant record carries", () => {
	const providers = { magpie: { api: "openai-completions", apiKey: "sk-other-secret-9999" } };
	const text = '"api":"openai-completions","provider":"zai-coding-cn"';
	assert.deepEqual(credentialLeaks(text, providers), []);
	// the same entry's real key still sweeps
	assert.equal(credentialLeaks(`${text} sk-other-secret-9999`, providers).length, 1);
});

test("the credential sweep skips URL fields and sub-8-char values", () => {
	const providers = {
		p: { baseUrl: "https://api.example.com/v1", note: "short", apiKey: "sk-long-enough-secret" },
	};
	assert.deepEqual(credentialLeaks("see https://api.example.com/v1 or short", providers), []);
});

test("the credential sweep covers every provider entry in the config", () => {
	const providers = {
		a: { apiKey: "aaaa-secret-key-one" },
		b: { apiKey: "bbbb-secret-key-two" },
	};
	const leaks = credentialLeaks("x bbbb-secret-key-two y", providers);
	assert.deepEqual(leaks, [{ provider: "b", field: "apiKey" }]);
	assert.equal(credentialLeaks("clean text", providers).length, 0);
});

// The sanitizer (spec #134, orchestrator capture): the checkout root
// becomes __REPO__ and the rig home — the session cwd's parent — becomes
// __RIG_HOME__, so a session that leaves the checkout still lands
// machine-free and the host-path guard never sees a /home/ residue.
test("the sanitizer replaces the checkout root and the rig home, cwd first", () => {
	const text = 'run in /home/theta/theta, home is /home/theta, work at /home/theta/research/w';
	const out = sanitizeTranscript(text, "/home/theta/theta");
	assert.equal(
		out,
		"run in __REPO__, home is __RIG_HOME__, work at __RIG_HOME__/research/w",
	);
});

test("the sanitizer never treats a depth-1 cwd's parent (the root) as a home", () => {
	const text = "cwd /checkout directly at the root, /etc/hosts untouched";
	assert.equal(sanitizeTranscript(text, "/checkout"), text.replaceAll("/checkout", "__REPO__"));
});

test("the sanitizer leaves paths that are neither root nor home", () => {
	const text = "/srv/data and /etc/config survive";
	assert.equal(sanitizeTranscript(text, "/home/theta/theta"), text);
});

// The node-list redaction (spec #134, the gateway-bearing capture): the
// cluster topology the gateway's own outputs carry — here at both
// escaping levels a rig transcript produces — is redacted mechanically,
// the golden-fixture vocabulary, before the fixture can enter the public
// repo. Distinct values keep distinct placeholders in first-occurrence
// order; the partition prefix survives.
test("the node-list redaction covers both escaping levels and keeps values distinct", () => {
	const text =
		'outer \\"node_list\\": \\"cpu[11-13]\\" then doubly \\\\"node_list\\\\\\": \\\\"gpu1\\\\" and repeat \\"node_list\\": \\"cpu[11-13]\\"';
	const out = redactNodeLists(text);
	assert.equal(out.includes("cpu[11-13]"), false);
	assert.equal(out.includes("gpu1"), false);
	assert.equal((out.match(/__HOST_NODES_CPU_A__/g) ?? []).length, 2);
	assert.equal(out.includes("__HOST_NODES_GPU_A__"), true);
});

test("the node-list redaction assigns placeholders in first-occurrence order per partition", () => {
	const text = '"node_list": "gpu2", "node_list": "cpu[26-27]", "node_list": "gpu1"';
	const out = redactNodeLists(text);
	assert.equal(out, '"node_list": "__HOST_NODES_GPU_A__", "node_list": "__HOST_NODES_CPU_A__", "node_list": "__HOST_NODES_GPU_B__"');
});

test("the node-list redaction leaves prose that merely names the field", () => {
	const text = "the node_list argument and node_list: philosophy stay";
	assert.equal(redactNodeLists(text), text);
});

test("the node-list redaction maps a prose echo to the same placeholder as its structured value", () => {
	const text =
		'"node_list": "cpu[14-23,29-30]" then the session paraphrases: `cpu[14-23,29-30]` plus one mixed (`cpu28`) — 12 idle nodes on the `cpu` partition, cpus busy';
	const out = redactNodeLists(text);
	assert.equal((out.match(/__HOST_NODES_CPU_A__/g) ?? []).length, 2);
	assert.equal(out.includes("__HOST_NODES_CPU_B__"), true);
	// bare partition word, plural, and a count stay — not topology
	assert.equal(out.includes("— 12 idle nodes on the `cpu` partition, cpus busy"), true);
});
