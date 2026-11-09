#!/usr/bin/env node
// The eval-capture tool (spec #133, ADR 0007): the operator step that
// records a scenario from the checked-in list in the clean-room rig and
// lands its sanitized fixture. Never a user path — captures are the
// replay net's evidence pipeline, dogfood-shaped: the rig gates on a
// clean tree, the auditor legs attest the live session, and the land step
// turns the evidence dir into the committed fixture triple (session.jsonl
// + provenance.json under test/eval/fixtures/<id>/, snapshot under
// test/eval/snapshots/).
//
//   node test/eval/capture.mjs rig <scenario-id>
//     Drive test/rig/run.mjs with the scenario's own prompt and legs, an
//     isolated evidence dir, and a 600s bound. The prompt comes from the
//     scenario list, so the capture is deliberate, prompt for prompt.
//
//   node test/eval/capture.mjs land <scenario-id> <evidence-dir>
//     Sanitize the recording (the golden-fixture recipe: the session's
//     checkout root becomes __REPO__, host machine paths and the provider
//     key must be absent — the operator reviews payload redaction before
//     the per-capture sign-off the PR body records), then write the
//     fixture, its provenance manifest (one digest per model-visible
//     surface class, computed against the capture's HEAD), and the
//     committed snapshot.
//
// The land step refuses evidence whose pre-head is not this tree's HEAD:
// digests must be computed against the bytes the session actually saw
// (the session-evidence precedent), so land before the tree moves again.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseSessionEntries } from "@earendil-works/pi-coding-agent";
import { run } from "../../scripts/dogfood-gates.mjs";
import { readSessionEvidence } from "../../scripts/session-evidence.mjs";
import { normalizeTree } from "./normalize.mjs";
import { SCENARIOS } from "./scenarios.mjs";
import { surfaceDigest } from "./surfaces.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function fail(message) {
	console.error(`eval-capture: ${message}`);
	process.exit(1);
}

function scenarioById(id) {
	const scenario = SCENARIOS.find((s) => s.id === id);
	if (scenario === undefined) fail(`unknown scenario id: ${id} (the checked-in list is the source)`);
	return scenario;
}

function runRig(scenario) {
	const evidenceDir = path.join(
		homedir(),
		".theta-evidence",
		`eval-${scenario.id}-${new Date().toISOString().replaceAll(/[-:]/g, "").slice(0, 15)}`,
	);
	mkdirSync(evidenceDir, { recursive: true });
	const args = [
		path.join(repoRoot, "test/rig/run.mjs"),
		"run",
		scenario.prompt,
		"--timeout",
		"600",
		"--session-dir",
		evidenceDir,
		...scenario.legs.flatMap((leg) => ["--leg", leg]),
	];
	console.log(`eval-capture: rig leg starting; evidence will land in ${evidenceDir}`);
	const result = run("node", args, { stdio: "inherit" });
	if (result.status !== 0) {
		fail(`rig leg exited ${result.status} — evidence in ${evidenceDir}; redo the capture, never patch it`);
	}
	console.log(`eval-capture: capture recorded in ${evidenceDir}`);
	console.log(`eval-capture: land it with: node test/eval/capture.mjs land ${scenario.id} ${evidenceDir}`);
}

