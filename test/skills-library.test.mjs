import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { test } from "node:test";

// Seam guard for the shipped skills library (see test/manifest.test.mjs for
// the same philosophy): if these break, pi loads a skill wrong or the library
// has silently rotted — dropped files, stray copies, edited vendored content,
// or missing provenance. The expected list and content hashes are checked in
// at test/expected-skills.json; a re-sync updates both deliberately.
const skillsRoot = new URL("../skills/", import.meta.url);
const expected = JSON.parse(
	await readFile(new URL("expected-skills.json", import.meta.url), "utf8"),
);

// The subset of YAML frontmatter the shipped SKILL.md files use: nested maps,
// block lists of scalars or maps, quoted/plain scalars. Deliberately not a
// general YAML engine — constructs outside the subset throw, so a future
// vendored file the parser cannot read fails the seam instead of mis-parsing.
function parseScalar(raw) {
	const value = raw.trim();
	if (value === "" || value === "~" || value === "null") return null;
	if (["—", ">", "|"].some((c) => value.startsWith(c))) {
		throw new Error(`unsupported YAML scalar: ${value.slice(0, 40)}`);
	}
	if (
		(value.startsWith('"') && value.endsWith('"')) ||
		(value.startsWith("'") && value.endsWith("'"))
	) {
		return value.slice(1, -1);
	}
	return value;
}

function parseYamlBlock(text) {
	const lines = text.split(/\r?\n/).filter((line) => line.trim() !== "");
	let pos = 0;

	function indentOf(line) {
		return line.length - line.trimStart().length;
	}

	function parseList(indent) {
		const list = [];
		while (pos < lines.length) {
			const line = lines[pos];
			const at = indentOf(line);
			const trimmed = line.trim();
			if (at !== indent || !trimmed.startsWith("- ")) break;
			const rest = trimmed.slice(2);
			pos++;
			if (rest.includes(":")) {
				// Map item: first key is inline after "- ", members sit deeper.
				const item = {};
				const colon = rest.indexOf(":");
				const key = rest.slice(0, colon).trim();
				const value = rest.slice(colon + 1).trim();
				item[key] = value === "" ? parseNode(indent + 2) : parseScalar(value);
				while (pos < lines.length && indentOf(lines[pos]) > indent) {
					const member = lines[pos].trim();
					const mColon = member.indexOf(":");
					if (mColon === -1) {
						throw new Error(`unsupported list member: ${member.slice(0, 40)}`);
					}
					item[member.slice(0, mColon).trim()] = parseScalar(
						member.slice(mColon + 1),
					);
					pos++;
				}
				list.push(item);
			} else {
				list.push(parseScalar(rest));
			}
		}
		return list;
	}

	function parseMap(indent) {
		const map = {};
		while (pos < lines.length) {
			const line = lines[pos];
			const at = indentOf(line);
			const trimmed = line.trim();
			if (at > indent) {
				throw new Error(`unexpected indent ${at} > ${indent}: ${trimmed.slice(0, 40)}`);
			}
			if (at < indent || trimmed.startsWith("- ")) break;
			const colon = trimmed.indexOf(":");
			if (colon === -1) {
				throw new Error(`not a mapping line: ${trimmed.slice(0, 40)}`);
			}
			const key = trimmed.slice(0, colon).trim();
			const value = trimmed.slice(colon + 1).trim();
			pos++;
			if (value === "") {
				// Block value: a deeper map, a list at this indent, or empty.
				if (
					pos < lines.length &&
					(indentOf(lines[pos]) > indent ||
						(indentOf(lines[pos]) === indent && lines[pos].trim().startsWith("- ")))
				) {
					map[key] = parseNode(indentOf(lines[pos]));
				} else {
					map[key] = null;
				}
			} else {
				map[key] = parseScalar(value);
			}
		}
		return map;
	}

	function parseNode(indent) {
		if (pos >= lines.length) return null;
		return lines[pos].trim().startsWith("- ") ? parseList(indent) : parseMap(indent);
	}

	return parseNode(indentOf(lines[0] ?? ""));
}

function parseFrontmatter(markdown) {
	const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown);
	if (!match) throw new Error("SKILL.md has no frontmatter block");
	return parseYamlBlock(match[1]);
}

const shipped = (await readdir(skillsRoot, { withFileTypes: true }))
	.filter((entry) => entry.isDirectory())
	.map((entry) => entry.name)
	.sort();

