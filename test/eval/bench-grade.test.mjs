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
