import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { createJiti } from "jiti";
import { tempDir } from "./helpers/temp-dir.mjs";
import { recordedNotify } from "./helpers/recorded-notify.mjs";

// The skill pool loader (spec #160, ADR 0008): the extension that loads the
// vendored domain packs per research project. The test drives the real
// handlers — loaded through jiti, the same loader pi runs extensions with —
// against the real vendored pool for the contribution and determinism pins,
// a temp cwd for the state file, and a temp pool mounted through THETA_POOL
// for the drift failure modes (missing skill dirs, unmapped skills, broken
// class maps). Every failure mode must come back diagnosed and never
// thrown; discovery in a zero-state session must contribute nothing and
// write nothing.
const jiti = createJiti(import.meta.url);
const {
	CLASSES_FILE,
	COMMAND_ACTOR,
	GATE_ACTOR,
	HISTORY_CAP,
	NOTEBOOK_FILE,
	SKILLS_COMMAND,
	STATE_DIR,
	STATE_FILE,
	STATE_VERSION,
	autoFireGate,
	default: registerSkillPool,
	discoverPoolSkills,
	gateSkipReason,
	poolRoot,
	planPoolLoading,
	readNotebookSlice,
	readSkillsState,
	runSkillsCommand,
} = await jiti.import("../extensions/skill-pool.ts");

// The class map under test — generated from pool/index.md's table and pinned
// against it both ways below, so the map and the human surface cannot drift.
const CLASSES = JSON.parse(
	fs.readFileSync(new URL("../pool/classes.json", import.meta.url), "utf8"),
);

// The throwaway-directory shape's shared home (test/helpers/temp-dir.mjs)
// — this suite's local copy was its first caller; #178's third caller is
// where the shape got extracted.

function withThetaPool(t, root) {
	const saved = process.env.THETA_POOL;
	// `process.env.X = undefined` stores the literal string "undefined" —
	// a truthy override poolRoot() would honor; clearing is the only unset.
	if (root === undefined) delete process.env.THETA_POOL;
	else process.env.THETA_POOL = root;
	t.after(() => {
		if (saved === undefined) delete process.env.THETA_POOL;
		else process.env.THETA_POOL = saved;
	});
}

function withoutThetaPool(t) {
	withThetaPool(t, undefined);
}

// A temp pool whose shape the test controls: two packs, the skills it names.
function makePool(t) {
	const root = tempDir(t, "pool-root-");
	fs.mkdirSync(path.join(root, "p1", "s1"), { recursive: true });
	fs.mkdirSync(path.join(root, "p1", "s2"), { recursive: true });
	fs.mkdirSync(path.join(root, "p2"), { recursive: true });
	return root;
}

function writeClasses(root, entries) {
	fs.writeFileSync(path.join(root, CLASSES_FILE), JSON.stringify(entries));
}

function writeState(cwd, state) {
	fs.mkdirSync(path.join(cwd, STATE_DIR), { recursive: true });
	fs.writeFileSync(path.join(cwd, STATE_DIR, STATE_FILE), JSON.stringify(state));
}

const stateFor = (packs, classAllow = ["local"]) => ({
	version: STATE_VERSION,
	classAllow,
	packs,
});

function notifyStub(cwd) {
	const { calls, notify } = recordedNotify();
	return { cwd, calls, ui: { notify } };
}

// The gate's own context stub: cwd + ui + a modelRegistry carrying the
// spy seam, so the command subcommands run against the injected classify
// exactly like the auto fire does.
function gateStub(cwd, seam) {
	const stub = notifyStub(cwd);
	return {
		cwd,
		calls: stub.calls,
		ui: stub.ui,
		modelRegistry: seam,
	};
}

// Every seam this section creates registers its calls here as they
// happen; the final test asserts the total is exactly the calls the
// keyed tests made — no keyless path ever reached the classifier.
const spyCalls = [];

// The injected seam (spec #162): the whole suite runs keyless — the
// classifier key never enters a test, and the spy counts every call so
// the suite-wide never-called pin can assert it. The stub is also a
// modelRegistry stand-in (getAvailableOfType + classify), so the
// command's live seam wraps it exactly like it wraps the real registry.
function makeSeam({ keyed = true, answer = { "need-key": 0.9 }, stopReason = "stop", throwAtCall = null, error } = {}) {
	const calls = [];
	const catalog = [{ provider: "openrouter", id: "typesafe/jev-1.13" }];
	const seam = {
		calls,
		keyed: async () => keyed,
		getAvailableOfType: async () => catalog,
		// Two call shapes reach this stub: as the injected seam,
		// classify(context); as the registry the live seam wraps,
		// classify(model, context). The context is the argument that
		// carries `questions`.
		classify: async (...args) => {
			const context = args.at(-1);
			calls.push(context);
			spyCalls.push(context);
			if (throwAtCall !== null) throw throwAtCall;
			if (stopReason !== "stop") return { answers: {}, stopReason, errorMessage: error };
			const answers = {};
			for (const question of Object.keys(context.questions)) {
				answers[question] = { type: "bool", probability: answer[question] ?? 0 };
			}
			return { answers, stopReason: "stop" };
		},
	};
	return seam;
}

// A notebook with n dated entries, the shape the recorder writes (ADR
// 0003): one JSON object per line, `type` and `text` the gate reads.
function writeNotebook(cwd, texts) {
	fs.mkdirSync(path.join(cwd, STATE_DIR), { recursive: true });
	const lines = texts.map((text, i) => JSON.stringify({ id: `hyp-000${i + 1}`, type: "hypothesis", date: "2026-11-16", text }));
	fs.writeFileSync(path.join(cwd, STATE_DIR, NOTEBOOK_FILE), lines.join("\n") + "\n");
}

// The eligible project: state ok, one pack enabled, notebook entries,
// no gate record, default classAllow — the auto gate's whole material.
function eligibleProject(t, { classAllow = ["local"], gate = undefined, notebook = true } = {}) {
	withoutThetaPool(t);
	const cwd = tempDir(t, "pool-cwd-");
	writeState(cwd, {
		version: STATE_VERSION,
		classAllow,
		packs: { bioinformatics: { enabled: true, history: [] } },
		...(gate !== undefined ? { gate } : {}),
	});
	if (notebook) writeNotebook(cwd, ["We will survey CRISPR base-editor off-target literature."]);
	return cwd;
}

