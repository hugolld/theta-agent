import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
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
// The plan test vector (spec #201): known Markdown bytes to a known revision
// digest. The recipe — first 12 hex of sha256 over the file bytes — is a
// cross-language contract: the TS side of the plan object (the decision-entry
// citation and the review gate, parent #200 T2/T3) pins the same fixture and
// the same literal, so both languages compute one revision for one plan.
const planVectorFixture = fileURLToPath(
	new URL("fixtures/notebook/plan-vector.md", import.meta.url),
);
const planVectorRevision = "c6f6084b0e5f";
// The shared plan-citation grammar fixture (spec #202): one committed
// decision entry line both this suite and the TS cards suite read — field
// names, shapes, and one grammar in both languages. Its cited revision is
// the plan vector's own digest: the cited plan's bytes are the committed
// vector's bytes.
const planDecisionFixture = fileURLToPath(
	new URL("fixtures/notebook/plan-decision.jsonl", import.meta.url),
);
const planDecisionPlanId = "2026-11-18-af3-benchmark";

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

// --- The plan-object path (spec #201, parent #200): .theta/plans/ write,
// --- read, update — the plan document the loop states before Execute. The
// --- ops carry plan text only: no evidence semantics, no notebook entries.

// A scratch project with `.theta/` already created: plan ops follow the
// entry rule that the researcher (or an evidenced record) creates the
// directory, and a fresh-project plan write refuses until then.
async function scratchThetaProject(t) {
	const project = await scratchProject(t);
	await mkdir(path.join(project, ".theta"));
	return project;
}

// The revision digest — first 12 hex of sha256 over the file bytes, the
// recipe the committed vector below pins cross-language. Delegates to the
// file's own sha256 helper: one hash home, two recipes off it.
const revisionOf = (text) => sha256(text).slice(0, 12);

const PLAN_TEXT =
	"# AF3 benchmark plan\n\nFold the five lysozyme variants and rank them against the controls.\n";
const PLAN_REVISED =
	"# AF3 benchmark plan\n\nFold the five variants, then the two controls, ranking every output by pLDDT.\n";
const planPath = (project, planId) => path.join(project, ".theta", "plans", `${planId}.md`);
const planIdToday = (slug) => `${localDate()}-${slug}`;

test("plan write creates the file and reports path and revision", { skip: skipReason }, async (t) => {
	const project = await scratchThetaProject(t);
	const run = runRecorder(["--plan-write", "af3-benchmark", "--plan-file", "-"], {
		cwd: project,
		stdin: PLAN_TEXT,
	});
	assert.equal(run.status, 0, `stderr: ${run.stderr}`);
	assert.equal(run.stderr, "");

	const planId = planIdToday("af3-benchmark");
	const expectedPath = `.theta/plans/${planId}.md`;
	assert.equal(
		run.stdout.trimEnd(),
		`wrote plan ${expectedPath} revision ${revisionOf(PLAN_TEXT)}`,
	);
	// The file: today's date, the slug, the plan's text as read (LF endings).
	assert.equal(
		await readFile(planPath(project, planId), "utf8"),
		PLAN_TEXT,
		"plan text is written as read",
	);
	assert.deepEqual(await readdir(path.join(project, ".theta")), ["plans"]);
});

test("the committed plan vector: known bytes to the pinned revision digest", { skip: skipReason }, async (t) => {
	// The cross-language contract (spec #201): these fixture bytes digest to
	// this literal revision. The TS side (parent #200 T2/T3) pins the same
	// pair, so both languages compute one revision for one plan.
	const project = await scratchThetaProject(t);
	const run = runRecorder(["--plan-write", "plan-vector", "--plan-file", planVectorFixture], {
		cwd: project,
	});
	assert.equal(run.status, 0, `stderr: ${run.stderr}`);
	assert.ok(
		run.stdout.includes(`revision ${planVectorRevision}`),
		`stdout names the pinned revision: ${run.stdout}`,
	);
	// The read op reports the same revision for the same bytes.
	const readBack = runRecorder(["--plan-read", planIdToday("plan-vector")], { cwd: project });
	assert.equal(readBack.status, 0, `stderr: ${readBack.stderr}`);
	assert.ok(
		readBack.stdout.includes(`revision ${planVectorRevision}`),
		`read names the pinned revision: ${readBack.stdout}`,
	);
});

test("plan read reports the path and the current revision", { skip: skipReason }, async (t) => {
	const project = await scratchThetaProject(t);
	const write = runRecorder(["--plan-write", "af3-benchmark", "--plan-file", "-"], {
		cwd: project,
		stdin: PLAN_TEXT,
	});
	assert.equal(write.status, 0, `stderr: ${write.stderr}`);

	const planId = planIdToday("af3-benchmark");
	const run = runRecorder(["--plan-read", planId], { cwd: project });
	assert.equal(run.status, 0, `stderr: ${run.stderr}`);
	assert.equal(
		run.stdout.trimEnd(),
		`plan .theta/plans/${planId}.md revision ${revisionOf(PLAN_TEXT)}`,
	);
});

