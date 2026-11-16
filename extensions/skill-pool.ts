import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionUIContext,
	ModelRegistry,
	ResourcesDiscoverEvent,
	ResourcesDiscoverResult,
	SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import type {
	ClassifierApi,
	ClassifierAnswer,
	ClassifierBoolQuestion,
	ClassifierContext,
	ClassifierModel,
	ClassifierResult,
	JsonObject,
} from "@earendil-works/pi-ai";

/**
 * The skill pool loader (spec #160, ADR 0008): the extension that loads the
 * vendored domain packs per research project. Discovery hooks pi's
 * `resources_discover` event and contributes `pool/<pack>/<skill>` directory
 * paths for every skill in an enabled pack whose class sits in the state's
 * `classAllow` — per-skill, not per-pack, because every pack is class-mixed
 * (the disclosed deviation from ADR 0008's `pool/<pack>` letter: pack
 * granularity can never be class-pure). Selection is deterministic and
 * scan-only: the inputs are exactly the pool trees (names + existence),
 * `classes.json`, and `skills.json` — no project-content reads, no
 * heuristics, and the same three inputs always yield the same sorted
 * `skillPaths`. Every failure mode — unparsable state, unknown version,
 * unknown pack, a missing skill directory, a skill missing from the class
 * map — contributes the sound rest, skips the rest, and names each skip and
 * why in the diagnosis block `/theta:skills` prints; discovery itself never
 * throws (a zero-state or broken session contributes nothing rather than
 * failing startup).
 *
 * The Jev gate (spec #162) rides the same extension: at a keyed
 * `session_start` it reads the project notebook (`.theta/notebook.jsonl` —
 * the one project-content read, the gate's own material input, never part
 * of selection), makes one `models.classify()` call through the injected
 * seam, and may widen `classAllow` beyond `local` before discovery reads.
 * Selection itself stays scan-only: the gate's judgment is the only
 * non-deterministic input, and it lands as committed state before any
 * discovery run that honors it.
 */

/** The pool root's directory name under the package root. */
export const POOL_DIR = "pool";

/** The class map's file name inside the pool root. */
export const CLASSES_FILE = "classes.json";

/** The per-project state directory, shared with the notebook recorder. */
export const STATE_DIR = ".theta";

/** The state file under STATE_DIR. */
export const STATE_FILE = "skills.json";

/** The state shape this extension speaks; an unknown version refuses loudly. */
export const STATE_VERSION = 1;

/** History is append-on-write, keeping the last 20 entries per pack. */
export const HISTORY_CAP = 20;

/** The command's registered name — `/theta:skills`. */
export const SKILLS_COMMAND = "theta:skills";

/** The history actor for entries the command itself writes. */
export const COMMAND_ACTOR = "command:theta:skills";

/** The gate record's actor: the classifier judgment, not a human act. */
export const GATE_ACTOR = "classify:jev";

/** The classifier slot the gate resolves — the named OpenRouter Jev slot. */
export const GATE_CLASSIFIER = { provider: "openrouter", id: "typesafe/jev-1.13" } as const;

/** The auto gate fires only when classAllow is exactly this — a human widening outranks it. */
export const DEFAULT_CLASS_ALLOW = ["local"] as const;

/** The notebook's last entries feeding the classify state, capped per the spec. */
const NOTEBOOK_WINDOW = 10;

/** Each notebook entry's text cap in the classify state. */
const NOTEBOOK_TEXT_CAP = 500;

/** A bool answer at or above this probability includes the class. */
const ANSWER_THRESHOLD = 0.5;

/** Each gate question admits exactly one class — the decision's whole vocabulary. */
const QUESTION_CLASSES: Record<string, Exclude<SkillClass, "local">> = {
	"need-key": "key",
	"need-cloud": "cloud",
};

export type SkillClass = "local" | "key" | "cloud";

const SKILL_CLASSES: readonly SkillClass[] = ["local", "key", "cloud"];

/** One append-on-write history entry; the command writes these. */
export interface HistoryEntry {
	at: string;
	actor: string;
	decision: "on" | "off";
	rationale: string;
}

export interface PackState {
	enabled: boolean;
	history: HistoryEntry[];
}

/**
 * The gate record (spec #162): one top-level object in the state file, the
 * latest decision — `skills.json` is committed state, so git carries the
 * trail. `decision` is the `classAllow` the run set; the rationale is
 * composed by the gate from input counts and the answer's probability,
 * never model prose.
 */
export interface GateRecord {
	at: string;
	actor: string;
	decision: string[];
	rationale: string;
}

/**
 * The state file's shape v1 (spec #160). `classAllow` is the gate's
 * decision state from day one — the command never widens it, it only
 * toggles pack enablement. `gate` (spec #162) is optional: an S1-era file
 * without it reads fine, and its absence is the auto gate's eligibility
 * signal, so `readSkillsState` must carry it through every typed rebuild
 * or the first toggle write erases the record.
 */