const discover = (cwd) =>
	discoverPoolSkills({ type: "resources_discover", cwd, reason: "startup" });

// The skip-pin shape the material-miss tests share: fire at a keyed seam,
// assert zero classify calls, then read the status block and assert it
// names the miss — one helper, so its users cannot drift apart (the
// empty-notebook leg asserts the same message inline).
async function assertSkippedAndNamed(cwd, missPattern) {
	const seam = makeSeam();
	await autoFireGate({ type: "session_start", reason: "startup" }, gateStub(cwd, seam), seam);
	assert.equal(seam.calls.length, 0, "a material miss must not call the classifier");
	const ctx = notifyStub(cwd);
	await runSkillsCommand("", ctx);
	assert.match(ctx.calls[0].message, /gate: not yet run/);
	assert.match(ctx.calls[0].message, missPattern);
}

// The failed-write scaffold the two gate write-failure tests share (the
// extraction rule, tests included): make the state dir unwritable, run
// the trigger, then assert exactly one notify — the failure at the
// caller's level, never a success line after a failed write — the old
// state intact, and no temp survivor. Restores the mode in finally.
async function assertFailedGateWrite(cwd, trigger, level) {
	const file = path.join(cwd, STATE_DIR, STATE_FILE);
	const before = fs.readFileSync(file, "utf8");
	fs.chmodSync(path.join(cwd, STATE_DIR), 0o500);
	try {
		const calls = await trigger();
		assert.equal(calls.length, 1, "one notify — a failed write must not be followed by the success line");
		assert.equal(calls[0].level, level);
		assert.match(calls[0].message, /could not write/);
		assert.equal(fs.readFileSync(file, "utf8"), before, "the old state survives");
		assert.equal(fs.existsSync(`${file}.tmp`), false, "no temp survivor");
	} finally {
		fs.chmodSync(path.join(cwd, STATE_DIR), 0o700);
	}
}

// ---------------------------------------------------------------------------
// The class map and the index (spec #160: both ways, plus the pinned counts).

test("classes.json matches pool/index.md's class column both ways", () => {
	const index = fs.readFileSync(new URL("../pool/index.md", import.meta.url), "utf8");
	const lines = index.split("\n");
	// The extraction anchors at the exact header row and consumes only the
	// table rows that follow it — never a forward search past other text.
	const header = lines.findIndex(
		(line) => line.trim() === "| name | pack | class | when needed |",
	);
	assert.notEqual(header, -1, "the index's table header moved");
	const rows = [];
	for (let i = header + 1; i < lines.length; i++) {
		if (!lines[i].startsWith("|")) break;
		const cells = lines[i].split("|").map((cell) => cell.trim());
		if (cells[1] === "" || cells[1].startsWith("-")) continue;
		rows.push({ name: cells[1], pack: cells[2], cls: cells[3] });
	}
	assert.equal(rows.length, 48, "the first wave is 48 skills");
	assert.equal(Object.keys(CLASSES).length, 48, "one map entry per pool skill");
	// table → map: every row in the map, with the same class
	for (const row of rows) {
		assert.equal(CLASSES[`${row.pack}/${row.name}`], row.cls, `${row.pack}/${row.name}`);
	}
	// map → table: every map key in the table
	const tableKeys = new Set(rows.map((row) => `${row.pack}/${row.name}`));
	for (const key of Object.keys(CLASSES)) {
		assert.ok(tableKeys.has(key), `${key} is in the map but not the table`);
	}
	// the spec's pinned counts
	const byClass = {};
	for (const cls of Object.values(CLASSES)) byClass[cls] = (byClass[cls] ?? 0) + 1;
	assert.deepEqual(byClass, { local: 41, key: 4, cloud: 3 });
	const localPerPack = {};
	for (const [key, cls] of Object.entries(CLASSES)) {
		if (cls === "local") {
			const pack = key.split("/")[0];
			localPerPack[pack] = (localPerPack[pack] ?? 0) + 1;
		}
	}
	assert.deepEqual(localPerPack, {
		bioinformatics: 29,
		cheminformatics: 10,
		"protein-engineering": 2,
	});
});

// ---------------------------------------------------------------------------
// Discovery against the real pool.

test("zero state contributes nothing and writes nothing", async (t) => {
	withoutThetaPool(t);
	const cwd = tempDir(t, "pool-cwd-");
	const result = await discover(cwd);
	assert.deepEqual(result, { skillPaths: [] });
	assert.equal(
		fs.existsSync(path.join(cwd, STATE_DIR)),
		false,
		"discovery must not write state",
	);
});

test("bioinformatics on loads exactly its local skills, sorted — the mixed-pack pin", async (t) => {
	withoutThetaPool(t);
	const cwd = tempDir(t, "pool-cwd-");
	writeState(cwd, stateFor({ bioinformatics: { enabled: true, history: [] } }));
	const { skillPaths } = await discover(cwd);
	assert.equal(skillPaths.length, 29);
	assert.deepEqual(
		skillPaths,
		Object.keys(CLASSES)
			.filter((key) => key.startsWith("bioinformatics/") && CLASSES[key] === "local")
			.map((key) => path.join(poolRoot(), key))
			.sort(),
	);
	assert.deepEqual(skillPaths, [...skillPaths].sort(), "paths must be sorted");
	for (const p of skillPaths) {
		assert.ok(
			!p.endsWith("/alphagenome") && !p.endsWith("/genomic-intelligence") && !p.endsWith("/waypoint-bio"),
			`${p}: no key-class skill may load on the local default`,
		);
	}
});

test("two discovery runs are byte-identical", async (t) => {
	withoutThetaPool(t);
	const cwd = tempDir(t, "pool-cwd-");
	writeState(
		cwd,
		stateFor({
			bioinformatics: { enabled: true, history: [] },
			cheminformatics: { enabled: true, history: [] },
		}),
	);
	const a = await discover(cwd);
	const b = await discover(cwd);
	assert.equal(JSON.stringify(a), JSON.stringify(b));
	assert.equal(a.skillPaths.length, 39); // 29 local + 10 local
});