test("plan update overwrites with a new revision, naming the one it replaces", { skip: skipReason }, async (t) => {
	const project = await scratchThetaProject(t);
	const write = runRecorder(["--plan-write", "af3-benchmark", "--plan-file", "-"], {
		cwd: project,
		stdin: PLAN_TEXT,
	});
	assert.equal(write.status, 0, `stderr: ${write.stderr}`);

	const planId = planIdToday("af3-benchmark");
	const run = runRecorder(["--plan-update", planId, "--plan-file", "-"], {
		cwd: project,
		stdin: PLAN_REVISED,
	});
	assert.equal(run.status, 0, `stderr: ${run.stderr}`);
	assert.equal(
		run.stdout.trimEnd(),
		`updated plan .theta/plans/${planId}.md revision ${revisionOf(PLAN_REVISED)} (was ${revisionOf(PLAN_TEXT)})`,
	);
	// The plan-id is immutable across the update: same file, new bytes.
	assert.equal(await readFile(planPath(project, planId), "utf8"), PLAN_REVISED);
	const readBack = runRecorder(["--plan-read", planId], { cwd: project });
	assert.ok(readBack.stdout.includes(`revision ${revisionOf(PLAN_REVISED)}`));
});

test("a hand edit is a new revision, not an error: read reports the edited bytes", { skip: skipReason }, async (t) => {
	const project = await scratchThetaProject(t);
	const planId = planIdToday("af3-benchmark");
	const write = runRecorder(["--plan-write", "af3-benchmark", "--plan-file", "-"], {
		cwd: project,
		stdin: PLAN_TEXT,
	});
	assert.equal(write.status, 0, `stderr: ${write.stderr}`);

	// The researcher hand-edits the Markdown — the recorder is the loop's
	// writer, not the file's owner. Reading the plan afterwards reports the
	// edited bytes' digest: the revision later approval must name.
	const handEdited = `${PLAN_TEXT}Added by hand: the negative control arm.\n`;
	await writeFile(planPath(project, planId), handEdited, "utf8");
	const run = runRecorder(["--plan-read", planId], { cwd: project });
	assert.equal(run.status, 0, `stderr: ${run.stderr}`);
	assert.ok(
		run.stdout.includes(`revision ${revisionOf(handEdited)}`),
		`read names the hand-edited revision: ${run.stdout}`,
	);
	// And the recorder can still update over the hand edit.
	const update = runRecorder(["--plan-update", planId, "--plan-file", "-"], {
		cwd: project,
		stdin: PLAN_REVISED,
	});
	assert.equal(update.status, 0, `stderr: ${update.stderr}`);
	assert.ok(update.stdout.includes(`(was ${revisionOf(handEdited)})`));
});

test("a same-day collision refuses: the slug names a plan that already exists", { skip: skipReason }, async (t) => {
	const project = await scratchThetaProject(t);
	const first = runRecorder(["--plan-write", "af3-benchmark", "--plan-file", "-"], {
		cwd: project,
		stdin: PLAN_TEXT,
	});
	assert.equal(first.status, 0, `stderr: ${first.stderr}`);

	const second = runRecorder(["--plan-write", "af3-benchmark", "--plan-file", "-"], {
		cwd: project,
		stdin: PLAN_REVISED,
	});
	assert.equal(second.status, 1);
	assert.match(second.stderr, /already exists/);
	assert.match(second.stderr, /af3-benchmark/);
	assert.match(second.stderr, /--plan-update/);
	assert.equal(second.stdout, "");
	// The first plan is unchanged — a collision never clobbers.
	assert.equal(await readFile(planPath(project, planIdToday("af3-benchmark")), "utf8"), PLAN_TEXT);
});

test("the slug grammar: date-prefixable kebab, lowercase, capped", { skip: skipReason }, async (t) => {
	const valid = ["af3", "af3-benchmark", "a1-b2-c3", "x".repeat(48)];
	for (const slug of valid) {
		const project = await scratchThetaProject(t);
		const run = runRecorder(["--plan-write", slug, "--plan-file", "-"], {
			cwd: project,
			stdin: PLAN_TEXT,
		});
		assert.equal(run.status, 0, `${slug}: should write`);
		assert.ok(existsSync(planPath(project, planIdToday(slug))), `${slug}: file named by the slug`);
	}
	const invalid = [
		["uppercase", "AF3-Benchmark"],
		["underscore", "af3_benchmark"],
		["space", "af3 benchmark"],
		["leading hyphen", "-af3"],
		["trailing hyphen", "af3-"],
		["double hyphen", "af3--benchmark"],
		["dot separator", "af3.benchmark"],
		["path escape", "../escape"],
		["non-ascii", "af3-é"],
		["over the cap", "a".repeat(49)],
		// The write must hold the same grammar the naming operations do: a
		// slug carrying a newline would write a plan file no read, update,
		// citation, or decision read can name.
		["trailing newline", "af3-benchmark\n"],
	];
	for (const [name, slug] of invalid) {
		const project = await scratchThetaProject(t);
		// The `=` form hands argparse the slug verbatim -- a leading hyphen
		// would otherwise read as a flag before the grammar check runs.
		const run = runRecorder([`--plan-write=${slug}`, "--plan-file", "-"], {
			cwd: project,
			stdin: PLAN_TEXT,
		});
		assert.equal(run.status, 1, `${name}: should exit 1`);
		assert.match(run.stderr, /slug/, `${name}: stderr names the slug grammar`);
		assert.equal(run.stdout, "");
		assert.deepEqual(
			await readdir(path.join(project, ".theta")),
			[],
			`${name}: wrote nothing`,
		);
	}
});

