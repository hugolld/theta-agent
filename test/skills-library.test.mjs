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
// block lists of scalars or maps, quoted/plain scalars, and block scalars as
// map values (`>` folded, `|` literal; `-` strip chomping only). Deliberately
// not a general YAML engine — constructs outside the subset throw, so a future
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
	// Blank lines are kept in `lines` because block scalars need them (they
	// fold into newlines); everywhere else skipBlanks() makes them
	// insignificant.
	const lines = text.split(/\r?\n/);
	let pos = 0;

	function indentOf(line) {
		return line.length - line.trimStart().length;
	}

	function skipBlanks() {
		while (pos < lines.length && lines[pos].trim() === "") pos++;
	}

	function parseList(indent) {
		const list = [];
		while (pos < lines.length) {
			skipBlanks();
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
			skipBlanks();
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
				skipBlanks();
				if (
					pos < lines.length &&
					(indentOf(lines[pos]) > indent ||
						(indentOf(lines[pos]) === indent && lines[pos].trim().startsWith("- ")))
				) {
					map[key] = parseNode(indentOf(lines[pos]));
				} else {
					map[key] = null;
				}
			} else if (value.startsWith(">") || value.startsWith("|")) {
				map[key] = parseBlockScalar(value, indent);
			} else {
				map[key] = parseScalar(value);
			}
		}
		return map;
	}

	// Block scalar as a map value. The header family (`>` folded, `|`
	// literal, optional `-` strip) is supported as one unit — a deliberate
	// re-sync-facing choice, since upstream skills move between the variants
	// across releases. Content is the shape the vendored files use: a
	// uniform-indent paragraph, where more-indented lines (literal newlines
	// under real folding) throw. Blank lines fold per YAML: a folded scalar
	// turns one blank line into a newline and n consecutive blanks into n
	// newlines; a literal scalar keeps the empty line. Leading and trailing
	// blanks only affect edge newlines, which the subset normalizes away, so
	// they are dropped. Headers outside the family (keep chomping, explicit
	// indent indicators) throw.
	function parseBlockScalar(header, indent) {
		if (![">", ">-", "|", "|-"].includes(header)) {
			throw new Error(`unsupported block scalar header: ${header}`);
		}
		const parts = [];
		let blockIndent = -1;
		while (pos < lines.length) {
			const line = lines[pos];
			if (line.trim() === "") {
				parts.push("");
				pos++;
				continue;
			}
			const at = indentOf(line);
			if (at <= indent) break;
			if (blockIndent === -1) {
				blockIndent = at;
			} else if (at !== blockIndent) {
				throw new Error(`unsupported indent inside block scalar: ${line.slice(0, 40)}`);
			}
			parts.push(line.trim());
			pos++;
		}
		while (parts.length > 0 && parts[0] === "") parts.shift();
		while (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
		if (parts.length === 0) {
			throw new Error("block scalar with no content lines");
		}
		const literal = header.startsWith("|");
		let value = parts[0];
		for (let i = 1; i < parts.length; i++) {
			if (parts[i] === "") {
				value += "\n";
			} else if (literal) {
				value += `\n${parts[i]}`;
			} else {
				value += `${parts[i - 1] === "" ? "" : " "}${parts[i]}`;
			}
		}
		return value;
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

// Parser-subset unit tests: block scalars must fold blank lines the way a
// real YAML engine does (verified against the `yaml` package pi itself uses):
// a folded scalar turns one blank line into a newline and n consecutive
// blanks into n newlines; a literal scalar keeps the empty line. Blank lines
// elsewhere in the frontmatter are insignificant. Pinning these here keeps a
// re-sync that imports a paragraph-broken description from silently
// mis-parsing or failing the length check.
test("frontmatter parser: block scalars fold blank lines per YAML semantics", () => {
	const folded = parseFrontmatter(
		"---\nname: x\ndescription: >-\n  para one\n\n  para two\n---\nbody",
	);
	assert.equal(folded.description, "para one\npara two");

	const foldedTwoBlanks = parseFrontmatter(
		"---\nname: x\ndescription: >-\n  para one\n\n\n  para two\n---\nbody",
	);
	assert.equal(foldedTwoBlanks.description, "para one\n\npara two");

	const literal = parseFrontmatter(
		"---\nname: x\ndescription: |-\n  para one\n\n  para two\n---\nbody",
	);
	assert.equal(literal.description, "para one\n\npara two");

	const literalNoBlanks = parseFrontmatter(
		"---\nname: x\ndescription: |-\n  line one\n  line two\n---\nbody",
	);
	assert.equal(literalNoBlanks.description, "line one\nline two");

	// Clip chomping (no indicator) differs from strip only in trailing
	// newlines, which the subset normalizes away — the folded value is the
	// same shape.
	const foldedClip = parseFrontmatter(
		"---\nname: x\ndescription: >\n  para one\n\n  para two\n---\nbody",
	);
	assert.equal(foldedClip.description, "para one\npara two");
});

test("frontmatter parser: blank lines outside block scalars are insignificant", () => {
	const withBlanks = parseFrontmatter(
		"---\nname: x\n\ndescription: plain value\n\nmetadata:\n\n  version: \"1.0\"\n---\nbody",
	);
	assert.equal(withBlanks.name, "x");
	assert.equal(withBlanks.description, "plain value");
	assert.deepEqual(withBlanks.metadata, { version: "1.0" });
});

const shipped = (await readdir(skillsRoot, { withFileTypes: true }))
	.filter((entry) => entry.isDirectory())
	.map((entry) => entry.name)
	.sort();

// The hyphenated key is destructured once; everything downstream uses
// plain identifiers.
const { vendored, "self-authored": selfAuthored } = expected;
const expectedVendored = [...vendored].map((s) => s.name).sort();
const expectedSelfAuthored = [...selfAuthored].sort();
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

// Digest of a whole skill directory: sha256 over the sorted manifest of
// "relative-path file-digest" lines, recursing into subdirectories. Any byte
// change anywhere in a vendored tree moves this value.
async function treeDigest(dirUrl) {
	const entries = (await readdir(dirUrl, { withFileTypes: true })).sort((a, b) =>
		a.name < b.name ? -1 : 1,
	);
	const manifest = [];
	for (const entry of entries) {
		if (entry.isDirectory()) {
			manifest.push(`${entry.name}/ ${await treeDigest(new URL(`${entry.name}/`, dirUrl))}`);
		} else {
			const fileDigest = createHash("sha256")
				.update(await readFile(new URL(entry.name, dirUrl)))
				.digest("hex");
			manifest.push(`${entry.name} ${fileDigest}`);
		}
	}
	return createHash("sha256").update(manifest.join("\n")).digest("hex");
}

test("vendored skills carry full provenance and are hash-pinned", async () => {
	for (const skill of vendored) {
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
		// Content pin over the whole tree (SKILL.md, references, scripts,
		// assets): any edit fails CI; a re-sync updates the pin with the
		// provenance header.
		const digest = await treeDigest(new URL(`${skill.name}/`, skillsRoot));
		assert.match(
			skill["tree-sha256"],
			/^[0-9a-f]{64}$/,
			`${skill.name}: tree-sha256 pin missing from expected-skills.json`,
		);
		assert.equal(
			digest,
			skill["tree-sha256"],
			`${skill.name}: content drifted from the pinned tree digest`,
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
	// Anchored to the loop table rows so incidental prose (e.g. "experimental
	// design") cannot stand in for a missing stage.
	const stages = ["Frame", "Search", "Hypothesize", "Design", "Execute", "Report"];
	for (const [index, stage] of stages.entries()) {
		assert.match(
			markdown,
			new RegExp(`\\| ${index + 1}\\. ${stage}\\s*\\|`),
			`${name}: loop table row ${index + 1} (${stage}) missing`,
		);
	}
	for (const routed of ["`literature-review`", "`hypothesis-generation`"]) {
		assert.ok(
			markdown.includes(routed),
			`${name}: routing to ${routed} missing from the body`,
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

// Glossary discipline, with GLOSSARY.md as the single source of truth: the
// _Avoid_ synonyms must not surface in self-authored prose, and every
// headword must describe language the docs actually use. Vendored trees are
// exempt — upstream voice by design. Banned terms use hyphen-guarded
// boundaries so legitimate hyphenated compounds (e.g. "re-syncs") do not
// match a banned single word; headword usage uses plain word boundaries so
// "tier" matches the "Tier-1" compounds the docs actually write.
const scanSurfaces = [
	"README.md",
	"CLAUDE.md",
	"skills/theta-research-loop/SKILL.md",
	"test/manifest.test.mjs",
	"test/skills-library.test.mjs",
];
const scanText = (
	await Promise.all(
		scanSurfaces.map((path) => readFile(new URL(`../${path}`, import.meta.url), "utf8")),
	)
).join("\n");
const glossary = await readFile(new URL("../GLOSSARY.md", import.meta.url), "utf8");

function wordPattern(core, hyphenGuarded) {
	const escaped = core
		.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
		.replace(/\s+/g, "\\s+");
	const [start, end] = hyphenGuarded ? ["(?<![\\w-])", "(?![\\w-])"] : ["\\b", "\\b"];
	return new RegExp(`${start}${escaped}s?${end}`, "i");
}

function glossaryAvoidTerms(markdown) {
	const terms = [];
	for (const line of markdown.split(/\r?\n/)) {
		const match = /^_Avoid_: (.*)$/.exec(line.trim());
		if (!match) continue;
		// Split on top-level commas, then drop the parenthetical glosses.
		const parts = [];
		let depth = 0;
		let current = "";
		for (const ch of match[1]) {
			if (ch === "(") depth++;
			if (depth === 0 && ch === ",") {
				parts.push(current);
				current = "";
				continue;
			}
			if (ch === ")") depth--;
			current += ch;
		}
		parts.push(current);
		for (const part of parts) {
			const term = part.replace(/\s*\([^)]*\)/g, "").trim();
			if (term) terms.push(term);
		}
	}
	return terms;
}

test("self-authored prose keeps the glossary's _Avoid_ terms out", () => {
	const offenders = glossaryAvoidTerms(glossary).filter((term) =>
		wordPattern(term, true).test(scanText),
	);
	assert.deepEqual(
		offenders,
		[],
		`_Avoid_ terms found in self-authored files: ${offenders.join(", ")}`,
	);
});

test("every glossary headword describes language the docs use", () => {
	const unused = [];
	for (const line of glossary.split(/\r?\n/)) {
		const match = /^\*\*(.+)\*\*:$/.exec(line.trim());
		if (!match) continue;
		for (const word of match[1].toLowerCase().split(/\s+/)) {
			const stem = word.replace(/s$/, "");
			if (!wordPattern(stem, false).test(scanText)) unused.push(word);
		}
	}
	assert.deepEqual(
		unused,
		[],
		`glossary headword words with no usage in self-authored docs: ${unused.join(", ")}`,
	);
});