test("a widened classAllow admits the key-class skills — the gate's decision state", async (t) => {
	withoutThetaPool(t);
	const cwd = tempDir(t, "pool-cwd-");
	writeState(
		cwd,
		stateFor({ bioinformatics: { enabled: true, history: [] } }, ["local", "key"]),
	);
	const { skillPaths } = await discover(cwd);
	assert.equal(skillPaths.length, 32);
	const names = skillPaths.map((p) => path.basename(p));
	for (const key of ["alphagenome", "genomic-intelligence", "waypoint-bio"]) {
		assert.ok(names.includes(key), `${key} must load once classAllow admits key`);
	}
});

test("a state pack the pool lacks is diagnosed while the sound rest still loads", async (t) => {
	withoutThetaPool(t);
	const cwd = tempDir(t, "pool-cwd-");
	writeState(
		cwd,
		stateFor({
			bioinformatics: { enabled: true, history: [] },
			"ghost-pack": { enabled: true, history: [] },
		}),
	);
	const { skillPaths } = await discover(cwd);
	assert.equal(skillPaths.length, 29);
	const plan = planPoolLoading(poolRoot(), cwd);
	const ghost = plan.diagnoses.find((d) => d.item === "ghost-pack");
	assert.ok(ghost, "the unknown pack must be named");
	assert.match(ghost.why, /no such pack/);
});

// ---------------------------------------------------------------------------
// Failure modes against a temp pool (THETA_POOL), each diagnosed, none thrown.

test("a class-map entry without a directory is diagnosed; the sound rest loads", async (t) => {
	const root = makePool(t);
	// s1 mapped local (loads); s2 mapped key (class-filtered — a filter hit,
	// not a skip, so no diagnosis); ghost and s3 mapped but absent (skips).
	writeClasses(root, { "p1/s1": "local", "p1/s2": "key", "p1/ghost": "local", "p1/s3": "key" });
	withThetaPool(t, root);
	const cwd = tempDir(t, "pool-cwd-");
	writeState(cwd, stateFor({ p1: { enabled: true, history: [] } }));
	const plan = planPoolLoading(root, cwd);
	assert.deepEqual(plan.skillPaths, [path.join(root, "p1", "s1")]);
	const diagnoses = Object.fromEntries(plan.diagnoses.map((d) => [d.item, d.why]));
	assert.equal("p1/s2" in diagnoses, false, "a class-filtered skill is not a skip");
	assert.match(diagnoses["p1/ghost"], /no such directory/);
	assert.match(diagnoses["p1/s3"], /no such directory/);
});

test("a mapped local skill loads while an unmapped sibling is diagnosed", async (t) => {
	const root = makePool(t);
	writeClasses(root, { "p1/s1": "local" });
	withThetaPool(t, root);
	const cwd = tempDir(t, "pool-cwd-");
	writeState(cwd, stateFor({ p1: { enabled: true, history: [] } }));
	const plan = planPoolLoading(root, cwd);
	assert.deepEqual(plan.skillPaths, [path.join(root, "p1", "s1")]);
	const s2 = plan.diagnoses.find((d) => d.item === "p1/s2");
	assert.ok(s2, "the unmapped skill must be named");
	assert.match(s2.why, /no entry/);
});

test("an unparsable class map contributes nothing and names itself once", async (t) => {
	const root = makePool(t);
	fs.writeFileSync(path.join(root, CLASSES_FILE), "{oops");
	withThetaPool(t, root);
	const cwd = tempDir(t, "pool-cwd-");
	writeState(cwd, stateFor({ p1: { enabled: true, history: [] } }));
	const plan = planPoolLoading(root, cwd);
	assert.deepEqual(plan.skillPaths, []);
	const mapDiagnoses = plan.diagnoses.filter((d) => d.item === CLASSES_FILE);
	assert.equal(mapDiagnoses.length, 1, "one aggregate line, not one per skill");
	assert.match(mapDiagnoses[0].why, /unparsable/);
});

test("an unparsable state file contributes nothing and is diagnosed", async (t) => {
	const root = makePool(t);
	writeClasses(root, { "p1/s1": "local" });
	withThetaPool(t, root);
	const cwd = tempDir(t, "pool-cwd-");
	fs.mkdirSync(path.join(cwd, STATE_DIR), { recursive: true });
	fs.writeFileSync(path.join(cwd, STATE_DIR, STATE_FILE), "{broken");
	const plan = planPoolLoading(root, cwd);
	assert.deepEqual(plan.skillPaths, []);
	const stateDiagnosis = plan.diagnoses.find((d) => d.item === `${STATE_DIR}/${STATE_FILE}`);
	assert.ok(stateDiagnosis, "the broken state must be named");
	assert.match(stateDiagnosis.why, /unparsable/);
});

test("an unknown state version contributes nothing and is diagnosed", async (t) => {
	const root = makePool(t);
	writeClasses(root, { "p1/s1": "local" });
	withThetaPool(t, root);
	const cwd = tempDir(t, "pool-cwd-");
	writeState(cwd, { version: 2, classAllow: ["local"], packs: {} });
	const plan = planPoolLoading(root, cwd);
	assert.deepEqual(plan.skillPaths, []);
	const stateDiagnosis = plan.diagnoses.find((d) => d.item === `${STATE_DIR}/${STATE_FILE}`);
	assert.ok(stateDiagnosis, "the unknown version must be named");
	assert.match(stateDiagnosis.why, /unknown version/);
});

test("discovery never throws, whatever the inputs", async (t) => {
	// every broken shape at once — the await completing is the pin
	const root = makePool(t);
	fs.writeFileSync(path.join(root, CLASSES_FILE), "nope");
	withThetaPool(t, root);
	const cwd = tempDir(t, "pool-cwd-");
	fs.mkdirSync(path.join(cwd, STATE_DIR), { recursive: true });
	fs.writeFileSync(path.join(cwd, STATE_DIR, STATE_FILE), "[[[");
	const result = await discover(cwd);
	assert.deepEqual(result, { skillPaths: [] });
	const absent = await discoverPoolSkills({
		type: "resources_discover",
		cwd: tempDir(t, "pool-nope-"),
		reason: "reload",
	});
	assert.deepEqual(absent, { skillPaths: [] });
});

// ---------------------------------------------------------------------------
// The command: status, toggles, history cap, atomic writes, refusals.

