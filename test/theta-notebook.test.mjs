import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

// Offline contract tests for skills/theta-notebook/scripts/notebook.py, the
// project notebook recorder (#37, M3 tracer). Driven through the process
// boundary only — exit codes, stdout, stderr, and the files written into a
// scratch research project. The evidence fixture is a real theta-lit-search
// `--json` output (captured from pubmed.py against the pubmed happy fixture
// set, retrieval date frozen), because the recorder's whole contract is to
// hang entries off that exact shape. Contract basis: ADR 0003.
const scriptPath = fileURLToPath(
	new URL("../skills/theta-notebook/scripts/notebook.py", import.meta.url),
);
const pubmedPath = fileURLToPath(
	new URL("../skills/theta-lit-search/scripts/pubmed.py", import.meta.url),
);
const evidenceFixture = fileURLToPath(
	new URL("fixtures/notebook/pubmed-search.json", import.meta.url),
);
const pubmedFixtures = fileURLToPath(new URL("fixtures/pubmed/", import.meta.url));

// The script requires Python 3.11+. `python3` is 3.9 on some macOS setups, so
// probe the versioned names too — same fallback list the script's version gate
// names. With none available (unusual), skip rather than fail: CI's ubuntu
// runner has 3.12 as `python3`.
function findPython() {
	for (const candidate of ["python3", "python3.13", "python3.12", "python3.11"]) {
		const probe = spawnSync(candidate, [
			"-c",
			"import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)",
		]);
		if (probe.status === 0) return candidate;
	}
	return null;
}

const python = findPython();
const skipReason = python
	? false
	: "no Python 3.11+ interpreter found (tried python3, python3.13, python3.12, python3.11)";