test("the plan-id grammar on read and update: calendar date plus slug", { skip: skipReason }, async (t) => {
	const project = await scratchThetaProject(t);
	const write = runRecorder(["--plan-write", "af3-benchmark", "--plan-file", "-"], {
		cwd: project,
		stdin: PLAN_TEXT,
	});
	assert.equal(write.status, 0, `stderr: ${write.stderr}`);

	for (const [name, planId] of [
		["slug without a date", "af3-benchmark"],
		["date not calendar-valid", "2026-13-01-af3"],
		["date not shaped", "20261122-af3"],
		["uppercase slug", "2026-11-22-AF3"],
		["path escape", "../../etc/passwd"],
	]) {
		for (const op of ["--plan-read", "--plan-update"]) {
			const args = op === "--plan-update" ? [op, planId, "--plan-file", "-"] : [op, planId];
			const run = runRecorder(args, { cwd: project, stdin: PLAN_TEXT });
			assert.equal(run.status, 1, `${name} ${op}: should exit 1`);
			// The discriminating stderr: this refusal is the grammar's, not a
			// generic non-empty one (the connector-scripts invariant).
			assert.ok(
				run.stderr.includes("plan ids are <YYYY-MM-DD>-<slug>"),
				`${name} ${op}: stderr names the plan-id grammar`,
			);
			assert.equal(run.stdout, "");
		}
	}

	// A well-shaped plan-id that names no written plan is a usage error too.
	const missing = runRecorder(["--plan-read", "2026-01-01-none-such"], { cwd: project });
	assert.equal(missing.status, 1);
	assert.match(missing.stderr, /no plan/);
	assert.match(missing.stderr, /2026-01-01-none-such/);

	const updateMissing = runRecorder(["--plan-update", "2026-01-01-none-such", "--plan-file", "-"], {
		cwd: project,
		stdin: PLAN_TEXT,
	});
	assert.equal(updateMissing.status, 1);
	assert.match(updateMissing.stderr, /no plan/);
});

test("plan-flag pairing errors exit 1 and write nothing", { skip: skipReason }, async (t) => {
	// Each case also names the stderr that discriminates it (the
	// connector-scripts invariant): the refusal must be this one, not any
	// non-empty stderr.
	const cases = [
		{ name: "write without --plan-file", args: ["--plan-write", "af3-benchmark"], err: "--plan-write requires --plan-file" },
		{ name: "update without --plan-file", args: ["--plan-update", planIdToday("af3-benchmark")], err: "--plan-update requires --plan-file" },
		{ name: "--plan-file with read", args: ["--plan-read", planIdToday("x"), "--plan-file", "-"], stdin: PLAN_TEXT, err: "--plan-file is not accepted with --plan-read" },
		{ name: "--plan-file with an entry", args: ["--decision", "x", "--plan-file", "-"], stdin: PLAN_TEXT, err: "--plan-file is only accepted with --plan-write or" },
		{ name: "write beside an entry flag", args: ["--plan-write", "af3-benchmark", "--plan-file", "-", "--decision", "x"], stdin: PLAN_TEXT, err: "not accepted with an entry type -- one operation per call" },
		{ name: "read with --grade", args: ["--plan-read", planIdToday("x"), "--grade", "asserted"], err: "--grade is not accepted with --plan-read" },
		{ name: "write with --evidence", args: ["--plan-write", "af3-benchmark", "--plan-file", "-", "--evidence", evidenceFixture, "--grade", "asserted"], stdin: PLAN_TEXT, err: "--evidence is not accepted with --plan-write" },
		{ name: "write with --supports", args: ["--plan-write", "af3-benchmark", "--plan-file", "-", "--supports", "hyp-0001"], stdin: PLAN_TEXT, err: "--supports is not accepted with --plan-write" },
		{ name: "write with --on", args: ["--plan-write", "af3-benchmark", "--plan-file", "-", "--on", "hyp-0001"], stdin: PLAN_TEXT, err: "--on is not accepted with --plan-write" },
		{ name: "write with --job-record", args: ["--plan-write", "af3-benchmark", "--plan-file", "-", "--job-record", jobRecordFixture, "--grade", "asserted"], stdin: PLAN_TEXT, err: "--job-record is not accepted with --plan-write" },
		{ name: "empty plan text", args: ["--plan-write", "af3-benchmark", "--plan-file", "-"], stdin: "  \n", err: "--plan-file is empty" },
		{ name: "plan file missing", args: ["--plan-write", "af3-benchmark", "--plan-file", "/nonexistent/plan.md"], err: "--plan-file unreadable" },
		{ name: "no operation at all", args: [], err: "or plan operation (--plan-write, --plan-update, --plan-read, --plan-decision) is required" },
	];
	for (const { name, args, stdin, err } of cases) {
		const project = await scratchThetaProject(t);
		const run = runRecorder(args, { cwd: project, stdin });
		assert.equal(run.status, 1, `${name}: should exit 1`);
		assert.ok(run.stderr.includes(err), `${name}: stderr names the refusal (${err})`);
		assert.equal(run.stdout, "", `${name}: no stdout on failure`);
		assert.deepEqual(await readdir(path.join(project, ".theta")), [], `${name}: wrote nothing`);
	}
});