test("bare status prints the table, the class mix, and the zero-state hint", async (t) => {
	withoutThetaPool(t);
	const cwd = tempDir(t, "pool-cwd-");
	const ctx = notifyStub(cwd);
	await runSkillsCommand("", ctx);
	assert.equal(ctx.calls.length, 1);
	const { message, level } = ctx.calls[0];
	assert.equal(level, "info");
	assert.match(message, /skill pool — /);
	for (const pack of ["bioinformatics", "cheminformatics", "protein-engineering"]) {
		assert.ok(message.includes(pack), `${pack} must appear`);
	}
	assert.match(message, /29 local, 3 key/); // the mixed pack, from the map
	assert.match(message, /nothing loads/); // the zero-state hint
	assert.match(message, /\/reload/);
});

test("an absent pool answers no-pool for status and toggle alike", async (t) => {
	withThetaPool(t, tempDir(t, "pool-empty-"));
	const cwd = tempDir(t, "pool-cwd-");
	const ctx = notifyStub(cwd);
	await runSkillsCommand("", ctx);
	assert.match(ctx.calls[0].message, /no pool in this install/);
	await runSkillsCommand("on bioinformatics", ctx);
	assert.match(ctx.calls.at(-1).message, /no pool in this install/);
	assert.equal(fs.existsSync(path.join(cwd, STATE_DIR)), false);
});

test("on toggles a pack, appends history, writes atomically, and says /reload", async (t) => {
	withoutThetaPool(t);
	const cwd = tempDir(t, "pool-cwd-");
	const ctx = notifyStub(cwd);
	await runSkillsCommand("on bioinformatics", ctx);
	const state = JSON.parse(fs.readFileSync(path.join(cwd, STATE_DIR, STATE_FILE), "utf8"));
	assert.equal(state.version, STATE_VERSION);
	assert.deepEqual(state.classAllow, ["local"]);
	assert.equal(state.packs.bioinformatics.enabled, true);
	assert.equal(state.packs.bioinformatics.history.length, 1);
	const entry = state.packs.bioinformatics.history[0];
	assert.equal(entry.actor, COMMAND_ACTOR);
	assert.equal(entry.decision, "on");
	assert.match(entry.at, /^\d{4}-\d{2}-\d{2}T/);
	assert.ok(entry.rationale.includes("on bioinformatics"));
	assert.equal(
		fs.existsSync(path.join(cwd, STATE_DIR, `${STATE_FILE}.tmp`)),
		false,
		"no temp file may survive the rename",
	);
	assert.equal(ctx.calls[0].level, "info");
	assert.match(ctx.calls[0].message, /\/reload/);
});

test("off appends its decision to the same pack's history", async (t) => {
	withoutThetaPool(t);
	const cwd = tempDir(t, "pool-cwd-");
	await runSkillsCommand("on bioinformatics", notifyStub(cwd));
	const ctx = notifyStub(cwd);
	await runSkillsCommand("off bioinformatics", ctx);
	const state = JSON.parse(fs.readFileSync(path.join(cwd, STATE_DIR, STATE_FILE), "utf8"));
	assert.equal(state.packs.bioinformatics.enabled, false);
	assert.deepEqual(
		state.packs.bioinformatics.history.map((entry) => entry.decision),
		["on", "off"],
	);
	assert.match(ctx.calls[0].message, /\/reload/);
});

test("an unknown pack refuses with the valid pack list and writes nothing", async (t) => {
	withoutThetaPool(t);
	const cwd = tempDir(t, "pool-cwd-");
	const ctx = notifyStub(cwd);
	await runSkillsCommand("on ghost-pack", ctx);
	assert.equal(ctx.calls[0].level, "error");
	assert.match(ctx.calls[0].message, /unknown pack "ghost-pack"/);
	for (const pack of ["bioinformatics", "cheminformatics", "protein-engineering"]) {
		assert.ok(ctx.calls[0].message.includes(pack), `valid packs must be named: ${pack}`);
	}
	assert.equal(fs.existsSync(path.join(cwd, STATE_DIR)), false);
});

test("a broken state file refuses the toggle instead of overwriting it", async (t) => {
	withoutThetaPool(t);
	const cwd = tempDir(t, "pool-cwd-");
	fs.mkdirSync(path.join(cwd, STATE_DIR), { recursive: true });
	const file = path.join(cwd, STATE_DIR, STATE_FILE);
	fs.writeFileSync(file, "{broken");
	const before = fs.readFileSync(file, "utf8");
	const ctx = notifyStub(cwd);
	await runSkillsCommand("on bioinformatics", ctx);
	assert.equal(ctx.calls[0].level, "error");
	assert.match(ctx.calls[0].message, /broken/);
	assert.equal(fs.readFileSync(file, "utf8"), before, "the broken file must survive untouched");
});

test("a failed state write is reported, never thrown, and the old state survives", async (t) => {
	withoutThetaPool(t);
	const cwd = tempDir(t, "pool-cwd-");
	await runSkillsCommand("on bioinformatics", notifyStub(cwd));
	const file = path.join(cwd, STATE_DIR, STATE_FILE);
	const before = fs.readFileSync(file, "utf8");
	fs.chmodSync(path.join(cwd, STATE_DIR), 0o500);
	try {
		const ctx = notifyStub(cwd);
		await runSkillsCommand("off bioinformatics", ctx);
		assert.equal(ctx.calls[0].level, "error");
		assert.match(ctx.calls[0].message, /could not write/);
		assert.equal(fs.readFileSync(file, "utf8"), before);
	} finally {
		fs.chmodSync(path.join(cwd, STATE_DIR), 0o700);
	}
});

test("history keeps the last 20 entries per pack", async (t) => {
	withoutThetaPool(t);
	const cwd = tempDir(t, "pool-cwd-");
	const ctx = notifyStub(cwd);
	for (let i = 0; i < 25; i++) {
		await runSkillsCommand(i % 2 === 0 ? "on bioinformatics" : "off bioinformatics", ctx);
	}
	const state = JSON.parse(fs.readFileSync(path.join(cwd, STATE_DIR, STATE_FILE), "utf8"));
	assert.equal(HISTORY_CAP, 20);
	assert.equal(state.packs.bioinformatics.history.length, HISTORY_CAP);
	const decisions = state.packs.bioinformatics.history.map((entry) => entry.decision);
	// 25 toggles, cap 20 → the first five drop; toggle 6 (index 5) was "off"
	assert.deepEqual(decisions[0], "off");
	assert.deepEqual(decisions.at(-1), "on");
});

