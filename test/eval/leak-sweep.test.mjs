import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { LEAK_CLASSES, readTokenBytes, sweepBytes } from "./leak-sweep.mjs";

// The per-capture leak sweep (issue #188, the B4 retro): the
// institutional-fact classes the land step guards mechanically, one
// registry instead of the hand-rolled sweeps each capture strike was
// rewriting. B4's five-fixture pass missed "the HEBMU one" because its
// /hebmu/ pattern was case-sensitive — the registry encodes the house
// distinction exactly: cluster ACCOUNTS, the SSH ALIAS token, and NODE
// NAMES are banned; the cluster's bare name is public (ADR 0004 names
// it). The token-bytes comparison is boolean and never prints.

test("every banned class hits its own shape", () => {
	const shapes = [
		["user u18901642 on the login node", "cluster-account"],
		["rsynced to hebmu_cluster:~/hpc_projects/", "ssh-alias"],
		["queued behind gpu03", "node-name"],
		["the cluster alias HEBMU_CLUSTER: also banned", "ssh-alias"],
	];
	for (const [text, expected] of shapes) {
		const { hits } = sweepBytes({ transcript: text });
		assert.ok(hits.includes(expected), `${JSON.stringify(text)} must hit ${expected}, got ${hits.join(",")}`);
	}
});

test("below the ban's shape misses — six digits, bare words, no digits", () => {
	const { hits } = sweepBytes({
		transcript: "user u123456 queued on gpu, the alias file, node zero",
	});
	assert.deepEqual(hits, []);
});

test("the cluster's bare name is public — no alias, no hit", () => {
	for (const text of ["the HEBMU one has 0.11", "deployed on hebmu (the cluster)"]) {
		const { hits } = sweepBytes({ transcript: text });
		assert.deepEqual(hits, [], `${JSON.stringify(text)} must stay clean, got ${hits.join(",")}`);
	}
});

test("the registry names every class it guards — a new class is a decision, not an accident", () => {
	assert.deepEqual(
		LEAK_CLASSES.map((entry) => entry.name),
		["cluster-account", "ssh-alias", "node-name"],
	);
});

test("token bytes hit by inclusion, boolean only, never printed", (t) => {
	const dir = mkdtempSync(path.join(tmpdir(), "leak-sweep-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const tokenFile = path.join(dir, "token");
	writeFileSync(tokenFile, "s3cr3t-token-value\n");
	const bytes = readTokenBytes(tokenFile);
	assert.ok(bytes.includes("s3cr3t-token-value"));
	const { hits } = sweepBytes({ transcript: "header --header Authorization=Bearer s3cr3t-token-value", tokenBytes: bytes });
	assert.ok(hits.includes("token-bytes"));
	const clean = sweepBytes({ transcript: "no token here", tokenBytes: bytes });
	assert.ok(!clean.hits.includes("token-bytes"));
	// The token's bytes must not survive into any failure message shape:
	// the sweep's contract is the class name, nothing else.
	assert.ok(!JSON.stringify(clean).includes("s3cr3t-token-value"));
});

test("the snapshot rides the same sweep as the transcript", () => {
	const { hits } = sweepBytes({ transcript: "clean", snapshot: "queued behind gpu07" });
	assert.ok(hits.includes("node-name"));
});

test("placeholders are counted, never flagged — the approved vocabulary", () => {
	const { placeholderCount } = sweepBytes({
		transcript: "__REPO__/skills/x __RIG_HOME__/agent __HOST_NODES_CPU_1__ plain",
	});
	assert.equal(placeholderCount, 3);
});

test("every landed fixture stays clean — the sweep runs in the suite, not only at land time", () => {
	// The land step guards at capture time, but a hook-bypassed commit
	// could carry a leaky fixture past it; this pin makes CI hold the
	// same bar continuously (the review round's finding). Token bytes
	// stay the host-side closeout's check — the token file never exists
	// on CI, so the class rides the operator CLI there.
	const fixtureDir = new URL("./fixtures/", import.meta.url);
	const ids = readdirSync(fixtureDir).filter((name) =>
		existsSync(new URL(`./fixtures/${name}/session.jsonl`, import.meta.url)),
	);
	assert.ok(ids.length > 0, "no landed fixtures to sweep");
	const offenders = [];
	for (const id of ids) {
		const transcript = readFileSync(new URL(`./fixtures/${id}/session.jsonl`, import.meta.url), "utf8");
		const snapshotPath = new URL(`./snapshots/${id}.json`, import.meta.url);
		const snapshot = existsSync(snapshotPath) ? readFileSync(snapshotPath, "utf8") : undefined;
		const { hits } = sweepBytes({ transcript, snapshot });
		if (hits.length > 0) offenders.push(`${id}: ${hits.join(",")}`);
	}
	assert.deepEqual(offenders, [], "landed fixtures hit banned leak classes");
});
