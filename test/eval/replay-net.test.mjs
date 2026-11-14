// The replay net (spec #133, ADR 0007): three pins per committed fixture,
// keyless and host-side in the standard suite — no model, no key, no rig.
// The net replays each fixture through pi's public reconstruction exports
// (parseSessionEntries → buildSessionContext), never a Theta
// re-implementation of replay: reconstruction semantics track the
// installed pi, and a pi version that changes them reds the snapshot pin
// on purpose. Per fixture:
//
//   provenance   the manifest's declared surface digests match the live
//                tree — a model-visible change without a fresh capture
//                reds here, naming the fixture
//   snapshot     the normalized entry tree equals its committed snapshot
//   determinism  pi's reconstruction yields one context hash, stable
//                across repeated runs in this pass
//
// plus the scenario's expected shape, checked structurally against the
// recording — the net-side half of the expectation the capture-time
// auditor legs already attested live.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { buildSessionContext, parseSessionEntries } from "@earendil-works/pi-coding-agent";
import { REPO_ROOT as repoRoot } from "../helpers/repo-root.mjs";
import { contextHash, normalizeTree } from "./normalize.mjs";
import { SCENARIOS } from "./scenarios.mjs";
import { assertShape } from "./shape.mjs";
import { surfaceDigest } from "./surfaces.mjs";
const fixtureFile = (scenario) => path.join(repoRoot, "test/eval/fixtures", scenario.id, "session.jsonl");
const manifestFile = (scenario) => path.join(repoRoot, "test/eval/fixtures", scenario.id, "provenance.json");
const snapshotFile = (scenario) => path.join(repoRoot, "test/eval/snapshots", `${scenario.id}.json`);

test("every scenario in the checked-in list has a committed fixture", () => {
	const missing = SCENARIOS.filter(
		(s) =>
			!existsSync(fixtureFile(s)) || !existsSync(manifestFile(s)) || !existsSync(snapshotFile(s)),
	).map((s) => s.id);
	assert.deepEqual(
		missing,
		[],
		`scenarios without a committed fixture + provenance + snapshot (capture them, docs/agents/eval.md): ${missing.join(", ")}`,
	);
});

test("scenario shape paths are auditor legs the capture attested", () => {
	// The net-time shape expectations carry the same paths as the
	// capture-time auditor legs; this pin keeps a path edit from moving one
	// list without the other. advertisesSkill is a name, not a path, and
	// stays out. opensSkillsToo and gateRefusal have no auditor leg — the
	// rig attests one skill read and one script execution, so the further
	// opens and the gate refusal are the net's alone (docs/agents/eval.md).
	for (const scenario of SCENARIOS) {
		const shapePaths = [scenario.shape.opensSkill, scenario.shape.runsScript].filter(
			(p) => p !== undefined,
		);
		for (const shapePath of shapePaths) {
			assert.ok(
				scenario.legs.includes(shapePath),
				`${scenario.id}: shape path ${shapePath} is not one of its auditor legs`,
			);
		}
		if (scenario.shape.gateRefusal !== undefined) {
			assert.ok(
				scenario.gateway === true,
				`${scenario.id}: a gateRefusal shape needs the gateway flag — the gate only judges gateway calls`,
			);
		}
	}
});

// Index a session's tool calls and results once for the shape checks: the
// call map is keyed by tool-call id, the result map by the toolCallId the
// result record carries — the pairing the shape assertions lean on.
// (indexCalls and the shape grammar live in shape.mjs since #134, so the
// per-scenario checks test without a fixture; see test/eval/shape.test.mjs.)

for (const scenario of SCENARIOS) {
	if (!existsSync(fixtureFile(scenario))) continue; // the presence test above owns the gap

	const text = readFileSync(fixtureFile(scenario), "utf8");
	const manifest = JSON.parse(readFileSync(manifestFile(scenario), "utf8"));
	const entries = parseSessionEntries(text);

	test(`provenance pin — ${scenario.id}: declared surface digests match the live tree`, () => {
		assert.deepEqual(
			Object.keys(manifest.surfaces).sort(),
			[...scenario.surfaces].sort(),
			`fixture ${scenario.id} must declare exactly its scenario's surface classes (${scenario.surfaces.join(", ")})`,
		);
		for (const [surfaceClass, recorded] of Object.entries(manifest.surfaces)) {
			assert.equal(
				surfaceDigest(surfaceClass, repoRoot),
				recorded,
				`fixture ${scenario.id} is stale: model-visible surface ${surfaceClass} changed since the capture — take a fresh eval capture and land its fixture + snapshot (docs/agents/eval.md)`,
			);
		}
	});

	test(`snapshot pin — ${scenario.id}: the normalized entry tree equals its committed snapshot`, () => {
		const snapshot = JSON.parse(readFileSync(snapshotFile(scenario), "utf8"));
		assert.deepEqual(
			normalizeTree(entries),
			snapshot,
			"the fixture's normalized entry tree drifted from its committed snapshot — regenerate the snapshot with a fresh land step, never by hand",
		);
	});

	test(`determinism pin — ${scenario.id}: one context hash across repeated runs`, () => {
		const replay = () => contextHash(buildSessionContext(parseSessionEntries(text)));
		assert.equal(replay(), replay(), "pi's reconstruction of the fixture is not deterministic");
	});

	test(`shape — ${scenario.id}: the recording matches the scenario's expected shape`, () => {
		assertShape(entries, scenario.shape);
	});
}
