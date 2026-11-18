import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { createJiti } from "jiti";
import { tempDir } from "./helpers/temp-dir.mjs";
import { recordedNotify } from "./helpers/recorded-notify.mjs";
import {
	cnfLine,
	decLine,
	hypLine,
	mthJobLine,
	obsLine,
	writeNotebook,
} from "./helpers/notebook-lines.mjs";

// The /notebook command (spec #182, demo doctrine B2): the project
// notebook rendered on demand — entries table, evidence grades, dates —
// through notify only, never a dialog. Loaded through jiti, the loader pi
// runs extensions with; the hand-built notebook lines and write helper
// come from their shared home (helpers/notebook-lines.mjs, the cards
// suite's before this one). The whole-notebook read the command rides is
// the cards extension's exported helper, pinned here beside its command
// consumer: file order, malformed-line refusal, the torn-write tail, the
// absence contract.
const jiti = createJiti(import.meta.url);
const {
	default: registerNotebookCommand,
	createNotebookCommand,
	notebookTable,
	NO_NOTEBOOK_MESSAGE,
} = await jiti.import("../extensions/notebook-command.ts");
const { readNotebookEntries } = await jiti.import("../extensions/notebook-cards.ts");

// --- the harness ------------------------------------------------------------

function tempProject(t) {
	return tempDir(t, "notebook-command-");
}

const notebookFile = (project) => path.join(project, ".theta", "notebook.jsonl");

// --- the table --------------------------------------------------------------

test("the five-entry notebook renders the whole trail, byte-pinned", (t) => {
	const project = tempProject(t);
	writeNotebook(project, [hypLine, obsLine, mthJobLine, decLine, cnfLine]);
	assert.deepEqual(notebookTable(readNotebookEntries(project)), [
		"Theta notebook - 5 entries - grades: 1 asserted, 2 cross-checked, 1 re-executed",
		"hyp-0001  hypothesis   2026-11-18  CRISPR base editing restores immune func...",
		"  pubmed [asserted] retrieved 2026-11-17 via esearch.fcgi, esummary.fcgi",
		"obs-0001  observation  2026-11-18  [cross-checked] Two independent retrieva...",
		"  pubmed [cross-checked] retrieved 2026-11-17 via esearch.fcgi",
		"    supports hyp-0001",
		"mth-0001  method       2026-11-18  AF3 structure prediction run for lysozym...",
		"  theta-compute [re-executed] job 12347 COMPLETED · template alphafold3 · retrieved 2026-11-18",
		"dec-0001  decision     2026-11-18  Run the antibody screen as a two-stage c...",
		"cnf-0001  confidence   2026-11-18  judgment on hyp-0001 - Raised: both stra...",
	]);
});

test("file order is provenance order — the journal is append-only", (t) => {
	const project = tempProject(t);
	writeNotebook(project, [obsLine, hypLine]);
	const rows = notebookTable(readNotebookEntries(project));
	const rowOf = (id) => rows.findIndex((line) => line.startsWith(id));
	assert.ok(rowOf("obs-0001") > 0);
	assert.ok(rowOf("hyp-0001") > rowOf("obs-0001"));
});

test("a trail with no grades carries no grades clause; one entry reads singular", (t) => {
	const project = tempProject(t);
	writeNotebook(project, [decLine]);
	assert.deepEqual(notebookTable(readNotebookEntries(project)), [
		"Theta notebook - 1 entry",
		"dec-0001  decision     2026-11-18  Run the antibody screen as a two-stage c...",
	]);
});

test("an empty notebook renders a zero-count header", () => {
	assert.deepEqual(notebookTable([]), ["Theta notebook - 0 entries"]);
});

test("text longer than the column truncates with an ellipsis; short text passes whole", (t) => {
	const project = tempProject(t);
	writeNotebook(project, [mthJobLine, decLine]);
	const rows = notebookTable(readNotebookEntries(project));
	// 41 characters of method text truncate at the column edge; the
	// 46-character decision text does too — both end in "...".
	assert.ok(rows[1].endsWith("AF3 structure prediction run for lysozym..."));
	assert.ok(rows[rows.length - 1].endsWith("two-stage c..."));
});

// --- the read helper's own contract ------------------------------------------

test("malformed lines skip; the sound rest still renders", (t) => {
	const project = tempProject(t);
	writeNotebook(project, ["{not json", JSON.stringify({ foo: 1 }), decLine, hypLine]);
	assert.deepEqual(
		readNotebookEntries(project).map((entry) => entry.id),
		["dec-0001", "hyp-0001"],
	);
});

test("a torn write's tail stays invisible until its newline lands", (t) => {
	const project = tempProject(t);
	fs.mkdirSync(path.join(project, ".theta"), { recursive: true });
	fs.writeFileSync(notebookFile(project), decLine); // no trailing newline
	assert.deepEqual(readNotebookEntries(project), []);
	fs.appendFileSync(notebookFile(project), "\n"); // the write completes
	assert.deepEqual(
		readNotebookEntries(project).map((entry) => entry.id),
		["dec-0001"],
	);
});

test("a session outside a research project reads absence, not error", (t) => {
	const project = tempProject(t); // no .theta at all
	assert.equal(readNotebookEntries(project), undefined);
});

// --- the handler -------------------------------------------------------------

test("no notebook notifies the absence once, info, never an error", (t) => {
	const project = tempProject(t);
	const { calls, notify } = recordedNotify();
	createNotebookCommand(notify)(project);
	assert.deepEqual(calls, [{ message: NO_NOTEBOOK_MESSAGE, level: "info" }]);
});

test("the table rides one notify — consecutive info notifies replace the status line in place", (t) => {
	// pi's interactive mode draws an info notify as a status text that a
	// following notify overwrites in place, so a table sent line-by-line
	// would collapse to its last line. The whole table rides one message.
	const project = tempProject(t);
	writeNotebook(project, [hypLine, obsLine, mthJobLine, decLine, cnfLine]);
	const { calls, notify } = recordedNotify();
	createNotebookCommand(notify)(project);
	const table = notebookTable(readNotebookEntries(project));
	assert.deepEqual(calls, [{ message: table.join("\n"), level: "info" }]);
});

test("the registered command wires cwd and notify only — a stub context with no dialog methods", async (t) => {
	const project = tempProject(t);
	writeNotebook(project, [decLine]);
	const registered = [];
	registerNotebookCommand({
		registerCommand: (name, options) => registered.push({ name, options }),
	});
	assert.equal(registered.length, 1);
	assert.equal(registered[0].name, "notebook");
	assert.equal(registered[0].options.description, "Show the project notebook: entries, grades, dates");
	const { calls, notify } = recordedNotify();
	// The only UI method this context offers is notify — a dialog call
	// would throw against the stub, the degradation pin.
	const ctx = { cwd: project, ui: { notify } };
	await assert.doesNotReject(() => registered[0].options.handler("", ctx));
	assert.equal(calls.length, 1);
	assert.equal(calls[0].level, "info");
	assert.ok(calls[0].message.includes("dec-0001"));
});
