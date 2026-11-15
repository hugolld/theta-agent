#!/usr/bin/env node
// The benchmark grader's objective half (spec #135, ADR 0007):
// workspace-as-oracle checks, executed against the task workspace the
// session ran in. Pure Node — node:fs only — because it runs
// in-container from the clone (`node test/eval/bench-grade.mjs ...`),
// where no node_modules exists; the pi package is never importable
// here by design. The subjective half (classify()) and the report
// merge live host-side in test/eval/bench-report.mjs.
//
//   node test/eval/bench-grade.mjs <task-id> <workspace-root> <out-json>
//
// The grader's exit code says whether it GRADED, never whether the
// task passed: a task grade is report data, and the leg's own failure
// contract rides the rig's exit-status machinery. The machine-readable
// result lands as a file (the exit-status rule) because its output
// channel may carry payload text.

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { benchTaskById } from "./bench-tasks.mjs";

// The check kinds the grader executes. A new kind is a decision that
// lands with its executor and its test in the same strike; an unknown
// kind in the task list refuses here, loudly, rather than passing
// silently as a no-op.
const CHECK_KINDS = new Set(["file", "notebook-entry", "file-match"]);

// One check, one result: { id, kind, pass, detail } — detail carries
// the refusal reason on failure and never the entry text (the report
// step reads the matched entry from `matched` when the judge needs it).
function checkFile(check, workspaceRoot) {
	const target = path.join(workspaceRoot, check.path);
	if (!existsSync(target)) return { pass: false, detail: `missing: ${check.path}` };
	return { pass: true, detail: `present: ${check.path}` };
}

// The notebook-entry check: the notebook parses as JSON lines, and at
// least one entry matches the declared type, id prefix, and text
// needles — every candidate is examined, so a faithful entry later in
// an append-only notebook rescues the check after a wrong one. The
// matched entry is returned separately — the classify judge's state
// input, not a stringly echo.
//
// The evidence clause (`evidenceSnapshot: true`, spec #136): the entry
// must stand on the recorder's stored snapshot — `evidence[0].snapshot`
// resolved beside the notebook (`.theta/`, the recorder's own root), so
// a decoy at the workspace root cannot satisfy it. The clause rides the
// candidate scan: an entry that fails it does not end the scan, and the
// failure names the clause.
function checkNotebookEntry(check, workspaceRoot, matched) {
	const target = path.join(workspaceRoot, check.path);
	if (!existsSync(target)) return { pass: false, detail: `missing: ${check.path}` };
	let lines;
	try {
		lines = readFileSync(target, "utf8").split("\n").filter((line) => line.trim() !== "");
	} catch (error) {
		return { pass: false, detail: `unreadable: ${error.message}` };
	}
	const entries = [];
	for (const [index, line] of lines.entries()) {
		try {
			entries.push(JSON.parse(line));
		} catch {
			return { pass: false, detail: `line ${index + 1} is not JSON` };
		}
	}
	const candidates = entries.filter((entry) => entry?.type === check.type);
	if (candidates.length === 0) {
		return { pass: false, detail: `no ${check.type} entry in ${entries.length} parsed entries` };
	}
	const snapshotRoot = path.dirname(target); // the recorder's snapshot root (.theta/)
	let needleMisses = [];
	let snapshotWanted = "";
	for (const entry of candidates) {
		if (typeof entry.id !== "string" || !entry.id.startsWith(check.idPrefix)) continue;
		// Needles match case-insensitively over the entry's text field —
		// the field the recorder owns; structure elsewhere is not prose.
		const haystack = String(entry.text ?? "").toLowerCase();
		needleMisses = check.textIncludes.filter((needle) => !haystack.includes(needle.toLowerCase()));
		if (needleMisses.length > 0) continue;
		if (check.evidenceSnapshot) {
			const snapshot = entry.evidence?.[0]?.snapshot;
			if (typeof snapshot !== "string" || !existsSync(path.join(snapshotRoot, snapshot))) {
				snapshotWanted = typeof snapshot === "string" ? snapshot : "(no evidence item)";
				continue;
			}
		}
		matched[check.id] = entry;
		return {
			pass: true,
			detail: `${entry.id} matches type, prefix, and text needles${check.evidenceSnapshot ? " with its evidence snapshot present" : ""}`,
		};
	}
	if (snapshotWanted) {
		return {
			pass: false,
			detail: `every text-matching ${check.type} entry misses its evidence snapshot (last looked for: ${snapshotWanted})`,
		};
	}
	if (needleMisses.length > 0) {
		return { pass: false, detail: `every ${check.type} entry with prefix ${check.idPrefix} misses text needles: ${needleMisses.join(", ")}` };
	}
	return {
		pass: false,
		detail: `no ${check.type} entry with id prefix ${check.idPrefix} among ${entries.length} parsed entries`,
	};
}

