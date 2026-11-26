import fs from "node:fs";
import path from "node:path";
import { Box, Text } from "@earendil-works/pi-tui";
import type {
	CustomEntry,
	EntryRenderer,
	ExtensionAPI,
	ExtensionContext,
	SessionStartEvent,
	ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { isCalendarDate, isPlanPath, PLAN_REVISION_RE } from "./plan-object.ts";

/**
 * The notebook entry cards (spec #178, demo doctrine B1 —
 * docs/agents/demo.md): every provenance entry the recorder appends to the
 * research project's `.theta/notebook.jsonl` renders as a card in the
 * interactive transcript. The hook diffs the notebook file on every
 * `tool_result` — the recorder runs through bash, and a codemode-wrapped
 * call still surfaces one outer `tool_result` — and each new line that
 * parses as a typed, dated provenance entry (ADR 0003's five types)
 * appends one durable custom entry (`pi.appendEntry`, excluded from model
 * context) drawn by the paired `pi.registerEntryRenderer`. Line bytes are
 * the identity: re-runs and retries dedupe, malformed lines never append
 * and never render, and on extension reload the seen-set rebuilds from
 * the session's own custom entries. No notebook file — a session outside
 * a research project — leaves the hook inert, never an error. The card
 * itself is interactive-mode dressing only: custom entries land in every
 * mode (print-mode transcripts carry them — the rig-side evidence), and
 * only a TUI draws them.
 */

/** The custom entry type the cards ride — the renderer's pairing key. */
export const ENTRY_CUSTOM_TYPE = "theta-notebook-entry";

/** The notebook's location under the session cwd — the recorder's own. */
const NOTEBOOK_RELATIVE = path.join(".theta", "notebook.jsonl");

/** The five entry types (ADR 0003) and the id prefix each sequences under. */
export const TYPE_PREFIX = {
	hypothesis: "hyp",
	method: "mth",
	observation: "obs",
	decision: "dec",
	confidence: "cnf",
} as const;

export type EntryType = keyof typeof TYPE_PREFIX;

/** The evidence grades (GLOSSARY): the trust mark on a source, never on judgment. */
export const GRADES = ["asserted", "cross-checked", "re-executed"] as const;

export type EvidenceGrade = (typeof GRADES)[number];

/**
 * The two verdicts a plan-citing decision records (spec #202): both are
 * provenance — an approval and a refusal cite the plan the same way.
 */
export const DECISION_VERDICTS = ["approved", "refused"] as const;

export type DecisionVerdict = (typeof DECISION_VERDICTS)[number];

/** One evidence item as the recorder writes it — connector output or job record. */
export interface EvidenceItem {
	source: string;
	endpoints?: string[];
	query?: string | null;
	retrieved: string;
	grade: EvidenceGrade;
	snapshot?: string;
	supports?: string;
	job_id?: string;
	template?: string | null;
	state?: string;
}

/** A provenance entry as the recorder writes it — the card's input shape. */
export interface NotebookEntry {
	id: string;
	type: EntryType;
	date: string;
	text: string;
	/** The observation's own grade — an observation is itself a source claim. */
	grade?: EvidenceGrade;
	/** The hypothesis a confidence entry judges — judgment's named subject. */
	hypothesis?: string;
	/** The plan citation (spec #202): the plan a decision approves or refuses. The writer resolved it against disk before recording — never an unresolved or stale citation. */
	planPath?: string;
	/** The cited revision: the digest the decision weighs (T1's recipe). */
	planRevision?: string;
	/** The verdict on the cited plan — a refusal records too. */
	decision?: DecisionVerdict;
	/** The decision's optional free-text rationale. */
	rationale?: string;
	evidence?: EvidenceItem[];
}

function idPattern(prefix: string): RegExp {
	return new RegExp(`^${prefix}-\\d+$`);
}

/** A hypothesis reference shape — a confidence subject or a supports link. */
function isHypRef(value: unknown): value is string {
	return typeof value === "string" && idPattern("hyp").test(value);
}

function nonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value !== "";
}

/**
 * One of the three evidence grades — the badge vocabulary, shared by the
 * item's grade and the observation's own.
 */
function isGrade(value: unknown): value is EvidenceGrade {
	return typeof value === "string" && (GRADES as readonly string[]).includes(value);
}

/**
 * One evidence item, validated to the fields the card reads: a non-empty
 * source, one of the three grades, a calendar-valid retrieval date, and —
 * when a link rides it — a hypothesis id shape. The item's deeper shape
 * (endpoints, job identity, snapshot address) is the recorder's own
 * validation; the card renders what is there and requires only what it
 * names.
 */
