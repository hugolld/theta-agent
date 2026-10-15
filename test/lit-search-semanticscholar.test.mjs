import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

// Offline contract tests for skills/theta-lit-search/scripts/semanticscholar.py,
// driven through the process boundary only (exit codes, stdout, stderr). The
// script's fixture transport (THETA_LIT_SEARCH_FIXTURES) swaps the thin network
// layer for the recorded bodies in test/fixtures/semanticscholar/<case>/,
// consumed in call order. Fixture bodies are synthetic but shaped like real
// Graph API responses: the {"error": "..."} bodies are the documented error
// shapes (OpenAPI Error400/Error404), the throttle body is the live-observed
// 429 message+code shape (recorded verbatim in the research note), and the
// 200-with-error-body case encodes the criterion that a status line can lie.
// Contract basis: docs/research/2026-10-11-m2-literature-api-contracts.md
// (section 3).
const scriptPath = fileURLToPath(
	new URL("../skills/theta-lit-search/scripts/semanticscholar.py", import.meta.url),
);
const fixtureRoot = fileURLToPath(new URL("fixtures/semanticscholar/", import.meta.url));

// The bounded field set the script requests; pinned here so the provenance
// assertion fails loudly if the set drifts.
const FIELDS =
	"title,authors,year,venue,citationCount,influentialCitationCount,externalIds,publicationDate";
const KEY_ENV = "S2_API_KEY";
const KEY_REQUEST_URL = "https://www.semanticscholar.org/product/api#api-key-form";

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