test("plan ops leave the notebook alone; entries sequence after plans", { skip: skipReason }, async (t) => {
	const project = await scratchThetaProject(t);
	const write = runRecorder(["--plan-write", "af3-benchmark", "--plan-file", "-"], {
		cwd: project,
		stdin: PLAN_TEXT,
	});
	assert.equal(write.status, 0, `stderr: ${write.stderr}`);
	const read = runRecorder(["--plan-read", planIdToday("af3-benchmark")], { cwd: project });
	assert.equal(read.status, 0, `stderr: ${read.stderr}`);

	// No notebook file appeared: the plan object is a document, not an entry.
	assert.equal(existsSync(path.join(project, ".theta", "notebook.jsonl")), false);

	// And an entry records normally beside the plan, ids starting fresh.
	const entry = runRecorder(["--decision", DECISION], { cwd: project });
	assert.equal(entry.status, 0, `stderr: ${entry.stderr}`);
	const entries = await readEntries(project);
	assert.deepEqual(entries.map((e) => e.id), ["dec-0001"]);
	assert.deepEqual(await readdir(path.join(project, ".theta")), ["notebook.jsonl", "plans"]);
});

test("--json prints the plan result object", { skip: skipReason }, async (t) => {
	const project = await scratchThetaProject(t);
	const write = runRecorder(
		["--plan-write", "af3-benchmark", "--plan-file", "-", "--json"],
		{ cwd: project, stdin: PLAN_TEXT },
	);
	assert.equal(write.status, 0, `stderr: ${write.stderr}`);
	const planId = planIdToday("af3-benchmark");
	assert.deepEqual(JSON.parse(write.stdout), {
		plan: planId,
		path: `.theta/plans/${planId}.md`,
		revision: revisionOf(PLAN_TEXT),
	});

	const update = runRecorder(
		["--plan-update", planId, "--plan-file", "-", "--json"],
		{ cwd: project, stdin: PLAN_REVISED },
	);
	assert.equal(update.status, 0, `stderr: ${update.stderr}`);
	assert.deepEqual(JSON.parse(update.stdout), {
		plan: planId,
		path: `.theta/plans/${planId}.md`,
		revision: revisionOf(PLAN_REVISED),
		previous_revision: revisionOf(PLAN_TEXT),
	});

	const read = runRecorder(["--plan-read", planId, "--json"], { cwd: project });
	assert.equal(read.status, 0, `stderr: ${read.stderr}`);
	assert.deepEqual(JSON.parse(read.stdout), {
		plan: planId,
		path: `.theta/plans/${planId}.md`,
		revision: revisionOf(PLAN_REVISED),
	});
});

test("a fresh project refuses the first plan write until .theta exists; a non-directory .theta exits 2", { skip: skipReason }, async (t) => {
	const fresh = await scratchProject(t);
	const noTheta = runRecorder(["--plan-write", "af3-benchmark", "--plan-file", "-"], {
		cwd: fresh,
		stdin: PLAN_TEXT,
	});
	assert.equal(noTheta.status, 2);
	assert.match(noTheta.stderr, /\.theta/);
	assert.deepEqual(await readdir(fresh), [], "wrote nothing");

	const project = await scratchProject(t);
	await writeFile(path.join(project, ".theta"), "not a directory\n", "utf8");
	const notDir = runRecorder(["--plan-write", "af3-benchmark", "--plan-file", "-"], {
		cwd: project,
		stdin: PLAN_TEXT,
	});
	assert.equal(notDir.status, 2);
	assert.ok(notDir.stderr.includes(".theta"));
});

// --- The plan-citation path (spec #202, parent #200 T2): a decision entry
// --- cites the plan it approves or refuses — planPath, planRevision,
// --- decision, optional rationale — resolved against disk before writing,
// --- and the notebook answers a decision read per plan path and revision.

test("a decision cites the plan it approves: the pinned field set, resolved against disk", { skip: skipReason }, async (t) => {
	const project = await scratchThetaProject(t);
	// The plan is written from the committed vector, so its revision is the
	// shared literal — the same bytes the fixture entry cites.
	const write = runRecorder(["--plan-write", "af3-benchmark", "--plan-file", planVectorFixture], {
		cwd: project,
	});
	assert.equal(write.status, 0, `stderr: ${write.stderr}`);
	const planId = planIdToday("af3-benchmark");

	const run = runRecorder(
		[
			"--decision", "Approve the AF3 benchmark plan",
			"--plan-cite", planId,
			"--revision", planVectorRevision,
			"--verdict", "approved",
			"--rationale", "Digest matches the plan on disk",
		],
		{ cwd: project },
	);
	assert.equal(run.status, 0, `stderr: ${run.stderr}`);
	const lines = run.stdout.trimEnd().split("\n");
	assert.equal(lines[0], "recorded dec-0001 (decision) in .theta/notebook.jsonl");
	assert.equal(
		lines[1],
		`# plan: .theta/plans/${planId}.md revision ${planVectorRevision} approved`,
	);

	const [entry] = await readEntries(project);
	assert.equal(entry.id, "dec-0001");
	assert.equal(entry.type, "decision");
	assert.equal(entry.text, "Approve the AF3 benchmark plan");
	assert.equal(entry.planPath, `.theta/plans/${planId}.md`);
	// The cited revision is the committed vector's digest.
	assert.equal(entry.planRevision, planVectorRevision);
	assert.equal(entry.decision, "approved");
	assert.equal(entry.rationale, "Digest matches the plan on disk");
	// The field set is exactly the pinned grammar's, nothing else.
	assert.deepEqual(Object.keys(entry).sort(), [
		"date",
		"decision",
		"id",
		"planPath",
		"planRevision",
		"rationale",
		"text",
		"type",
	]);
});