// A scratch research project: an empty temp directory the recorder treats as
// its workspace. Removed when the test ends, however it ends.
async function scratchProject(t) {
	const dir = await mkdtemp(path.join(tmpdir(), "theta-notebook-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	return dir;
}

function runRecorder(args, { cwd, stdin } = {}) {
	return spawnSync(python, [scriptPath, ...args], {
		cwd,
		input: stdin,
		encoding: "utf8",
		timeout: 30_000,
	});
}

function localDate() {
	const now = new Date();
	const pad = (n) => String(n).padStart(2, "0");
	return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

const HYPOTHESIS =
	"CRISPR-based gene editing can restore immune cell function in aged organisms";

// One entry line out of notebook.jsonl, parsed.
async function readEntries(project) {
	const raw = await readFile(path.join(project, ".theta", "notebook.jsonl"), "utf8");
	return raw
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line) => JSON.parse(line));
}

const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");

test("hypothesis from an evidence file: dated entry, graded content-addressed snapshot", { skip: skipReason }, async (t) => {
	const project = await scratchProject(t);
	const run = runRecorder(
		["--hypothesis", HYPOTHESIS, "--evidence", evidenceFixture, "--grade", "asserted"],
		{ cwd: project },
	);
	assert.equal(run.status, 0, `stderr: ${run.stderr}`);
	assert.equal(run.stderr, "");

	// stdout names what was recorded, connector-footer style.
	const lines = run.stdout.trimEnd().split("\n");
	assert.equal(lines.length, 3);
	assert.equal(lines[0], "recorded hyp-0001 (hypothesis) in .theta/notebook.jsonl");
	assert.ok(lines[1].includes("pubmed"), "evidence line names the source");
	assert.ok(lines[1].includes("retrieved 2026-10-18"), "evidence line names the retrieval date");
	assert.ok(lines[1].includes("grade asserted"));
	assert.match(lines[2], /^# snapshot: evidence\/[0-9a-f]{64}\.json$/);

	// The entry: one dated hypothesis provenance entry.
	const entries = await readEntries(project);
	assert.equal(entries.length, 1);
	const [entry] = entries;
	assert.equal(entry.id, "hyp-0001");
	assert.equal(entry.type, "hypothesis");
	assert.equal(entry.date, localDate());
	assert.equal(entry.text, HYPOTHESIS);
	const [item] = entry.evidence;
	assert.equal(item.source, "pubmed");
	assert.deepEqual(item.endpoints, ["esearch.fcgi", "esummary.fcgi"]);
	assert.equal(item.query, "CRISPR gene therapy");
	// retrieved is the connector's access date, not today — the two dates are
	// different claims and must stay distinguishable.
	assert.equal(item.retrieved, "2026-10-18");
	assert.notEqual(item.retrieved, entry.date);
	assert.equal(item.grade, "asserted");
	assert.equal(item.snapshot, `evidence/${sha256(await readFile(evidenceFixture, "utf8"))}.json`);

	// The snapshot: the connector's final output, verbatim, content-addressed.
	const snapshotPath = path.join(project, ".theta", item.snapshot);
	const snapshot = await readFile(snapshotPath, "utf8");
	assert.equal(snapshot, await readFile(evidenceFixture, "utf8"));
	assert.equal(
		createHash("sha256").update(snapshot).digest("hex"),
		path.basename(snapshotPath, ".json"),
	);
});

test("evidence piped on stdin records the same entry (--evidence -)", { skip: skipReason }, async (t) => {
	const project = await scratchProject(t);
	const run = runRecorder(
		["--hypothesis", HYPOTHESIS, "--evidence", "-", "--grade", "cross-checked"],
		{ cwd: project, stdin: await readFile(evidenceFixture, "utf8") },
	);
	assert.equal(run.status, 0, `stderr: ${run.stderr}`);
	const [entry] = await readEntries(project);
	assert.equal(entry.id, "hyp-0001");
	assert.equal(entry.evidence[0].retrieved, "2026-10-18");
	assert.equal(entry.evidence[0].grade, "cross-checked");
});

test("real connector output records end-to-end: pubmed.py stdout pipes into the recorder", { skip: skipReason }, async (t) => {
	const env = { ...process.env, THETA_LIT_SEARCH_FIXTURES: `${pubmedFixtures}happy/` };
	const pubmedRun = spawnSync(
		python,
		[pubmedPath, "--query", "CRISPR gene therapy", "--retmax", "2", "--json"],
		{ env, encoding: "utf8", timeout: 30_000 },
	);
	assert.equal(pubmedRun.status, 0, `pubmed stderr: ${pubmedRun.stderr}`);

	const project = await scratchProject(t);
	const run = runRecorder(
		["--hypothesis", HYPOTHESIS, "--evidence", "-", "--grade", "asserted"],
		{ cwd: project, stdin: pubmedRun.stdout },
	);
	assert.equal(run.status, 0, `stderr: ${run.stderr}`);

	const [entry] = await readEntries(project);
	assert.equal(entry.evidence[0].source, "pubmed");
	// The connector stamped its own access date (today, offline fixtures
	// notwithstanding) and the recorder carries it through.
	assert.equal(entry.evidence[0].retrieved, localDate());
	// The snapshot is the connector's final output byte-for-byte.
	const snapshot = await readFile(
		path.join(project, ".theta", entry.evidence[0].snapshot),
		"utf8",
	);
	assert.equal(snapshot, pubmedRun.stdout);
});

test("a second hypothesis sequences the id and reuses an identical snapshot", { skip: skipReason }, async (t) => {
	const project = await scratchProject(t);
	const args = ["--evidence", evidenceFixture, "--grade", "asserted"];
	const first = runRecorder(["--hypothesis", HYPOTHESIS, ...args], { cwd: project });
	assert.equal(first.status, 0, `stderr: ${first.stderr}`);
	const second = runRecorder(
		["--hypothesis", "Base editing avoids the double-strand breaks that limit HDR in HSCs", ...args],
		{ cwd: project },
	);
	assert.equal(second.status, 0, `stderr: ${second.stderr}`);

	const entries = await readEntries(project);
	assert.equal(entries.length, 2);
	assert.deepEqual(entries.map((entry) => entry.id), ["hyp-0001", "hyp-0002"]);
	// Content-addressed storage dedupes: one snapshot file, referenced twice.
	const evidenceDir = await readdir(path.join(project, ".theta", "evidence"));
	assert.equal(evidenceDir.length, 1);
	assert.equal(entries[0].evidence[0].snapshot, entries[1].evidence[0].snapshot);
});

test("--json echoes exactly the entry that was appended", { skip: skipReason }, async (t) => {
	const project = await scratchProject(t);
	const run = runRecorder(
		["--hypothesis", HYPOTHESIS, "--evidence", evidenceFixture, "--grade", "asserted", "--json"],
		{ cwd: project },
	);
	assert.equal(run.status, 0, `stderr: ${run.stderr}`);
	const [entry] = await readEntries(project);
	assert.deepEqual(JSON.parse(run.stdout), entry);
});

test("usage errors exit 1 and write nothing into the project", { skip: skipReason }, async (t) => {
	const badEvidence = async (name, text) => {
		const file = path.join(await scratchProject(t), name);
		await writeFile(file, text, "utf8");
		return file;
	};
	const cases = [
		{ name: "no arguments", args: [] },
		{ name: "missing evidence and grade", args: ["--hypothesis", "x"] },
		{ name: "missing grade", args: ["--hypothesis", "x", "--evidence", evidenceFixture] },
		{ name: "missing evidence", args: ["--hypothesis", "x", "--grade", "asserted"] },
		{ name: "unknown grade", args: ["--hypothesis", "x", "--evidence", evidenceFixture, "--grade", "high"] },
		{ name: "blank hypothesis", args: ["--hypothesis", "   ", "--evidence", evidenceFixture, "--grade", "asserted"] },
		{ name: "evidence file missing", args: ["--hypothesis", "x", "--evidence", "/nonexistent/evidence.json", "--grade", "asserted"] },
		{ name: "evidence is a directory", args: ["--hypothesis", "x", "--evidence", path.dirname(evidenceFixture), "--grade", "asserted"] },
		{ name: "empty stdin", args: ["--hypothesis", "x", "--evidence", "-", "--grade", "asserted"], stdin: "" },
		{ name: "not JSON", args: ["--hypothesis", "x", "--grade", "asserted", await badEvidence("not-json.json", "{oops")] },
		{ name: "not a JSON object", args: ["--hypothesis", "x", "--grade", "asserted", await badEvidence("array.json", "[]")] },
		{ name: "missing source", args: ["--hypothesis", "x", "--grade", "asserted", await badEvidence("no-source.json", JSON.stringify({ provenance: { calls: [{ endpoint: "e", url: "https://x" }], accessed: "2026-10-18" } }))] },
		{ name: "missing provenance", args: ["--hypothesis", "x", "--grade", "asserted", await badEvidence("no-prov.json", JSON.stringify({ source: "pubmed" }))] },
		{ name: "empty calls list", args: ["--hypothesis", "x", "--grade", "asserted", await badEvidence("no-calls.json", JSON.stringify({ source: "pubmed", provenance: { calls: [], accessed: "2026-10-18" } }))] },
		{ name: "calls not a list", args: ["--hypothesis", "x", "--grade", "asserted", await badEvidence("calls-str.json", JSON.stringify({ source: "pubmed", provenance: { calls: "esearch.fcgi", accessed: "2026-10-18" } }))] },
		{ name: "call without endpoint", args: ["--hypothesis", "x", "--grade", "asserted", await badEvidence("no-endpoint.json", JSON.stringify({ source: "pubmed", provenance: { calls: [{ url: "https://x" }], accessed: "2026-10-18" } }))] },
		{ name: "call without url", args: ["--hypothesis", "x", "--grade", "asserted", await badEvidence("no-url.json", JSON.stringify({ source: "pubmed", provenance: { calls: [{ endpoint: "esearch.fcgi" }], accessed: "2026-10-18" } }))] },
		{ name: "accessed not a date", args: ["--hypothesis", "x", "--grade", "asserted", await badEvidence("bad-date.json", JSON.stringify({ source: "pubmed", provenance: { calls: [{ endpoint: "e", url: "https://x" }], accessed: "18/10/2026" } }))] },
		{ name: "accessed not a string", args: ["--hypothesis", "x", "--grade", "asserted", await badEvidence("num-date.json", JSON.stringify({ source: "pubmed", provenance: { calls: [{ endpoint: "e", url: "https://x" }], accessed: 20261018 } }))] },
	];
	for (const { name, args, stdin } of cases) {
		const project = await scratchProject(t);
		const run = runRecorder(args, { cwd: project, stdin });
		assert.equal(run.status, 1, `${name}: should exit 1`);
		assert.notEqual(run.stderr.trim(), "", `${name}: stderr must say what is wrong`);
		assert.equal(run.stdout, "", `${name}: no stdout on failure`);
		// A rejected input must leave no trace: nothing is written before every
		// check passes.
		assert.deepEqual(await readdir(project), [], `${name}: wrote files into the project`);
	}
});

test("a corrupt existing notebook exits 2 unchanged, before anything is written", { skip: skipReason }, async (t) => {
	const project = await scratchProject(t);
	await mkdir(path.join(project, ".theta"));
	await writeFile(path.join(project, ".theta", "notebook.jsonl"), "this is not json\n", "utf8");

	const run = runRecorder(
		["--hypothesis", HYPOTHESIS, "--evidence", evidenceFixture, "--grade", "asserted"],
		{ cwd: project },
	);
	assert.equal(run.status, 2);
	assert.ok(run.stderr.includes("notebook"), "stderr names the notebook");
	assert.equal(run.stdout, "");
	// The corrupt line is still the only content; no snapshot dir appeared.
	assert.equal(
		await readFile(path.join(project, ".theta", "notebook.jsonl"), "utf8"),
		"this is not json\n",
	);
	assert.deepEqual(await readdir(path.join(project, ".theta")), ["notebook.jsonl"]);
});

test("a .theta that is a regular file exits 2", { skip: skipReason }, async (t) => {
	const project = await scratchProject(t);
	await writeFile(path.join(project, ".theta"), "not a directory\n", "utf8");
	const run = runRecorder(
		["--hypothesis", HYPOTHESIS, "--evidence", evidenceFixture, "--grade", "asserted"],
		{ cwd: project },
	);
	assert.equal(run.status, 2);
	assert.ok(run.stderr.includes(".theta"));
});
