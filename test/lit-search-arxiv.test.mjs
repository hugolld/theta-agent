import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

// Offline contract tests for skills/theta-lit-search/scripts/arxiv.py, driven
// through the process boundary only (exit codes, stdout, stderr). The script's
// fixture transport (THETA_LIT_SEARCH_FIXTURES) swaps the thin network layer
// for the recorded bodies in test/fixtures/arxiv/<case>/, consumed in call
// order. Fixture bodies are synthetic but shaped like real arXiv Atom
// responses; the Error-entry shape is the documented failure channel (arXiv
// API User's Manual 3.4: "Errors are returned as Atom feeds with a single
// entry representing the error"), and the plain-text "Rate exceeded." body is
// the observed throttle signal. Contract basis:
// docs/research/2026-10-11-m2-literature-api-contracts.md (section 2).
const scriptPath = fileURLToPath(
	new URL("../skills/theta-lit-search/scripts/arxiv.py", import.meta.url),
);
const fixtureRoot = fileURLToPath(new URL("fixtures/arxiv/", import.meta.url));

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

function runArxiv(args, { fixtureDir } = {}) {
	const env = { ...process.env };
	// Environment hygiene: the fixture variable may not leak from the
	// developer's shell into a test that did not ask for it.
	delete env.THETA_LIT_SEARCH_FIXTURES;
	if (fixtureDir !== undefined) {
		env.THETA_LIT_SEARCH_FIXTURES = `${fixtureRoot}${fixtureDir}`;
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
	const run = runArxiv(
		["--query", "single-cell RNA sequencing", "--retmax", "2", "--json"],
		{ fixtureDir: "happy/" },
	);
	assert.equal(run.status, 0, `stderr: ${run.stderr}`);
	assert.equal(run.stderr, "");

	const payload = JSON.parse(run.stdout);
	assert.equal(payload.source, "arxiv");
	assert.equal(payload.operation, "search");
	assert.equal(payload.query, "single-cell RNA sequencing");
	assert.equal(payload.count, 2);
	assert.equal(payload.total_matches, 1523);
	// The feed title echoes the canonicalized query: the only way to see an
	// unknown field prefix silently rewritten to all:.
	assert.ok(payload.query_as_executed.includes("search_query=all:single-cell"));

	const [first, second] = payload.records;
	assert.equal(first.arxiv_id, "2401.01234");
	assert.equal(first.arxiv_id_versioned, "2401.01234v2");
	assert.equal(first.version, "2");
	// The feed hard-wraps titles mid-sentence; records carry them collapsed.
	assert.equal(
		first.title,
		"A single-cell atlas of CRISPR repair outcomes across human hematopoietic lineages",
	);
	assert.equal(first.title.includes("\n"), false);
	assert.deepEqual(first.authors, [
		"Aisha Rahman",
		"Marcus Webb",
		"Li Wei",
		"Sofia Marino",
	]);
	assert.equal(first.year, "2024");
	assert.equal(first.published, "2024-01-02T18:00:00-05:00");
	assert.equal(first.primary_category, "q-bio.GN");
	assert.deepEqual(first.categories, ["q-bio.GN", "cs.LG"]);
	// arXiv:doi is the journal DOI, present only when registered.
	assert.equal(first.doi, "10.1038/s41588-024-01700-9");
	assert.equal(second.arxiv_id, "2310.09999");
	assert.equal(second.doi, null);

	// One call per search: arXiv's query endpoint answers in one request.
	assert.equal(payload.provenance.calls.length, 1);
	const [query] = payload.provenance.calls;
	assert.equal(query.endpoint, "query");
	assert.deepEqual(query.params, {
		search_query: "single-cell RNA sequencing",
		max_results: "2",
	});
	assert.ok(query.url.startsWith("https://export.arxiv.org/api/query?"));
	assert.ok(query.url.includes("search_query=single-cell+RNA+sequencing"));
	assert.equal(payload.provenance.accessed, localDate());
});

