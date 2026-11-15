// Pins the workspace-oracle grader (spec #135): golden workspaces grade
// by name — a passing notebook, a missing notebook, a wrong entry type,
// a missing text needle, a corrupt line — and the CLI writes its
// machine-readable result as a file with an exit code that says whether
// it graded, never whether the task passed.

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { gradeWorkspace } from "./bench-grade.mjs";
import { benchTaskById } from "./bench-tasks.mjs";

const task = benchTaskById("provenance-decision");

// One golden workspace per test, under a fresh tmp dir.
function workspaceWith(notebookLines) {
	const root = mkdtempSync(path.join(tmpdir(), "bench-grade-"));
	if (notebookLines !== null) {
		mkdirSync(path.join(root, ".theta"), { recursive: true });
		writeFileSync(path.join(root, ".theta/notebook.jsonl"), notebookLines.join("\n") + "\n");
	}
	return root;
}

const goodEntry = {
	id: "dec-0001",
	type: "decision",
	date: "2026-11-15",
	text: "Sequence the confirmatory cohort with long-read sequencing instead of short reads, starting with the March batch.",
};

test("a recorded decision passes every objective check and is captured for the judge", () => {
	const root = workspaceWith([JSON.stringify(goodEntry)]);
	try {
		const graded = gradeWorkspace(task, root);
		assert.deepEqual(
			graded.checks.map((c) => [c.id, c.pass]),
			[
				["notebook-written", true],
				["decision-entry", true],
			],
		);
		assert.deepEqual(graded.matched["decision-entry"], goodEntry, "the matched entry feeds the judge");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a missing notebook fails the file check by name", () => {
	const root = workspaceWith(null);
	try {
		const graded = gradeWorkspace(task, root);
		const fileCheck = graded.checks.find((c) => c.id === "notebook-written");
		assert.equal(fileCheck.pass, false);
		assert.match(fileCheck.detail, /missing: \.theta\/notebook\.jsonl/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a notebook without a decision entry fails the entry check by name", () => {
	const root = workspaceWith([JSON.stringify({ id: "hyp-0001", type: "hypothesis", date: "2026-11-15", text: "long-read sequencing" })]);
	try {
		const graded = gradeWorkspace(task, root);
		const entryCheck = graded.checks.find((c) => c.id === "decision-entry");
		assert.equal(entryCheck.pass, false);
		assert.match(entryCheck.detail, /no decision entry/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a decision entry that misses the text needles fails by name", () => {
	const root = workspaceWith([JSON.stringify({ ...goodEntry, text: "We changed our mind about the pipeline." })]);
	try {
		const graded = gradeWorkspace(task, root);
		const entryCheck = graded.checks.find((c) => c.id === "decision-entry");
		assert.equal(entryCheck.pass, false);
		assert.match(entryCheck.detail, /misses text needles: long-read/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a faithful entry later in the notebook rescues the check after a wrong one", () => {
	// The scan examines every candidate: an append-only notebook may hold
	// a stray decision before the faithful one, and the first candidate's
	// needle miss must not end the scan (the review round's finding).
	const stray = { ...goodEntry, id: "dec-0001", text: "We renamed the freezer." };
	const faithful = { ...goodEntry, id: "dec-0002" };
	const root = workspaceWith([JSON.stringify(stray), JSON.stringify(faithful)]);
	try {
		const graded = gradeWorkspace(task, root);
		const entryCheck = graded.checks.find((c) => c.id === "decision-entry");
		assert.equal(entryCheck.pass, true);
		assert.deepEqual(graded.matched["decision-entry"], faithful);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a corrupt notebook line fails the entry check without grading the rest", () => {
	const root = workspaceWith(["{not json", JSON.stringify(goodEntry)]);
	try {
		const graded = gradeWorkspace(task, root);
		const entryCheck = graded.checks.find((c) => c.id === "decision-entry");
		assert.equal(entryCheck.pass, false);
		assert.match(entryCheck.detail, /line 1 is not JSON/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("an unknown check kind refuses loudly instead of passing silently", () => {
	const root = workspaceWith([JSON.stringify(goodEntry)]);
	try {
		assert.throws(
			() => gradeWorkspace({ ...task, checks: [{ id: "x", kind: "prose" }] }, root),
			/unknown check kind: prose/,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("the CLI grades into a report file and exits 0 whether or not the task passed", () => {
	const root = workspaceWith(null); // the task will fail — the grader still grades
	const outDir = mkdtempSync(path.join(tmpdir(), "bench-out-"));
	try {
		const graded = spawnSync(
			"node",
			[path.join(import.meta.dirname, "bench-grade.mjs"), task.id, root, path.join(outDir, "grades.json")],
			{ encoding: "utf8" },
		);
		assert.equal(graded.status, 0, `grader exited non-zero: ${graded.stderr}`);
		const written = JSON.parse(readFileSync(path.join(outDir, "grades.json"), "utf8"));
		assert.equal(written.task, task.id);
		assert.ok(written.checks.some((c) => c.pass === false), "the failed task's grade records the failure");
		assert.match(graded.stdout, /failed: notebook-written/);
	} finally {
		rmSync(root, { recursive: true, force: true });
		rmSync(outDir, { recursive: true, force: true });
	}
});

test("the CLI refuses an unknown task id with exit 1", () => {
	const outDir = mkdtempSync(path.join(tmpdir(), "bench-out-"));
	try {
		const graded = spawnSync(
			"node",
			[path.join(import.meta.dirname, "bench-grade.mjs"), "no-such-task", outDir, path.join(outDir, "g.json")],
			{ encoding: "utf8" },
		);
		assert.equal(graded.status, 1);
		assert.match(graded.stderr, /unknown benchmark task id/);
	} finally {
		rmSync(outDir, { recursive: true, force: true });
	}
});

// The spec #136 grader surface: the notebook evidence clause and the
// file-match kind — the literature-triage recipe grades the provenance
// chain (a kept observation must stand on a stored snapshot), and the
// compute-staging recipe grades the staged artifacts by shape, wherever
// the session chose to put them.

const litTask = benchTaskById("lit-triage");
const stagedTask = benchTaskById("compute-staging");

function obsEntry(snapshot) {
	return {
		id: "obs-0001",
		type: "observation",
		date: "2026-11-15",
		text: "A primary study reports that plasma proteomics samples degrade measurably when storage temperature rises above the standard cold chain.",
		grade: "asserted",
		evidence: [
			{
				source: "pubmed",
				endpoints: ["esearch.fcgi", "esummary.fcgi"],
				query: "storage temperature plasma proteomics",
				retrieved: "2026-11-15",
				grade: "asserted",
				snapshot,
			},
		],
	};
}

function evidenceWorkspace(entry, snapshotPresent) {
	const root = mkdtempSync(path.join(tmpdir(), "bench-grade-"));
	mkdirSync(path.join(root, ".theta"), { recursive: true });
	writeFileSync(path.join(root, ".theta/notebook.jsonl"), `${JSON.stringify(entry)}\n`);
	if (snapshotPresent) {
		mkdirSync(path.join(root, ".theta/evidence"), { recursive: true });
		writeFileSync(path.join(root, ".theta/evidence/abc123.json"), '{"query":"storage temperature plasma proteomics"}\n');
	}
	return root;
}

test("a kept observation standing on a stored snapshot passes the evidence clause and feeds the judge", () => {
	const root = evidenceWorkspace(obsEntry("evidence/abc123.json"), true);
	try {
		const graded = gradeWorkspace(litTask, root);
		const check = graded.checks.find((c) => c.id === "triage-entry");
		assert.equal(check.pass, true);
		assert.deepEqual(graded.matched["triage-entry"], obsEntry("evidence/abc123.json"), "the matched entry feeds the judge");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a kept observation without its snapshot fails the evidence clause by name", () => {
	const root = evidenceWorkspace(obsEntry("evidence/abc123.json"), false);
	try {
		const graded = gradeWorkspace(litTask, root);
		const check = graded.checks.find((c) => c.id === "triage-entry");
		assert.equal(check.pass, false);
		assert.match(check.detail, /evidence snapshot/);
		assert.equal(graded.matched["triage-entry"], undefined, "nothing to judge when the clause fails");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("an entry whose snapshot exists rescues the check after one without", () => {
	// The clause rides the candidate scan: a matching entry that fails the
	// clause must not end it — an append-only notebook may hold a stray
	// observation before the faithful one.
	const stray = obsEntry("evidence/deadbeef.json");
	const root = evidenceWorkspace(stray, false);
	mkdirSync(path.join(root, ".theta"), { recursive: true });
	writeFileSync(path.join(root, ".theta/notebook.jsonl"), `${JSON.stringify(stray)}\n${JSON.stringify(obsEntry("evidence/abc123.json"))}\n`);
	mkdirSync(path.join(root, ".theta/evidence"), { recursive: true });
	writeFileSync(path.join(root, ".theta/evidence/abc123.json"), "{}\n");
	try {
		const graded = gradeWorkspace(litTask, root);
		assert.equal(graded.checks.find((c) => c.id === "triage-entry").pass, true);
		assert.equal(graded.matched["triage-entry"].id, "obs-0001");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("the snapshot path resolves beside the notebook, not beside the workspace root", () => {
	// The recorder stores snapshots relative to .theta/ — the grader
	// resolves the clause the way the recorder writes it.
	const root = evidenceWorkspace(obsEntry("evidence/abc123.json"), false);
	mkdirSync(path.join(root, ".theta/evidence"), { recursive: true });
	// A decoy at the wrong root: workspace-root/evidence/ must not satisfy
	// the clause — only .theta/evidence/ does.
	mkdirSync(path.join(root, "evidence"), { recursive: true });
	writeFileSync(path.join(root, "evidence/abc123.json"), "{}\n");
	try {
		const graded = gradeWorkspace(litTask, root);
		assert.equal(graded.checks.find((c) => c.id === "triage-entry").pass, false, "the decoy must not satisfy the clause");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// The staged workspace: method entry plus the two artifacts, placed in a
// subdirectory the session chose.
function stagedWorkspace({ script, fasta }) {
	const root = mkdtempSync(path.join(tmpdir(), "bench-grade-"));
	mkdirSync(path.join(root, ".theta"), { recursive: true });
	writeFileSync(
		path.join(root, ".theta/notebook.jsonl"),
		`${JSON.stringify({
			id: "mth-0001",
			type: "method",
			date: "2026-11-15",
			text: "Staged an AlphaFold 3 run for the two peptides: job script and sequence input in staging/, submission pending.",
		})}\n`,
	);
	if (script) {
		mkdirSync(path.join(root, "staging"), { recursive: true });
		writeFileSync(path.join(root, "staging/af3-run.sbatch"), "#SBATCH --job-name=af3\n#SBATCH --time=02:00:00\nsbatch runs the prediction\n");
	}
	if (fasta) {
		mkdirSync(path.join(root, "staging"), { recursive: true });
		writeFileSync(path.join(root, "staging/peptides.fasta"), ">peptide_1\nACDEFGHIKLMN\n>peptide_2\nMKTAYIAKQRQISFVK\n");
	}
	return root;
}

test("the staged artifacts are found by shape wherever the session put them", () => {
	const root = stagedWorkspace({ script: true, fasta: true });
	try {
		const graded = gradeWorkspace(stagedTask, root);
		assert.deepEqual(
			graded.checks.filter((c) => c.kind === "file-match").map((c) => [c.id, c.pass]),
			[
				["job-script", true],
				["sequence-input", true],
			],
		);
		assert.deepEqual(graded.matched["method-entry"].id, "mth-0001");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a staged workspace without the script or the input fails the matching check by name", () => {
	const root = stagedWorkspace({ script: false, fasta: true });
	try {
		const graded = gradeWorkspace(stagedTask, root);
		const check = graded.checks.find((c) => c.id === "job-script");
		assert.equal(check.pass, false);
		assert.match(check.detail, /no file matches/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a script without the sbatch directive fails on the needles, naming them", () => {
	const root = stagedWorkspace({ script: true, fasta: false });
	try {
		writeFileSync(path.join(root, "staging/af3-run.sbatch"), "# a plain shell script, no directive\nrun something\n");
		const graded = gradeWorkspace(stagedTask, root);
		const check = graded.checks.find((c) => c.id === "job-script");
		assert.equal(check.pass, false);
		assert.match(check.detail, /miss text needles: sbatch/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("globMatches: ** spans directories, * stays in its segment, ? takes one character", async () => {
	const { globMatches } = await import("./bench-grade.mjs");
	assert.equal(globMatches("**/*.sbatch", "staging/af3-run.sbatch"), true);
	assert.equal(globMatches("**/*.sbatch", "af3-run.sbatch"), true, "** may span zero directories");
	assert.equal(globMatches("**/*.sbatch", "staging/af3-run.sh"), false);
	assert.equal(globMatches("**/*.fa", "x/y.fa"), true);
	assert.equal(globMatches("*.sh", "a/b.sh"), false, "* never crosses a directory separator");
	assert.equal(globMatches("run-?.sh", "run-1.sh"), true);
	assert.equal(globMatches("run-?.sh", "run-12.sh"), false);
});
