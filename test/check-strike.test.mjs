import assert from "node:assert/strict";
import { test } from "node:test";

// Unit tests for the pure half of scripts/check-strike.mjs (the evidence-
// freshness gate, #27). The gh/git orchestration around it stays untested —
// same seam split as audit-dogfood.mjs.
import { evidenceFreshness } from "../scripts/check-strike.mjs";

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
