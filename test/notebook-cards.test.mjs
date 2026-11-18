import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { createJiti } from "jiti";
import { tempDir } from "./helpers/temp-dir.mjs";
import {
	cnfLine,
	decLine,
	hypLine,
	mthJobLine,
	obsLine,
	writeNotebook,
} from "./helpers/notebook-lines.mjs";

// The notebook entry cards (spec #178): the diff hook and the renderer
// mapping, loaded through jiti — the loader pi runs extensions with — and
// driven against a real temp cwd the way skill-pool's suite drives the
// loader. Every failure mode the spec names has a pin here: dedupe on
// re-runs, malformed-line refusal, no-project inertness, the torn-write
// tail, the startup backlog fence, and the reload rebuild from the
// session's own custom entries. The hand-built notebook lines and the
// write helper live in their shared home (helpers/notebook-lines.mjs)
// since the notebook-command suite (#182) became their second caller.
const jiti = createJiti(import.meta.url);
const {
	ENTRY_CUSTOM_TYPE,
	default: registerNotebookCards,
	createNotebookCards,
	cardLines,
	cardModel,
	parseProvenanceEntry,
	plainStyle,
	notebookEntryRenderer,
} = await jiti.import("../extensions/notebook-cards.ts");

// --- the harness ------------------------------------------------------------

function tempProject(t) {
	return tempDir(t, "notebook-cards-");
}

/** The events the handlers see — plausible tool_result / session_start stubs. */
const toolResult = () => ({ type: "tool_result", toolName: "bash", toolCallId: "t1" });
const sessionStart = () => ({ type: "session_start", reason: "reload" });

function makeCards(project) {
	const appended = [];
	const cards = createNotebookCards({
		appendEntry: (customType, data) => appended.push({ customType, data }),
	});
	const fire = () => cards.onToolResult(toolResult(), { cwd: project });
	// The real handler order: session_start opens the session (and re-arms
	// its fence), tool_result follows — every flow test drives both.
	const start = (entries = []) =>
		cards.onSessionStart(sessionStart(), {
			cwd: project,
			sessionManager: { getEntries: () => entries },
		});
	return { cards, appended, fire, start };
}

// --- the diff hook ----------------------------------------------------------

test("a line the recorder appends mid-session earns exactly one card", (t) => {
	const project = tempProject(t);
	const { appended, fire, start } = makeCards(project);
	start(); // the session opens with no notebook — the fence is empty
	fire();
	assert.deepEqual(appended, []);
	writeNotebook(project, [decLine]);
	fire();
	assert.deepEqual(appended, [{ customType: ENTRY_CUSTOM_TYPE, data: { line: decLine } }]);
});

test("an entry recorded in the session's first tool call still cards", (t) => {
	// The recorder's line postdates the session-start read even when no
	// earlier tool call exists — the fence must not swallow it.
	const project = tempProject(t);
	const { appended, fire, start } = makeCards(project);
	start();
	writeNotebook(project, [decLine]);
	fire(); // the session's first and only tool_result so far
	assert.deepEqual(appended, [{ customType: ENTRY_CUSTOM_TYPE, data: { line: decLine } }]);
});

test("re-runs dedupe: the same bytes never card twice", (t) => {
	const project = tempProject(t);
	const { appended, fire, start } = makeCards(project);
	start();
	writeNotebook(project, [decLine]);
	fire();
	fire();
	fire();
	assert.deepEqual(appended, [{ customType: ENTRY_CUSTOM_TYPE, data: { line: decLine } }]);
});

test("an entry appended while a torn write sits in flight waits for its newline", (t) => {
	const project = tempProject(t);
	const { appended, fire, start } = makeCards(project);
	start();
	const file = path.join(project, ".theta", "notebook.jsonl");
	fs.mkdirSync(path.join(project, ".theta"), { recursive: true });
	fs.writeFileSync(file, decLine); // no trailing newline — a write in flight
	fire();
	assert.deepEqual(appended, []); // the torn tail stays invisible
	fs.appendFileSync(file, "\n"); // the write completes
	fire();
	assert.deepEqual(appended, [{ customType: ENTRY_CUSTOM_TYPE, data: { line: decLine } }]);
});

test("malformed lines never append; the sound rest still cards", (t) => {
	const project = tempProject(t);
	const { appended, fire, start } = makeCards(project);
	start();
	writeNotebook(project, [decLine]);
	fire();
	writeNotebook(project, ["{not json", JSON.stringify({ foo: 1 }), obsLine]);
	fire();
	assert.deepEqual(appended.map((a) => a.data.line), [decLine, obsLine]);
});

test("a session outside a research project is inert, never an error", (t) => {
	const project = tempProject(t); // no .theta at all
	const { appended, fire, start } = makeCards(project);
	assert.doesNotThrow(() => {
		start();
		fire();
		writeNotebook(project, [decLine]);
		fire();
	});
	assert.deepEqual(appended, [{ customType: ENTRY_CUSTOM_TYPE, data: { line: decLine } }]);
	fs.mkdirSync(path.join(project, "empty-theta", ".theta"), { recursive: true });
	const bare = createNotebookCards({ appendEntry: () => assert.fail("must not append") });
	bare.onToolResult(toolResult(), { cwd: path.join(project, "empty-theta") });
});

