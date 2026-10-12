import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// PubMed search probe - M2 shape contest, arm B (PROTOTYPE, never ships).
// Registers one tool with the same semantics as arm A's script: >= 0.34 s
// pacing between calls (0.11 s with NCBI_API_KEY), advisory backoff on
// x-ratelimit-remaining: 0, errors inside HTTP 200 bodies surfaced as failed
// tool results, api_key/email/tool values redacted from echoed URLs.

const DESCRIPTION =
	"PubMed literature search for biomedicine. Runs a PubMed query through NCBI E-utilities (esearch + esummary) and returns structured metadata per paper: title, first author, year, journal, PMID, and DOI. Paces requests to the E-utilities limit (3 per second anonymous, 10 with NCBI_API_KEY), detects API errors that arrive inside HTTP 200 bodies, and redacts api_key, email, and tool values from any echoed request URL. Use for searches of biomedical literature by topic or query; not for full text, citation graphs, or non-biomedical databases.";

const SORTS = ["relevance", "pub_date", "Author", "JournalName"] as const;
const BASE = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/";
const REDACT_RE = /(api_key|email|tool)=[^&]*/g;

const Params = Type.Object({
	query: Type.String({ description: "PubMed search term (E-utilities term syntax)" }),
	retmax: Type.Optional(
		Type.Number({ description: "Maximum results (default 8, max 200)", minimum: 1, maximum: 200 }),
	),
	sort: Type.Optional(
		Type.String({
			description: "Sort order: relevance (default), pub_date (recent first), Author, or JournalName",
		}),
	),
});

interface PaperRecord {
	title: string;
	firstAuthor: string;
	year: string;
	journal: string;
	pmid: string;
	doi: string;
}

function redact(url: string): string {
	return url.replace(REDACT_RE, "$1=REDACTED");
}

// Pacing state lives in the extension runtime: sequential calls share it.
let nextOk = 0;

async function pacedFetch(
	path: string,
	params: Record<string, string>,
	outerSignal: AbortSignal | undefined,
): Promise<{ body: string; url: string }> {
	// signal is optional in the execute() contract; pace and fetch either way.
	const signal = outerSignal ?? new AbortController().signal;
	const apiKey = process.env.NCBI_API_KEY ?? "";
	const interval = apiKey ? 110 : 340;
	const wait = nextOk - Date.now();
	if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
	if (apiKey) params = { ...params, api_key: apiKey };
	const url = `${BASE}${path}?${new URLSearchParams(params)}`;
	const res = await fetch(url, {
		signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
		headers: { "User-Agent": "theta-lit-probe/0.1" },
	});
	const body = await res.text();
	nextOk = Date.now() + interval;
	// Advisory only: header semantics are unverified (live-observed
	// 2026-10-11); a reported empty budget earns a 1 s backoff.
	if (res.headers.get("x-ratelimit-remaining") === "0") {
		nextOk = Math.max(nextOk, Date.now() + 1000);
	}
	if (!res.ok) {
		throw new Error(`HTTP ${res.status} from ${path}: ${body.slice(0, 200)}`);
	}
	return { body, url: redact(url) };
}

async function parseBody(body: string, path: string): Promise<Record<string, unknown>> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		throw new Error(`${path} returned a non-JSON body: ${body.slice(0, 200)}`);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error(`${path} returned a non-object JSON body: ${body.slice(0, 200)}`);
	}
	const obj = parsed as Record<string, unknown>;
	if ("error" in obj) {
		// E-utilities errors arrive inside HTTP 200.
		throw new Error(`${path} error inside HTTP 200: ${JSON.stringify(obj.error).slice(0, 200)}`);
	}
	return obj;
}

function extractRecord(uid: string, doc: Record<string, unknown>): PaperRecord {
	const pubdate = `${doc.pubdate ?? ""}` || `${doc.epubdate ?? ""}`;
	const yearMatch = /\d{4}/.exec(pubdate);
	let doi = "-";
	const articleIds = Array.isArray(doc.articleids) ? doc.articleids : [];
	for (const art of articleIds) {
		if (
			typeof art === "object" &&
			art !== null &&
			(art as Record<string, unknown>).idtype === "doi" &&
			`${(art as Record<string, unknown>).value ?? ""}` !== ""
		) {
			doi = `${(art as Record<string, unknown>).value}`;
			break;
		}
	}
	const journal = `${doc.fulljournalname ?? ""}` || `${doc.source ?? ""}`;
	return {
		title: `${doc.title ?? ""}`,
		firstAuthor: `${doc.sortfirstauthor ?? ""}`,
		year: yearMatch ? yearMatch[0] : "",
		journal,
		pmid: uid,
		doi,
	};
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "pubmed_probe_search",
		label: "PubMed probe search",
		description: DESCRIPTION,
		parameters: Params,
		async execute(_toolCallId, params, signal) {
			const retmax = Math.min(Math.max(Math.round(params.retmax ?? 8), 1), 200);
			const sort = params.sort ?? "relevance";
			if (!(SORTS as readonly string[]).includes(sort)) {
				throw new Error(`sort must be one of ${SORTS.join(", ")}`);
			}
			const esearchParams: Record<string, string> = {
				db: "pubmed",
				term: params.query,
				retmode: "json",
				retmax: String(retmax),
			};
			if (sort !== "relevance") esearchParams.sort = sort;

			const esearch = await pacedFetch("esearch.fcgi", esearchParams, signal);
			const esearchBody = await parseBody(esearch.body, "esearch");
			const result = esearchBody.esearchresult;
			if (typeof result !== "object" || result === null || !("idlist" in result)) {
				throw new Error(`esearch body has no esearchresult.idlist: ${esearch.body.slice(0, 200)}`);
			}
			const ids = ((result as Record<string, unknown>).idlist as unknown[])
				.slice(0, retmax)
				.map((id) => `${id}`);
			const urls = [esearch.url];
			const records: PaperRecord[] = [];
			if (ids.length > 0) {
				const esummary = await pacedFetch(
					"esummary.fcgi",
					{ db: "pubmed", id: ids.join(","), retmode: "json" },
					signal,
				);
				urls.push(esummary.url);
				const esummaryBody = await parseBody(esummary.body, "esummary");
				const sresult = esummaryBody.result;
				if (typeof sresult !== "object" || sresult === null || !("uids" in sresult)) {
					throw new Error(`esummary error or malformed body: ${esummary.body.slice(0, 200)}`);
				}
				const uids = (sresult as Record<string, unknown>).uids as unknown[];
				for (const uid of uids) {
					const doc = (sresult as Record<string, unknown>)[`${uid}`];
					if (typeof doc === "object" && doc !== null && "error" in doc) {
						// Per-UID errors also ride inside HTTP 200.
						throw new Error(
							`esummary error for PMID ${uid}: ${JSON.stringify((doc as Record<string, unknown>).error).slice(0, 200)}`,
						);
					}
					if (typeof doc === "object" && doc !== null) {
						records.push(extractRecord(`${uid}`, doc as Record<string, unknown>));
					}
				}
			}

			const accessed = new Date().toISOString().slice(0, 10);
			const lines = records.map(
				(r) => `${r.title} | ${r.firstAuthor} | ${r.year} | ${r.journal} | PMID ${r.pmid} | DOI ${r.doi}`,
			);
			lines.push(`# provenance: ${urls.join("; ")}; accessed ${accessed}`);
			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: {
					query: params.query,
					sort,
					count: records.length,
					pmids: records.map((r) => r.pmid),
					records,
					provenance: { urls, accessed },
				},
			};
		},
	});
}
