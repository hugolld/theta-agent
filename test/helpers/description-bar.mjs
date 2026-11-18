// The description bar — string-valued, 1..1024 chars — one home since the
// demo prompt templates became the shape's third caller (#184's review
// round): shipped skills, pool skills, and prompt-template frontmatter
// face the same bound, asserted identically.
import assert from "node:assert/strict";

export function assertDescriptionBar(label, frontmatter) {
	assert.equal(
		typeof frontmatter.description,
		"string",
		`${label}: description missing`,
	);
	assert.ok(
		frontmatter.description.length > 0 && frontmatter.description.length <= 1024,
		`${label}: description must be 1..1024 chars, got ${frontmatter.description.length}`,
	);
}
