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
//     surface class, computed against the landing tree the guard proves
//     identical to the capture's on every surface path), and the
//     committed snapshot.
//
// The land step refuses evidence whose capture-bound surfaces moved: the
// manifest's digests must name the bytes the session actually saw, and an
// eval capture binds surfaces, not HEAD (ADR 0007) — a test-tree-only
// commit after the capture changes nothing the model saw. The check is
// mechanical and filesystem-exact: no surface path differs between the
// session's pre-head and this tree — committed, uncommitted, or ignored
// (`--ignored=matching`: the surface digests walk the raw filesystem, so
// an ignored __pycache__ under a skill tree rides a tree digest exactly
// like an edit would). Throws; the CLI maps the message to its refusal.
export function assertSurfacesUnmoved(treeRoot, preHead) {
	const surfacePaths = surfaceProbePaths();
	const committed = run("git", ["-C", treeRoot, "diff", "--name-only", preHead, "HEAD", "--", ...surfacePaths]);
	// core.ignorecase (macOS default true) hides case-only renames from
	// status under a pathspec; the digests walk readdirSync names, so the
	// probe must not share the blindness.
	const dirty = run("git", [
		"-c",
		"core.ignorecase=false",
		"-C",
		treeRoot,
		"status",
		"--porcelain",
		"--untracked-files=all",
		"--ignored=matching",
		"--",
		...surfacePaths,
	]);
	if (committed.status !== 0 || dirty.status !== 0) {
		throw new Error(
			`the land guard's git probe failed (diff exit ${committed.status}, status exit ${dirty.status}) — ` +
				"check the evidence dir's pre-head against this tree",
		);
	}
	if (committed.stdout.trim() !== "" || dirty.stdout.trim() !== "") {
		throw new Error(
			`the capture-bound surfaces changed since the session's HEAD (${preHead.slice(0, 7)}) — ` +
				"landing here would bind digests the session never saw; recapture",
		);
	}
}

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseSessionEntries } from "@earendil-works/pi-coding-agent";
import { run } from "../../scripts/dogfood-gates.mjs";
import { readSessionEvidence } from "../../scripts/session-evidence.mjs";
import { REPO_ROOT as repoRoot } from "../helpers/repo-root.mjs";
import { machinePathPrefixes } from "../helpers/machine-paths.mjs";
import { normalizeTree } from "./normalize.mjs";
import { SCENARIOS } from "./scenarios.mjs";
import { surfaceDigest, surfaceProbePaths } from "./surfaces.mjs";

function fail(message) {
	console.error(`eval-capture: ${message}`);
	process.exit(1);
}

// One home for the id lookup (the capture CLI and the tests share it):
// throws — the CLI maps the message to its refusal, a test import fails
// its assertion instead of exiting the runner.
export function scenarioById(id) {
	const scenario = SCENARIOS.find((s) => s.id === id);
	if (scenario === undefined) {
		throw new Error(`unknown scenario id: ${id} (the checked-in list is the source)`);
	}
	return scenario;
}

// The rig invocation a scenario drives, as the argv array run.mjs receives
// (spec #134): the scenario's own prompt, a 600s bound, the isolated
// evidence dir, its auditor legs in order — and the rig flags its scenario
// list entry declares. `gateway: true` passes `--gateway`: the rig admits
// the gateway token as its second credential and preflights the host-side
// forward before launch, so a gateway capture needs that forward up (one
// parked re-probe when it is down, never a retry loop).
export function rigArgs(scenario, evidenceDir) {
	return [
		path.join(repoRoot, "test/rig/run.mjs"),
		"run",
		scenario.prompt,
		"--timeout",
		"600",
		"--session-dir",
		evidenceDir,
		...(scenario.gateway ? ["--gateway"] : []),
		...scenario.legs.flatMap((leg) => ["--leg", leg]),
	];
}

function runRig(scenario) {
	const evidenceDir = path.join(
		homedir(),
		".theta-evidence",
		`eval-${scenario.id}-${new Date().toISOString().replaceAll(/[-:]/g, "").slice(0, 15)}`,
	);
	mkdirSync(evidenceDir, { recursive: true });
	const args = rigArgs(scenario, evidenceDir);
	console.log(`eval-capture: rig leg starting; evidence will land in ${evidenceDir}`);
	const result = run("node", args, { stdio: "inherit" });
	if (result.status !== 0) {
		fail(`rig leg exited ${result.status} — evidence in ${evidenceDir}; redo the capture, never patch it`);
	}
	console.log(`eval-capture: capture recorded in ${evidenceDir}`);
	console.log(`eval-capture: land it with: node test/eval/capture.mjs land ${scenario.id} ${evidenceDir}`);
}

// The credential sweep's pure half (pinned by capture-guard.test.mjs):
// which (provider, field) pairs leak into the text. The sweep skips the
// structural fields a transcript carries by design — `api` is the
// API-flavor name pi stamps onto every assistant record, URLs are
// endpoints — and values under 8 chars are too short to be
// secret-bearing. Everything else a provider entry carries is swept,
// whichever provider it is: a capture that echoes a credential fails
// here, and the values are never printed — only the provider and field
// name that leaked. Connector scripts redact their own outputs (ADR
// 0002); this is the net's belt under that suspenders, checked once per
// capture.
export function credentialLeaks(text, providers) {
	const leaks = [];
	for (const [provider, entry] of Object.entries(providers)) {
		if (entry === null || typeof entry !== "object") continue;
		for (const [field, value] of Object.entries(entry)) {
			if (field === "api") continue;
			if (typeof value !== "string" || /^https?:\/\//.test(value) || value.length < 8) continue;
			if (text.includes(value)) leaks.push({ provider, field });
		}
	}
	return leaks;
}

function assertNoProviderKey(text) {
	let config;
	try {
		config = JSON.parse(readFileSync(path.join(homedir(), ".pi/agent/models.json"), "utf8"));
	} catch {
		fail("cannot read ~/.pi/agent/models.json — the credential guard refuses to run blind");
	}
	const providers = config?.providers ?? {};
	if (Object.keys(providers).length === 0) {
		fail("no provider entries in ~/.pi/agent/models.json — the credential guard has nothing to check");
	}
	for (const { provider, field } of credentialLeaks(text, providers)) {
		fail(`the sanitized transcript contains provider ${provider}'s ${field} value — the capture leaked a credential`);
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
	try {
		assertSurfacesUnmoved(repoRoot, evidence.preHeadRaw.trim());
	} catch (error) {
		fail(error.message);
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
	for (const machine of machinePathPrefixes()) {
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
				// The binding pair: the capture session's anchor, and the
				// tree the digests were computed against — the guard above
				// proves the surfaces identical between the two.
				sessionPreHead: evidence.preHeadRaw.trim(),
				landedHead: head,
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
	let scenario;
	try {
		scenario = scenarioById(id);
	} catch (error) {
		fail(error.message);
	}
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