function runS2(args, { fixtureDir, apiKey = "test-key-s2" } = {}) {
	const env = { ...process.env };
	// Environment hygiene: neither variable may leak from the developer's shell
	// into a test that did not ask for it.
	delete env.THETA_LIT_SEARCH_FIXTURES;
	if (apiKey === null) {
		delete env[KEY_ENV];
	} else {
		env[KEY_ENV] = apiKey;
	}
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

test("search: exit 0, records with metadata and citation counts, redacted provenance", { skip: skipReason }, () => {
	const run = runS2(["--query", "CRISPR off-target", "--retmax", "2", "--json"], {
		fixtureDir: "happy/",
	});
	assert.equal(run.status, 0, `stderr: ${run.stderr}`);
	assert.equal(run.stderr, "");

	const payload = JSON.parse(run.stdout);
	assert.equal(payload.source, "semanticscholar");
	assert.equal(payload.operation, "search");
	assert.equal(payload.query, "CRISPR off-target");
	assert.equal(payload.count, 2);
	assert.equal(payload.total_matches, 8741);

	const [first, second] = payload.records;
	assert.equal(first.paper_id, "6a3a57e6be7a53f8e2e4dc4e58c40dd95d1e0af6");
	// The fixture title arrives hard-wrapped with a double space; records
	// carry it collapsed.
	assert.equal(
		first.title,
		"Sequence- and structure-resolved modeling of CRISPR off-target activity across guide designs",
	);
	assert.equal(first.title.includes("\n"), false);
	assert.deepEqual(first.authors, [
		"Aisha Rahman",
		"Marcus Webb",
		"Li Wei",
		"Sofia Marino",
	]);
	assert.equal(first.year, "2024");
	assert.equal(first.venue, "Nature Biotechnology");
	// Citation counts ride along where the API returns them free.
	assert.equal(first.citation_count, 87);
	assert.equal(first.influential_citation_count, 12);
	assert.equal(first.doi, "10.1038/s41587-024-02123-4");
	assert.equal(first.publication_date, "2024-03-06");
	// Sparse records stay honest: nulls and zeros, never dropped keys lying.
	assert.deepEqual(second.authors, []);
	assert.equal(second.year, null);
	assert.equal(second.venue, null);
	assert.equal(second.citation_count, 0);
	assert.equal(second.doi, null);

	// One call per search; the key rode in the x-api-key header and only the
	// header name survives into provenance.
	assert.equal(payload.provenance.calls.length, 1);
	const [search] = payload.provenance.calls;
	assert.equal(search.endpoint, "paper/search");
	assert.deepEqual(search.params, {
		query: "CRISPR off-target",
		limit: "2",
		fields: FIELDS,
	});
	assert.ok(search.url.startsWith("https://api.semanticscholar.org/graph/v1/paper/search?"));
	// redact_url re-encodes the fields commas as %2C (still a valid, repeatable
	// URL), so compare the decoded query rather than the raw substring.
	assert.equal(
		decodeURIComponent(new URL(search.url).search),
		`?query=CRISPR+off-target&limit=2&fields=${FIELDS}`,
	);
	assert.deepEqual(search.headers, { "x-api-key": "REDACTED" });
	assert.equal(payload.provenance.accessed, localDate());
});

test("search text mode: record lines with citation counts, match count, provenance footer", { skip: skipReason }, () => {
	const run = runS2(["--query", "CRISPR off-target", "--retmax", "2"], {
		fixtureDir: "happy/",
	});
	assert.equal(run.status, 0, `stderr: ${run.stderr}`);
	const lines = run.stdout.trimEnd().split("\n");
	assert.equal(lines.length, 4);
	assert.ok(lines[0].includes("Nature Biotechnology"));
	assert.ok(lines[0].includes("cited by 87"));
	assert.ok(lines[0].includes("DOI 10.1038/s41587-024-02123-4"));
	assert.ok(lines[0].includes("Aisha Rahman, Marcus Webb, Li Wei et al."), "four authors truncate to three + et al.");
	assert.ok(lines[1].includes("cited by 0"));
	assert.ok(lines[2].includes("2 of 8741 matches"));
	assert.ok(lines[3].includes("api.semanticscholar.org/graph/v1/paper/search"));
	assert.ok(lines[3].includes(`accessed ${localDate()}`));
});

test("get by DOI: exit 0, exact metadata summary", { skip: skipReason }, () => {
	const run = runS2(["--doi", "10.1038/s41587-024-02123-4", "--json"], {
		fixtureDir: "id/",
	});
	assert.equal(run.status, 0, `stderr: ${run.stderr}`);

	const payload = JSON.parse(run.stdout);
	assert.equal(payload.operation, "summary");
	assert.equal(payload.doi, "10.1038/s41587-024-02123-4");
	assert.equal(payload.count, 1);
	assert.equal(payload.records[0].title, "Sequence- and structure-resolved modeling of CRISPR off-target activity across guide designs");
	assert.equal(payload.records[0].paper_id, "6a3a57e6be7a53f8e2e4dc4e58c40dd95d1e0af6");

	// The DOI rides in the path verbatim: DOI: prefix, slash and all.
	assert.equal(payload.provenance.calls.length, 1);
	const [lookup] = payload.provenance.calls;
	assert.equal(lookup.endpoint, "paper/DOI:10.1038/s41587-024-02123-4");
	assert.deepEqual(lookup.params, { fields: FIELDS });
	assert.ok(
		lookup.url.startsWith(
			"https://api.semanticscholar.org/graph/v1/paper/DOI:10.1038/s41587-024-02123-4?",
		),
	);
	assert.deepEqual(lookup.headers, { "x-api-key": "REDACTED" });
});

test("unknown DOI: exit 0 with an explicit empty answer, not an error", { skip: skipReason }, () => {
	const run = runS2(["--doi", "10.0000/does-not-exist", "--json"], {
		fixtureDir: "id-zero/",
	});
	assert.equal(run.status, 0, `stderr: ${run.stderr}`);
	const payload = JSON.parse(run.stdout);
	assert.equal(payload.count, 0);
	assert.deepEqual(payload.records, []);
	assert.ok(payload.note.includes("not found in Semantic Scholar"));
});

test("keyless: exit 5, one-line reason with the key-request URL, before any request", { skip: skipReason }, () => {
	// No fixture directory either: the keyless guard must fire before any
	// transport exists, so nothing ever reaches the network.
	const run = runS2(["--query", "crispr"], { fixtureDir: undefined, apiKey: null });
	assert.equal(run.status, 5);
	assert.equal(run.stdout, "");
	const lines = run.stderr.trimEnd().split("\n");
	assert.equal(lines.length, 1, "the reason is one line");
	assert.ok(run.stderr.includes(KEY_ENV));
	assert.ok(run.stderr.includes(KEY_REQUEST_URL), "the message carries the key-request URL");
});

test("rejected key (HTTP 403): exit 5, message names the credential", { skip: skipReason }, () => {
	const run = runS2(["--query", "crispr", "--json"], { fixtureDir: "bad-key-403/" });
	assert.equal(run.status, 5);
	assert.equal(run.stdout, "");
	assert.ok(run.stderr.includes("403"));
	assert.ok(run.stderr.includes(KEY_ENV));
	assert.ok(run.stderr.includes(KEY_REQUEST_URL));
});

test("throttle response (429 message body): exit 4 with the pace stated", { skip: skipReason }, () => {
	const run = runS2(["--query", "crispr", "--json"], { fixtureDir: "throttle-429/" });
	assert.equal(run.status, 4);
	assert.equal(run.stdout, "");
	assert.ok(run.stderr.includes("Too Many Requests"), "stderr names the throttle body");
	assert.ok(run.stderr.includes("1 request/second"), "stderr states the pace");
});

test("a 429 status with an unparseable body still exits 4, not 2", { skip: skipReason }, () => {
	// The 429 verdict is status-driven and must survive a gateway error
	// page; a parse failure must not reclassify a throttle as transport.
	const run = runS2(["--query", "crispr", "--json"], { fixtureDir: "throttle-429-html/" });
	assert.equal(run.status, 4);
	assert.equal(run.stdout, "");
	assert.ok(run.stderr.includes("proxy error page"), "stderr carries the raw body");
	assert.ok(run.stderr.includes("1 request/second"));
});

test("error inside an HTTP 200 body: exit 3", { skip: skipReason }, () => {
	const run = runS2(["--query", "crispr", "--json"], { fixtureDir: "error-200/" });
	assert.equal(run.status, 3);
	assert.equal(run.stdout, "");
	assert.ok(run.stderr.includes("inside HTTP 200"));
	assert.ok(run.stderr.includes("Internal server error"), "stderr carries the body's error text");
});

test("a 200 paper object without paperId exits 3, never a blank record", { skip: skipReason }, () => {
	// The Codex closeout round: an empty 200 object once extracted into a
	// confident all-null record with count 1.
	const run = runS2(["--doi", "10.1038/s41587-024-02123-4", "--json"], {
		fixtureDir: "id-empty-object/",
	});
	assert.equal(run.status, 3);
	assert.equal(run.stdout, "");
	assert.ok(run.stderr.includes("paperId"));
});

test("a search data entry without paperId exits 3, never a blank record", { skip: skipReason }, () => {
	const run = runS2(["--query", "crispr", "--json"], {
		fixtureDir: "search-empty-paper/",
	});
	assert.equal(run.status, 3);
	assert.equal(run.stdout, "");
	assert.ok(run.stderr.includes("paperId"));
});

test("documented 400 error body with its status: exit 2", { skip: skipReason }, () => {
	const run = runS2(["--query", "crispr", "--json"], { fixtureDir: "status-400/" });
	assert.equal(run.status, 2);
	assert.equal(run.stdout, "");
	assert.ok(run.stderr.includes("400"));
	assert.ok(run.stderr.includes("Invalid field parameter"));
});

test("zero-result search: exit 0 with an explicit empty answer", { skip: skipReason }, () => {
	const run = runS2(["--query", "zzqx-nonexistent-gene", "--json"], { fixtureDir: "zero/" });
	assert.equal(run.status, 0, `stderr: ${run.stderr}`);
	const payload = JSON.parse(run.stdout);
	assert.equal(payload.count, 0);
	assert.equal(payload.total_matches, 0);
	assert.deepEqual(payload.records, []);
	assert.ok(payload.note.includes("not found in Semantic Scholar"));
});

test("the key never appears in any output", { skip: skipReason }, () => {
	const sentinel = "theta-s2-sentinel-key-value";
	for (const [args, fixtureDir] of [
		[["--query", "CRISPR off-target", "--json"], "happy/"],
		[["--query", "CRISPR off-target"], "happy/"],
		[["--doi", "10.1038/s41587-024-02123-4", "--json"], "id/"],
	]) {
		const run = runS2(args, { fixtureDir, apiKey: sentinel });
		assert.equal(run.status, 0, `stderr: ${run.stderr}`);
		assert.ok(!run.stdout.includes(sentinel), `stdout must not echo the key for ${args}`);
		assert.ok(!run.stderr.includes(sentinel), `stderr must not echo the key for ${args}`);
	}
});

test("usage errors exit 1 without touching the network", { skip: skipReason }, () => {
	const cases = [
		[],
		["--query", ""],
		["--query", "x", "--retmax", "0"],
		["--query", "x", "--retmax", "101"],
		["--query", "x", "--retmax", "500"],
		["--doi", "10.1038/s41587-024-02123-4", "--retmax", "500"],
		["--doi", "not-a-doi"],
		["--doi", ""],
		// URL delimiters pasted in from a URL: the suffix rides in the request
		// path verbatim, so these must fail visible, not issue a different
		// request (the Codex closeout round).
		["--doi", "10.1038/s41587-024-02123-4?fields=title#frag"],
		["--doi", "10.1038/s41587-024-02123-4", "--query", "both"],
	];
	for (const args of cases) {
		const run = runS2(args);
		assert.equal(run.status, 1, `args ${JSON.stringify(args)} should exit 1`);
		assert.notEqual(run.stderr.trim(), "");
		assert.equal(run.stdout, "");
	}
});