test("a refusal records the citation too; the rationale stays optional", { skip: skipReason }, async (t) => {
	const project = await scratchThetaProject(t);
	const write = runRecorder(["--plan-write", "af3-benchmark", "--plan-file", "-"], {
		cwd: project,
		stdin: PLAN_TEXT,
	});
	assert.equal(write.status, 0, `stderr: ${write.stderr}`);
	const planId = planIdToday("af3-benchmark");

	const run = runRecorder(
		[
			"--decision", DECISION,
			"--plan-cite", planId,
			"--revision", revisionOf(PLAN_TEXT),
			"--verdict", "refused",
		],
		{ cwd: project },
	);
	assert.equal(run.status, 0, `stderr: ${run.stderr}`);
	assert.ok(
		run.stdout.includes(
			`# plan: .theta/plans/${planId}.md revision ${revisionOf(PLAN_TEXT)} refused`,
		),
		`footer names the refusal: ${run.stdout}`,
	);
	const [entry] = await readEntries(project);
	assert.equal(entry.decision, "refused");
	assert.equal(entry.planPath, `.theta/plans/${planId}.md`);
	assert.equal("rationale" in entry, false, "no rationale flag, no rationale field");
});

test("the citation resolves against disk: a missing plan and a stale revision exit 1, appending nothing", { skip: skipReason }, async (t) => {
	const project = await scratchThetaProject(t);

	// A citation naming no written plan is a usage refusal.
	const missing = runRecorder(
		[
			"--decision", "x",
			"--plan-cite", "2026-01-01-none-such",
			"--revision", planVectorRevision,
			"--verdict", "approved",
		],
		{ cwd: project },
	);
	assert.equal(missing.status, 1, `stderr: ${missing.stderr}`);
	assert.match(missing.stderr, /no plan/);
	assert.match(missing.stderr, /2026-01-01-none-such/);
	assert.equal(missing.stdout, "");

	// A stale citation — the digest of bytes the plan no longer carries —
	// refuses too, naming the revision the plan holds now.
	const write = runRecorder(["--plan-write", "af3-benchmark", "--plan-file", "-"], {
		cwd: project,
		stdin: PLAN_TEXT,
	});
	assert.equal(write.status, 0, `stderr: ${write.stderr}`);
	const planId = planIdToday("af3-benchmark");
	const update = runRecorder(["--plan-update", planId, "--plan-file", "-"], {
		cwd: project,
		stdin: PLAN_REVISED,
	});
	assert.equal(update.status, 0, `stderr: ${update.stderr}`);
	const stale = runRecorder(
		[
			"--decision", "x",
			"--plan-cite", planId,
			"--revision", revisionOf(PLAN_TEXT),
			"--verdict", "approved",
		],
		{ cwd: project },
	);
	assert.equal(stale.status, 1);
	assert.match(stale.stderr, /stale/);
	assert.ok(
		stale.stderr.includes(revisionOf(PLAN_REVISED)),
		"stderr names the plan's current revision",
	);
	assert.equal(stale.stdout, "");
	// Neither refusal appended anything: the notebook does not even exist.
	assert.equal(
		existsSync(path.join(project, ".theta", "notebook.jsonl")),
		false,
		"appended nothing",
	);

	// Citing the revision the plan holds now records the decision — the
	// positive control names the citation, not only the exit.
	const fresh = runRecorder(
		[
			"--decision", "x",
			"--plan-cite", planId,
			"--revision", revisionOf(PLAN_REVISED),
			"--verdict", "approved",
		],
		{ cwd: project },
	);
	assert.equal(fresh.status, 0, `stderr: ${fresh.stderr}`);
	assert.equal(
		fresh.stdout.trimEnd().split("\n")[1],
		`# plan: .theta/plans/${planId}.md revision ${revisionOf(PLAN_REVISED)} approved`,
	);
});

