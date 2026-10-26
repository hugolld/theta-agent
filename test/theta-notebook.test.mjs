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
// The job-record fixture is an assembled theta-compute record (M4 S5): the
// answers one gateway run yields — submit, final job_status, fetch_artifacts
// stripped of file contents — with the retrieval date (observed) frozen, the
// same freeze the pubmed fixture applies to provenance.accessed.
const jobRecordFixture = fileURLToPath(
	new URL("fixtures/notebook/job-record.json", import.meta.url),
);
const jobRecordArgumentsDigest =
	"b7fadc2c62709af32f3d165655772cd301c5050db8bff6e9df46579f79e155a1";
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
				"--observation", OBSERVATION,
				"--evidence", evidenceFixture, "--grade", "asserted",
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
		{ name: "not JSON", args: ["--hypothesis", "x", "--grade", "asserted", "--evidence", await badEvidence("not-json.json", "{oops")] },
		{ name: "not a JSON object", args: ["--hypothesis", "x", "--grade", "asserted", "--evidence", await badEvidence("array.json", "[]")] },
		{ name: "missing source", args: ["--hypothesis", "x", "--grade", "asserted", "--evidence", await badEvidence("no-source.json", JSON.stringify({ provenance: { calls: [{ endpoint: "e", url: "https://x" }], accessed: "2026-10-18" } }))] },
		{ name: "missing provenance", args: ["--hypothesis", "x", "--grade", "asserted", "--evidence", await badEvidence("no-prov.json", JSON.stringify({ source: "pubmed" }))] },
		{ name: "empty calls list", args: ["--hypothesis", "x", "--grade", "asserted", "--evidence", await badEvidence("no-calls.json", JSON.stringify({ source: "pubmed", provenance: { calls: [], accessed: "2026-10-18" } }))] },
		{ name: "calls not a list", args: ["--hypothesis", "x", "--grade", "asserted", "--evidence", await badEvidence("calls-str.json", JSON.stringify({ source: "pubmed", provenance: { calls: "esearch.fcgi", accessed: "2026-10-18" } }))] },
		{ name: "call without endpoint", args: ["--hypothesis", "x", "--grade", "asserted", "--evidence", await badEvidence("no-endpoint.json", JSON.stringify({ source: "pubmed", provenance: { calls: [{ url: "https://x" }], accessed: "2026-10-18" } }))] },
		{ name: "call without url", args: ["--hypothesis", "x", "--grade", "asserted", "--evidence", await badEvidence("no-url.json", JSON.stringify({ source: "pubmed", provenance: { calls: [{ endpoint: "esearch.fcgi" }], accessed: "2026-10-18" } }))] },
		{ name: "accessed not a date", args: ["--hypothesis", "x", "--grade", "asserted", "--evidence", await badEvidence("bad-date.json", JSON.stringify({ source: "pubmed", provenance: { calls: [{ endpoint: "e", url: "https://x" }], accessed: "18/10/2026" } }))] },
		{ name: "accessed not a calendar date", args: ["--hypothesis", "x", "--grade", "asserted", "--evidence", await badEvidence("cal-date.json", JSON.stringify({ source: "pubmed", provenance: { calls: [{ endpoint: "e", url: "https://x" }], accessed: "2026-02-30" } }))] },
		{ name: "accessed not a string", args: ["--hypothesis", "x", "--grade", "asserted", "--evidence", await badEvidence("num-date.json", JSON.stringify({ source: "pubmed", provenance: { calls: [{ endpoint: "e", url: "https://x" }], accessed: 20261018 } }))] },
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

// --- The job-record path (M4 S5, ADR 0004): a gateway job record is the
// --- evidence item of the method entry that records a compute run.

