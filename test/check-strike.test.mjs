import assert from "node:assert/strict";
import { test } from "node:test";

// Unit tests for the pure halves of scripts/check-strike.mjs (the evidence-
// freshness gate, #27, the CI-green gate, #41 retro, and the review-
// coverage gate, #133 retro). The gh/git orchestration around them stays
// untested — same seam split as audit-dogfood.mjs.
import {
	ciChecks,
	declaredParent,
	disclosedRanges,
	evidenceFreshness,
	uncoveredCommits,
} from "../scripts/check-strike.mjs";

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

const R1 = "c053b8d1234567890abcdef1234567890abcdef1";
const R2 = "dae6988123456789abcdef1234567890abcdef12";
const R3 = "903c1fd1234567890abcdef1234567890abcdef1";

test("a reviewed line parses as a range; list markers and prose ride along", () => {
	const body = [
		"## Disclosures",
		"",
		"- Reviewed: c053b8d1..dae69881 (delta round)",
		"  - reviewed: 903c1fd1",
	].join("\n");
	assert.deepEqual(disclosedRanges(body), [
		{ base: "c053b8d1", head: "dae69881" },
		{ base: null, head: "903c1fd1" },
	]);
});

test("prose without a hex token and negated spellings match nothing", () => {
	// "reviewed the diff" carries no sha; "unreviewed:" must not match —
	// the literal must start the token after the optional marker.
	assert.deepEqual(disclosedRanges("reviewed the whole diff today"), []);
	assert.deepEqual(disclosedRanges("- unreviewed: c053b8d1..dae69881"), []);
	assert.deepEqual(disclosedRanges("the capture at c053b8d1 is fresh"), []);
	assert.deepEqual(disclosedRanges(undefined), []);
});

test("prose may follow the shas; one range per line", () => {
	const body = "reviewed: c053b8d1..dae69881 — the delta round over the guard fixes\n";
	assert.deepEqual(disclosedRanges(body), [{ base: "c053b8d1", head: "dae69881" }]);
});

test("uncoveredCommits names branch commits no range covers, in branch order", () => {
	const branch = [R1, R2, R3];
	assert.deepEqual(uncoveredCommits(branch, [R1, R3]), [R2]);
	assert.deepEqual(uncoveredCommits(branch, []), branch);
	assert.deepEqual(uncoveredCommits(branch, [R1, R2, R3, "fffaaa111"]), []);
});