test("--plan-decision reads the latest citing decision per plan path and revision", { skip: skipReason }, async (t) => {
	const project = await scratchThetaProject(t);
	const write = runRecorder(["--plan-write", "af3-benchmark", "--plan-file", "-"], {
		cwd: project,
		stdin: PLAN_TEXT,
	});
	assert.equal(write.status, 0, `stderr: ${write.stderr}`);
	const planId = planIdToday("af3-benchmark");
	const r1 = revisionOf(PLAN_TEXT);

	const approve = runRecorder(
		["--decision", "Approve v1", "--plan-cite", planId, "--revision", r1, "--verdict", "approved"],
		{ cwd: project },
	);
	assert.equal(approve.status, 0, `stderr: ${approve.stderr}`);

	const update = runRecorder(["--plan-update", planId, "--plan-file", "-"], {
		cwd: project,
		stdin: PLAN_REVISED,
	});
	assert.equal(update.status, 0, `stderr: ${update.stderr}`);
	const r2 = revisionOf(PLAN_REVISED);

	const refuse = runRecorder(
		[
			"--decision", "Refuse v2 — the controls are misstated",
			"--plan-cite", planId,
			"--revision", r2,
			"--verdict", "refused",
			"--rationale", "Revision dropped the negative-control arm",
		],
		{ cwd: project },
	);
	assert.equal(refuse.status, 0, `stderr: ${refuse.stderr}`);

	// The latest decision for each revision: the refusal for the current
	// one, the approval for the superseded one.
	const readR1 = runRecorder(["--plan-decision", planId, "--revision", r1], { cwd: project });
	assert.equal(readR1.status, 0, `stderr: ${readR1.stderr}`);
	assert.equal(
		readR1.stdout.trimEnd(),
		`decision approved for .theta/plans/${planId}.md revision ${r1} (dec-0001)`,
	);
	const readR2 = runRecorder(["--plan-decision", planId, "--revision", r2], { cwd: project });
	assert.equal(readR2.status, 0, `stderr: ${readR2.stderr}`);
	assert.equal(
		readR2.stdout.trimEnd(),
		`decision refused for .theta/plans/${planId}.md revision ${r2} (dec-0002)`,
	);

	// --json carries the entry itself; the notebook's own last line is it.
	const readJson = runRecorder(["--plan-decision", planId, "--revision", r2, "--json"], {
		cwd: project,
	});
	assert.equal(readJson.status, 0, `stderr: ${readJson.stderr}`);
	const entries = await readEntries(project);
	assert.deepEqual(JSON.parse(readJson.stdout), {
		planPath: `.theta/plans/${planId}.md`,
		planRevision: r2,
		latest: entries[1],
	});

	// The latest decision wins: a later entry for the same revision
	// supersedes the earlier one on read — a first-match reader would
	// answer the refusal here.
	const restated = runRecorder(
		[
			"--decision", "Approve v2 once the controls were restated",
			"--plan-cite", planId,
			"--revision", r2,
			"--verdict", "approved",
		],
		{ cwd: project },
	);
	assert.equal(restated.status, 0, `stderr: ${restated.stderr}`);
	const readLatest = runRecorder(["--plan-decision", planId, "--revision", r2], {
		cwd: project,
	});
	assert.equal(readLatest.status, 0, `stderr: ${readLatest.stderr}`);
	assert.equal(
		readLatest.stdout.trimEnd(),
		`decision approved for .theta/plans/${planId}.md revision ${r2} (dec-0003)`,
	);

	// A revision no decision cites: the clear no-decision report, JSON
	// latest null — and the read op never needed the plan file on disk.
	await rm(path.join(project, ".theta", "plans", `${planId}.md`));
	const none = runRecorder(["--plan-decision", planId, "--revision", "0".repeat(12)], {
		cwd: project,
	});
	assert.equal(none.status, 0, `stderr: ${none.stderr}`);
	assert.equal(
		none.stdout.trimEnd(),
		`no decision for .theta/plans/${planId}.md revision 000000000000`,
	);
	const noneJson = runRecorder(
		["--plan-decision", planId, "--revision", "0".repeat(12), "--json"],
		{ cwd: project },
	);
	assert.deepEqual(JSON.parse(noneJson.stdout), {
		planPath: `.theta/plans/${planId}.md`,
		planRevision: "000000000000",
		latest: null,
	});
});