// The credential guard: every string the provider's config entry carries
// (URLs excepted) must be absent from the sanitized transcript. The
// values are never printed — only the field name that leaked. Connector
// scripts redact their own outputs (ADR 0002); this is the net's belt
// under that suspenders, checked once per capture.
function assertNoProviderKey(text) {
	let config;
	try {
		config = JSON.parse(readFileSync(path.join(homedir(), ".pi/agent/models.json"), "utf8"));
	} catch {
		fail("cannot read ~/.pi/agent/models.json — the credential guard refuses to run blind");
	}
	const entry = config?.providers?.["zai-coding-cn"];
	if (entry === null || typeof entry !== "object") {
		fail("no zai-coding-cn provider entry — the credential guard has nothing to check");
	}
	for (const [field, value] of Object.entries(entry)) {
		if (typeof value !== "string" || /^https?:\/\//.test(value) || value.length < 8) continue;
		if (text.includes(value)) {
			fail(`the sanitized transcript contains the provider entry's ${field} value — the capture leaked a credential`);
		}
	}
}

function land(scenario, evidenceDir) {
	if (!existsSync(evidenceDir)) fail(`no evidence dir at ${evidenceDir}`);
	const evidence = readSessionEvidence(evidenceDir);
	if (evidence.watchdogFired) fail("the watchdog fired on this capture — redo it");
	if (evidence.exitStatusRaw.trim() !== "0") {
		fail(`capture exit status ${evidence.exitStatusRaw.trim()} — redo the capture`);
	}
	if (evidence.stderrBytes.length > 0) fail("capture stderr is not empty — redo the capture");
	if (evidence.promptText !== scenario.prompt) {
		fail("the recorded prompt is not the scenario's prompt — captures read their prompt from the checked-in list");
	}
	const head = run("git", ["-C", repoRoot, "rev-parse", "HEAD"]).stdout.trim();
	if (evidence.preHeadRaw.trim() !== head) {
		fail("the evidence's pre-head is not this tree's HEAD — land against the tree the session saw");
	}

	// Sanitization, the golden-fixture recipe: the session's checkout root
	// becomes __REPO__ everywhere (structure survives, machine roots do
	// not); host machine paths and credentials must be absent outright.
	const firstLine = evidence.transcriptText.split("\n", 1)[0];
	const session = JSON.parse(firstLine);
	if (session.type !== "session" || typeof session.cwd !== "string" || !session.cwd.startsWith("/")) {
		fail("the transcript's first record is not a session header with an absolute cwd");
	}
	const sanitized = evidence.transcriptText.replaceAll(session.cwd, "__REPO__");
	assertNoProviderKey(sanitized);
	for (const machine of [homedir(), "/Users/"]) {
		if (sanitized.includes(machine)) {
			fail(`the sanitized transcript still contains a host machine path (${machine.slice(0, 8)}…) — sanitize before committing`);
		}
	}

	const fixtureDir = path.join(repoRoot, "test/eval/fixtures", scenario.id);
	mkdirSync(fixtureDir, { recursive: true });
	writeFileSync(path.join(fixtureDir, "session.jsonl"), sanitized);
	const surfaces = {};
	for (const surfaceClass of scenario.surfaces) {
		surfaces[surfaceClass] = surfaceDigest(surfaceClass, repoRoot);
	}
	writeFileSync(
		path.join(fixtureDir, "provenance.json"),
		`${JSON.stringify(
			{
				scenario: scenario.id,
				capturedHead: head,
				piVersion: evidence.piVersionRaw.trim(),
				nodeVersion: evidence.nodeVersionRaw.trim(),
				surfaces,
			},
			null,
			"\t",
		)}\n`,
	);
	// The snapshot regenerates from the sanitized bytes through the same
	// normalization the net applies — never hand-edited.
	const snapshotDir = path.join(repoRoot, "test/eval/snapshots");
	mkdirSync(snapshotDir, { recursive: true });
	writeFileSync(
		path.join(snapshotDir, `${scenario.id}.json`),
		`${JSON.stringify(normalizeTree(parseSessionEntries(sanitized)), null, "\t")}\n`,
	);
	console.log(`eval-capture: landed fixture ${path.join("test/eval/fixtures", scenario.id)} and its snapshot`);
	console.log("eval-capture: review the sanitized transcript (payload redaction is a per-capture judgment),");
	console.log("eval-capture: run npm test, and record the owner's per-capture sign-off in the PR body.");
}

function main() {
	const [mode, id, evidenceDir] = process.argv.slice(2);
	if (mode === undefined || id === undefined) {
		console.log("usage: capture.mjs rig <scenario-id> | land <scenario-id> <evidence-dir>");
		return;
	}
	const scenario = scenarioById(id);
	if (mode === "rig") {
		runRig(scenario);
	} else if (mode === "land") {
		if (evidenceDir === undefined) fail("land needs an evidence dir");
		land(scenario, evidenceDir);
	} else {
		fail(`unknown mode: ${mode}`);
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main();
}
