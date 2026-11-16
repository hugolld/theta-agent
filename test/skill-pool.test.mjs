import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createJiti } from "jiti";

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
	HISTORY_CAP,
	SKILLS_COMMAND,
	STATE_DIR,
	STATE_FILE,
	STATE_VERSION,
	default: registerSkillPool,
	discoverPoolSkills,
	poolRoot,
	planPoolLoading,
	runSkillsCommand,
} = await jiti.import("../extensions/skill-pool.ts");

// The class map under test — generated from pool/index.md's table and pinned
// against it both ways below, so the map and the human surface cannot drift.
const CLASSES = JSON.parse(
	fs.readFileSync(new URL("../pool/classes.json", import.meta.url), "utf8"),
);

function tempDir(t, prefix) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	return dir;
}

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
	const calls = [];
	return { cwd, calls, ui: { notify: (message, level) => calls.push([message, level]) } };
}

const discover = (cwd) =>
	discoverPoolSkills({ type: "resources_discover", cwd, reason: "startup" });

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
	const [message, level] = ctx.calls[0];
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
	assert.match(ctx.calls[0][0], /no pool in this install/);
	await runSkillsCommand("on bioinformatics", ctx);
	assert.match(ctx.calls.at(-1)[0], /no pool in this install/);
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
	assert.equal(ctx.calls[0][1], "info");
	assert.match(ctx.calls[0][0], /\/reload/);
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
	assert.match(ctx.calls[0][0], /\/reload/);
});

test("an unknown pack refuses with the valid pack list and writes nothing", async (t) => {
	withoutThetaPool(t);
	const cwd = tempDir(t, "pool-cwd-");
	const ctx = notifyStub(cwd);
	await runSkillsCommand("on ghost-pack", ctx);
	assert.equal(ctx.calls[0][1], "error");
	assert.match(ctx.calls[0][0], /unknown pack "ghost-pack"/);
	for (const pack of ["bioinformatics", "cheminformatics", "protein-engineering"]) {
		assert.ok(ctx.calls[0][0].includes(pack), `valid packs must be named: ${pack}`);
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
	assert.equal(ctx.calls[0][1], "error");
	assert.match(ctx.calls[0][0], /broken/);
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
		assert.equal(ctx.calls[0][1], "error");
		assert.match(ctx.calls[0][0], /could not write/);
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
	assert.equal(ctx.calls[0][1], "error");
	assert.match(ctx.calls[0][0], /usage/);
	await runSkillsCommand("on", ctx);
	assert.equal(ctx.calls[1][1], "error");
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

test("the default export registers the discover hook and the command", async (t) => {
	const events = [];
	const commands = [];
	registerSkillPool({
		on: (event, handler) => events.push([event, handler]),
		registerCommand: (name, options) => commands.push([name, options]),
	});
	assert.deepEqual(events.map(([event]) => event), ["resources_discover"]);
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
