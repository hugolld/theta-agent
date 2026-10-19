import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

// Offline contract tests for skills/theta-notebook/scripts/notebook.py, the
// project notebook recorder (#37 tracer, #39 batch). Driven through the
// process boundary only — exit codes, stdout, stderr, and the files written
// into a scratch research project. The evidence fixture is a real
// theta-lit-search `--json` output (captured from pubmed.py against the
// pubmed happy fixture set, retrieval date frozen), because the recorder's
// whole contract is to hang entries off that exact shape. Contract basis:
// ADR 0003.
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
const METHOD =
	"Adenine base editing via ABE, chosen to avoid double-strand breaks in HSCs";
const OBSERVATION =
	"Two independent retrievals agree that HDR-mediated repair is rare in HSCs";
const DECISION = "Drop the HDR-mediated knock-in arm; pursue base editing only";
const CONFIDENCE = "Moderate; the support is literature-only so far";

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

test("method records its motivating evidence, or stands alone", { skip: skipReason }, async (t) => {
	const project = await scratchProject(t);
	const withEvidence = runRecorder(
		["--method", METHOD, "--evidence", evidenceFixture, "--grade", "cross-checked"],
		{ cwd: project },
	);
	assert.equal(withEvidence.status, 0, `stderr: ${withEvidence.stderr}`);
	const lines = withEvidence.stdout.trimEnd().split("\n");
	assert.equal(lines[0], "recorded mth-0001 (method) in .theta/notebook.jsonl");
	assert.equal(lines.length, 3, "an evidence-bearing method keeps the evidence footer");

	const withoutEvidence = runRecorder(["--method", "Base editing panel design"], {
		cwd: project,
	});
	assert.equal(withoutEvidence.status, 0, `stderr: ${withoutEvidence.stderr}`);
	assert.equal(
		withoutEvidence.stdout.trim(),
		"recorded mth-0002 (method) in .theta/notebook.jsonl",
		"a text-only entry prints the recorded line only",
	);

	const entries = await readEntries(project);
	assert.equal(entries.length, 2);
	assert.deepEqual(entries.map((entry) => entry.id), ["mth-0001", "mth-0002"]);
	assert.equal(entries[0].text, METHOD);
	// The evidence-bearing entry cites the graded, content-addressed item;
	// the text-only entry carries no evidence field at all.
	assert.equal(entries[0].evidence[0].grade, "cross-checked");
	assert.equal(
		entries[0].evidence[0].snapshot,
		`evidence/${sha256(await readFile(evidenceFixture, "utf8"))}.json`,
	);
	assert.equal("evidence" in entries[1], false);
	assert.equal(entries[1].evidence, undefined);
});

test("observation carries the entry-level grade and links evidence to a hypothesis", { skip: skipReason }, async (t) => {
	const project = await scratchProject(t);
	const hyp = runRecorder(
		["--hypothesis", HYPOTHESIS, "--evidence", evidenceFixture, "--grade", "asserted"],
		{ cwd: project },
	);
	assert.equal(hyp.status, 0, `stderr: ${hyp.stderr}`);

	const obs = runRecorder(
		[
			"--observation", OBSERVATION,
			"--evidence", evidenceFixture,
			"--grade", "cross-checked",
			"--supports", "hyp-0001",
		],
		{ cwd: project },
	);
	assert.equal(obs.status, 0, `stderr: ${obs.stderr}`);
	const lines = obs.stdout.trimEnd().split("\n");
	assert.equal(lines[0], "recorded obs-0001 (observation) in .theta/notebook.jsonl");
	assert.equal(lines[1], "# grade: cross-checked");
	assert.equal(lines[2], "# supports: hyp-0001");
	assert.ok(lines[3].includes("grade cross-checked"), "the item keeps its own grade");

	const entries = await readEntries(project);
	assert.equal(entries.length, 2);
	const [hypothesis, observation] = entries;
	// The two grades stay distinct fields: the entry's own grade rates the
	// source behind the observation; the item's grade rates its snapshot.
	assert.equal(observation.type, "observation");
	assert.equal(observation.grade, "cross-checked");
	assert.equal(observation.evidence[0].grade, "cross-checked");
	// The link lives on the evidence item and names the hypothesis it backs.
	assert.equal(observation.evidence[0].supports, "hyp-0001");
	// The hypothesis entry itself carries no link and no entry-level grade.
	assert.equal(hypothesis.grade, undefined);
	assert.equal(hypothesis.evidence[0].supports, undefined);
	// One snapshot file serves both entries.
	const evidenceDir = await readdir(path.join(project, ".theta", "evidence"));
	assert.equal(evidenceDir.length, 1);
});

