import assert from "node:assert/strict";
import { test } from "node:test";

// Unit tests for the pure halves of scripts/check-strike.mjs (the evidence-
// freshness gate, #27, and the CI-green gate, #41 retro). The gh/git
// orchestration around them stays untested — same seam split as
// audit-dogfood.mjs.
import { ciChecks, declaredParent, evidenceFreshness } from "../scripts/check-strike.mjs";

const HEAD = "ac77fef6a3f0764f9c07346c8654e1eca275184f";
const STALE = "243bd05f4b9c5e404c5e0259b8b9f94f1edd37c9";

test("an attestation naming HEAD is fresh", () => {
	const body = ["## Evidence", "", "```text", `clean                  ${HEAD}`, "```"].join(
		"\n",
	);
	assert.deepEqual(evidenceFreshness(body, HEAD), {
		verdict: "fresh",
		attested: [HEAD],
	});
});

test("an attestation naming an older commit is stale — the M2 failure mode", () => {
	// Review fixes landed after capture; the body still attests the pre-fix
	// HEAD. This is what marked-stale evidence looked like, twice.
	const body = `clean ${STALE}`;
	const result = evidenceFreshness(body, HEAD);
	assert.equal(result.verdict, "stale");
	assert.deepEqual(result.attested, [STALE]);
});

test("any stale attestation fails the whole body", () => {
	assert.equal(evidenceFreshness(`clean ${HEAD}\nclean ${STALE}`, HEAD).verdict, "stale");
});

test("no attestation is a pass-with-note, not a failure", () => {
	// Chore strikes carry no dogfood pair. Prose "clean" must not match —
	// the 40-hex token is the matcher, so padding prose stays a pass.
	assert.equal(evidenceFreshness("clean boot, exit 0", HEAD).verdict, "none");
	assert.equal(evidenceFreshness(`clean ${HEAD.slice(0, 39)}`, HEAD).verdict, "none");
	assert.equal(evidenceFreshness("", HEAD).verdict, "none");
	assert.equal(evidenceFreshness(undefined, HEAD).verdict, "none");
});

test("a checks table with every row pass is green", () => {
	const table = [
		"verify\tpass\t38s\thttps://github.com/example/runs/1",
		"lint\tpass\t5s\thttps://github.com/example/runs/2",
	].join("\n");
	assert.deepEqual(ciChecks(table), { verdict: "green", offenders: [] });
});

test("failing and pending checks are red, named — pending blocks at ready time", () => {
	// M3's verify sat red four hours past ready; a pending run is not a
	// pass either — the gate runs where pending means wait.
	const table = "verify\tfail\t24s\turl\nlint\tpending\t1m10s\turl";
	const result = ciChecks(table);
	assert.equal(result.verdict, "red");
	assert.deepEqual(result.offenders, ["verify (fail)", "lint (pending)"]);
});

test("a skipping row is a row, not a pass — only pass is green", () => {
	// gh marks condition-skipped jobs `skipping`: the check ran nothing, so
	// it attests nothing. Fail closed.
	assert.equal(ciChecks("verify\tpass\t38s\turl\nlint\tskipping\t0s\turl").verdict, "red");
});

test("no parseable check rows is a pass-with-note, not a failure", () => {
	// gh free text ("no checks found", headers, errors) carries no tab-
	// status rows — no checks exist, and the gate protects what exists.
	assert.equal(ciChecks("").verdict, "none");
	assert.equal(ciChecks("no checks found").verdict, "none");
	assert.equal(ciChecks(undefined).verdict, "none");
});

test("a Parent section declares the child's spec", () => {
	const body = ["## Parent", "", "#49", "", "## What to build", "…"].join("\n");
	assert.equal(declaredParent(body), "#49");
	assert.equal(declaredParent(null), null);
	assert.equal(declaredParent("## What to build\nno parent section"), null);
});

test("a bare mention is not a parent claim — the #61 ready-gate false positive", () => {
	// S2's body names S1 in its blocked-by list while declaring #49 as
	// parent: under any-mention matching, S1's gate read its successor as
	// an unlanded child.
	const body = ["## Parent", "", "#49", "", "- #51 (S1 — tracer skeleton)"].join("\n");
	assert.equal(declaredParent(body), "#49");
});