test("malformed invocations answer the usage line", async (t) => {
	withoutThetaPool(t);
	const cwd = tempDir(t, "pool-cwd-");
	const ctx = notifyStub(cwd);
	await runSkillsCommand("frobnicate", ctx);
	assert.equal(ctx.calls[0].level, "error");
	assert.match(ctx.calls[0].message, /usage/);
	await runSkillsCommand("on", ctx);
	assert.equal(ctx.calls[1].level, "error");
});

test("THETA_POOL names the pool root", async (t) => {
	const root = makePool(t);
	writeClasses(root, { "p1/s1": "local", "p1/s2": "local" });
	withThetaPool(t, root);
	const cwd = tempDir(t, "pool-cwd-");
	writeState(cwd, stateFor({ p1: { enabled: true, history: [] } }));
	const { skillPaths } = await discover(cwd);
	assert.deepEqual(skillPaths, [path.join(root, "p1", "s1"), path.join(root, "p1", "s2")]);
});

// ---------------------------------------------------------------------------
// The default export registers both surfaces, and they work end to end.

test("the default export registers the discover hook, the session hook, and the command", async (t) => {
	const events = [];
	const commands = [];
	registerSkillPool({
		on: (event, handler) => events.push([event, handler]),
		registerCommand: (name, options) => commands.push([name, options]),
	});
	// S2 grew the registration: the auto gate rides session_start.
	assert.deepEqual(events.map(([event]) => event), ["resources_discover", "session_start"]);
	assert.deepEqual(commands.map(([name]) => name), [SKILLS_COMMAND]);

	withoutThetaPool(t);
	const cwd = tempDir(t, "pool-cwd-");
	const [, options] = commands[0];
	await options.handler("on cheminformatics", { cwd, ui: { notify: () => {} } });
	const state = JSON.parse(fs.readFileSync(path.join(cwd, STATE_DIR, STATE_FILE), "utf8"));
	assert.equal(state.packs.cheminformatics.enabled, true);
	const [, handler] = events[0];
	const result = await handler({ type: "resources_discover", cwd, reason: "startup" }, {});
	assert.equal(result.skillPaths.length, 10); // cheminformatics's local skills
	assert.ok(result.skillPaths.every((p) => p.includes("cheminformatics")));
});

// ---------------------------------------------------------------------------
// The Jev gate (spec #162): one classify call over the notebook and the
// enabled packs decides classAllow beyond local. The whole suite runs
// keyless through the injected seam — the suite-wide spy pin at the end
// is the proof.

test("keyless session start never calls the classify seam", async (t) => {
	const cwd = eligibleProject(t);
	const seam = makeSeam({ keyed: false });
	await autoFireGate({ type: "session_start", reason: "startup" }, gateStub(cwd, seam), seam);
	assert.equal(seam.calls.length, 0, "a keyless start must not call the classifier");
	const read = readSkillsState(cwd);
	assert.equal(read.kind, "ok");
	assert.equal(read.state.gate, undefined, "no record may land keyless");
	assert.deepEqual(read.state.classAllow, ["local"], "classAllow stays the default");
});

test("keyed start with material fires once, records, and widens", async (t) => {
	const cwd = eligibleProject(t);
	const seam = makeSeam({ answer: { "need-key": 0.83 } });
	const stub = gateStub(cwd, seam);
	await autoFireGate({ type: "session_start", reason: "startup" }, stub, seam);
	assert.equal(seam.calls.length, 1, "exactly one classify call");
	// The success notify — the auto fire's one user-facing line, pinned:
	// the new classAllow, the record's home, info level.
	assert.equal(stub.calls.length, 1);
	assert.equal(stub.calls[0].level, "info");
	assert.match(stub.calls[0].message, /gate: classAllow is now local, key/);
	assert.match(stub.calls[0].message, /the record is in \.theta\/skills\.json/);
	// The call's state: the notebook's capped entries plus the enabled packs.
	const state = seam.calls[0].state;
	assert.ok(Array.isArray(state.notebook));
	assert.equal(state.notebook.length, 1);
	assert.equal(state.notebook[0].text, "We will survey CRISPR base-editor off-target literature.");
	assert.deepEqual(state.packs, ["bioinformatics"]);
	assert.deepEqual(Object.keys(seam.calls[0].questions), ["need-key"]);
	const read = readSkillsState(cwd);
	assert.equal(read.kind, "ok");
	// The record: actor, decision, composed rationale — and classAllow set.
	assert.equal(read.state.gate.actor, GATE_ACTOR);
	assert.deepEqual(read.state.gate.decision, ["local", "key"]);
	assert.deepEqual(read.state.classAllow, read.state.gate.decision, "record and classAllow never disagree");
	assert.match(read.state.gate.at, /^\d{4}-\d{2}-\d{2}T/);
	// The rationale is composed, never model prose: input counts, the
	// question, the answer's probability.
	assert.match(read.state.gate.rationale, /notebook 1 entries/);
	assert.match(read.state.gate.rationale, /packs bioinformatics/);
	assert.match(read.state.gate.rationale, /need-key p=0\.83/);
});

test("a below-threshold answer still lands a record — the decision stays local", async (t) => {
	const cwd = eligibleProject(t);
	const seam = makeSeam({ answer: { "need-key": 0.3 } });
	await autoFireGate({ type: "session_start", reason: "startup" }, gateStub(cwd, seam), seam);
	assert.equal(seam.calls.length, 1);
	const read = readSkillsState(cwd);
	assert.equal(read.kind, "ok");
	// The negative branch is a judgment, not a failure: the record lands
	// with decision ["local"] and classAllow stays the default — and the
	// record makes it the once-per-project signal, so no second call.
	assert.deepEqual(read.state.gate.decision, ["local"]);
	assert.deepEqual(read.state.classAllow, ["local"]);
	assert.match(read.state.gate.rationale, /need-key p=0\.30/);
	const seam2 = makeSeam({ answer: { "need-key": 0.9 } });
	await autoFireGate({ type: "session_start", reason: "startup" }, gateStub(cwd, seam2), seam2);
	assert.equal(seam2.calls.length, 0, "the negative record is still the once signal");
	assert.deepEqual(readSkillsState(cwd).state.classAllow, ["local"]);
});