test("the startup backlog fence: lines present at session start never card", (t) => {
	const project = tempProject(t);
	const { appended, fire, start } = makeCards(project);
	writeNotebook(project, [hypLine, decLine]); // recorded by earlier sessions
	start(); // the session opens on the existing notebook — fenced
	fire();
	assert.deepEqual(appended, []);
	writeNotebook(project, [obsLine]); // this session's recorder runs
	fire();
	assert.deepEqual(appended.map((a) => a.data.line), [obsLine]);
});

test("session_start rebuilds the seen-set from the session's own custom entries", (t) => {
	const project = tempProject(t);
	const { cards, appended, fire, start } = makeCards(project);
	start();
	writeNotebook(project, [decLine]);
	fire();
	assert.equal(appended.length, 1);
	const sessionEntries = [
		{ type: "message", message: { role: "user" } },
		{ type: "custom", customType: ENTRY_CUSTOM_TYPE, data: { line: decLine } },
		{ type: "custom", customType: "other-extension", data: { line: decLine } },
	];
	cards.onSessionStart(sessionStart(), {
		cwd: project,
		sessionManager: { getEntries: () => sessionEntries },
	});
	fire(); // the rebuilt set covers the carded line — no duplicate
	assert.equal(appended.length, 1);
	writeNotebook(project, [cnfLine]);
	fire(); // the new line still cards
	assert.deepEqual(appended.map((a) => a.data.line), [decLine, cnfLine]);
});

test("the reload re-arm fences lines that landed while the extension was away", (t) => {
	const project = tempProject(t);
	const { cards, appended, fire, start } = makeCards(project);
	start();
	writeNotebook(project, [decLine]);
	fire();
	// Another session's entry lands; then the extension reloads mid-session.
	writeNotebook(project, [hypLine]);
	cards.onSessionStart(sessionStart(), {
		cwd: project,
		sessionManager: { getEntries: () => [] },
	});
	fire(); // the session-start read fenced the away-time line
	assert.deepEqual(appended, [expectCard(decLine)]);
	writeNotebook(project, [obsLine]);
	fire();
	assert.deepEqual(appended.slice(1), [expectCard(obsLine)]);
});

function expectCard(line) {
	return { customType: ENTRY_CUSTOM_TYPE, data: { line } };
}

test("without a session_start, the first diff is its own backlog fence", (t) => {
	// The floor for a host that never fired session_start: the first diff
	// baselines from its own read, so the backlog never cards there either.
	const project = tempProject(t);
	const { appended, fire } = makeCards(project);
	writeNotebook(project, [hypLine, decLine]);
	fire();
	assert.deepEqual(appended, []);
	writeNotebook(project, [obsLine]);
	fire();
	assert.deepEqual(appended.map((a) => a.data.line), [obsLine]);
});

// --- parseProvenanceEntry: the typed, dated gate ----------------------------

test("each of the five types parses in the recorder's own shapes", () => {
	for (const line of [hypLine, obsLine, mthJobLine, decLine, cnfLine]) {
		const entry = parseProvenanceEntry(line);
		assert.ok(entry !== undefined, `must parse: ${line.slice(0, 60)}…`);
		assert.equal(typeof entry.id, "string");
	}
});

test("the gate refuses every malformed shape", () => {
	const wrongPrefix = JSON.stringify({ ...JSON.parse(decLine), id: "hyp-0001" });
	const badDate = JSON.stringify({ ...JSON.parse(decLine), date: "2026-02-30" });
	const shapeDate = JSON.stringify({ ...JSON.parse(decLine), date: "2026-2-3" });
	const noText = JSON.stringify({ id: "dec-0002", type: "decision", date: "2026-11-18", text: "" });
	const unknownType = JSON.stringify({ id: "x-0001", type: "speculation", date: "2026-11-18", text: "x" });
	const hypWithoutEvidence = JSON.stringify({
		id: "hyp-0002",
		type: "hypothesis",
		date: "2026-11-18",
		text: "x",
	});
	const obsWithoutGrade = JSON.stringify({
		id: "obs-0002",
		type: "observation",
		date: "2026-11-18",
		text: "x",
		evidence: [JSON.parse(obsLine).evidence[0]],
	});
	const cnfWithoutSubject = JSON.stringify({
		id: "cnf-0002",
		type: "confidence",
		date: "2026-11-18",
		text: "x",
	});
	const badGradeItem = JSON.stringify({
		...JSON.parse(hypLine),
		id: "hyp-0003",
		evidence: [{ ...JSON.parse(hypLine).evidence[0], grade: "guaranteed" }],
	});
	for (const line of [
		"not json",
		"[]",
		'"a string"',
		wrongPrefix,
		badDate,
		shapeDate,
		noText,
		unknownType,
		hypWithoutEvidence,
		obsWithoutGrade,
		cnfWithoutSubject,
		badGradeItem,
	]) {
		assert.equal(parseProvenanceEntry(line), undefined, `must refuse: ${line.slice(0, 60)}`);
	}
});

