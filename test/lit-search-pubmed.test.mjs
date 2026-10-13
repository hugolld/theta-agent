import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

// Offline contract tests for skills/theta-lit-search/scripts/pubmed.py, driven
// through the process boundary only (exit codes, stdout, stderr). The script's
// fixture transport (THETA_LIT_SEARCH_FIXTURES) swaps the thin network layer
// for the recorded bodies in test/fixtures/pubmed/<case>/, consumed in call
// order. Fixture bodies are synthetic but shaped like real E-utilities
// responses; the throttle body is documented verbatim in NBK25497. Contract
// basis: docs/research/2026-10-11-m2-literature-api-contracts.md.
const scriptPath = fileURLToPath(
	new URL("../skills/theta-lit-search/scripts/pubmed.py", import.meta.url),
);
const fixtureRoot = fileURLToPath(new URL("fixtures/pubmed/", import.meta.url));

// The script requires Python 3.11+. `python3` is 3.9 on some macOS setups, so
// probe the versioned names too — same fallback list the script's version gate
// names. With none available (unusual), skip rather than fail: CI's ubuntu
// runner has 3.12 as `python3`.
function findPython() {
	for (const candidate of ["python3", "python3.13", "python3.12", "python3.11"]) {
		const probe = spawnSync(candidate, [
			"-c",
			"import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)",
		]);
		if (probe.status === 0) return candidate;
	}
	return null;
}

const python = findPython();
const skipReason = python
	? false
	: "no Python 3.11+ interpreter found (tried python3, python3.13, python3.12, python3.11)";

function runPubmed(args, { fixtureDir, apiKey } = {}) {
	const env = { ...process.env };
	// Environment hygiene: neither variable may leak from the developer's shell
	// into a test that did not ask for it.
	delete env.NCBI_API_KEY;
	delete env.THETA_LIT_SEARCH_FIXTURES;
	if (fixtureDir !== undefined) {
		env.THETA_LIT_SEARCH_FIXTURES = `${fixtureRoot}${fixtureDir}`;
	}
	if (apiKey !== undefined) {
		env.NCBI_API_KEY = apiKey;
	}
	return spawnSync(python, [scriptPath, ...args], {
		env,
		encoding: "utf8",
		timeout: 30_000,
	});
}

