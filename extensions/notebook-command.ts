import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	GRADES,
	evidenceDetail,
	readNotebookEntries,
	type EvidenceGrade,
	type NotebookEntry,
} from "./notebook-cards.ts";

/**
 * The /notebook command (spec #182, demo doctrine B2 —
 * docs/agents/demo.md): the project notebook rendered on demand —
 * entries table, evidence grades, dates. The handler reads
 * `.theta/notebook.jsonl` from the session cwd through the cards
 * extension's exported grammar (one home for the validator, the read,
 * and the evidence detail — extensions/notebook-cards.ts) and maps the
 * entries to aligned rows. Output is notify-only, never a blocking
 * dialog, the doctrine's mode constraint for commands: complete in
 * interactive mode, forwarded in RPC, a silent no-op in print and JSON.
 * The whole table rides one notify — pi's interactive mode draws an info
 * notify as a status text a following notify overwrites in place, so a
 * line-by-line table would collapse to its last line. No notebook — a
 * session outside a research project — notifies the absence, never an
 * error. The command owns what the cards' startup backlog fence skips:
 * the whole journal renders on demand, in file order — the notebook is
 * append-only, so file order is provenance order.
 */

/** The command's invocation name — /notebook. */
export const NOTEBOOK_COMMAND_NAME = "notebook";

/** The absence wording — a session outside a research project. */
export const NO_NOTEBOOK_MESSAGE = "No project notebook in this directory";

/** The row's text column: 40 characters, ellipsis when longer. */
const TEXT_WIDTH = 40;

/** The row's fixed columns: ids sequence to four digits, "observation" is the longest type. */
const ID_WIDTH = 8;
const TYPE_WIDTH = 11;

/** The row's text column — the observation's grade leads, a confidence names its subject. */
function rowText(entry: NotebookEntry): string {
	if (entry.type === "observation") return `[${entry.grade}] ${entry.text}`;
	if (entry.type === "confidence") return `judgment on ${entry.hypothesis} - ${entry.text}`;
	return entry.text;
}

function truncate(text: string): string {
	return text.length > TEXT_WIDTH ? `${text.slice(0, TEXT_WIDTH)}...` : text;
}

/**
 * The grade totals across the trail — every evidence item's grade plus
 * the observations' own (an observation is itself a source claim). A
 * grade nothing carries stays off the header; a trail with no grades at
 * all carries no grades clause.
 */
function gradeTotals(entries: NotebookEntry[]): string {
	const counts = new Map<EvidenceGrade, number>();
	const count = (grade: EvidenceGrade): void => {
		counts.set(grade, (counts.get(grade) ?? 0) + 1);
	};
	for (const entry of entries) {
		if (entry.type === "observation" && entry.grade !== undefined) count(entry.grade);
		for (const item of entry.evidence ?? []) count(item.grade);
	}
	return GRADES.filter((grade) => (counts.get(grade) ?? 0) > 0)
		.map((grade) => `${counts.get(grade)} ${grade}`)
		.join(", ");
}

/**
 * The notebook table: a header line (entry count, grade totals), then
 * one aligned row per entry in file order with each entry's evidence
 * items as indented lines badged with their grades. Pure and
 * string-valued — the unit tests pin the bytes, and no terminal sits
 * inside the mapping. Unstyled: B5 brands later.
 */
export function notebookTable(entries: NotebookEntry[]): string[] {
	const count = `${entries.length} ${entries.length === 1 ? "entry" : "entries"}`;
	const totals = gradeTotals(entries);
	const header =
		totals === "" ? `Theta notebook - ${count}` : `Theta notebook - ${count} - grades: ${totals}`;
	const lines = [header];
	for (const entry of entries) {
		lines.push(
			`${entry.id.padEnd(ID_WIDTH)}  ${entry.type.padEnd(TYPE_WIDTH)}  ${entry.date}  ${truncate(rowText(entry))}`,
		);
		for (const item of entry.evidence ?? []) {
			lines.push(`  ${item.source} [${item.grade}] ${evidenceDetail(item)}`);
			if (item.supports !== undefined) lines.push(`    supports ${item.supports}`);
		}
	}
	return lines;
}

/** The handler's notify channel — the only UI surface the command touches. */
export type CommandNotify = (message: string, level: "info" | "warning" | "error") => void;

/** The whole-notebook read — the cards extension's helper by default, injectable in tests. */
export type CommandReader = (cwd: string) => NotebookEntry[] | undefined;

/**
 * The command's core, notify and reader injected: reads the notebook and
 * renders it, or notifies the absence. Total by construction — the
 * reader returns undefined on any read failure, and the mapping is pure —
 * so a deliberate invocation never throws.
 */
export function createNotebookCommand(
	notify: CommandNotify,
	reader: CommandReader = readNotebookEntries,
): (cwd: string) => void {
	return (cwd) => {
		const entries = reader(cwd);
		if (entries === undefined) {
			notify(NO_NOTEBOOK_MESSAGE, "info");
			return;
		}
		notify(notebookTable(entries).join("\n"), "info");
	};
}

export default function registerNotebookCommand(pi: ExtensionAPI): void {
	pi.registerCommand(NOTEBOOK_COMMAND_NAME, {
		description: "Show the project notebook: entries, grades, dates",
		handler: async (_args, ctx) => {
			createNotebookCommand((message, level) => ctx.ui.notify(message, level))(ctx.cwd);
		},
	});
}