// --- the renderer mapping ---------------------------------------------------

test("the card model maps a typed entry to its card fields", () => {
	const obs = cardModel(parseProvenanceEntry(obsLine));
	assert.equal(obs.id, "obs-0001");
	assert.equal(obs.type, "observation");
	assert.equal(obs.date, "2026-11-18");
	assert.equal(obs.grade, "cross-checked"); // the observation's own grade
	assert.equal(obs.evidence.length, 1);
	assert.equal(obs.evidence[0].grade, "cross-checked");
	assert.equal(obs.evidence[0].supports, "hyp-0001");
	assert.ok(obs.evidence[0].detail.includes("retrieved 2026-11-17"));
	assert.ok(obs.raw.includes('"id": "obs-0001"'));

	const cnf = cardModel(parseProvenanceEntry(cnfLine));
	assert.equal(cnf.on, "hyp-0001"); // judgment's named subject
	assert.deepEqual(cnf.evidence, []);

	const job = cardModel(parseProvenanceEntry(mthJobLine));
	assert.equal(job.grade, undefined); // a method carries no entry-level grade
	assert.equal(job.evidence[0].source, "theta-compute");
	assert.ok(job.evidence[0].detail.includes("job 12347 COMPLETED"));
	assert.ok(job.evidence[0].detail.includes("template alphafold3"));
});

test("cardLines draws header, text, badges, and references; expanded adds the raw entry", () => {
	const collapsed = cardLines(cardModel(parseProvenanceEntry(obsLine)), plainStyle, false);
	assert.ok(collapsed[0].includes("obs-0001") && collapsed[0].includes("observation"));
	assert.ok(collapsed[0].includes("2026-11-18"));
	assert.ok(collapsed.some((l) => l.includes("HDR-mediated repair is rare")));
	assert.ok(collapsed.some((l) => l.includes("grade [cross-checked]")));
	assert.ok(collapsed.some((l) => l.includes("pubmed") && l.includes("[cross-checked]")));
	assert.ok(collapsed.some((l) => l.includes("supports hyp-0001")));
	assert.ok(!collapsed.some((l) => l.includes('"id"')));

	const expanded = cardLines(cardModel(parseProvenanceEntry(obsLine)), plainStyle, true);
	assert.ok(expanded.some((l) => l.includes('"id": "obs-0001"')));
	assert.ok(expanded.some((l) => l.includes('"snapshot": "evidence/bb22.json"')));
});

test("the renderer draws a Box from a valid line and nothing from a malformed one", () => {
	// The identity theme — the styling seam's plain stand-in.
	const theme = {
		fg: (_token, text) => text,
		bg: (_token, text) => text,
		bold: (text) => text,
	};
	const valid = notebookEntryRenderer({ data: { line: decLine } }, { expanded: false }, theme);
	assert.ok(valid !== undefined);
	const rendered = valid.render(80).join("\n");
	assert.ok(rendered.includes("dec-0001"));
	assert.ok(rendered.includes("two-stage cascade"));
	// The malformed paths refuse before any theme call — undefined is safe.
	assert.equal(
		notebookEntryRenderer({ data: { line: "{not json" } }, { expanded: false }, undefined),
		undefined,
	);
	assert.equal(notebookEntryRenderer({}, { expanded: false }, undefined), undefined);
});

// --- the registration -------------------------------------------------------

test("the default factory wires both events and the renderer under the entry type", (t) => {
	const registrations = { events: [], renderers: [] };
	const pi = {
		appendEntry: () => {},
		on: (event, handler) => registrations.events.push({ event, handler }),
		registerEntryRenderer: (customType, renderer) => registrations.renderers.push({ customType, renderer }),
	};
	registerNotebookCards(pi);
	assert.deepEqual(
		registrations.events.map((r) => r.event).sort(),
		["session_start", "tool_result"],
	);
	assert.deepEqual(
		registrations.renderers.map((r) => r.customType),
		[ENTRY_CUSTOM_TYPE],
	);
	// The wired handlers are the real diff: a temp project proves the pair.
	const project = tempProject(t);
	const sessionStartHandler = registrations.events.find((r) => r.event === "session_start").handler;
	const toolResultHandler = registrations.events.find((r) => r.event === "tool_result").handler;
	sessionStartHandler(sessionStart(), {
		cwd: project,
		sessionManager: { getEntries: () => [] },
	});
	writeNotebook(project, [hypLine]);
	const appended = [];
	pi.appendEntry = (c, d) => appended.push({ c, d });
	toolResultHandler(toolResult(), { cwd: project });
	assert.deepEqual(appended, [{ c: ENTRY_CUSTOM_TYPE, d: { line: hypLine } }]);
});