test("decision records text, with optional evidence", { skip: skipReason }, async (t) => {
	const project = await scratchProject(t);
	const run = runRecorder(
		["--decision", DECISION, "--evidence", evidenceFixture, "--grade", "asserted"],
		{ cwd: project },
	);
	assert.equal(run.status, 0, `stderr: ${run.stderr}`);
	const [entry] = await readEntries(project);
	assert.equal(entry.id, "dec-0001");
	assert.equal(entry.type, "decision");
	assert.equal(entry.text, DECISION);
	assert.equal(entry.evidence[0].source, "pubmed");
});

test("confidence records the judgment on a named hypothesis", { skip: skipReason }, async (t) => {
	const project = await scratchProject(t);
	const hyp = runRecorder(
		["--hypothesis", HYPOTHESIS, "--evidence", evidenceFixture, "--grade", "asserted"],
		{ cwd: project },
	);
	assert.equal(hyp.status, 0, `stderr: ${hyp.stderr}`);

	const run = runRecorder(["--confidence", CONFIDENCE, "--on", "hyp-0001"], {
		cwd: project,
	});
	assert.equal(run.status, 0, `stderr: ${run.stderr}`);
	assert.equal(
		run.stdout.trimEnd(),
		"recorded cnf-0001 (confidence) in .theta/notebook.jsonl\n# judgment on hyp-0001",
	);

	const entries = await readEntries(project);
	const [hypothesis, confidence] = entries;
	assert.equal(confidence.id, "cnf-0001");
	assert.equal(confidence.type, "confidence");
	assert.equal(confidence.hypothesis, "hyp-0001");
	assert.equal(confidence.text, CONFIDENCE);
	// Judgment is not a source claim: no evidence, no grade, no snapshot dir.
	assert.equal(confidence.evidence, undefined);
	assert.equal(confidence.grade, undefined);
	assert.equal(hypothesis.hypothesis, undefined);
	assert.deepEqual(await readdir(path.join(project, ".theta")), [
		"evidence",
		"notebook.jsonl",
	]);
});

test("ids sequence per type across interleaved entries", { skip: skipReason }, async (t) => {
	const project = await scratchProject(t);
	const ev = ["--evidence", evidenceFixture, "--grade", "asserted"];
	const calls = [
		["--hypothesis", HYPOTHESIS, ...ev],
		["--observation", OBSERVATION, ...ev],
		["--hypothesis", "A second, rival hypothesis", ...ev],
		["--method", METHOD],
		["--decision", DECISION],
		["--confidence", CONFIDENCE, "--on", "hyp-0002"],
		["--observation", "A later observation", ...ev, "--supports", "hyp-0001"],
	];
	for (const args of calls) {
		const run = runRecorder(args, { cwd: project });
		assert.equal(run.status, 0, `stderr for ${args[0]}: ${run.stderr}`);
	}
	const entries = await readEntries(project);
	assert.deepEqual(
		entries.map((entry) => `${entry.id} ${entry.type}`),
		[
			"hyp-0001 hypothesis",
			"obs-0001 observation",
			"hyp-0002 hypothesis",
			"mth-0001 method",
			"dec-0001 decision",
			"cnf-0001 confidence",
			"obs-0002 observation",
		],
	);
	// The interleaved notebook's links and judgments resolve to their
	// targets: the last observation backs the first hypothesis, the
	// confidence judges the second.
	assert.equal(entries[6].evidence[0].supports, "hyp-0001");
	assert.equal(entries[5].hypothesis, "hyp-0002");
});