function isEvidenceItem(value: unknown): value is EvidenceItem {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const item = value as Record<string, unknown>;
	if (!nonEmptyString(item.source)) return false;
	if (!isGrade(item.grade)) return false;
	if (typeof item.retrieved !== "string" || !isCalendarDate(item.retrieved)) return false;
	if (item.supports !== undefined && !isHypRef(item.supports)) return false;
	return true;
}

/** A non-empty evidence list — hypothesis and observation require one. */
function isEvidenceList(value: unknown): value is EvidenceItem[] {
	return (
		Array.isArray(value) &&
		value.length > 0 &&
		value.every((item) => isEvidenceItem(item))
	);
}

/**
 * The plan citation's grammar (spec #202), pinned against the shared
 * fixture entry both suites read: `planPath` names a plan object by its
 * recorded path — `.theta/plans/<plan-id>.md`, the form every plan
 * operation reports — `planRevision` is the 12-hex digest the decision
 * weighs, and `decision` is one of the two verdicts. The fields are
 * all-or-nothing on a decision entry and ride only a decision: the
 * recorder resolved the citation against disk before writing (a missing
 * plan or a stale revision never became an entry), so this validator
 * pins the shapes, not the disk state. The shapes themselves live in
 * plan-object.ts since spec #203 made the gate their second reader.
 */

function isDecisionVerdict(value: unknown): value is DecisionVerdict {
	return (
		typeof value === "string" &&
		(DECISION_VERDICTS as readonly string[]).includes(value)
	);
}

/**
 * One notebook line as a typed, dated provenance entry, or undefined: the
 * gate every diffed line crosses before it earns a card. The id must
 * carry its own type's prefix (the recorder sequences ids per type), the
 * date must name a real calendar day, and each type's own essentials must
 * hold — evidence on a hypothesis and an observation (with its own
 * grade), a named hypothesis on a confidence. Method and decision entries
 * carry evidence only when a motivating source was recorded; a confidence
 * entry never does, and extra fields beyond the card's needs are the
 * recorder's business, not the card's. A decision may cite the plan it
 * approves or refuses (spec #202): the citation fields are all-or-nothing
 * and ride only a decision.
 */
export function parseProvenanceEntry(line: string): NotebookEntry | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
	const entry = parsed as Record<string, unknown>;
	const type = entry.type;
	if (typeof type !== "string" || !(type in TYPE_PREFIX)) return undefined;
	const entryType = type as EntryType;
	if (typeof entry.id !== "string" || !idPattern(TYPE_PREFIX[entryType]).test(entry.id)) {
		return undefined;
	}
	if (typeof entry.date !== "string" || !isCalendarDate(entry.date)) return undefined;
	if (!nonEmptyString(entry.text)) return undefined;
	const evidence = entry.evidence;
	if (entryType === "hypothesis" || entryType === "observation") {
		if (!isEvidenceList(evidence)) return undefined;
	} else if (evidence !== undefined && !isEvidenceList(evidence)) {
		return undefined;
	}
	if (entryType === "observation" && !isGrade(entry.grade)) return undefined;
	if (entryType === "confidence" && !isHypRef(entry.hypothesis)) return undefined;
	const cites =
		entry.planPath !== undefined ||
		entry.planRevision !== undefined ||
		entry.decision !== undefined ||
		entry.rationale !== undefined;
	if (cites) {
		if (entryType !== "decision") return undefined;
		if (typeof entry.planPath !== "string" || !isPlanPath(entry.planPath)) {
			return undefined;
		}
		if (
			typeof entry.planRevision !== "string" ||
			!PLAN_REVISION_RE.test(entry.planRevision)
		) {
			return undefined;
		}
		if (!isDecisionVerdict(entry.decision)) return undefined;
		if (entry.rationale !== undefined && !nonEmptyString(entry.rationale)) {
			return undefined;
		}
	}
	return { ...(entry as unknown as NotebookEntry) };
}

/** One evidence item's card fields — the source line a card draws from it. */
export interface CardEvidence {
	source: string;
	/** The item's provenance detail: endpoints called, or the job's identity. */
	detail: string;
	grade: EvidenceGrade;
	/** The hypothesis this evidence supports — rendered as a card reference. */
	supports?: string;
}

/** The card's whole field set, mapped from one validated provenance entry. */
export interface CardModel {
	id: string;
	type: EntryType;
	date: string;
	text: string;
	/** The observation's own grade — grades seat on evidence items, an observation adds its own. */
	grade?: EvidenceGrade;
	evidence: CardEvidence[];
	/** The hypothesis a confidence entry judges — rendered as a card reference. */
	on?: string;
	/** The raw entry data — the expanded view shows it verbatim. */
	raw: string;
}