export interface SkillsState {
	version: number;
	classAllow: string[];
	packs: Record<string, PackState>;
	gate?: GateRecord;
}

/** One skip, named for the diagnosis block. */
export interface Diagnosis {
	item: string;
	why: string;
}

export type StateRead =
	| { kind: "absent" }
	| { kind: "ok"; state: SkillsState }
	| { kind: "invalid"; why: string };

export type ClassesRead =
	| { kind: "absent" }
	| { kind: "ok"; classes: Record<string, SkillClass> }
	| { kind: "invalid"; why: string };

export interface PackStatus {
	name: string;
	enabled: boolean;
	/** Whether the pool carries a pack directory of this name. */
	known: boolean;
	/** Class counts from the map; undefined when the map is unreadable. */
	classMix: Partial<Record<SkillClass, number>> | undefined;
	/** Sorted skill names that would load now under the current state. */
	wouldLoad: string[];
}

export interface PoolPlan {
	/** False when the pool root is absent or carries no pack directories. */
	poolPresent: boolean;
	stateRead: StateRead;
	classesRead: ClassesRead;
	/** Sorted absolute skill-directory paths — the discovery contribution. */
	skillPaths: string[];
	diagnoses: Diagnosis[];
	packs: PackStatus[];
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * The one state-unusable message: the gate paths (skip check, run, and
 * the explicit command) share it, so the vocabulary cannot drift between
 * them — the explicit command prefixes its own "broken" reading of the
 * same why.
 */
function stateUnavailableWhy(stateRead: StateRead): string {
	return stateRead.kind === "invalid" ? `state is invalid (${stateRead.why})` : "no state file yet";
}

/**
 * The gate write's shared failure shape: the record write, the temp-file
 * cleanup, and the failure notify — one home, so the auto fire and the
 * explicit command report a failed write the same way. The success notify
 * stays at the call site, outside the try: a notify that throws must not
 * be reported as a failed write after the write already landed.
 */
function writeGateRecord(
	cwd: string,
	state: SkillsState,
	record: GateRecord,
	ui: Pick<ExtensionUIContext, "notify">,
	failurePrefix: string,
): void {
	try {
		const nextState: SkillsState = { ...state, classAllow: record.decision, gate: record };
		writeSkillsState(cwd, nextState);
	} catch (error) {
		tryUnlinkTmp(path.join(cwd, STATE_DIR, STATE_FILE));
		ui.notify(`${failurePrefix} could not write: ${errorMessage(error)}`, "warning");
	}
}

function byItem(a: Diagnosis, b: Diagnosis): number {
	return a.item < b.item ? -1 : a.item > b.item ? 1 : 0;
}

/**
 * The pool root: `pool/` beside the package root, resolved from this file's
 * own location — pi loads extension TypeScript through jiti, whose
 * `import.meta.url` names the real source file, so the resolution holds for
 * a repo checkout, an installed package, and the rig's clone alike.
 * `THETA_POOL`, when set, names the pool root instead.
 */
export function poolRoot(): string {
	const override = process.env.THETA_POOL;
	if (override !== undefined && override.trim() !== "") return override;
	return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", POOL_DIR);
}

/** Sorted child directory names; a missing or unreadable path reads as none. */
function sortedChildDirs(root: string, sub?: string): string[] {
	const dir = sub === undefined ? root : path.join(root, sub);
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	return entries
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.sort();
}

/**
 * The one read shape both JSON inputs share (the tree-wide extraction rule:
 * the second caller is where the shared helper is born): missing file reads
 * as absent, an unreadable/unparsable/non-object file reads as invalid with
 * its why, and only a JSON object reads as ok. Callers layer their own
 * vocabulary on top of the value.
 */
type JsonObjectRead =
	| { kind: "absent" }
	| { kind: "invalid"; why: string }
	| { kind: "ok"; value: Record<string, unknown> };

function readJsonObject(file: string): JsonObjectRead {
	let raw: string;
	try {
		raw = fs.readFileSync(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" };
		return { kind: "invalid", why: `unreadable (${errorMessage(error)})` };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		return { kind: "invalid", why: `unparsable JSON (${errorMessage(error)})` };
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		return { kind: "invalid", why: "not a JSON object" };
	}
	return { kind: "ok", value: parsed as Record<string, unknown> };
}

/**
 * The class map read. A map that is missing, unparsable, or carries a value
 * outside the class vocabulary is one invalid read — the sound-rest
 * discipline then contributes nothing from any enabled pack, and the
 * diagnosis block carries one aggregate line naming the file, not one line
 * per skill.
 */
export function readClassesMap(root: string): ClassesRead {
	const read = readJsonObject(path.join(root, CLASSES_FILE));
	if (read.kind !== "ok") return read;
	const classes: Record<string, SkillClass> = {};
	for (const [key, value] of Object.entries(read.value)) {
		if (!SKILL_CLASSES.includes(value as SkillClass)) {
			return {
				kind: "invalid",
				why: `unknown class value at ${key}: ${JSON.stringify(value)}`,
			};
		}
		classes[key] = value as SkillClass;
	}
	return { kind: "ok", classes };
}

/**
 * The state read, rooted at the given cwd exactly — no ancestor walk, the
 * notebook recorder's discipline (the state belongs to the research project
 * the session runs in, and a walk would silently borrow a parent's
 * selection). Absent is the ordinary zero-state session; invalid covers
 * unparsable JSON, an unknown version, and a shape that is not state v1 —
 * invalid state contributes nothing and is never partially honored.
 */
export function readSkillsState(cwd: string): StateRead {
	const read = readJsonObject(path.join(cwd, STATE_DIR, STATE_FILE));
	if (read.kind !== "ok") return read;
	const shape = read.value;
	if (shape.version !== STATE_VERSION) {
		return {
			kind: "invalid",
			why: `unknown version ${JSON.stringify(shape.version)}; this loader speaks version ${STATE_VERSION}`,
		};
	}
	if (
		!Array.isArray(shape.classAllow) ||
		!shape.classAllow.every((entry) => typeof entry === "string")
	) {
		return { kind: "invalid", why: "classAllow is not an array of strings" };
	}
	if (shape.packs === null || typeof shape.packs !== "object" || Array.isArray(shape.packs)) {
		return { kind: "invalid", why: "packs is not a JSON object" };
	}
	const packs: Record<string, PackState> = {};
	// History entries stay unvalidated beyond what the toggle needs
	// (enabled boolean, history array): the loader only re-writes them,
	// never interprets them.
	for (const [name, pack] of Object.entries(shape.packs as Record<string, unknown>)) {
		if (pack === null || typeof pack !== "object" || Array.isArray(pack)) {
			return { kind: "invalid", why: `pack ${name} is not an object` };
		}
		const packShape = pack as Record<string, unknown>;
		if (typeof packShape.enabled !== "boolean" || !Array.isArray(packShape.history)) {
			return { kind: "invalid", why: `pack ${name} is not an enabled/history object` };
		}
		packs[name] = { enabled: packShape.enabled, history: packShape.history as HistoryEntry[] };
	}
	// The gate record (spec #162), optional: validated like the rest, so a
	// typed rebuild carries it — the S1 rebuild would drop an unknown
	// top-level field, and the first /theta:skills on|off write would erase
	// the decision. An invalid gate record invalidates the state: the gate
	// is the classAllow's provenance, and a state whose record disagrees
	// with its own classAllow semantics must never be honored partially.
	const gate = validateGateRecord(shape.gate);
	if (gate.kind === "invalid") return { kind: "invalid", why: gate.why };
	return {
		kind: "ok",
		state: {
			version: STATE_VERSION,
			classAllow: shape.classAllow as string[],
			packs,
			...(gate.kind === "ok" ? { gate: gate.record } : {}),
		},
	};
}

/**
 * The gate record's own validation: an object with a string `at`, the
 * `classify:jev` actor, a string-array decision, and a string rationale.
 * Anything else is one invalid read — the record is the classAllow's
 * provenance, so a broken record must refuse the state, never load the
 * widening it claims to license. Undefined (the absent field) reads as
 * absent; every other shape is validated or refused.
 */
function validateGateRecord(value: unknown): { kind: "absent" } | { kind: "ok"; record: GateRecord } | { kind: "invalid"; why: string } {
	if (value === undefined) return { kind: "absent" };
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return { kind: "invalid", why: "gate is not a JSON object" };
	}
	const record = value as Record<string, unknown>;
	if (
		typeof record.at !== "string" ||
		record.actor !== GATE_ACTOR ||
		!Array.isArray(record.decision) ||
		!record.decision.every((entry) => typeof entry === "string") ||
		typeof record.rationale !== "string"
	) {
		return { kind: "invalid", why: "gate is not an at/actor/decision/rationale record" };
	}
	return { kind: "ok", record: value as GateRecord };
}

function mixFor(
	classes: Record<string, SkillClass>,
	pack: string,
): Partial<Record<SkillClass, number>> {
	const mix: Partial<Record<SkillClass, number>> = {};
	for (const [key, cls] of Object.entries(classes)) {
		if (!key.startsWith(`${pack}/`)) continue;
		mix[cls] = (mix[cls] ?? 0) + 1;
	}
	return mix;
}

/**
 * The loader's whole decision, computed fresh on every call — discovery and
 * the status command share this one plan, so what the status table shows is
 * exactly what discovery would contribute. Same pool tree + same state file
 * + same class map → byte-identical sorted `skillPaths` (the determinism
 * pin): every name list is sorted, and nothing beyond the three inputs
 * enters the computation.
 */
export function planPoolLoading(root: string, cwd: string): PoolPlan {
	const poolDirs = sortedChildDirs(root);
	const poolPresent = poolDirs.length > 0;
	const classesRead = readClassesMap(root);
	const stateRead = readSkillsState(cwd);
	const diagnoses: Diagnosis[] = [];
	const skillPaths: string[] = [];
	const packStatuses: PackStatus[] = [];

	const state = stateRead.kind === "ok" ? stateRead.state : undefined;
	const classes = classesRead.kind === "ok" ? classesRead.classes : undefined;
	if (poolPresent) {
		if (classesRead.kind === "absent") {
			diagnoses.push({
				item: CLASSES_FILE,
				why: "missing in the pool root — no skill can pass the class filter",
			});
		} else if (classesRead.kind === "invalid") {
			diagnoses.push({
				item: CLASSES_FILE,
				why: `${classesRead.why} — no skill can pass the class filter`,
			});
		}
		if (stateRead.kind === "invalid") {
			diagnoses.push({
				item: `${STATE_DIR}/${STATE_FILE}`,
				why: `${stateRead.why} — nothing loads until it is fixed or removed`,
			});
		}
	}

	// Status rows cover the union of the pool's packs and the state's packs,
	// sorted; a state row whose pack the pool lacks carries its diagnosis.
	const names = [
		...new Set([...poolDirs, ...(state !== undefined ? Object.keys(state.packs) : [])]),
	].sort();
	for (const name of names) {
		const poolHas = poolDirs.includes(name);
		const packState = state?.packs[name];
		const enabled = packState?.enabled === true;
		const wouldLoad: string[] = [];
		if (enabled && poolHas && classes !== undefined) {
			const skillDirs = sortedChildDirs(root, name);
			const mapped = [
				...new Set(
					Object.keys(classes)
						.filter((key) => key.startsWith(`${name}/`))
						.map((key) => key.slice(name.length + 1)),
				),
			].sort();
			for (const skill of [...new Set([...skillDirs, ...mapped])].sort()) {
				const key = `${name}/${skill}`;
				if (!skillDirs.includes(skill)) {
					diagnoses.push({
						item: key,
						why: "the class map names it but no such directory exists in the pool",
					});
					continue;
				}
				const cls = classes[key];
				if (cls === undefined) {
					diagnoses.push({ item: key, why: "on disk but the class map has no entry for it" });
					continue;
				}
				if (state !== undefined && state.classAllow.includes(cls)) {
					wouldLoad.push(skill);
					skillPaths.push(path.join(root, name, skill));
				}
			}
		}
		if (enabled && !poolHas) {
			diagnoses.push({
				item: name,
				why: `enabled in ${STATE_DIR}/${STATE_FILE} but the pool has no such pack`,
			});
		}
		packStatuses.push({
			name,
			enabled,
			known: poolHas,
			classMix: classes === undefined ? undefined : mixFor(classes, name),
			wouldLoad,
		});
	}
	return {
		poolPresent,
		stateRead,
		classesRead,
		skillPaths: skillPaths.sort(),
		diagnoses: diagnoses.sort(byItem),
		packs: packStatuses,
	};
}

/**
 * The classify seam (spec #162): the gate's whole reach into the
 * classifier, one injected function pair. The default resolves the
 * classifier slot and calls `ctx.modelRegistry.classify()`; the keyless
 * test suite injects its own, so the whole suite runs without the key —
 * and the spy pin (no keyless path ever reached the classifier) holds by
 * construction. Named export, the S1 jiti pattern: the test imports this
 * module's exports through jiti exactly like pi loads the extension.
 * The types are pi's own (`ClassifierContext`/`ClassifierResult`) — the
 * seam promises no more than the API it wraps.
 */
export type Classify = (context: ClassifierContext) => Promise<ClassifierResult>;

/** The bool question the gate asks — the only question shape it sends. */
export type BoolQuestion = ClassifierBoolQuestion;

/**
 * The gate's runtime reach, injected as one object so the tests (and any
 * future caller) swap the whole classifier surface in one argument.
 */
export interface GateSeam {
	/** Whether the session is keyed — the slot resolves with working credentials. */
	keyed: () => Promise<boolean>;
	/** One classify call over the state and its questions. */
	classify: Classify;
}

/**
 * The live seam: `getAvailableOfType("classifier", "openrouter")` — the
 * credential-aware probe, never a bare catalog find (a find would
 * "resolve" on a host whose openrouter entry carries a dead key, and the
 * gate would fire-and-fail there). Keyed-ness and the call share one
 * resolution — the probe's own catalog entry is the model object
 * `classify()` wants. The gate reaches the classifier only through
 * `ctx.modelRegistry.classify()` — pi resolves auth, and theta code
 * never sees the key.
 */
export function liveGateSeam(
	registry: Pick<ModelRegistry, "getAvailableOfType" | "classify">,
): GateSeam {
	return {
		keyed: async () => (await pickClassifierEntry(registry, GATE_CLASSIFIER)) !== undefined,
		classify: async (context) => {
			// The slot resolved at keyed() time may have gone by call time;
			// re-resolving keeps undefined honest here too.
			const entry = await pickClassifierEntry(registry, GATE_CLASSIFIER);
			if (entry === undefined) {
				throw new Error(`classifier slot ${GATE_CLASSIFIER.provider}/${GATE_CLASSIFIER.id} did not resolve`);
			}
			return registry.classify(entry, context);
		},
	} satisfies GateSeam;
}

/** The probe's resolved catalog entry for the slot, when it resolves. */
async function pickClassifierEntry(
	registry: Pick<ModelRegistry, "getAvailableOfType">,
	slot: { provider: string; id: string },
): Promise<ClassifierModel<ClassifierApi> | undefined> {
	const available = await registry.getAvailableOfType("classifier", slot.provider);
	return available.find((model) => model.id === slot.id);
}

/** The notebook's file name under STATE_DIR. */
export const NOTEBOOK_FILE = "notebook.jsonl";

/** One notebook entry's readable shape for the classify state. */
export interface NotebookSlice {
	type: string;
	text: string;
}

/**
 * The notebook's last NOTEBOOK_WINDOW entries, each entry's text capped at
 * NOTEBOOK_TEXT_CAP characters. A missing notebook reads as none; a line
 * that does not parse is skipped, never fatal — the gate's material check
 * (at least one entry) is what skips the fire, and a corrupt line must
 * not sink the sound rest.
 */
export function readNotebookSlice(cwd: string): NotebookSlice[] {
	let raw: string;
	try {
		raw = fs.readFileSync(path.join(cwd, STATE_DIR, NOTEBOOK_FILE), "utf8");
	} catch {
		return [];
	}
	const slices: NotebookSlice[] = [];
	for (const line of raw.split("\n")) {
		if (line.trim() === "") continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			continue;
		}
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) continue;
		const entry = parsed as Record<string, unknown>;
		if (typeof entry.text !== "string") continue;
		slices.push({
			type: typeof entry.type === "string" ? entry.type : "",
			text: entry.text.slice(0, NOTEBOOK_TEXT_CAP),
		});
	}
	return slices.slice(-NOTEBOOK_WINDOW);
}

