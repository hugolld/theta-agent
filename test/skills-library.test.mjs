import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { test } from "node:test";
import { parse as parseYaml, YAMLParseError } from "yaml";

// Seam guard for the shipped skills library (see test/manifest.test.mjs for
// the same philosophy): if these break, pi loads a skill wrong or the library
// has silently rotted — dropped files, stray copies, edited vendored content,
// or missing provenance. The expected list and content hashes are checked in
// at test/expected-skills.json; a re-sync updates both deliberately.
const skillsRoot = new URL("../skills/", import.meta.url);
const expected = JSON.parse(
	await readFile(new URL("expected-skills.json", import.meta.url), "utf8"),
);

// Frontmatter is parsed by the same YAML engine pi itself runs (`yaml`, the
// package pi declares as a dependency — 2.9.x on both sides today), so what
// this suite sees is what pi sees. If pi ever moves to a different YAML
// engine or major, re-check this seam's parity claim. Values come back fully
// typed — `false` is a boolean, `1.5` a number — and invalid YAML throws,
// failing the suite loudly. That throw is the point
// of the seam (#22): pi's own failure mode is the silent one — it drops a
// skill whose frontmatter it cannot parse — so a construct the engine
// rejects must never reach a shipped SKILL.md.
function parseFrontmatter(markdown) {
	const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown);
	if (!match) throw new Error("SKILL.md has no frontmatter block");
	return parseYaml(match[1]);
}