/**
 * One evidence item's provenance detail — the endpoints called, or the
 * job's identity. One home for the shape: the card draws it and the
 * `/notebook` table (#182) reprints it, so the detail bytes never fork
 * between the two surfaces.
 */
export function evidenceDetail(item: EvidenceItem): string {
	const retrieved = `retrieved ${item.retrieved}`;
	if (item.job_id !== undefined) {
		const template =
			item.template === undefined ? "" : ` · ${item.template === null ? "no template" : `template ${item.template}`}`;
		return `job ${item.job_id}${item.state === undefined ? "" : ` ${item.state}`}${template} · ${retrieved}`;
	}
	const endpoints =
		item.endpoints === undefined || item.endpoints.length === 0 ? "" : ` via ${item.endpoints.join(", ")}`;
	return `${retrieved}${endpoints}`;
}

/**
 * The renderer mapping: a typed entry to the card's fields. Pure and
 * string-valued — the TUI renderer styles these, the unit tests pin them,
 * and no terminal sits inside the mapping.
 */
export function cardModel(entry: NotebookEntry): CardModel {
	return {
		id: entry.id,
		type: entry.type,
		date: entry.date,
		text: entry.text,
		grade: entry.grade,
		evidence: (entry.evidence ?? []).map((item) => ({
			source: item.source,
			detail: evidenceDetail(item),
			grade: item.grade,
			supports: item.supports,
		})),
		on: entry.hypothesis,
		raw: JSON.stringify(entry, null, 2),
	};
}

/** The theme tokens the card uses — the default theme's vocabulary; B5 brands later. */
export type CardToken = "accent" | "dim";

/** The styling seam: the real renderer passes pi's theme, tests pass an identity. */
export interface CardStyle {
	fg: (token: CardToken, text: string) => string;
	bold: (text: string) => string;
}

/**
 * The card's styled lines. pi-tui's Text wraps at terminal width, so the
 * entry text carries no truncation policy here — recorder doctrine keeps
 * entries short, and v1 wraps instead of cutting.
 */
export function cardLines(model: CardModel, style: CardStyle, expanded: boolean): string[] {
	const badge = (grade: string): string => style.fg("accent", `[${grade}]`);
	const lines: string[] = [
		`${style.bold(model.id)} ${model.type} ${style.fg("dim", model.date)}`,
		model.text,
	];
	if (model.grade !== undefined) lines.push(`grade ${badge(model.grade)}`);
	for (const item of model.evidence) {
		lines.push(`evidence ${item.source} ${style.fg("dim", item.detail)} ${badge(item.grade)}`);
		if (item.supports !== undefined) {
			lines.push(`${style.fg("dim", "→")} supports ${style.bold(item.supports)}`);
		}
	}
	if (model.on !== undefined) lines.push(`judgment on ${style.bold(model.on)}`);
	if (expanded) {
		for (const rawLine of model.raw.split("\n")) lines.push(style.fg("dim", rawLine));
	}
	return lines;
}

/** The custom entry's data shape — the line is the card's whole payload. */
export interface CardData {
	line: string;
}

/** The identity style — the unit tests' stand-in for a theme. */
export const plainStyle: CardStyle = {
	fg: (_token, text) => text,
	bold: (text) => text,
};

/**
 * The entry renderer: one card per custom entry, from its line. A line
 * that no longer parses — an entry the hook would never have appended —
 * renders nothing (undefined), the same refusal at render time the diff
 * hook holds at append time.
 */
export const notebookEntryRenderer: EntryRenderer<CardData> = (entry, options, theme) => {
	const dataLine = entry.data?.line;
	if (typeof dataLine !== "string") return undefined;
	const parsed = parseProvenanceEntry(dataLine);
	if (parsed === undefined) return undefined;
	const style: CardStyle = {
		fg: (token, text) => theme.fg(token, text),
		bold: (text) => theme.bold(text),
	};
	const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
	for (const cardLine of cardLines(cardModel(parsed), style, options.expanded)) {
		box.addChild(new Text(cardLine));
	}
	return box;
};

/**
 * The notebook read: the whole file's text, or undefined when there is
 * nothing to diff — no notebook (a session outside a research project) or
 * an unreadable one. Both leave the hook inert; a card is cosmetic and
 * never an error.
 */
export type NotebookReader = (cwd: string) => string | undefined;

export const fileNotebookReader: NotebookReader = (cwd) => {
	try {
		return fs.readFileSync(path.join(cwd, NOTEBOOK_RELATIVE), "utf8");
	} catch {
		return undefined;
	}
};