test("citation-flag pairing errors exit 1 and write nothing", { skip: skipReason }, async (t) => {
	// Each case names the stderr that discriminates it (the
	// connector-scripts invariant): the refusal is this one, not any
	// non-empty stderr.
	const cases = [
		{ name: "citation flags on a method", args: ["--method", "x", "--plan-cite", planDecisionPlanId, "--revision", planVectorRevision, "--verdict", "approved"], err: "only accepted with --decision" },
		{ name: "--verdict without --plan-cite", args: ["--decision", "x", "--verdict", "approved"], err: "--plan-cite is required with" },
		{ name: "--revision without --plan-cite", args: ["--decision", "x", "--revision", planVectorRevision], err: "--plan-cite is required with" },
		{ name: "--rationale without --plan-cite", args: ["--decision", "x", "--rationale", "why"], err: "--plan-cite is required with" },
		{ name: "citation without --revision", args: ["--decision", "x", "--plan-cite", planDecisionPlanId, "--verdict", "approved"], err: "requires --revision" },
		{ name: "citation without --verdict", args: ["--decision", "x", "--plan-cite", planDecisionPlanId, "--revision", planVectorRevision], err: "requires --verdict" },
		{ name: "revision short of 12 hex", args: ["--decision", "x", "--plan-cite", planDecisionPlanId, "--revision", "c6f6084b0e5", "--verdict", "approved"], err: "12 lowercase hex" },
		{ name: "revision uppercase", args: ["--decision", "x", "--plan-cite", planDecisionPlanId, "--revision", "C6F6084B0E5F", "--verdict", "approved"], err: "12 lowercase hex" },
		{ name: "citation with a malformed plan-id", args: ["--decision", "x", "--plan-cite", "af3-benchmark", "--revision", planVectorRevision, "--verdict", "approved"], err: "plan ids are <YYYY-MM-DD>-<slug>" },
		{ name: "blank rationale", args: ["--decision", "x", "--plan-cite", planDecisionPlanId, "--revision", planVectorRevision, "--verdict", "approved", "--rationale", "   "], err: "--rationale must be non-empty" },
		{ name: "verdict outside the choices", args: ["--decision", "x", "--plan-cite", planDecisionPlanId, "--revision", planVectorRevision, "--verdict", "pending"], err: "invalid choice" },
		{ name: "--revision beside --plan-write", args: ["--plan-write", "af3-benchmark", "--plan-file", "-", "--revision", planVectorRevision], stdin: PLAN_TEXT, err: "--revision is only accepted with" },
		{ name: "--plan-cite beside --plan-write", args: ["--plan-write", "af3-benchmark", "--plan-file", "-", "--plan-cite", planDecisionPlanId], stdin: PLAN_TEXT, err: "--plan-cite is not accepted with --plan-write" },
		{ name: "--plan-file with --plan-decision", args: ["--plan-decision", planDecisionPlanId, "--revision", planVectorRevision, "--plan-file", "-"], stdin: PLAN_TEXT, err: "--plan-file is not accepted with --plan-decision" },
		{ name: "--plan-decision without --revision", args: ["--plan-decision", planDecisionPlanId], err: "--plan-decision requires --revision" },
		{ name: "--plan-decision beside an entry type", args: ["--decision", "x", "--plan-decision", planDecisionPlanId], err: "one operation per call" },
		{ name: "--plan-decision with a malformed plan-id", args: ["--plan-decision", "af3-benchmark", "--revision", planVectorRevision], err: "plan ids are <YYYY-MM-DD>-<slug>" },
		{ name: "--verdict beside --plan-decision", args: ["--plan-decision", planDecisionPlanId, "--revision", planVectorRevision, "--verdict", "approved"], err: "--verdict is not accepted with --plan-decision" },
		{ name: "--rationale beside --plan-decision", args: ["--plan-decision", planDecisionPlanId, "--revision", planVectorRevision, "--rationale", "why"], err: "--rationale is not accepted with --plan-decision" },
		{ name: "--plan-cite beside --plan-decision", args: ["--plan-decision", planDecisionPlanId, "--revision", planVectorRevision, "--plan-cite", planDecisionPlanId], err: "--plan-cite is not accepted with --plan-decision" },
		{ name: "decision-read revision uppercase", args: ["--plan-decision", planDecisionPlanId, "--revision", "C6F6084B0E5F"], err: "12 lowercase hex" },
		// A `$` anchor also sits before a trailing newline under `match`; the
		// citation grammars are fullmatch, so a value carrying one refuses
		// instead of passing the shape check and then matching nothing.
		{ name: "plan-cite with a trailing newline", args: ["--decision", "x", "--plan-cite", `${planDecisionPlanId}\n`, "--revision", planVectorRevision, "--verdict", "approved"], err: "plan ids are <YYYY-MM-DD>-<slug>" },
		{ name: "citation revision with a trailing newline", args: ["--decision", "x", "--plan-cite", planDecisionPlanId, "--revision", `${planVectorRevision}\n`, "--verdict", "approved"], err: "12 lowercase hex" },
		{ name: "decision-read plan-id with a trailing newline", args: ["--plan-decision", `${planDecisionPlanId}\n`, "--revision", planVectorRevision], err: "plan ids are <YYYY-MM-DD>-<slug>" },
		{ name: "decision-read revision with a trailing newline", args: ["--plan-decision", planDecisionPlanId, "--revision", `${planVectorRevision}\n`], err: "12 lowercase hex" },
	];
	for (const { name, args, stdin, err } of cases) {
		const project = await scratchProject(t);
		const run = runRecorder(args, { cwd: project, stdin });
		assert.equal(run.status, 1, `${name}: should exit 1 (stderr: ${run.stderr})`);
		assert.ok(run.stderr.includes(err), `${name}: stderr names the refusal (${err})`);
		assert.equal(run.stdout, "", `${name}: no stdout on failure`);
		assert.deepEqual(await readdir(project), [], `${name}: wrote nothing`);
	}
});

test("the shared grammar fixture: the recorder reads it back and ids sequence past it", { skip: skipReason }, async (t) => {
	const project = await scratchProject(t);
	await mkdir(path.join(project, ".theta"));
	await writeFile(
		path.join(project, ".theta", "notebook.jsonl"),
		`${(await readFile(planDecisionFixture, "utf8")).trimEnd()}\n`,
		"utf8",
	);

	// The reader consumes the committed line as-is: the latest decision for
	// the cited path and revision is the fixture entry, shape-equal — and
	// the read op never needed the plan object on disk.
	const read = runRecorder(
		["--plan-decision", planDecisionPlanId, "--revision", planVectorRevision],
		{ cwd: project },
	);
	assert.equal(read.status, 0, `stderr: ${read.stderr}`);
	assert.equal(
		read.stdout.trimEnd(),
		`decision approved for .theta/plans/${planDecisionPlanId}.md revision ${planVectorRevision} (dec-0001)`,
	);
	const readJson = runRecorder(
		["--plan-decision", planDecisionPlanId, "--revision", planVectorRevision, "--json"],
		{ cwd: project },
	);
	assert.equal(readJson.status, 0, `stderr: ${readJson.stderr}`);
	assert.deepEqual(JSON.parse(readJson.stdout), {
		planPath: `.theta/plans/${planDecisionPlanId}.md`,
		planRevision: planVectorRevision,
		latest: JSON.parse(await readFile(planDecisionFixture, "utf8")),
	});
	assert.deepEqual(await readdir(path.join(project, ".theta")), ["notebook.jsonl"]);

	// The recorder sequences past the fixture's id: the next decision is
	// dec-0002.
	const next = runRecorder(["--decision", DECISION], { cwd: project });
	assert.equal(next.status, 0, `stderr: ${next.stderr}`);
	const entries = await readEntries(project);
	assert.deepEqual(entries.map((entry) => entry.id), ["dec-0001", "dec-0002"]);
});