test("an answer of exactly the 0.5 threshold admits — the boundary is inclusive", async (t) => {
	const cwd = eligibleProject(t);
	const seam = makeSeam({ answer: { "need-key": 0.5 } });
	await autoFireGate({ type: "session_start", reason: "startup" }, gateStub(cwd, seam), seam);
	assert.deepEqual(readSkillsState(cwd).state.gate.decision, ["local", "key"], "exactly 0.5 admits");
});

test("the widening applies to the firing session's discovery — no /reload", async (t) => {
	const cwd = eligibleProject(t);
	const seam = makeSeam({ answer: { "need-key": 0.9 } });
	await autoFireGate({ type: "session_start", reason: "startup" }, gateStub(cwd, seam), seam);
	// discovery reads the state the hook wrote — the write-before-read pin
	const { skillPaths } = await discover(cwd);
	const names = skillPaths.map((p) => path.basename(p));
	assert.equal(skillPaths.length, 32, "29 local + 3 key once classAllow admits key");
	for (const key of ["alphagenome", "genomic-intelligence", "waypoint-bio"]) {
		assert.ok(names.includes(key), `${key} must load in the firing session`);
	}
});

test("a record present means no second call at the next start", async (t) => {
	const cwd = eligibleProject(t, {
		gate: {
			at: "2026-11-16T00:00:00.000Z",
			actor: GATE_ACTOR,
			decision: ["local", "key"],
			rationale: "notebook 1 entries; packs bioinformatics; need-key p=0.83",
		},
	});
	const seam = makeSeam();
	await autoFireGate({ type: "session_start", reason: "startup" }, gateStub(cwd, seam), seam);
	assert.equal(seam.calls.length, 0, "the once-per-project signal is the record");
	const read = readSkillsState(cwd);
	assert.equal(read.state.gate.decision.join(","), "local,key", "the record is unchanged");
});

test("a hand-widened classAllow outranks the automatic fire", async (t) => {
	const cwd = eligibleProject(t, { classAllow: ["local", "key"] });
	const seam = makeSeam();
	await autoFireGate({ type: "session_start", reason: "startup" }, gateStub(cwd, seam), seam);
	assert.equal(seam.calls.length, 0, "the auto gate never clobbers a human widening");
	const read = readSkillsState(cwd);
	assert.deepEqual(read.state.classAllow, ["local", "key"]);
	assert.equal(read.state.gate, undefined, "no record lands for a skipped fire");
});

test("an absent or empty notebook skips the fire, named in the status block", async (t) => {
	const cwd = eligibleProject(t, { notebook: false });
	await assertSkippedAndNamed(cwd, /no notebook entries/);
	// an empty notebook (the file exists, zero entries) skips the same way
	writeNotebook(cwd, []);
	const ctx2 = notifyStub(cwd);
	await runSkillsCommand("", ctx2);
	assert.match(ctx2.calls[0].message, /no notebook entries/);
});

test("zero packs enabled skips the fire — the status block names it", async (t) => {
	withoutThetaPool(t);
	const cwd = tempDir(t, "pool-cwd-");
	writeState(cwd, stateFor({ bioinformatics: { enabled: false, history: [] } }));
	writeNotebook(cwd, ["Some recorded research."]);
	await assertSkippedAndNamed(cwd, /no pack is enabled/);
});

test("a transport error widens nothing, records nothing, and retries next start", async (t) => {
	const cwd = eligibleProject(t);
	const seam = makeSeam({ throwAtCall: new TypeError("fetch failed") });
	const stub = gateStub(cwd, seam);
	await autoFireGate({ type: "session_start", reason: "startup" }, stub, seam);
	assert.equal(seam.calls.length, 1, "the call was attempted");
	assert.equal(stub.calls.length, 1, "one notify names the failure");
	assert.equal(stub.calls[0].level, "warning");
	assert.match(stub.calls[0].message, /did not run/);
	const read = readSkillsState(cwd);
	assert.equal(read.state.gate, undefined, "no record lands on failure");
	assert.deepEqual(read.state.classAllow, ["local"], "nothing widens");
	// the next start tries again — the eligibility signal stayed absent
	const seam2 = makeSeam({ answer: { "need-key": 0.9 } });
	await autoFireGate({ type: "session_start", reason: "startup" }, gateStub(cwd, seam2), seam2);
	assert.equal(seam2.calls.length, 1, "retry across sessions, never in-session loops");
	assert.equal(readSkillsState(cwd).state.gate.decision.join(","), "local,key");
});

test("a stopReason error answer widens nothing and retries next start", async (t) => {
	const cwd = eligibleProject(t);
	const seam = makeSeam({ stopReason: "error", error: "provider 502" });
	const stub = gateStub(cwd, seam);
	await autoFireGate({ type: "session_start", reason: "startup" }, stub, seam);
	assert.equal(seam.calls.length, 1);
	assert.equal(stub.calls.length, 1);
	assert.match(stub.calls[0].message, /stopReason error/);
	const read = readSkillsState(cwd);
	assert.equal(read.state.gate, undefined);
	assert.deepEqual(read.state.classAllow, ["local"]);
	// the next start tries again — the record stayed absent
	const seam2 = makeSeam({ answer: { "need-key": 0.9 } });
	await autoFireGate({ type: "session_start", reason: "startup" }, gateStub(cwd, seam2), seam2);
	assert.equal(seam2.calls.length, 1, "retry across sessions, never in-session loops");
	assert.equal(readSkillsState(cwd).state.gate.decision.join(","), "local,key");
});

test("a failed auto-fire write warns, lands nothing, and never says success", async (t) => {
	const cwd = eligibleProject(t);
	const seam = makeSeam({ answer: { "need-key": 0.9 } });
	const stub = gateStub(cwd, seam);
	await assertFailedGateWrite(cwd, async () => {
		await autoFireGate({ type: "session_start", reason: "startup" }, stub, seam);
		return stub.calls;
	}, "warning");
	assert.equal(seam.calls.length, 1, "the judgment ran; only the write failed");
	// No record landed, so the next keyed start retries — the once
	// signal is the record on disk, never the attempted run.
	const seam2 = makeSeam({ answer: { "need-key": 0.9 } });
	await autoFireGate({ type: "session_start", reason: "startup" }, gateStub(cwd, seam2), seam2);
	assert.equal(seam2.calls.length, 1, "a failed write leaves the eligibility signal absent");
	assert.equal(readSkillsState(cwd).state.gate.decision.join(","), "local,key");
});