test("invalid frontmatter fails loudly under the real YAML engine", async () => {
	// The shape-contest hole (#22): a plain scalar with a `: ` sequence was
	// accepted by the subset parser while pi's real engine rejected it and
	// silently dropped the skill. This fixture pins that invalid frontmatter
	// throws here — the suite is the loud half of pi's silent drop.
	const invalid = await readFile(
		new URL("fixtures/frontmatter/invalid/SKILL.md", import.meta.url),
		"utf8",
	);
	// The class pin matters: parseFrontmatter also throws a plain Error when
	// the `---` fence is missing, and that throw must not satisfy this test.
	assert.throws(() => parseFrontmatter(invalid), YAMLParseError);
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

// The connector exit-code contract lives in three prose sites — the
// theta-lit-search SKILL.md table (model-facing doctrine), each script's
// module docstring (developer-facing), and docs/agents/connector-scripts.md
// (repo conventions). Nothing structural keeps them agreeing; this test does.
// The oracle below is the single source of truth: changing the contract means
// changing it here deliberately, in the same commit as the sites.
const EXIT_CODE_CONTRACT = [
	[0, "success"],
	[1, "usage"],
	[2, "transport"],
	[3, "api"],
	[4, "throttled"],
	[5, "credentials"],
];

test("the connector exit-code contract agrees across its three prose sites", async () => {
	// SKILL.md's table carries the full contract: exact code set, and the
	// first word of each meaning cell must be the code's keyword.
	const { markdown } = await loadSkill("theta-lit-search");
	const table = [...markdown.matchAll(/^\| (\d) \| ([A-Za-z-]+)/gm)].map(
		(match) => [Number(match[1]), match[2].toLowerCase()],
	);
	assert.deepEqual(
		table,
		EXIT_CODE_CONTRACT,
		"theta-lit-search: SKILL.md exit-code table drifted from the contract oracle",
	);

	// Each script's docstring repeats the codes it owns — a subset is fine
	// (only Semantic Scholar owns the credentials code today), a different
	// keyword for a shared code is not.
	const docstring = (script) =>
		readFile(new URL(`theta-lit-search/scripts/${script}`, skillsRoot), "utf8").then(
			(source) => {
				const open = source.indexOf('"""');
				return source.slice(open, source.indexOf('"""', open + 3));
			},
		);
	for (const [script, owned] of [
		["pubmed.py", [0, 1, 2, 3, 4]],
		["arxiv.py", [0, 1, 2, 3, 4]],
		["semanticscholar.py", [0, 1, 2, 3, 4, 5]],
	]) {
		const codes = [...(await docstring(script)).matchAll(/^ {2}(\d) {2}([A-Za-z-]+)/gm)]
			.map((match) => [Number(match[1]), match[2].toLowerCase()])
			.filter(([code]) => EXIT_CODE_CONTRACT.some(([ownedCode]) => ownedCode === code));
		assert.deepEqual(
			codes.map(([code]) => code),
			owned,
			`${script}: docstring exit codes drifted`,
		);
		for (const [code, keyword] of codes) {
			assert.equal(
				keyword,
				EXIT_CODE_CONTRACT.find(([ownedCode]) => ownedCode === code)?.[1],
				`${script}: code ${code} keyword drifted`,
			);
		}
	}

	// The conventions note must name every code with its keyword (the
	// "5 (credentials ...)" paren form included).
	const note = await readFile(
		new URL("../docs/agents/connector-scripts.md", import.meta.url),
		"utf8",
	);
	for (const [code, keyword] of EXIT_CODE_CONTRACT) {
		assert.match(
			note,
			new RegExp(`\\b${code}\\s*\\(?\\s*${keyword}\\b`, "i"),
			`connector-scripts.md lost exit code ${code} (${keyword})`,
		);
	}
});

// The notebook recorder is not a connector — it makes no requests — so it
// shares only the codes that carry over (success, usage) and owns its failure
// domain: the notebook it cannot read or write. Same two prose sites as the
// connectors (SKILL.md table, script docstring), same drift guard.
const NOTEBOOK_EXIT_CODE_CONTRACT = [
	[0, "success"],
	[1, "usage"],
	[2, "notebook"],
];

test("the notebook recorder exit-code contract agrees across its two prose sites", async () => {
	const { markdown } = await loadSkill("theta-notebook");
	const table = [...markdown.matchAll(/^\| (\d) \| ([A-Za-z-]+)/gm)].map(
		(match) => [Number(match[1]), match[2].toLowerCase()],
	);
	assert.deepEqual(
		table,
		NOTEBOOK_EXIT_CODE_CONTRACT,
		"theta-notebook: SKILL.md exit-code table drifted from the contract oracle",
	);

	const source = await readFile(
		new URL("theta-notebook/scripts/notebook.py", skillsRoot),
		"utf8",
	);
	const open = source.indexOf('"""');
	const docstring = source.slice(open, source.indexOf('"""', open + 3));
	const codes = [...docstring.matchAll(/^ {2}(\d) {2}([A-Za-z-]+)/gm)].map(
		(match) => [Number(match[1]), match[2].toLowerCase()],
	);
	assert.deepEqual(codes, NOTEBOOK_EXIT_CODE_CONTRACT, "notebook.py: docstring exit codes drifted");
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
	// extensions/theta.ts carries the /theta status strings — milestone prose
	// that drifted silently outside the scan until the S6 retro joined it.
	"extensions/theta.ts",
	"skills/theta-research-loop/SKILL.md",
	"skills/theta-lit-search/SKILL.md",
	"skills/theta-lit-search/references/pubmed.md",
	"skills/theta-lit-search/references/arxiv.md",
	"skills/theta-lit-search/references/semantic-scholar.md",
	"skills/theta-notebook/SKILL.md",
	// The gateway skill carries the compute doctrine and its headwords.
	"skills/theta-compute/SKILL.md",
	// ADRs that introduce glossary vocabulary are scan surfaces — ADR 0003
	// carries the M3 provenance headwords, ADR 0004 the M4 compute headwords.
	// Earlier ADRs stay off the list — ADR 0002 predates the Connector skill
	// headword and discusses its _Avoid_ terms by name.
	"docs/adr/0003-provenance-is-a-project-notebook.md",
	"docs/adr/0004-compute-is-a-native-mcp-server.md",
	// ADR 0005 carries the clean-room headword; the rig's own prose lives in
	// dogfood.md's clean-room section, already a scan surface.
	"docs/adr/0005-dogfood-runs-in-a-clean-room-rig.md",
	// ADR 0006 carries the submit-capability headword (M5's safety gates).
	"docs/adr/0006-a-server-held-capability-bounds-submits.md",
	// The gateway README carries the compute headwords' working vocabulary
	// (compute gateway, audit line) through the M4 strikes.
	"gateway/README.md",
	// connector-scripts.md carries the connector headwords' working
	// vocabulary, extended by the M4 job-record strike to the evidence-item
	// and gateway vocabulary.
	"docs/agents/connector-scripts.md",
	// dogfood.md carries the Attestation leg headword — the auditor's legs
	// and their registry are its working vocabulary.
	"docs/agents/dogfood.md",
	// pi-transcript-schema.md carries the Codemode headword's working
	// vocabulary since the M5 S2 nestedCalls strike.
	"docs/agents/pi-transcript-schema.md",
	// extensions/submit-gate.ts carries the Submit gate headword's working
	// vocabulary — the confirm dialog's title and the refusal/drift reasons.
	"extensions/submit-gate.ts",
	"test/manifest.test.mjs",
	"test/skills-library.test.mjs",
];
const scanSurfaceText = await Promise.all(
	scanSurfaces.map(async (surface) => [
		surface,
		await readFile(new URL(`../${surface}`, import.meta.url), "utf8"),
	]),
);
const scanText = scanSurfaceText.map(([, text]) => text).join("\n");
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

// The avoid-term scan's offenders, each named by surface and line: the
// failure message is the check's UI — the term alone sent the S1 fixer
// grepping, and the first grep missed docs/agents entirely.
function avoidOffenders(surfaceText, glossaryText) {
	const terms = glossaryAvoidTerms(glossaryText);
	const offenders = [];
	for (const [surface, text] of surfaceText) {
		for (const term of terms) {
			const pattern = wordPattern(term, true);
			for (const [index, line] of text.split(/\r?\n/).entries()) {
				if (pattern.test(line)) offenders.push(`${surface}:${index + 1} — ${term}`);
			}
		}
	}
	return offenders;
}

test("self-authored prose keeps the glossary's _Avoid_ terms out", () => {
	const offenders = avoidOffenders(scanSurfaceText, glossary);
	assert.deepEqual(
		offenders,
		[],
		`_Avoid_ terms found in self-authored files: ${offenders.join("; ")}`,
	);
});

test("an avoid-term failure names the surface and the line", () => {
	// The green tree never exercises the offenders loop; this pins the
	// message's shape — place first, term second — against a synthetic
	// glossary and surface pair. The terms are invented: this file is
	// itself a scan surface, so the fixture must not speak a real ban.
	const glossaryText = "**Fake headword**:\na definition\n_Avoid_: florblewort, gnarly capstan\n";
	const offenders = avoidOffenders(
		[
			["docs/fake.md", "line one\nthe florblewort is spent\nline three"],
			["docs/other.md", "gnarly capstan mentioned"],
		],
		glossaryText,
	);
	assert.deepEqual(offenders, ["docs/fake.md:2 — florblewort", "docs/other.md:1 — gnarly capstan"]);
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