/**
 * The complete lines of a notebook read. The trailing segment without its
 * newline is a torn write in flight — the recorder always terminates a
 * line — so it stays invisible until the write completes and a later read
 * sees the whole line.
 */
function completeLines(raw: string): string[] {
	const lines = raw.split("\n");
	lines.pop();
	return lines;
}

/**
 * The whole notebook as typed entries — the on-demand read the
 * `/notebook` command (#182) rides. Every complete line that parses, in
 * file order: the journal is append-only, so file order is provenance
 * order. Malformed lines skip — the same refusal the diff hook holds at
 * append time — and a torn write's tail stays invisible until its
 * newline lands. No notebook (or an unreadable one) returns undefined;
 * the caller owns the absence wording.
 */
export function readNotebookEntries(cwd: string): NotebookEntry[] | undefined {
	const raw = fileNotebookReader(cwd);
	if (raw === undefined) return undefined;
	return completeLines(raw)
		.map((line) => parseProvenanceEntry(line))
		.filter((entry): entry is NotebookEntry => entry !== undefined);
}

/** The handlers' context needs — the whole ExtensionContext narrowed to what the hook reads. */
export type CardsToolResultContext = Pick<ExtensionContext, "cwd">;

export type CardsSessionStartContext = Pick<ExtensionContext, "cwd"> & {
	sessionManager?: Pick<ExtensionContext["sessionManager"], "getEntries">;
};

/**
 * The diff state and its two handlers. The seen-set holds line bytes —
 * re-runs and retries produce the same bytes and dedupe; the append-only
 * file guarantees a line never changes once seen. `session_start` owns
 * two rebuilds at once: the set re-seeds from the session's own custom
 * entries (the cards already in the transcript — reload and resume
 * alike), and the notebook's then-current lines join them as the startup
 * backlog fence (B2 owns the trail display on demand): a session renders
 * only what lands after it opened, so an entry recorded in the session's
 * own first tool call still cards — the recorder's line postdates the
 * session-start read even when no earlier tool call exists. The first
 * diff without a session start (a host that never fired one) baselines
 * from its own read as the same fence's floor.
 */
export function createNotebookCards(
	pi: Pick<ExtensionAPI, "appendEntry">,
	reader: NotebookReader = fileNotebookReader,
): {
	onToolResult: (event: ToolResultEvent, context: CardsToolResultContext) => void;
	onSessionStart: (event: SessionStartEvent, context: CardsSessionStartContext) => void;
} {
	const seen = new Set<string>();
	let baselined = false;
	const baseline = (context: { cwd: string }): void => {
		const raw = reader(context.cwd);
		if (raw !== undefined) {
			for (const line of completeLines(raw)) seen.add(line);
		}
		baselined = true;
	};
	const diff = (context: CardsToolResultContext): void => {
		const raw = reader(context.cwd);
		if (raw === undefined) return;
		const lines = completeLines(raw);
		if (!baselined) {
			for (const line of lines) seen.add(line);
			baselined = true;
			return; // the backlog fence's floor — see createNotebookCards
		}
		for (const line of lines) {
			if (line === "" || seen.has(line)) continue;
			seen.add(line);
			if (parseProvenanceEntry(line) !== undefined) {
				pi.appendEntry(ENTRY_CUSTOM_TYPE, { line });
			}
		}
	};
	return {
		// Every tool_result, unfiltered: the recorder runs through bash, a
		// codemode-wrapped run surfaces one outer tool_result, and the read
		// is cheap. The never-throw floor is silent by design — a cosmetic
		// card must never fail a session, and print-mode boot-clean audits
		// hold stderr to zero bytes.
		onToolResult: (event, context) => {
			void event;
			try {
				diff(context);
			} catch {
				// silent floor — see above
			}
		},
		onSessionStart: (event, context) => {
			void event;
			try {
				seen.clear();
				const entries = context.sessionManager?.getEntries() ?? [];
				for (const entry of entries) {
					const custom = entry as CustomEntry<CardData> | undefined;
					if (custom?.type === "custom" && custom.customType === ENTRY_CUSTOM_TYPE) {
						const line = custom.data?.line;
						if (typeof line === "string") seen.add(line);
					}
				}
				baseline(context);
			} catch {
				// silent floor — see above
			}
		},
	};
}

export default function registerNotebookCards(pi: ExtensionAPI): void {
	const cards = createNotebookCards(pi);
	pi.on("tool_result", (event, context) => cards.onToolResult(event, context));
	pi.on("session_start", (event, context) => cards.onSessionStart(event, context));
	pi.registerEntryRenderer(ENTRY_CUSTOM_TYPE, notebookEntryRenderer);
}