/** The enabled pack names, sorted — the classify state's other input. */
function enabledPackNames(state: SkillsState): string[] {
	return Object.entries(state.packs)
		.filter(([, pack]) => pack.enabled)
		.map(([name]) => name)
		.sort();
}

/**
 * The gate's material check: everything the auto fire requires, the first
 * miss named for the status block. `stateRead` ok, at least one pack
 * enabled, the notebook carries at least one entry, no gate record, and
 * classAllow exactly the default — the last condition keeps a
 * hand-widened set safe: a human decision outranks the automatic fire,
 * and the auto gate never clobbers it.
 */
export function gateSkipReason(
	stateRead: StateRead,
	notebook: NotebookSlice[],
): string | undefined {
	if (stateRead.kind !== "ok") return stateUnavailableWhy(stateRead);
	const state = stateRead.state;
	const enabled = enabledPackNames(state);
	if (enabled.length === 0) return "no pack is enabled";
	if (notebook.length === 0) return `no notebook entries in ${STATE_DIR}/${NOTEBOOK_FILE}`;
	if (state.gate !== undefined) return "the gate has already run for this project";
	if (JSON.stringify(state.classAllow) !== JSON.stringify([...DEFAULT_CLASS_ALLOW])) {
		return `classAllow was hand-widened (${state.classAllow.join(", ")})`;
	}
	return undefined;
}

