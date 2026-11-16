import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ResourcesDiscoverEvent,
	ResourcesDiscoverResult,
} from "@earendil-works/pi-coding-agent";

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

export type SkillClass = "local" | "key" | "cloud";

const SKILL_CLASSES: readonly SkillClass[] = ["local", "key", "cloud"];

/** One append-on-write history entry; S2's classify gate appends its own. */
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
 * The state file's shape v1 (spec #160). `classAllow` is the S2 gate's
 * decision state from day one — the command never widens it, it only
 * toggles pack enablement.
 */
export interface SkillsState {
	version: number;
	classAllow: string[];
	packs: Record<string, PackState>;
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
	// History entries stay unvalidated beyond object-ness: S2's classify gate
	// appends entries of its own, and the loader only re-writes them.
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
	return {
		kind: "ok",
		state: { version: STATE_VERSION, classAllow: shape.classAllow as string[], packs },
	};
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
 * The `resources_discover` handler: the plan's sorted skillPaths, nothing
 * else. The backstop catch is the never-throw floor — planPoolLoading is
 * written to catch its own failure modes, but a bug in it must degrade to an
 * empty contribution rather than fail session startup; the status command
 * recomputes the same plan, so the diagnosis block stays the user-visible
 * surface for whatever went wrong.
 */
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

/** The command context the handler needs — cwd for the state, ui for output. */
type SkillsContext = Pick<ExtensionCommandContext, "cwd" | "ui">;

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
		// The command line is the why for a manual toggle; S2's classify gate
		// writes the classifier's own reason into this field.
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
 * The `/theta:skills` handler — non-interactive by construction: notify
 * only, no `ui.select`, so interactive, print, and RPC sessions behave
 * identically. Bare prints the status table plus the diagnosis block;
 * `on <pack>` / `off <pack>` toggles one pack (append-on-write history,
 * atomic write) and answers with the `/reload` instruction — discovery
 * re-fires with reason "reload" and re-reads the state file.
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
		ctx.ui.notify(
			`usage: /${SKILLS_COMMAND} — or /${SKILLS_COMMAND} on <pack> | off <pack>`,
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
	pi.registerCommand(SKILLS_COMMAND, {
		description: "Show and toggle the skill pool packs this project loads",
		handler: (args, ctx) => runSkillsCommand(args, ctx),
	});
}