test("session_start never throws — the never-throw floor owns the hook", async (t) => {
	// The throwing seams must be REACHED, not just constructed: an eligible
	// project passes the material check, so keyed() and classify() really
	// run. A throwing probe, a throwing classify, a nonexistent project dir:
	// the await completing with a warning notify is the pin, in every
	// combination.
	const throwingSeam = () => ({
		// The registry surface keyed()'s probe goes through: the throw lands
		// inside pickClassifierEntry, so the caught error travels the route
		// the assertions name — a thrown probe, read as keyless.
		getAvailableOfType: () => {
			throw new Error("probe exploded");
		},
		keyed: () => {
			throw new Error("probe exploded");
		},
		classify: () => {
			throw new Error("classify exploded");
		},
		calls: [],
	});
	const stub1 = gateStub(eligibleProject(t), throwingSeam());
	await autoFireGate({ type: "session_start", reason: "startup" }, stub1, undefined);
	assert.equal(stub1.calls.length, 0, "a thrown probe reads as keyless — silent skip");
	const stub2 = gateStub("/nonexistent", throwingSeam());
	await autoFireGate({ type: "session_start", reason: "startup" }, stub2, undefined);
	const seam2 = {
		keyed: async () => {
			throw new Error("probe rejected");
		},
		classify: () => {
			throw new Error("never reached");
		},
		calls: [],
	};
	await autoFireGate({ type: "session_start", reason: "resume" }, gateStub("/nonexistent", seam2), seam2);
	// The classify path throws mid-run: the whole-hook floor catches it and
	// degrades to one warning notify — never a thrown handler.
	const cwd = eligibleProject(t);
	const seam3 = {
		keyed: async () => true,
		classify: () => {
			throw new TypeError("fetch failed");
		},
		calls: [],
	};
	const stub3 = gateStub(cwd, seam3);
	await autoFireGate({ type: "session_start", reason: "startup" }, stub3, seam3);
	assert.equal(stub3.calls[0].level, "warning");
	assert.match(stub3.calls[0].message, /did not run/);
	assert.equal(readSkillsState(cwd).state.gate, undefined, "nothing lands through the floor");
});

test("the notebook slice caps at 10 entries and 500 characters", (t) => {
	withoutThetaPool(t);
	const cwd = tempDir(t, "pool-cwd-");
	writeNotebook(cwd, Array.from({ length: 15 }, (_, i) => `Entry ${i} ${"x".repeat(600)}`));
	const slice = readNotebookSlice(cwd);
	assert.equal(slice.length, 10, "the window is the last 10 entries");
	assert.equal(slice[0].text.length, 500, "each text caps at 500 characters");
	assert.equal(slice[9].text, "Entry 14 " + "x".repeat(491), "the last entry is in the window, capped");
});

test("an unparsable notebook line is skipped, not fatal", (t) => {
	withoutThetaPool(t);
	const cwd = tempDir(t, "pool-cwd-");
	fs.mkdirSync(path.join(cwd, STATE_DIR), { recursive: true });
	fs.writeFileSync(
		path.join(cwd, STATE_DIR, NOTEBOOK_FILE),
		"{broken json\n" + JSON.stringify({ type: "decision", text: "A sound entry." }) + "\n",
	);
	const slice = readNotebookSlice(cwd);
	assert.equal(slice.length, 1);
	assert.equal(slice[0].text, "A sound entry.");
});

test("explicit gate re-runs at the auto ceiling: one call, need-key only", async (t) => {
	const cwd = eligibleProject(t);
	const seam = makeSeam({ answer: { "need-key": 0.6, "need-cloud": 0.9 } });
	const ctx = gateStub(cwd, seam);
	await runSkillsCommand("gate", ctx);
	assert.equal(seam.calls.length, 1);
	assert.deepEqual(Object.keys(seam.calls[0].questions), ["need-key"], "the auto ceiling asks need-key only");
	const read = readSkillsState(cwd);
	assert.deepEqual(read.state.gate.decision, ["local", "key"]);
	assert.match(ctx.calls[0].message, /run \/reload/);
});

test("gate cloud runs the full ceiling: one call, two questions", async (t) => {
	const cwd = eligibleProject(t);
	const seam = makeSeam({ answer: { "need-key": 0.7, "need-cloud": 0.8 } });
	const ctx = gateStub(cwd, seam);
	await runSkillsCommand("gate cloud", ctx);
	assert.equal(seam.calls.length, 1, "one call, never one per question");
	const questions = Object.keys(seam.calls[0].questions);
	assert.equal(questions.length, 2);
	assert.ok(questions.includes("need-key") && questions.includes("need-cloud"));
	const read = readSkillsState(cwd);
	assert.deepEqual(read.state.gate.decision, ["local", "key", "cloud"]);
	assert.deepEqual(read.state.classAllow, ["local", "key", "cloud"]);
});

test("a plain gate re-run narrows a cloud approval honestly", async (t) => {
	const cwd = eligibleProject(t, {
		gate: {
			at: "2026-11-16T00:00:00.000Z",
			actor: GATE_ACTOR,
			decision: ["local", "key", "cloud"],
			rationale: "notebook 1 entries; packs bioinformatics; need-key p=0.70; need-cloud p=0.80",
		},
		classAllow: ["local", "key", "cloud"],
	});
	const seam = makeSeam({ answer: { "need-key": 0.9, "need-cloud": 0.1 } });
	const ctx = gateStub(cwd, seam);
	await runSkillsCommand("gate", ctx);
	assert.equal(seam.calls.length, 1);
	assert.deepEqual(Object.keys(seam.calls[0].questions), ["need-key"]);
	const read = readSkillsState(cwd);
	assert.deepEqual(read.state.gate.decision, ["local", "key"], "the key-ceiling judgment narrows the set");
	assert.deepEqual(read.state.classAllow, ["local", "key"], "the run sets exactly its decision — never widen-only");
});

test("a need-cloud refusal keeps cloud out — the judgment is the answer", async (t) => {
	const cwd = eligibleProject(t);
	const seam = makeSeam({ answer: { "need-key": 0.9, "need-cloud": 0.2 } });
	const ctx = gateStub(cwd, seam);
	await runSkillsCommand("gate cloud", ctx);
	const read = readSkillsState(cwd);
	assert.deepEqual(read.state.gate.decision, ["local", "key"], "cloud stays out when the research does not show the need");
	assert.match(read.state.gate.rationale, /need-cloud p=0\.20/);
});