/** The need-key question, at the auto ceiling. */
const NEED_KEY_QUESTION = {
	type: "bool" as const,
	instructions:
		"Does this recorded research need skills that carry their own credential (an API key or account login) beyond the local set?",
	criteria: {
		true: "The recorded research needs credential-bearing skills beyond the local set",
		false: "The recorded research does not show that need",
	},
};

/** The need-cloud question, at the full ceiling. */
const NEED_CLOUD_QUESTION = {
	type: "bool" as const,
	instructions:
		"Does this recorded research need skills whose use is metered spend (paid per use) beyond the local set?",
	criteria: {
		true: "The recorded research needs metered-spend skills beyond the local set",
		false: "The recorded research does not show that need",
	},
};

/**
 * One gate run — the shared body of the auto fire and the explicit
 * command runs. The ceiling names the questions: the auto ceiling asks
 * `need-key` only; the full ceiling asks `need-key` and `need-cloud`.
 * The decision is `local` plus each answer at or above the threshold,
 * exactly the ceiling's vocabulary; the rationale is composed by the
 * gate — input counts, the question asked, the answer with its
 * probability — never model prose (the classify API returns only
 * probabilities and confidence; there are no Jev words to quote).
 * A failed call (a transport error, or a stopReason error result — an
 * answer, not a throw) widens nothing and records nothing: no decision
 * landed, so the eligibility signal stays absent, and the next keyed
 * session start tries again.
 */