test("job record rides a method entry: graded item, content-addressed snapshot", { skip: skipReason }, async (t) => {
	const project = await scratchProject(t);
	const run = runRecorder(
		[
			"--method",
			"AlphaFold3 fold of hen egg white lysozyme on the cluster",
			"--job-record", jobRecordFixture,
			"--grade", "re-executed",
		],
		{ cwd: project },
	);
	assert.equal(run.status, 0, `stderr: ${run.stderr}`);
	assert.equal(run.stderr, "");

	// stdout names what was recorded, evidence-footer style, plus the
	// artifact manifest line the fetched artifacts earned.
	const lines = run.stdout.trimEnd().split("\n");
	assert.equal(lines.length, 4);
	assert.equal(lines[0], "recorded mth-0001 (method) in .theta/notebook.jsonl");
	assert.equal(
		lines[1],
		"# evidence: theta-compute job 12347 COMPLETED (template alphafold3); retrieved 2026-10-25; grade re-executed",
	);
	assert.equal(lines[2], "# artifacts: 2 files, 49414 bytes");
	assert.match(lines[3], /^# snapshot: evidence\/[0-9a-f]{64}\.json$/);

	// The entry: one dated method provenance entry whose evidence item is
	// the job record — the glossary's six fields plus retrieved/grade/snapshot.
	const entries = await readEntries(project);
	assert.equal(entries.length, 1);
	const [entry] = entries;
	assert.equal(entry.id, "mth-0001");
	assert.equal(entry.type, "method");
	assert.equal(entry.date, localDate());
	const [item] = entry.evidence;
	assert.equal(item.source, "theta-compute");
	assert.equal(item.job_id, "12347");
	assert.equal(item.template, "alphafold3");
	assert.equal(item.arguments_digest, jobRecordArgumentsDigest);
	assert.equal(item.state, "COMPLETED");
	assert.deepEqual(item.artifacts, JSON.parse(await readFile(jobRecordFixture, "utf8")).artifacts);
	// retrieved is the record's observed date, not today — the two dates are
	// different claims and must stay distinguishable.
	assert.equal(item.retrieved, "2026-10-25");
	assert.notEqual(item.retrieved, entry.date);
	assert.equal(item.grade, "re-executed");
	assert.equal(item.snapshot, `evidence/${sha256(await readFile(jobRecordFixture, "utf8"))}.json`);

	// The snapshot: the assembled record verbatim, content-addressed.
	const snapshotPath = path.join(project, ".theta", item.snapshot);
	const snapshot = await readFile(snapshotPath, "utf8");
	assert.equal(snapshot, await readFile(jobRecordFixture, "utf8"));
	assert.equal(
		createHash("sha256").update(snapshot).digest("hex"),
		path.basename(snapshotPath, ".json"),
	);
});

test("job record piped on stdin records the same entry (--job-record -)", { skip: skipReason }, async (t) => {
	const project = await scratchProject(t);
	const run = runRecorder(
		["--method", METHOD, "--job-record", "-", "--grade", "re-executed"],
		{ cwd: project, stdin: await readFile(jobRecordFixture, "utf8") },
	);
	assert.equal(run.status, 0, `stderr: ${run.stderr}`);
	const [entry] = await readEntries(project);
	assert.equal(entry.evidence[0].job_id, "12347");
	assert.equal(entry.evidence[0].retrieved, "2026-10-25");
	assert.equal(entry.evidence[0].grade, "re-executed");
});

test("a job record without fetched artifacts grades asserted, never re-executed", { skip: skipReason }, async (t) => {
	const project = await scratchProject(t);
	const record = JSON.parse(await readFile(jobRecordFixture, "utf8"));
	delete record.artifacts;
	const noArtifacts = path.join(project, "job-record-no-artifacts.json");
	await writeFile(noArtifacts, JSON.stringify(record, null, 2), "utf8");

	const run = runRecorder(
		["--method", METHOD, "--job-record", noArtifacts, "--grade", "asserted"],
		{ cwd: project },
	);
	assert.equal(run.status, 0, `stderr: ${run.stderr}`);
	const lines = run.stdout.trimEnd().split("\n");
	assert.equal(lines.length, 3, "no artifact manifest, no artifacts line");
	assert.equal(
		lines[1],
		"# evidence: theta-compute job 12347 COMPLETED (template alphafold3); retrieved 2026-10-25; grade asserted",
	);
	const [entry] = await readEntries(project);
	assert.equal(entry.evidence[0].artifacts, undefined);

	// The claim re-executed stands on the fetched artifacts; without the
	// manifest the recorder refuses it as a usage error and appends nothing.
	const before = await readFile(path.join(project, ".theta", "notebook.jsonl"), "utf8");
	const reexecuted = runRecorder(
		["--method", "A second look", "--job-record", noArtifacts, "--grade", "re-executed"],
		{ cwd: project },
	);
	assert.equal(reexecuted.status, 1);
	assert.match(reexecuted.stderr, /re-executed/);
	assert.match(reexecuted.stderr, /manifest|artifacts/);
	assert.equal(reexecuted.stdout, "");
	assert.equal(
		await readFile(path.join(project, ".theta", "notebook.jsonl"), "utf8"),
		before,
		"appended nothing",
	);
});

test("identical job records dedupe into one snapshot; ids sequence per type", { skip: skipReason }, async (t) => {
	const project = await scratchProject(t);
	const recordArgs = ["--job-record", jobRecordFixture, "--grade", "re-executed"];
	const first = runRecorder(["--method", METHOD, ...recordArgs], { cwd: project });
	assert.equal(first.status, 0, `stderr: ${first.stderr}`);
	const second = runRecorder(
		["--method", "The same run recorded from a later session", ...recordArgs],
		{ cwd: project },
	);
	assert.equal(second.status, 0, `stderr: ${second.stderr}`);

	const entries = await readEntries(project);
	assert.deepEqual(entries.map((entry) => entry.id), ["mth-0001", "mth-0002"]);
	const evidenceDir = await readdir(path.join(project, ".theta", "evidence"));
	assert.equal(evidenceDir.length, 1);
	assert.equal(entries[0].evidence[0].snapshot, entries[1].evidence[0].snapshot);
});

test("an observation's job-record evidence links to a hypothesis (--supports)", { skip: skipReason }, async (t) => {
	const project = await scratchProject(t);
	const hyp = runRecorder(
		["--hypothesis", HYPOTHESIS, "--evidence", evidenceFixture, "--grade", "asserted"],
		{ cwd: project },
	);
	assert.equal(hyp.status, 0, `stderr: ${hyp.stderr}`);

	const obs = runRecorder(
		[
			"--observation",
			"The fold completed and its ranked outputs came back",
			"--job-record", jobRecordFixture,
			"--grade", "re-executed",
			"--supports", "hyp-0001",
		],
		{ cwd: project },
	);
	assert.equal(obs.status, 0, `stderr: ${obs.stderr}`);
	const entries = await readEntries(project);
	const observation = entries[entries.length - 1];
	assert.equal(observation.type, "observation");
	assert.equal(observation.evidence[0].supports, "hyp-0001");
	assert.equal(observation.evidence[0].job_id, "12347");
});

test("job-record usage errors exit 1 and write nothing into the project", { skip: skipReason }, async (t) => {
	const badRecord = async (name, record) => {
		const file = path.join(await scratchProject(t), name);
		await writeFile(file, typeof record === "string" ? record : JSON.stringify(record, null, 2), "utf8");
		return file;
	};
	const base = {
		gateway: "theta-compute",
		job_id: "12347",
		run_name: "af3-lysozyme",
		template: "alphafold3",
		arguments_digest: jobRecordArgumentsDigest,
		state: "COMPLETED",
		observed: "2026-10-25",
	};
	const manifest = {
		run_name: "af3-lysozyme",
		total_bytes: 49414,
		files: [{ path: "alphafold3_output/model.cif", size: 48211 }],
	};
	const cases = [
		{ name: "--evidence and --job-record together", args: ["--method", "x", "--evidence", evidenceFixture, "--grade", "asserted", "--job-record", jobRecordFixture] },
		{ name: "confidence with a job record", args: ["--confidence", "x", "--on", "hyp-0001", "--job-record", jobRecordFixture, "--grade", "asserted"] },
		{ name: "job record without grade", args: ["--method", "x", "--job-record", jobRecordFixture] },
		{ name: "grade without a job record", args: ["--method", "x", "--grade", "asserted"] },
		{ name: "cross-checked on a job record", args: ["--method", "x", "--job-record", jobRecordFixture, "--grade", "cross-checked"] },
		{ name: "job record file missing", args: ["--method", "x", "--job-record", "/nonexistent/record.json", "--grade", "asserted"] },
		{ name: "job record not JSON", args: ["--method", "x", "--grade", "asserted", "--job-record", await badRecord("not-json.json", "{oops")] },
		{ name: "job record not an object", args: ["--method", "x", "--grade", "asserted", "--job-record", await badRecord("array.json", "[]")] },
		{ name: "missing gateway", args: ["--method", "x", "--grade", "asserted", "--job-record", await badRecord("no-gateway.json", { ...base, gateway: undefined })] },
		{ name: "empty gateway", args: ["--method", "x", "--grade", "asserted", "--job-record", await badRecord("empty-gateway.json", { ...base, gateway: "" })] },
		{ name: "job_id not digits", args: ["--method", "x", "--grade", "asserted", "--job-record", await badRecord("bad-id.json", { ...base, job_id: "abc47" })] },
		{ name: "job_id not a string", args: ["--method", "x", "--grade", "asserted", "--job-record", await badRecord("num-id.json", { ...base, job_id: 12347 })] },
		{ name: "run_name with a space", args: ["--method", "x", "--grade", "asserted", "--job-record", await badRecord("space-run.json", { ...base, run_name: "af3 lysozyme" })] },
		{ name: "run_name too long", args: ["--method", "x", "--grade", "asserted", "--job-record", await badRecord("long-run.json", { ...base, run_name: "a".repeat(65) })] },
		{ name: "missing template", args: ["--method", "x", "--grade", "asserted", "--job-record", await badRecord("no-template.json", { ...base, template: undefined })] },
		{ name: "template not a string or null", args: ["--method", "x", "--grade", "asserted", "--job-record", await badRecord("num-template.json", { ...base, template: 3 })] },
		{ name: "arguments_digest not hex", args: ["--method", "x", "--grade", "asserted", "--job-record", await badRecord("bad-digest.json", { ...base, arguments_digest: "z".repeat(64) })] },
		{ name: "arguments_digest too short", args: ["--method", "x", "--grade", "asserted", "--job-record", await badRecord("short-digest.json", { ...base, arguments_digest: "a".repeat(63) })] },
		{ name: "missing state", args: ["--method", "x", "--grade", "asserted", "--job-record", await badRecord("no-state.json", { ...base, state: undefined })] },
		{ name: "empty state", args: ["--method", "x", "--grade", "asserted", "--job-record", await badRecord("empty-state.json", { ...base, state: " " })] },
		{ name: "observed not a date", args: ["--method", "x", "--grade", "asserted", "--job-record", await badRecord("bad-observed.json", { ...base, observed: "25/10/2026" })] },
		{ name: "observed not a calendar date", args: ["--method", "x", "--grade", "asserted", "--job-record", await badRecord("cal-observed.json", { ...base, observed: "2026-02-30" })] },
		{ name: "artifacts not an object", args: ["--method", "x", "--grade", "asserted", "--job-record", await badRecord("art-list.json", { ...base, artifacts: [] })] },
		{ name: "artifacts files empty", args: ["--method", "x", "--grade", "asserted", "--job-record", await badRecord("no-files.json", { ...base, artifacts: { ...manifest, files: [] } })] },
		{ name: "file entry without path", args: ["--method", "x", "--grade", "asserted", "--job-record", await badRecord("no-path.json", { ...base, artifacts: { ...manifest, files: [{ size: 1 }] } })] },
		{ name: "file entry with contents", args: ["--method", "x", "--grade", "asserted", "--job-record", await badRecord("with-b64.json", { ...base, artifacts: { ...manifest, files: [{ path: "out/model.cif", size: 48211, content_b64: "TT0kCg==" }] } })] },
		{ name: "artifacts with contents at the top level", args: ["--method", "x", "--grade", "asserted", "--job-record", await badRecord("top-b64.json", { ...base, artifacts: { ...manifest, content_b64: "TT0kCg==" } })] },
		{ name: "file size negative", args: ["--method", "x", "--grade", "asserted", "--job-record", await badRecord("neg-size.json", { ...base, artifacts: { ...manifest, files: [{ path: "out/model.cif", size: -1 }] } })] },
		{ name: "file size not a number", args: ["--method", "x", "--grade", "asserted", "--job-record", await badRecord("str-size.json", { ...base, artifacts: { ...manifest, files: [{ path: "out/model.cif", size: "48211" }] } })] },
		{ name: "total_bytes negative", args: ["--method", "x", "--grade", "asserted", "--job-record", await badRecord("neg-total.json", { ...base, artifacts: { ...manifest, total_bytes: -5 } })] },
		{ name: "artifacts run_name mismatch", args: ["--method", "x", "--grade", "asserted", "--job-record", await badRecord("mismatch-run.json", { ...base, artifacts: { ...manifest, run_name: "other-run" } })] },
	];
	for (const { name, args } of cases) {
		const project = await scratchProject(t);
		const run = runRecorder(args, { cwd: project });
		assert.equal(run.status, 1, `${name}: should exit 1`);
		assert.notEqual(run.stderr.trim(), "", `${name}: stderr must say what is wrong`);
		assert.equal(run.stdout, "", `${name}: no stdout on failure`);
		// A rejected input must leave no trace: nothing is written before every
		// check passes.
		assert.deepEqual(await readdir(project), [], `${name}: wrote files into the project`);
	}
});

test("a raw submit's job record: template null, no manifest, footer says so", { skip: skipReason }, async (t) => {
	const project = await scratchProject(t);
	const record = {
		gateway: "theta-compute",
		job_id: "12399",
		run_name: "bnb-screen",
		template: null,
		arguments_digest: jobRecordArgumentsDigest,
		state: "FAILED",
		observed: "2026-10-25",
	};
	const file = path.join(project, "job-record-raw.json");
	await writeFile(file, JSON.stringify(record, null, 2), "utf8");

	const run = runRecorder(
		["--method", METHOD, "--job-record", file, "--grade", "asserted"],
		{ cwd: project },
	);
	assert.equal(run.status, 0, `stderr: ${run.stderr}`);
	const lines = run.stdout.trimEnd().split("\n");
	assert.equal(lines.length, 3);
	assert.equal(
		lines[1],
		"# evidence: theta-compute job 12399 FAILED (no template); retrieved 2026-10-25; grade asserted",
	);
	const [entry] = await readEntries(project);
	assert.equal(entry.evidence[0].template, null);
	assert.equal(entry.evidence[0].artifacts, undefined);
});