const expectedVendored = [...expected.vendored].map((s) => s.name).sort();
const expectedSelfAuthored = [...expected["self-authored"]].sort();
const expectedShipped = [...expectedVendored, ...expectedSelfAuthored].sort();

async function loadSkill(name) {
	const markdown = await readFile(
		new URL(`${name}/SKILL.md`, skillsRoot),
		"utf8",
	);
	return { markdown, frontmatter: parseFrontmatter(markdown) };
}

test("shipped skills equal the checked-in expected list", () => {
	assert.deepEqual(shipped, expectedShipped);
});

test("every skill carries a parseable SKILL.md with a valid name and description", async () => {
	for (const name of shipped) {
		const { frontmatter } = await loadSkill(name);
		assert.match(
			frontmatter.name,
			/^[a-z0-9][a-z0-9-]{0,63}$/,
			`${name}: invalid skill name`,
		);
		assert.equal(
			frontmatter.name,
			name,
			`${name}: frontmatter name differs from directory`,
		);
		assert.equal(
			typeof frontmatter.description,
			"string",
			`${name}: description missing`,
		);
		assert.ok(
			frontmatter.description.length > 0 && frontmatter.description.length <= 1024,
			`${name}: description must be 1..1024 chars, got ${frontmatter.description.length}`,
		);
	}
});

test("vendored skills carry full provenance and are hash-pinned", async () => {
	for (const skill of expected.vendored) {
		const { frontmatter } = await loadSkill(skill.name);
		const provenance = frontmatter.metadata?.provenance;
		assert.ok(provenance, `${skill.name}: metadata.provenance missing`);
		for (const field of ["upstream-repo", "release", "commit", "date", "license"]) {
			assert.equal(
				typeof provenance[field],
				"string",
				`${skill.name}: provenance.${field} missing`,
			);
		}
		assert.match(provenance["upstream-repo"], /K-Dense-AI\/scientific-agent-skills/);
		assert.match(provenance.release, /^v\d+\.\d+\.\d+$/);
		assert.match(provenance.commit, /^[0-9a-f]{40}$/);
		assert.match(provenance.date, /^\d{4}-\d{2}-\d{2}$/);
		assert.match(provenance.license, /MIT/);
		// Content pin: any edit to a vendored file (including its SKILL.md body)
		// fails CI; a re-sync updates the hash with the provenance header.
		const bytes = await readFile(new URL(`${skill.name}/SKILL.md`, skillsRoot));
		const digest = createHash("sha256").update(bytes).digest("hex");
		assert.match(
			skill.sha256,
			/^[0-9a-f]{64}$/,
			`${skill.name}: sha256 pin missing from expected-skills.json`,
		);
		assert.equal(
			digest,
			skill.sha256,
			`${skill.name}: content drifted from the pinned hash`,
		);
	}
});

test("the orchestrator is self-authored and walks the six-stage loop", async () => {
	const name = "theta-research-loop";
	assert.ok(expectedSelfAuthored.includes(name), `${name} not marked self-authored in the expected list`);
	const { frontmatter, markdown } = await loadSkill(name);
	assert.equal(
		frontmatter.metadata?.authorship,
		"self-authored",
		`${name}: metadata.authorship must mark it self-authored`,
	);
	assert.equal(frontmatter.metadata?.provenance, undefined, `${name}: must not carry vendored provenance`);
	for (const stage of ["frame", "search", "hypothesize", "design", "execute", "report"]) {
		assert.match(
			markdown.toLowerCase(),
			new RegExp(stage),
			`${name}: loop stage "${stage}" missing from the body`,
		);
	}
	for (const routed of ["literature-review", "hypothesis-generation"]) {
		assert.match(
			markdown,
			new RegExp(routed),
			`${name}: routing to "${routed}" missing from the body`,
		);
	}
});

// Tier-2 infra per ADR 0001 / spec #5: K-Dense's compute stack is excluded —
// theta-compute replaces it in M4. If one of these names ever ships, the
// tiers have been crossed by accident.
const TIER2_INFRA_NAMES = [
	"modal",
	"ray",
	"slurm",
	"kubernetes",
	"docker",
	"terraform",
	"get-available-resources",
	"ginkgo-cloud-lab",
	"benchling-integration",
	"dnanexus-integration",
];

test("no Tier-2 infra skills ship", () => {
	const crossed = shipped.filter((name) => TIER2_INFRA_NAMES.includes(name));
	assert.deepEqual(crossed, [], `Tier-2 infra skills must not ship: ${crossed.join(", ")}`);
});