export async function runGate(
	seam: GateSeam,
	cwd: string,
	ceiling: "auto" | "cloud",
): Promise<{ kind: "ok"; record: GateRecord; classAllow: string[] } | { kind: "failed"; why: string }> {
	const stateRead = readSkillsState(cwd);
	if (stateRead.kind !== "ok") {
		return { kind: "failed", why: stateUnavailableWhy(stateRead) };
	}
	const notebook = readNotebookSlice(cwd);
	const enabled = enabledPackNames(stateRead.state);
	const questions: Record<string, ClassifierBoolQuestion> = {
		"need-key": NEED_KEY_QUESTION,
	};
	if (ceiling === "cloud") questions["need-cloud"] = NEED_CLOUD_QUESTION;
	let result: ClassifierResult;
	try {
		// The classify state is pi's JsonObject: the notebook slice rides as
		// JSON objects (type + text), not as the typed interface — the wire
		// shape is the contract, and the interface is the reader's.
		const notebookJson: JsonObject[] = notebook.map((entry) => ({
			type: entry.type,
			text: entry.text,
		}));
		result = await seam.classify({
			state: {
				notebook: notebookJson,
				packs: enabled,
			},
			questions,
		});
	} catch (error) {
		return { kind: "failed", why: `classify call failed: ${errorMessage(error)}` };
	}
	if (result.stopReason !== "stop") {
		return {
			kind: "failed",
			why: `classify answered stopReason ${result.stopReason}${result.errorMessage !== undefined ? ` (${result.errorMessage})` : ""}`,
		};
	}
	const classAllow: string[] = [...DEFAULT_CLASS_ALLOW];
	const rationaleParts: string[] = [
		`notebook ${notebook.length} entries`,
		`packs ${enabled.length > 0 ? enabled.join(", ") : "none"}`,
	];
	for (const question of Object.keys(questions)) {
		const answer: ClassifierAnswer | undefined = result.answers[question];
		// The answer is checked, never cast: pi's ClassifierAnswer is a
		// union, and a non-bool answer to a bool question is a failed run,
		// not a probability to read off a wrong shape.
		if (answer === undefined) {
			return { kind: "failed", why: `classify answered no ${question}` };
		}
		if (answer.type !== "bool") {
			return { kind: "failed", why: `classify answered ${question} as ${answer.type}, not bool` };
		}
		const probability = answer.probability;
		// The decision stays within the ceiling's vocabulary: each question
		// admits exactly its class, and `local` is always there — the run
		// sets classAllow to exactly its decision.
		const admitted = QUESTION_CLASSES[question];
		if (admitted !== undefined && probability >= ANSWER_THRESHOLD && !classAllow.includes(admitted)) {
			classAllow.push(admitted);
		}
		rationaleParts.push(`${question} p=${probability.toFixed(2)}`);
	}
	return {
		kind: "ok",
		record: {
			at: new Date().toISOString(),
			actor: GATE_ACTOR,
			decision: classAllow,
			rationale: rationaleParts.join("; "),
		},
		classAllow,
	};
}

