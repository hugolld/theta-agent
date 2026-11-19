import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