test("the decision read skips lines that are not citing decisions", { skip: skipReason }, async (t) => {
	// The reader holds the TS validator's two citation bars: a decision
	// entry carrying a verdict. A citation on another entry type, or a
	// citing decision with no verdict (hand edits the recorder never
	// writes), matches no query — they sit after the fixture line, so a
	// reader that ignored the type or the verdict would answer one of them.
	// The validator's wider entry grammar (ids, dates, the rationale's
	// shape) is not this read's.
	const project = await scratchProject(t);
	await mkdir(path.join(project, ".theta"));
	const fixtureLine = (await readFile(planDecisionFixture, "utf8")).trimEnd();
	const notCiting = [
		JSON.stringify({
			id: "mth-0001",
			type: "method",
			date: "2026-11-18",
			text: "x",
			planPath: `.theta/plans/${planDecisionPlanId}.md`,
			planRevision: planVectorRevision,
			decision: "approved",
		}),
		JSON.stringify({
			id: "dec-0002",
			type: "decision",
			date: "2026-11-18",
			text: "x",
			planPath: `.theta/plans/${planDecisionPlanId}.md`,
			planRevision: planVectorRevision,
		}),
	];
	await writeFile(
		path.join(project, ".theta", "notebook.jsonl"),
		`${[fixtureLine, ...notCiting].join("\n")}\n`,
		"utf8",
	);

	const read = runRecorder(
		["--plan-decision", planDecisionPlanId, "--revision", planVectorRevision],
		{ cwd: project },
	);
	assert.equal(read.status, 0, `stderr: ${read.stderr}`);
	assert.equal(
		read.stdout.trimEnd(),
		`decision approved for .theta/plans/${planDecisionPlanId}.md revision ${planVectorRevision} (dec-0001)`,
	);
});

test("a corrupt notebook exits 2 on the decision read too, before any answer", { skip: skipReason }, async (t) => {
	const project = await scratchProject(t);
	await mkdir(path.join(project, ".theta"));
	await writeFile(path.join(project, ".theta", "notebook.jsonl"), "this is not json\n", "utf8");

	const run = runRecorder(
		["--plan-decision", planDecisionPlanId, "--revision", planVectorRevision],
		{ cwd: project },
	);
	assert.equal(run.status, 2);
	assert.match(run.stderr, /not JSON/);
	assert.equal(run.stdout, "");
});

test("an unreadable plan file exits 2 on the citation path", { skip: skipReason }, async (t) => {
	const project = await scratchThetaProject(t);
	const write = runRecorder(["--plan-write", "af3-benchmark", "--plan-file", "-"], {
		cwd: project,
		stdin: PLAN_TEXT,
	});
	assert.equal(write.status, 0, `stderr: ${write.stderr}`);
	const planId = planIdToday("af3-benchmark");
	await chmod(planPath(project, planId), 0o000);

	// A plan the recorder cannot read is a notebook failure (exit 2), the
	// code --plan-read and --plan-update take on the same bytes — not a
	// usage error, and never an entry.
	const run = runRecorder(
		[
			"--decision", "x",
			"--plan-cite", planId,
			"--revision", revisionOf(PLAN_TEXT),
			"--verdict", "approved",
		],
		{ cwd: project },
	);
	assert.equal(run.status, 2, `stderr: ${run.stderr}`);
	assert.match(run.stderr, /cannot read/);
	assert.equal(run.stdout, "");
	assert.equal(
		existsSync(path.join(project, ".theta", "notebook.jsonl")),
		false,
		"appended nothing",
	);
});

test("a citing decision may carry evidence too; the footer names the plan first", { skip: skipReason }, async (t) => {
	const project = await scratchThetaProject(t);
	const write = runRecorder(["--plan-write", "af3-benchmark", "--plan-file", "-"], {
		cwd: project,
		stdin: PLAN_TEXT,
	});
	assert.equal(write.status, 0, `stderr: ${write.stderr}`);
	const planId = planIdToday("af3-benchmark");

	const run = runRecorder(
		[
			"--decision", DECISION,
			"--evidence", evidenceFixture,
			"--grade", "asserted",
			"--plan-cite", planId,
			"--revision", revisionOf(PLAN_TEXT),
			"--verdict", "refused",
		],
		{ cwd: project },
	);
	assert.equal(run.status, 0, `stderr: ${run.stderr}`);
	const lines = run.stdout.trimEnd().split("\n");
	assert.equal(lines.length, 4);
	assert.equal(
		lines[1],
		`# plan: .theta/plans/${planId}.md revision ${revisionOf(PLAN_TEXT)} refused`,
	);
	assert.ok(lines[2].includes("pubmed"), "the evidence footer follows the plan line");
	const [entry] = await readEntries(project);
	assert.equal(entry.decision, "refused");
	assert.equal(entry.evidence[0].source, "pubmed");
});