test("search text mode: record lines, match count, provenance footer", { skip: skipReason }, () => {
	const run = runArxiv(["--query", "single-cell RNA sequencing", "--retmax", "2"], {
		fixtureDir: "happy/",
	});
	assert.equal(run.status, 0, `stderr: ${run.stderr}`);
	const lines = run.stdout.trimEnd().split("\n");
	assert.equal(lines.length, 4);
	assert.ok(lines[0].includes("arXiv 2401.01234v2"));
	assert.ok(lines[0].includes("cat q-bio.GN"));
	assert.ok(lines[0].includes("Aisha Rahman, Marcus Webb, Li Wei et al."), "four authors truncate to three + et al.");
	assert.ok(lines[1].includes("arXiv 2310.09999"));
	assert.ok(lines[2].includes("2 of 1523 matches"));
	assert.ok(lines[3].includes("export.arxiv.org/api/query"));
	assert.ok(lines[3].includes(`accessed ${localDate()}`));
});

test("sort passthrough: non-default sortBy/sortOrder reach the query", { skip: skipReason }, () => {
	const run = runArxiv(
		["--query", "single-cell RNA sequencing", "--sort", "submittedDate", "--order", "ascending", "--json"],
		{ fixtureDir: "happy/" },
	);
	assert.equal(run.status, 0, `stderr: ${run.stderr}`);
	const payload = JSON.parse(run.stdout);
	assert.equal(payload.sort, "submittedDate");
	assert.equal(payload.order, "ascending");
	assert.equal(payload.provenance.calls[0].params.sortBy, "submittedDate");
	assert.equal(payload.provenance.calls[0].params.sortOrder, "ascending");
});

test("get by arXiv ID: exit 0, exact metadata summary, legacy IDs parsed", { skip: skipReason }, () => {
	const run = runArxiv(["--arxiv-id", "1706.03762,hep-th/9901001", "--json"], {
		fixtureDir: "id/",
	});
	assert.equal(run.status, 0, `stderr: ${run.stderr}`);

	const payload = JSON.parse(run.stdout);
	assert.equal(payload.operation, "summary");
	assert.deepEqual(payload.arxiv_ids, ["1706.03762", "hep-th/9901001"]);
	assert.equal(payload.count, 2);

	const [modern, legacy] = payload.records;
	assert.equal(modern.arxiv_id, "1706.03762");
	// The feed returns the versioned form even for a bare input ID.
	assert.equal(modern.arxiv_id_versioned, "1706.03762v7");
	// Verified shape: 1706.03762 carries no arxiv:doi element at all.
	assert.equal(modern.doi, null);
	// Legacy IDs contain a slash; the version suffix is optional.
	assert.equal(legacy.arxiv_id, "hep-th/9901001");
	assert.equal(legacy.version, null);

	assert.equal(payload.provenance.calls.length, 1);
	assert.equal(payload.provenance.calls[0].endpoint, "query");
	assert.equal(payload.provenance.calls[0].params.id_list, "1706.03762,hep-th/9901001");
	assert.equal(payload.provenance.calls[0].params.max_results, "2");
});

test("multi-ID lookup above the API default page size: max_results rides along", { skip: skipReason }, () => {
	// The API's default page size is 10 and it applies to id_list responses
	// too; without an explicit max_results, an 11+-ID lookup would return a
	// confident truncated 10 (live-confirmed via the feed's own echoed
	// canonical query). 12 IDs pins the fix.
	const ids = Array.from({ length: 12 }, (_, i) => `2401.0${String(i + 1).padStart(4, "0")}`);
	const run = runArxiv(["--arxiv-id", ids.join(","), "--json"], { fixtureDir: "id-many/" });
	assert.equal(run.status, 0, `stderr: ${run.stderr}`);
	const payload = JSON.parse(run.stdout);
	assert.equal(payload.count, 12, "all 12 records return, not the default page of 10");
	assert.deepEqual(payload.records.map((record) => record.arxiv_id), ids);
	assert.deepEqual(payload.provenance.calls[0].params, {
		id_list: ids.join(","),
		max_results: "12",
	});
});

