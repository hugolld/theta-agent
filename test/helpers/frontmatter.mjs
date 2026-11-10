// Frontmatter parsed by the same YAML engine pi itself runs (`yaml`, the
// package pi declares as a dependency), so what callers see is what pi
// sees. Invalid YAML throws at the caller, loudly — pi's own failure mode
// is the silent one (#22): it drops a skill whose frontmatter it cannot
// parse. Extracted at its second caller (the replay net's advertisement
// surface, test/eval/surfaces.mjs) from test/skills-library.test.mjs, per
// the shared-helper rule.
import { parse as parseYaml } from "yaml";

export function parseFrontmatter(markdown) {
	const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown);
	if (!match) throw new Error("SKILL.md has no frontmatter block");
	return parseYaml(match[1]);
}