test("an explicit gate failure records nothing and answers an error", async (t) => {
	const cwd = eligibleProject(t);
	const seam = makeSeam({ throwAtCall: new TypeError("fetch failed") });
	const ctx = gateStub(cwd, seam);
	await runSkillsCommand("gate", ctx);
	assert.equal(ctx.calls[0].level, "error");
	assert.match(ctx.calls[0].message, /did not run/);
	const read = readSkillsState(cwd);
	assert.equal(read.state.gate, undefined);
	assert.deepEqual(read.state.classAllow, ["local"]);
});

test("the explicit gate refuses a broken state instead of overwriting it", async (t) => {
	withoutThetaPool(t);
	const cwd = tempDir(t, "pool-cwd-");
	fs.mkdirSync(path.join(cwd, STATE_DIR), { recursive: true });
	fs.writeFileSync(path.join(cwd, STATE_DIR, STATE_FILE), "{broken");
	const seam = makeSeam();
	const ctx = gateStub(cwd, seam);
	await runSkillsCommand("gate", ctx);
	assert.equal(seam.calls.length, 0, "no call on a broken state");
	assert.equal(ctx.calls[0].level, "error");
	assert.match(ctx.calls[0].message, /broken/);
});

test("a failed explicit-gate write answers an error and never says success", async (t) => {
	const cwd = eligibleProject(t);
	const seam = makeSeam({ answer: { "need-key": 0.9 } });
	const ctx = gateStub(cwd, seam);
	await assertFailedGateWrite(cwd, async () => {
		await runSkillsCommand("gate", ctx);
		return ctx.calls;
	}, "error");
	assert.equal(seam.calls.length, 1, "the judgment ran; only the write failed");
});

test("a toggle write preserves the gate record — the typed rebuild pin", async (t) => {
	const cwd = eligibleProject(t);
	const gate = {
		at: "2026-11-16T00:00:00.000Z",
		actor: GATE_ACTOR,
		decision: ["local", "key"],
		rationale: "notebook 1 entries; packs bioinformatics; need-key p=0.83",
	};
	writeState(cwd, {
		version: STATE_VERSION,
		classAllow: ["local", "key"],
		packs: { bioinformatics: { enabled: true, history: [] } },
		gate,
	});
	await runSkillsCommand("off bioinformatics", gateStub(cwd, makeSeam()));
	const read = readSkillsState(cwd);
	assert.equal(read.kind, "ok");
	assert.deepEqual(read.state.gate, gate, "the toggle write must carry the record");
	assert.equal(read.state.packs.bioinformatics.enabled, false);
	assert.deepEqual(read.state.classAllow, ["local", "key"]);
});

test("an invalid gate record invalidates the state — never partially honored", async (t) => {
	withoutThetaPool(t);
	const cwd = tempDir(t, "pool-cwd-");
	writeState(cwd, {
		version: STATE_VERSION,
		classAllow: ["local"],
		packs: { bioinformatics: { enabled: true, history: [] } },
		gate: { at: "2026-11-16T00:00:00.000Z", actor: "human:guess", decision: ["local", "cloud"], rationale: "hand-made" },
	});
	const read = readSkillsState(cwd);
	assert.equal(read.kind, "invalid", "a forged actor refuses the whole state");
	const plan = planPoolLoading(poolRoot(), cwd);
	assert.equal(plan.skillPaths.length, 0, "invalid state loads nothing");
});

test("the status block carries the gate record line", async (t) => {
	const cwd = eligibleProject(t, {
		gate: {
			at: "2026-11-16T01:02:03.000Z",
			actor: GATE_ACTOR,
			decision: ["local", "key"],
			rationale: "notebook 1 entries; packs bioinformatics; need-key p=0.83",
		},
	});
	const ctx = notifyStub(cwd);
	await runSkillsCommand("", ctx);
	assert.match(ctx.calls[0].message, /gate: classify:jev → local, key at 2026-11-16T01:02:03\.000Z/);
});

test("skip reasons name each miss in order", () => {
	// The material check's own enumeration, one miss per condition.
	const okState = {
		kind: "ok",
		state: { version: STATE_VERSION, classAllow: ["local"], packs: { p: { enabled: true, history: [] } } },
	};
	assert.equal(gateSkipReason({ kind: "absent" }, []), "no state file yet");
	assert.match(gateSkipReason({ kind: "invalid", why: "unparsable" }, []), /invalid/);
	assert.equal(
		gateSkipReason({ kind: "ok", state: { version: STATE_VERSION, classAllow: ["local"], packs: {} } }, [{ type: "hypothesis", text: "x" }]),
		"no pack is enabled",
	);
	assert.equal(gateSkipReason(okState, []), "no notebook entries in .theta/notebook.jsonl");
	assert.equal(
		gateSkipReason(
			{ kind: "ok", state: { ...okState.state, gate: { at: "x", actor: GATE_ACTOR, decision: ["local"], rationale: "r" } } },
			[{ type: "hypothesis", text: "x" }],
		),
		"the gate has already run for this project",
	);
	assert.match(
		gateSkipReason({ kind: "ok", state: { ...okState.state, classAllow: ["local", "cloud"] } }, [{ type: "hypothesis", text: "x" }]),
		/hand-widened/,
	);
	assert.equal(gateSkipReason(okState, [{ type: "hypothesis", text: "x" }]), undefined, "all material → no skip");
});

test("suite pin: the keyless suite made exactly the classify calls the keyed tests made", () => {
	// Every seam registered its calls into spyCalls as it made them; the
	// keyed tests asserted their own counts inline. This pin is the
	// suite-level statement: no other test — none of the S1 discovery and
	// command tests, none of the failure-mode tests — reached the seam.
	// The count is the sum the keyed tests above made: auto-fire (1),
	// widening (1), below-threshold record (1), the 0.5 boundary (1),
	// transport failure (1) + its retry (1), stopReason (1) + its retry
	// (1), the auto-fire write failure (1) + its retry (1), explicit gate
	// (1), gate cloud (1), plain re-run (1), need-cloud refusal (1),
	// explicit failure (1), the explicit write failure (1) — 16 keyed
	// calls, zero from any keyless path.
	assert.equal(spyCalls.length, 16);
});