test("unknown arXiv ID: exit 0 with an explicit empty answer, not an error", { skip: skipReason }, () => {
	const run = runArxiv(["--arxiv-id", "9999.99999", "--json"], { fixtureDir: "id-zero/" });
	assert.equal(run.status, 0, `stderr: ${run.stderr}`);
	const payload = JSON.parse(run.stdout);
	assert.equal(payload.count, 0);
	assert.equal(payload.total_matches, 0);
	assert.deepEqual(payload.records, []);
	assert.ok(payload.note.includes("not found in arXiv"));
});

test("Atom error entry inside HTTP 200 exits 3", { skip: skipReason }, () => {
	const run = runArxiv(["--query", "anything", "--json"], { fixtureDir: "error-feed/" });
	assert.equal(run.status, 3);
	assert.equal(run.stdout, "");
	assert.ok(run.stderr.includes("HTTP 200"));
	assert.ok(run.stderr.includes("start must be an integer"), "stderr carries the feed's error reason");
});

test("plain-text throttle body exits 4, whatever the HTTP status", { skip: skipReason }, () => {
	for (const fixtureDir of ["throttle/", "throttle-429/"]) {
		const run = runArxiv(["--query", "anything", "--json"], { fixtureDir });
		assert.equal(run.status, 4, `${fixtureDir}: expected exit 4`);
		assert.equal(run.stdout, "");
		assert.ok(run.stderr.includes("Rate exceeded"), `${fixtureDir}: stderr names the throttle body`);
		assert.ok(run.stderr.includes("three seconds"), `${fixtureDir}: stderr states the pace`);
	}
});

test("a 200 body that is not XML, or XML but not a feed, exits 3", { skip: skipReason }, () => {
	// Plain text (a gateway error): fails the XML parse entirely.
	const plainText = runArxiv(["--query", "anything", "--json"], { fixtureDir: "not-xml/" });
	assert.equal(plainText.status, 3);
	assert.equal(plainText.stdout, "");
	assert.ok(plainText.stderr.includes("non-XML"));

	// Well-formed XML with the wrong root element (an HTML error page).
	const html = runArxiv(["--query", "anything", "--json"], { fixtureDir: "not-atom/" });
	assert.equal(html.status, 3);
	assert.equal(html.stdout, "");
	assert.ok(html.stderr.includes("not an Atom feed"));
});

test("non-200 HTTP status exits 2", { skip: skipReason }, () => {
	const run = runArxiv(["--query", "anything", "--json"], { fixtureDir: "status-400/" });
	assert.equal(run.status, 2);
	assert.equal(run.stdout, "");
	assert.ok(run.stderr.includes("400"));
});

test("zero-result search: exit 0 with an explicit empty answer", { skip: skipReason }, () => {
	const run = runArxiv(["--query", "zzqx-nonexistent-gene", "--json"], { fixtureDir: "zero/" });
	assert.equal(run.status, 0);
	const payload = JSON.parse(run.stdout);
	assert.equal(payload.count, 0);
	assert.equal(payload.total_matches, 0);
	assert.deepEqual(payload.records, []);
	assert.ok(payload.note.includes("not found in arXiv"));
});

test("usage errors exit 1 without touching the network", { skip: skipReason }, () => {
	const cases = [
		[],
		["--query", ""],
		["--query", "x", "--retmax", "500"],
		["--query", "x", "--retmax", "0"],
		["--query", "x", "--sort", "citationCount"],
		["--query", "x", "--order", "sideways"],
		["--arxiv-id", "not-an-id"],
		["--arxiv-id", ""],
		["--arxiv-id", "1706.03762", "--query", "both"],
	];
	for (const args of cases) {
		const run = runArxiv(args);
		assert.equal(run.status, 1, `args ${JSON.stringify(args)} should exit 1`);
		assert.notEqual(run.stderr.trim(), "");
		assert.equal(run.stdout, "");
	}
});
