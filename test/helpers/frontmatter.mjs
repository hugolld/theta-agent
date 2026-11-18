// Frontmatter parsed by the same YAML engine pi itself runs (`yaml`, the
// package pi declares as a dependency), so what callers see is what pi
// sees. Invalid YAML throws at the caller, loudly — pi's own failure mode
// is the silent one (#22): it drops a skill whose frontmatter it cannot
// parse. Extracted at its second caller (the replay net's advertisement
// surface, test/eval/surfaces.mjs) from test/skills-library.test.mjs, per
// the shared-helper rule.
import { parse as parseYaml } from "yaml";

// The fence both exports read — one home for the `---` block's shape, so
// the strip and the parse can never drift apart (the demo prompt
// templates' pins became the fence's second consumer, #184's review
// round).
const FRONTMATTER_FENCE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

export function parseFrontmatter(markdown) {
	const match = FRONTMATTER_FENCE.exec(markdown);
	if (!match) throw new Error("SKILL.md has no frontmatter block");
	return parseYaml(match[1]);
}

// The markdown past the fence — the body a template's pins assert against.
export function frontmatterBody(markdown) {
	const match = FRONTMATTER_FENCE.exec(markdown);
	if (!match) throw new Error("no frontmatter block to strip past");
	return markdown.slice(match[0].length);
}