function localDate() {
	const now = new Date();
	const pad = (n) => String(n).padStart(2, "0");
	return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

test("search: exit 0, records with metadata and repeat-the-call provenance", { skip: skipReason }, () => {
	const run = runPubmed(
		["--query", "CRISPR gene therapy", "--retmax", "2", "--json"],
		{ fixtureDir: "happy/" },
	);
	assert.equal(run.status, 0, `stderr: ${run.stderr}`);
	assert.equal(run.stderr, "");

	const payload = JSON.parse(run.stdout);
	assert.equal(payload.source, "pubmed");
	assert.equal(payload.operation, "search");
	assert.equal(payload.query, "CRISPR gene therapy");
	assert.equal(payload.count, 2);
	assert.equal(payload.total_matches, 4532);

	const [first, second] = payload.records;
	assert.equal(first.pmid, "39114817");
	assert.match(first.title, /^CRISPR-based gene editing/);
	assert.deepEqual(first.authors, ["Frasca D", "Blomberg BB"]);
	assert.equal(first.year, "2023");
	assert.equal(first.journal, "Nature");
	assert.equal(first.doi, "10.1038/s41586-023-06321-w");
	// The fourth author stays in the structured record even though the text
	// mode truncates the display list.
	assert.equal(second.authors.length, 4);

	assert.equal(payload.provenance.calls.length, 2);
	const [esearch, esummary] = payload.provenance.calls;
	assert.equal(esearch.endpoint, "esearch.fcgi");
	assert.equal(esearch.params.db, "pubmed");
	assert.equal(esearch.params.term, "CRISPR gene therapy");
	assert.equal(esearch.params.retmode, "json");
	assert.ok(esearch.url.startsWith("https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?"));
	assert.equal(esummary.endpoint, "esummary.fcgi");
	assert.equal(esummary.params.id, "39114817,37850042");
	assert.equal(payload.provenance.accessed, localDate());
});

test("search text mode: record lines, match count, provenance footer", { skip: skipReason }, () => {
	const run = runPubmed(["--query", "CRISPR gene therapy", "--retmax", "2"], {
		fixtureDir: "happy/",
	});
	assert.equal(run.status, 0, `stderr: ${run.stderr}`);
	const lines = run.stdout.trimEnd().split("\n");
	assert.equal(lines.length, 4);
	assert.ok(lines[0].includes("PMID 39114817"));
	assert.ok(lines[0].includes("Frasca D"));
	assert.ok(lines[1].includes("PMID 37850042"));
	assert.ok(lines[1].includes("Chen Z, Rao L, Wang Y et al."), "four authors truncate to three + et al.");
	assert.ok(lines[2].includes("2 of 4532 matches"));
	assert.ok(lines[3].includes("esearch.fcgi"));
	assert.ok(lines[3].includes("esummary.fcgi"));
	assert.ok(lines[3].includes(`accessed ${localDate()}`));
});

test("keyed run: the API key never reaches output; provenance shows it redacted", { skip: skipReason }, () => {
	const key = "theta-test-key-DO-NOT-PRINT";
	const run = runPubmed(["--query", "CRISPR gene therapy", "--retmax", "2", "--json"], {
		fixtureDir: "happy/",
		apiKey: key,
	});
	assert.equal(run.status, 0, `stderr: ${run.stderr}`);
	assert.ok(!run.stdout.includes(key), "key leaked into stdout");
	assert.ok(!run.stderr.includes(key), "key leaked into stderr");

	const payload = JSON.parse(run.stdout);
	for (const call of payload.provenance.calls) {
		assert.equal(call.params.api_key, "REDACTED");
		assert.ok(call.url.includes("api_key=REDACTED"));
	}
});

test("get by PMID: exit 0, exact metadata summary, one call", { skip: skipReason }, () => {
	const run = runPubmed(["--pmid", "39114817", "--json"], { fixtureDir: "pmid/" });
	assert.equal(run.status, 0, `stderr: ${run.stderr}`);

	const payload = JSON.parse(run.stdout);
	assert.equal(payload.operation, "summary");
	assert.deepEqual(payload.pmids, ["39114817"]);
	assert.equal(payload.count, 1);
	assert.equal(payload.records[0].pmid, "39114817");
	assert.equal(payload.records[0].title, payload.records[0].title.trim());
	// No esearch happens for an identifier lookup.
	assert.equal(payload.provenance.calls.length, 1);
	assert.equal(payload.provenance.calls[0].endpoint, "esummary.fcgi");
});

test("per-PMID error inside HTTP 200 exits 3 with nothing on stdout", { skip: skipReason }, () => {
	const run = runPubmed(["--pmid", "999999999", "--json"], { fixtureDir: "pmid-error/" });
	assert.equal(run.status, 3);
	assert.equal(run.stdout, "");
	assert.ok(run.stderr.includes("999999999"), "stderr names the PMID");
	assert.ok(run.stderr.includes("cannot get document summary"));
});

test("top-level error body inside HTTP 200 exits 3", { skip: skipReason }, () => {
	const run = runPubmed(["--query", "anything", "--json"], { fixtureDir: "error-200/" });
	assert.equal(run.status, 3);
	assert.equal(run.stdout, "");
	assert.ok(run.stderr.includes("HTTP 200"));
});

test("throttle body inside HTTP 200 exits 4", { skip: skipReason }, () => {
	const run = runPubmed(["--query", "anything", "--json"], { fixtureDir: "throttle/" });
	assert.equal(run.status, 4);
	assert.equal(run.stdout, "");
	assert.ok(run.stderr.toLowerCase().includes("rate limit"));
});

test("non-200 HTTP status exits 2", { skip: skipReason }, () => {
	const run = runPubmed(["--query", "anything", "--json"], { fixtureDir: "status-503/" });
	assert.equal(run.status, 2);
	assert.equal(run.stdout, "");
	assert.ok(run.stderr.includes("503"));
});

test("zero results: exit 0 with an explicit empty answer", { skip: skipReason }, () => {
	const run = runPubmed(["--query", "zzqx-nonexistent-syndrome", "--json"], {
		fixtureDir: "zero/",
	});
	assert.equal(run.status, 0);
	const payload = JSON.parse(run.stdout);
	assert.equal(payload.count, 0);
	assert.equal(payload.total_matches, 0);
	assert.deepEqual(payload.records, []);
	assert.ok(payload.note.includes("not found in PubMed"));
});

test("usage errors exit 1 without touching the network", { skip: skipReason }, () => {
	const cases = [
		[],
		["--query", ""],
		["--query", "x", "--retmax", "500"],
		["--query", "x", "--retmax", "0"],
		["--query", "x", "--sort", "citation_count"],
		["--pmid", "not-a-pmid"],
		["--pmid", "123", "--query", "both"],
	];
	for (const args of cases) {
		const run = runPubmed(args);
		assert.equal(run.status, 1, `args ${JSON.stringify(args)} should exit 1`);
		assert.notEqual(run.stderr.trim(), "");
		assert.equal(run.stdout, "");
	}
});