test("unresolved references exit 1 and append nothing", { skip: skipReason }, async (t) => {
	const project = await scratchProject(t);
	const hyp = runRecorder(
		["--hypothesis", HYPOTHESIS, "--evidence", evidenceFixture, "--grade", "asserted"],
		{ cwd: project },
	);
	assert.equal(hyp.status, 0, `stderr: ${hyp.stderr}`);

	for (const { name, args } of [
		{
			name: "confidence on an unknown hypothesis",
			args: ["--confidence", CONFIDENCE, "--on", "hyp-0009"],
		},
		{
			name: "observation supporting an unknown hypothesis",
			args: [
				"--observation", OBSERVATION, ...["--evidence", evidenceFixture, "--grade", "asserted"],
				"--supports", "hyp-0009",
			],
		},
	]) {
		const before = await readFile(path.join(project, ".theta", "notebook.jsonl"), "utf8");
		const run = runRecorder(args, { cwd: project });
		assert.equal(run.status, 1, `${name}: should exit 1`);
		assert.match(run.stderr, /names no hypothesis/, `${name}: stderr names the problem`);
		assert.equal(run.stdout, "", `${name}: no stdout on failure`);
		const after = await readFile(path.join(project, ".theta", "notebook.jsonl"), "utf8");
		assert.equal(after, before, `${name}: appended nothing`);
	}
	assert.equal((await readEntries(project)).length, 1);
});


test("usage errors exit 1 and write nothing into the project", { skip: skipReason }, async (t) => {
	const badEvidence = async (name, text) => {
		const file = path.join(await scratchProject(t), name);
		await writeFile(file, text, "utf8");
		return file;
	};
	const cases = [
		{ name: "no arguments", args: [] },
		{ name: "two type flags", args: ["--hypothesis", "x", "--method", "y"] },
		{ name: "missing evidence and grade", args: ["--hypothesis", "x"] },
		{ name: "missing grade", args: ["--hypothesis", "x", "--evidence", evidenceFixture] },
		{ name: "missing evidence", args: ["--hypothesis", "x", "--grade", "asserted"] },
		{ name: "unknown grade", args: ["--hypothesis", "x", "--evidence", evidenceFixture, "--grade", "high"] },
		{ name: "blank hypothesis", args: ["--hypothesis", "   ", "--evidence", evidenceFixture, "--grade", "asserted"] },
		{ name: "blank method", args: ["--method", "   "] },
		{ name: "blank observation", args: ["--observation", "   ", "--evidence", evidenceFixture, "--grade", "asserted"] },
		{ name: "blank decision", args: ["--decision", "   "] },
		{ name: "blank confidence", args: ["--confidence", "   ", "--on", "hyp-0001"] },
		{ name: "observation missing evidence", args: ["--observation", "x", "--grade", "asserted"] },
		{ name: "observation missing grade", args: ["--observation", "x", "--evidence", evidenceFixture] },
		{ name: "method evidence without grade", args: ["--method", "x", "--evidence", evidenceFixture] },
		{ name: "grade without evidence", args: ["--method", "x", "--grade", "asserted"] },
		{ name: "decision evidence without grade", args: ["--decision", "x", "--evidence", evidenceFixture] },
		{ name: "confidence without --on", args: ["--confidence", "x"] },
		{ name: "--on without --confidence", args: ["--decision", "x", "--on", "hyp-0001"] },
		{ name: "--on names a non-hypothesis id", args: ["--confidence", "x", "--on", "obs-0001"] },
		{ name: "confidence with evidence", args: ["--confidence", "x", "--on", "hyp-0001", "--evidence", evidenceFixture, "--grade", "asserted"] },
		{ name: "--on names no recorded hypothesis", args: ["--confidence", "x", "--on", "hyp-0009"] },
		{ name: "--supports on a hypothesis entry", args: ["--hypothesis", "x", "--evidence", evidenceFixture, "--grade", "asserted", "--supports", "hyp-0001"] },
		{ name: "--supports on a method entry", args: ["--method", "x", "--evidence", evidenceFixture, "--grade", "asserted", "--supports", "hyp-0001"] },
		{ name: "--supports names no recorded hypothesis", args: ["--observation", "x", "--evidence", evidenceFixture, "--grade", "asserted", "--supports", "hyp-0009"] },
		{ name: "--supports names a non-hypothesis id", args: ["--observation", "x", "--evidence", evidenceFixture, "--grade", "asserted", "--supports", "dec-0001"] },
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