// The file-match check (spec #136): the staged artifact, found by shape.
// Globs walk the whole workspace — the session chooses the path, the
// check finds the file — and every matched file's text must carry the
// needles; pass on the first match that does. The walk is a plain
// recursive readdir (the task workspace is small and plain).
export function globMatches(glob, relPath) {
	// Segment-wise: "**" spans zero or more directories (absorbing its
	// own slash), "*" matches within one segment, "?" takes one
	// character. Anchored at both ends; nothing else in a glob is a
	// wildcard.
	const segments = glob.split("/");
	let pattern = "^";
	for (const [index, segment] of segments.entries()) {
		const last = index === segments.length - 1;
		if (segment === "**") {
			if (last) {
				pattern += ".+";
				continue;
			}
			pattern += "(?:[^/]+/)*";
			continue; // the ** segment carries its own slash; no join
		}
		pattern += segment
			.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
			.replace(/\\\*/g, "[^/]*")
			.replace(/\\\?/g, "[^/]");
		if (!last) pattern += "/";
	}
	return new RegExp(`${pattern}$`).test(relPath);
}

function checkFileMatch(check, workspaceRoot) {
	const files = readdirSync(workspaceRoot, { recursive: true }).filter((rel) => statSync(path.join(workspaceRoot, rel)).isFile());
	const hits = files.filter((rel) => check.globs.some((glob) => globMatches(glob, rel))).sort();
	if (hits.length === 0) {
		return { pass: false, detail: `no file matches ${JSON.stringify(check.globs)}` };
	}
	for (const rel of hits) {
		let text;
		try {
			text = readFileSync(path.join(workspaceRoot, rel), "utf8").toLowerCase();
		} catch {
			continue;
		}
		const missing = check.textIncludes.filter((needle) => !text.includes(needle.toLowerCase()));
		if (missing.length === 0) {
			return { pass: true, detail: `${rel} matches and carries the needles` };
		}
	}
	return { pass: false, detail: `${hits.length} matched file(s) but all miss text needles: ${check.textIncludes.join(", ")}` };
}

// The pure grading core (pinned by bench-grade.test.mjs): runs the
// task's declarative checks against the workspace, returning the
// result rows and the matched-entry map the judge consumes. Unknown
// check kinds refuse loudly — a typo in the task list must never grade
// as a silent pass.
export function gradeWorkspace(task, workspaceRoot) {
	const results = [];
	const matched = {};
	for (const check of task.checks) {
		if (!CHECK_KINDS.has(check.kind)) {
			throw new Error(`unknown check kind: ${check.kind} (check ${check.id} in task ${task.id})`);
		}
		const outcome =
			check.kind === "file"
				? checkFile(check, workspaceRoot)
				: check.kind === "notebook-entry"
					? checkNotebookEntry(check, workspaceRoot, matched)
					: checkFileMatch(check, workspaceRoot);
		results.push({ id: check.id, kind: check.kind, pass: outcome.pass, detail: outcome.detail });
	}
	return { task: task.id, checks: results, matched };
}

function main() {
	const [taskId, workspaceRoot, outFile] = process.argv.slice(2);
	if (!taskId || !workspaceRoot || !outFile) {
		console.log("usage: bench-grade.mjs <task-id> <workspace-root> <out-json>");
		process.exit(process.argv.length > 2 ? 1 : 0);
	}
	let task;
	try {
		task = benchTaskById(taskId);
	} catch (error) {
		console.error(`bench-grade: ${error.message}`);
		process.exit(1);
	}
	if (!existsSync(workspaceRoot)) {
		console.error(`bench-grade: no workspace at ${workspaceRoot}`);
		process.exit(1);
	}
	let graded;
	try {
		graded = gradeWorkspace(task, workspaceRoot);
	} catch (error) {
		console.error(`bench-grade: ${error.message}`);
		process.exit(1);
	}
	mkdirSync(path.dirname(outFile), { recursive: true });
	writeFileSync(outFile, `${JSON.stringify(graded, null, "\t")}\n`);
	const failed = graded.checks.filter((check) => !check.pass).map((check) => check.id);
	console.log(`bench-grade: ${failed.length === 0 ? "all objective checks pass" : `failed: ${failed.join(", ")}`}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main();
}