/**
 * The auto fire at a keyed session start (any reason): check the material,
 * one classify call at the auto ceiling, write the record. The write
 * lands before `resources_discover` reads — pi awaits session_start
 * handlers first — so the widening applies to the firing session with no
 * /reload. Concurrent first starts may both fire; the atomic write keeps
 * one record. Keyless (the slot cannot resolve) skips silently — the
 * status block names the project-side material misses only, since a
 * keyless host is not a project fact. The never-throw floor owns the
 * whole hook — the try wraps everything, so a gate bug degrades to a
 * warning notify, never a failed startup.
 */
export async function autoFireGate(
	event: Pick<SessionStartEvent, "reason">,
	ctx: Pick<ExtensionContext, "cwd" | "ui" | "modelRegistry">,
	seam: GateSeam = liveGateSeam(ctx.modelRegistry),
): Promise<void> {
	void event; // any reason fires — the record is the once-per-project signal
	try {
		// One read feeds the skip check and the run: the write lands over
		// the same state it judged, so a concurrent toggle's write is never
		// silently erased by a stale read here.
		const stateRead = readSkillsState(ctx.cwd);
		const skip = gateSkipReason(stateRead, readNotebookSlice(ctx.cwd));
		if (skip !== undefined || stateRead.kind !== "ok") return;
		let keyed: boolean;
		try {
			keyed = await seam.keyed();
		} catch {
			return; // the probe itself failed — keyless for all the gate knows
		}
		if (!keyed) return;
		const run = await runGate(seam, ctx.cwd, "auto");
		if (run.kind === "failed") {
			ctx.ui.notify(`/${SKILLS_COMMAND} gate did not run: ${run.why}`, "warning");
			return;
		}
		writeGateRecord(ctx.cwd, stateRead.state, run.record, ctx.ui, `/${SKILLS_COMMAND} gate`);
		ctx.ui.notify(
			`/${SKILLS_COMMAND} gate: classAllow is now ${run.classAllow.join(", ")} — the record is in ${STATE_DIR}/${STATE_FILE}`,
			"info",
		);
	} catch (error) {
		ctx.ui.notify(`/${SKILLS_COMMAND} gate did not run: ${errorMessage(error)}`, "warning");
	}
}

