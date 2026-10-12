#!/usr/bin/env node
// Summarize one contest trial transcript: arm-state verification, routing
// classification, call timeline, and enforcement signals. Usage:
//   node prototype/analyze.mjs <session-dir-or-jsonl> [A|B]
import fs from "node:fs";
import path from "node:path";

const target = process.argv[2];
let file = target;
if (fs.statSync(target).isDirectory()) {
	file = fs.readdirSync(target).find((f) => f.endsWith(".jsonl"));
	file = path.join(target, file);
}
const arm = process.argv[3] ?? (path.basename(file).includes("protoA") ? "A" : "B");
const recs = fs
	.readFileSync(file, "utf8")
	.split("\n")
	.filter(Boolean)
	.map((l) => JSON.parse(l));

const userTs = recs.find((r) => r.message?.role === "user")?.timestamp;
let skills = [], tools = "", hasTool = false, hasSkill = false;
const calls = []; // {ts, name, detail, isError}
const results = new Map();

for (const r of recs) {
	const m = r.message;
	if (!m) continue;
	if (m.role === "system") {
		const s = m.sections?.skills ?? "";
		skills = [...s.matchAll(/<name>([^<]*)<\/name>/g)].map((x) => x[1]);
		tools = m.sections?.tools ?? "";
		hasSkill = skills.includes("theta-lit-probe");
		hasTool = tools.includes("pubmed_probe_search");
	}
	if (m.role === "assistant") {
		for (const c of m.content ?? []) {
			if (c.type === "toolCall") {
				let detail = "";
				if (c.name === "bash") detail = (c.arguments?.command ?? "").replace(/\s+/g, " ").slice(0, 140);
				else detail = JSON.stringify(c.arguments ?? {}).slice(0, 140);
				calls.push({ ts: r.timestamp, name: c.name, detail });
			}
		}
	}
	if (m.role === "toolResult") results.set(m.toolCallId, m);
}

// Routing classification over bash commands + tool calls.
const armUsed = [];
const incumbent = [];
const handRolled = [];
for (const r of recs) {
	const m = r.message;
	if (m?.role !== "assistant") continue;
	for (const c of m.content ?? []) {
		if (c.type !== "toolCall") continue;
		if (c.name === "pubmed_probe_search") armUsed.push("tool:" + c.arguments?.query);
		const cmd = c.name === "bash" ? (c.arguments?.command ?? "") : "";
		if (/theta-lit-probe|pubmed_search\.py/.test(cmd)) armUsed.push("script:" + cmd.replace(/\s+/g, " ").slice(0, 100));
		if (/paper-lookup/.test(cmd)) incumbent.push(cmd.slice(0, 100));
		if (/eutils\.ncbi\.nlm\.nih\.gov/.test(cmd) && !/pubmed_search\.py/.test(cmd)) handRolled.push(cmd.replace(/\s+/g, " ").slice(0, 100));
	}
}
for (const r of recs) {
	const m = r.message;
	if (m?.role !== "assistant") continue;
	for (const c of m.content ?? []) {
		if (c.type === "toolCall" && c.name === "read" && /paper-lookup/.test(c.arguments?.path ?? "")) incumbent.push("read:" + c.arguments.path);
	}
}

const firstArmCall = recs.find((r) => {
	const m = r.message;
	if (m?.role !== "assistant") return false;
	return (m.content ?? []).some(
		(c) => c.type === "toolCall" && (c.name === "pubmed_probe_search" || (c.name === "bash" && /theta-lit-probe|pubmed_search\.py/.test(c.arguments?.command ?? ""))),
	);
});
const ttf = firstArmCall && userTs ? ((new Date(firstArmCall.timestamp) - new Date(userTs)) / 1000).toFixed(1) + "s" : "n/a";
const errors = [...results.values()].filter((m) => m.isError);
const last = recs[recs.length - 1];
const span = ((new Date(last.timestamp) - new Date(recs[0].timestamp)) / 1000).toFixed(1);

console.log("file:", file);
console.log(`arm ${arm} | skills advertised: ${skills.length} | theta-lit-probe: ${hasSkill} | pubmed_probe_search registered: ${hasTool}`);
console.log(`span: ${span}s | tool calls: ${calls.length} | toolResults with isError: ${errors.length} | time-to-first-arm-use: ${ttf}`);
console.log("routing: arm-code used:", armUsed.length ? armUsed : "NO");
console.log("routing: paper-lookup used:", incumbent.length ? incumbent : "no");
console.log("routing: hand-rolled eutils:", handRolled.length ? handRolled : "no");
console.log("call timeline:");
for (const c of calls) console.log(" ", c.ts, c.name.padEnd(8), c.detail);