export async function discoverPoolSkills(
	event: Pick<ResourcesDiscoverEvent, "cwd">,
): Promise<ResourcesDiscoverResult> {
	try {
		return { skillPaths: planPoolLoading(poolRoot(), event.cwd).skillPaths };
	} catch (error) {
		// never-throw backstop — see above
		console.error(`[${SKILLS_COMMAND}] discovery failed: ${errorMessage(error)}`);
		return { skillPaths: [] };
	}
}

/**
 * The command's full context: the toggle and status need cwd + ui; the
 * gate subcommands additionally reach the model registry (the classify
 * seam's live home).
 */
type SkillsContext = Pick<ExtensionCommandContext, "cwd" | "ui" | "modelRegistry">;

function renderStatus(ctx: SkillsContext): void {
	const root = poolRoot();
	const plan = planPoolLoading(root, ctx.cwd);
	if (!plan.poolPresent) {
		ctx.ui.notify("no pool in this install", "info");
		return;
	}
	const lines: string[] = [];
	lines.push(`skill pool — ${root}`);
	lines.push("");
	lines.push(`${"pack".padEnd(24)}${"enabled".padEnd(9)}${"class mix".padEnd(28)}load now`);
	for (const pack of plan.packs) {
		const mix =
			pack.classMix === undefined
				? "unknown"
				: (SKILL_CLASSES.filter((cls) => (pack.classMix?.[cls] ?? 0) > 0)
						.map((cls) => `${pack.classMix?.[cls]} ${cls}`)
						.join(", ") || "none");
		const suffix = pack.known ? "" : " (not in the pool)";
		lines.push(
			`${pack.name.padEnd(24)}${(pack.enabled ? "yes" : "no").padEnd(9)}${mix.padEnd(28)}${pack.wouldLoad.length}${suffix}`,
		);
	}
	if (plan.stateRead.kind === "absent") {
		lines.push("");
		lines.push(
			`no ${STATE_DIR}/${STATE_FILE} in this project — nothing loads; /${SKILLS_COMMAND} on <pack> enables one`,
		);
	}
	// The gate line (spec #162): the record or its absence, plus the auto
	// gate's skip reason when it lacks material — the status block names
	// the miss, so a silent skip is never a mystery.
	lines.push("");
	if (plan.stateRead.kind === "ok" && plan.stateRead.state.gate !== undefined) {
		const gate = plan.stateRead.state.gate;
		lines.push(`gate: ${gate.actor} → ${gate.decision.join(", ")} at ${gate.at}`);
	} else {
		lines.push("gate: not yet run");
	}
	if (plan.stateRead.kind === "ok" && plan.stateRead.state.gate === undefined) {
		const skip = gateSkipReason(plan.stateRead, readNotebookSlice(ctx.cwd));
		if (skip !== undefined) lines.push(`gate: ${skip}`);
	}
	if (plan.diagnoses.length > 0) {
		lines.push("");
		lines.push("skipped:");
		for (const diagnosis of plan.diagnoses) {
			lines.push(`  ${diagnosis.item} — ${diagnosis.why}`);
		}
	}
	lines.push("");
	lines.push("changes apply after /reload");
	ctx.ui.notify(lines.join("\n"), "info");
}

/**
 * Atomic write: the payload lands in a sibling temp file and renames over
 * the target — a crash mid-write leaves the old state standing, never a
 * truncated one.
 */
function writeSkillsState(cwd: string, state: SkillsState): void {
	const dir = path.join(cwd, STATE_DIR);
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, STATE_FILE);
	const tmp = `${file}.tmp`;
	fs.writeFileSync(tmp, `${JSON.stringify(state, null, "\t")}\n`);
	fs.renameSync(tmp, file);
}

function tryUnlinkTmp(file: string): void {
	try {
		fs.unlinkSync(`${file}.tmp`);
	} catch {
		// best-effort cleanup — the write error is the report
	}
}

function togglePack(decision: "on" | "off", pack: string, ctx: SkillsContext): void {
	const root = poolRoot();
	const poolPacks = sortedChildDirs(root);
	if (poolPacks.length === 0) {
		ctx.ui.notify("no pool in this install", "info");
		return;
	}
	if (!poolPacks.includes(pack)) {
		ctx.ui.notify(`unknown pack "${pack}" — valid packs: ${poolPacks.join(", ")}`, "error");
		return;
	}
	const read = readSkillsState(ctx.cwd);
	if (read.kind === "invalid") {
		ctx.ui.notify(
			`${STATE_DIR}/${STATE_FILE} is broken (${read.why}) — fix or remove it before toggling`,
			"error",
		);
		return;
	}
	const state: SkillsState =
		read.kind === "ok"
			? read.state
			: { version: STATE_VERSION, classAllow: ["local"], packs: {} };
	const current = state.packs[pack] ?? { enabled: false, history: [] };
	const entry: HistoryEntry = {
		at: new Date().toISOString(),
		actor: COMMAND_ACTOR,
		decision,
		// The command line is the why for a manual toggle; the gate writes
		// its own record top-level (spec #162's disclosed deviation from
		// #160's letter: the decision is class-level, not pack-level).
		rationale: `/${SKILLS_COMMAND} ${decision} ${pack}`,
	};
	const nextState: SkillsState = {
		...state,
		packs: {
			...state.packs,
			[pack]: {
				enabled: decision === "on",
				history: [...current.history, entry].slice(-HISTORY_CAP),
			},
		},
	};
	try {
		writeSkillsState(ctx.cwd, nextState);
	} catch (error) {
		tryUnlinkTmp(path.join(ctx.cwd, STATE_DIR, STATE_FILE));
		ctx.ui.notify(
			`could not write ${STATE_DIR}/${STATE_FILE}: ${errorMessage(error)}`,
			"error",
		);
		return;
	}
	ctx.ui.notify(
		decision === "on"
			? `${pack} on — run /reload to load its skills`
			: `${pack} off — run /reload to unload its skills`,
		"info",
	);
}

/**
 * The explicit gate run (spec #162): `/theta:skills gate` re-runs the
 * judgment at the auto ceiling (`need-key` only); `gate cloud` runs the
 * full ceiling — one call, two questions, decision = `local` + answers.
 * The owner's invocation is the spend approval ADR 0008 requires for
 * cloud; Jev's answer is the judgment — a `need-cloud` refusal means the
 * recorded research does not show the need yet, and cloud stays out. The
 * run's decision lands within its ceiling: a plain `gate` re-run after a
 * cloud approval narrows honestly to `local`+`key` — the owner asked for
 * the key-ceiling judgment; re-asking cloud is `gate cloud`. Any run
 * sets `classAllow` to exactly its decision — never widen-only — and the
 * record and `classAllow` never disagree. Non-interactive like the rest
 * of the command: no `ui.confirm`, identical in interactive, print, and
 * RPC. The reply tells the user to run `/reload` (the command runs
 * mid-session, after discovery fired).
 */
async function runExplicitGate(ceiling: "auto" | "cloud", ctx: SkillsContext): Promise<void> {
	const stateRead = readSkillsState(ctx.cwd);
	if (stateRead.kind !== "ok") {
		const why = stateRead.kind === "invalid" ? `state is broken (${stateRead.why})` : "no state file yet";
		ctx.ui.notify(`gate: ${why} — fix or remove it first`, "error");
		return;
	}
	const seam = liveGateSeam(ctx.modelRegistry);
	const run = await runGate(seam, ctx.cwd, ceiling);
	if (run.kind === "failed") {
		ctx.ui.notify(`gate did not run: ${run.why} — the record is unchanged; retry later`, "error");
		return;
	}
	writeGateRecord(ctx.cwd, stateRead.state, run.record, ctx.ui, "gate");
	ctx.ui.notify(
		`gate: classAllow is now ${run.classAllow.join(", ")} (${run.record.rationale}) — run /reload to apply it`,
		"info",
	);
}

/**
 * The `/theta:skills` handler — non-interactive by construction: notify
 * only, no `ui.select`, so interactive, print, and RPC sessions behave
 * identically. Bare prints the status table plus the diagnosis block and
 * the gate line; `on <pack>` / `off <pack>` toggles one pack
 * (append-on-write history, atomic write) and answers with the
 * `/reload` instruction — discovery re-fires with reason "reload" and
 * re-reads the state file; `gate` / `gate cloud` runs the explicit
 * judgment (above).
 */
export async function runSkillsCommand(args: string, ctx: SkillsContext): Promise<void> {
	try {
		const tokens = args.trim().split(/\s+/).filter((token) => token !== "");
		const command = tokens[0];
		if (command === undefined) {
			renderStatus(ctx);
			return;
		}
		if ((command === "on" || command === "off") && tokens.length === 2) {
			togglePack(command, tokens[1], ctx);
			return;
		}
		if (command === "gate" && tokens.length === 1) {
			await runExplicitGate("auto", ctx);
			return;
		}
		if (command === "gate" && tokens.length === 2 && tokens[1] === "cloud") {
			await runExplicitGate("cloud", ctx);
			return;
		}
		ctx.ui.notify(
			`usage: /${SKILLS_COMMAND} — or /${SKILLS_COMMAND} on <pack> | off <pack> | gate | gate cloud`,
			"error",
		);
	} catch (error) {
		// The never-throw floor, mirroring discovery's backstop: a bug in the
		// command degrades to an error notice, never a thrown handler.
		ctx.ui.notify(`/${SKILLS_COMMAND} failed: ${errorMessage(error)}`, "error");
	}
}

export default function registerSkillPool(pi: ExtensionAPI) {
	pi.on("resources_discover", (event) => discoverPoolSkills(event));
	pi.on("session_start", (event, ctx) => autoFireGate(event, ctx));
	pi.registerCommand(SKILLS_COMMAND, {
		description: "Show and toggle the skill pool packs this project loads",
		handler: (args, ctx) => runSkillsCommand(args, ctx),
	});
}
