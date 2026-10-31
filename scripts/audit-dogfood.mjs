import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { gitStatus, manifestSha256 } from "./dogfood-gates.mjs";

// SemVer comparison: true when a >= b. Prereleases follow SemVer precedence
// (a release outranks its own prerelease; numeric identifiers compare
// numerically and rank below alphanumeric ones). Malformed versions —
// leading zeros, empty or malformed prerelease identifiers — fail closed.
export function ge(a, b) {
	const parse = (v) => {
		const m =
			/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(
				v,
			);
		if (!m) return null;
		// A wholly numeric prerelease identifier must not carry a leading zero.
		if (
			m[4] !== undefined &&
			m[4].split(".").some((id) => /^0\d+$/.test(id))
		) {
			return null;
		}
		return {
			core: [BigInt(m[1]), BigInt(m[2]), BigInt(m[3])],
			pre: m[4] === undefined ? null : m[4].split("."),
		};
	};
	// Floors may be written short ("1.4", "22.19"); pad them to full SemVer.
	const norm = (v) =>
		/^\d+$/.test(v) ? `${v}.0.0` : /^\d+\.\d+$/.test(v) ? `${v}.0` : v;
	const pa = parse(norm(a));
	const pb = parse(norm(b));
	if (!pa || !pb) return false;
	for (let i = 0; i < 3; i++) {
		if (pa.core[i] !== pb.core[i]) return pa.core[i] > pb.core[i];
	}
	if (pa.pre === null && pb.pre === null) return true;
	if (pa.pre === null) return true;
	if (pb.pre === null) return false;
	const cmpId = (x, y) => {
		const nx = /^\d+$/.test(x);
		const ny = /^\d+$/.test(y);
		if (nx && ny) {
			const d = BigInt(x) - BigInt(y);
			return d === 0n ? 0 : d > 0n ? 1 : -1;
		}
		if (nx) return -1;
		if (ny) return 1;
		return x < y ? -1 : x > y ? 1 : 0;
	};
	for (let i = 0; i < Math.max(pa.pre.length, pb.pre.length); i++) {
		if (pb.pre[i] === undefined) return true;
		if (pa.pre[i] === undefined) return false;
		const c = cmpId(pa.pre[i], pb.pre[i]);
		if (c !== 0) return c > 0;
	}
	return true;
}

// pi XML-escapes skill fields before serializing them into the transcript.
export function decodeXmlEntities(s) {
	return s.replace(/&(amp|lt|gt|quot|apos|#39);/g, (_, e) =>
		({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'" })[e],
	);
}

// The advertised skill records live in exactly one <available_skills> block
// inside the skills section pi maintains (message.sections.skills). A second
// block could hide advertisement drift, so any other count throws — and the
// tag counts must balance, so an unclosed block or stray <skill> records
// outside the parsed block fail closed too. Each record must carry both a
// name and a location — advertisement identity is the pair, not the path.
export function extractLocations(skillsText) {
	const opens = (skillsText.match(/<available_skills>/g) ?? []).length;
	const closes = (skillsText.match(/<\/available_skills>/g) ?? []).length;
	const blocks = skillsText.match(/<available_skills>[\s\S]*?<\/available_skills>/g);
	if (!blocks || blocks.length !== 1 || opens !== 1 || closes !== 1) {
		throw new Error(
			`expected exactly 1 well-formed available_skills block, found ${blocks ? blocks.length : 0} (open tags ${opens}, close tags ${closes})`,
		);
	}
	const skillTags = (skillsText.match(/<skill>/g) ?? []).length;
	const skillCloses = (skillsText.match(/<\/skill>/g) ?? []).length;
	const out = [];
	for (const record of blocks[0].match(/<skill>[\s\S]*?<\/skill>/g) ?? []) {
		// Each child tag must appear exactly once per record: stray or
		// duplicated name/location tags are corruption, not content.
		const nameMatches = record.match(/<name>[\s\S]*?<\/name>/g) ?? [];
		const locationMatches = record.match(/<location>[\s\S]*?<\/location>/g) ?? [];
		if (nameMatches.length !== 1 || locationMatches.length !== 1) {
			throw new Error(
				`malformed skill record: ${nameMatches.length} name tags, ${locationMatches.length} location tags`,
			);
		}
		const name = decodeXmlEntities(
			nameMatches[0].match(/<name>([\s\S]*?)<\/name>/)?.[1] ?? "",
		);
		const location = decodeXmlEntities(
			locationMatches[0].match(/<location>([\s\S]*?)<\/location>/)?.[1] ?? "",
		);
		if (!name || !location) {
			throw new Error("malformed skill advertisement record (missing name or location)");
		}
		out.push({ name, location });
	}
	if (out.length !== skillTags || skillCloses !== skillTags) {
		throw new Error(
			`stray or unclosed <skill> records: ${skillTags} openings, ${skillCloses} closings, ${out.length} parsed`,
		);
	}
	return out;
}

// Resolves the spot-check's skill argument to an absolute checkout path and
// requires it to be one of the advertised SKILL.md files — traversal and
// non-skill paths are rejected. Comparison happens on canonical paths, with
// a lexical fallback for arguments that do not resolve on disk.
export function resolveAdvertisedSkill(root, skill, expected) {
	const lexical = path.resolve(root, skill);
	let target = lexical;
	try {
		target = fs.realpathSync(lexical);
	} catch {
		// unresolvable paths compare lexically and fail membership below
	}
	if (!expected.has(target)) {
		throw new Error(
			`skill argument must be an advertised checkout SKILL.md, got: ${skill}`,
		);
	}
	return target;
}

// Resolves a checkout-relative argument (named by `label` in the errors) to
// an absolute path and requires an existing `file` or `directory` inside
// the checkout — traversal and outside paths, including symlinks that
// escape the checkout, are rejected. Containment is the criterion: neither
// scripts nor the notebook directory has an advertisement set to check
// membership against.
function resolveInsideCheckout(rootArg, label, arg, kind) {
	const root = fs.realpathSync(rootArg);
	const lexical = path.resolve(root, arg);
	let target = lexical;
	try {
		target = fs.realpathSync(lexical);
	} catch {
		throw new Error(`${label} argument does not resolve on disk: ${arg}`);
	}
	const rightKind =
		kind === "file" ? fs.statSync(target).isFile() : fs.statSync(target).isDirectory();
	if (!rightKind || !target.startsWith(root + path.sep)) {
		throw new Error(`${label} argument must be a ${kind} inside the checkout, got: ${arg}`);
	}
	return target;
}

// Resolves the script argument to an absolute path and requires an existing
// regular file inside the checkout.
export function resolveCheckoutScript(rootArg, script) {
	return resolveInsideCheckout(rootArg, "script", script, "file");
}

// A calendar-valid YYYY-MM-DD date string — the form the recorder and the
// connectors stamp (`date.today().isoformat()`, `provenance.accessed`). A
// shape check alone would accept 2026-02-30; a date is attestable only when
// it names a real day.
export function isIsoDate(s) {
	if (typeof s !== "string") return false;
	const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
	if (!m) return false;
	const y = Number(m[1]);
	const mo = Number(m[2]);
	const d = Number(m[3]);
	if (mo < 1 || mo > 12) return false;
	const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
	const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
	return d >= 1 && d <= days[mo - 1];
}

// Resolves the notebook argument to an absolute path and requires an
// existing directory inside the checkout — the `.theta/` the recorder
// writes under the session's cwd, gitignored so the clean-tree proof holds
// with a notebook present.
export function resolveNotebookDir(rootArg, notebook) {
	return resolveInsideCheckout(rootArg, "notebook", notebook, "directory");
}

// The recorder's grade vocabulary (SKILL.md): a grade rates the source, and
// anything outside the vocabulary is not a grade.
const NOTEBOOK_GRADES = new Set(["asserted", "cross-checked", "re-executed"]);

// The five entry types the recorder writes (ADR 0003): each sequences its
// own id prefix (hyp-0001, mth-0001, …) and carries evidence as noted.
// observation alone takes an entry-level grade — a grade rates a source,
// judgment is the confidence entry type, and the two never merge. confidence
// names the hypothesis it judges; hypothesis entries are the link targets.
const NOTEBOOK_TYPES = {
	hypothesis: { prefix: "hyp", evidence: "required" },
	method: { prefix: "mth", evidence: "optional" },
	observation: { prefix: "obs", evidence: "required", graded: true },
	decision: { prefix: "dec", evidence: "optional" },
	confidence: { prefix: "cnf", evidence: "forbidden", judges: true },
};

// The typed-shape guards the notebook checks share: a plain JSON object
// (arrays and null are not records), a non-empty string field, and an
// optional non-negative integer field (a JSON boolean is not an integer).
const isPlainObject = (x) => typeof x === "object" && x !== null && !Array.isArray(x);
const nonEmptyString = (x) => typeof x === "string" && x !== "";
const optionalNonNegativeInt = (x) =>
	x === undefined || (typeof x === "number" && Number.isInteger(x) && x >= 0);

// Reads one cited snapshot and derives the evidence fields the recorder
// derives from it (the recorder parsers' logic, mirrored): the snapshot must
// have the shape the citing item declares — a connector `--json` output
// (ADR 0003) or an assembled gateway job record (ADR 0004) — typed shape,
// not presence — and its bytes must hash to the address that names it.
// Content addressing is what makes the file self-verifying: no digest
// match, no attestation. `kind` names the expected shape; the item's own
// fields pick it (endpoints = connector, job_id = job record).
function auditSnapshot(thetaDir, addr, digest, citedFrom, kind) {
	const lexical = path.join(thetaDir, addr);
	let real;
	try {
		real = fs.realpathSync(lexical);
	} catch {
		throw new Error(`${addr} (cited on ${citedFrom}) does not exist`);
	}
	if (!real.startsWith(thetaDir + path.sep)) {
		throw new Error(
			`${addr} (cited on ${citedFrom}) resolves outside the notebook directory`,
		);
	}
	if (!fs.statSync(real).isFile()) {
		throw new Error(`${addr} (cited on ${citedFrom}) is not a regular file`);
	}
	const buf = fs.readFileSync(real);
	let payload;
	try {
		payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buf));
	} catch (e) {
		throw new Error(`${addr} (cited on ${citedFrom}) is not valid JSON: ${e.message}`);
	}
	const what = kind === "job" ? "gateway job record" : "connector output";
	const shapeError = (why) =>
		new Error(`${addr} (cited on ${citedFrom}) is not a ${what}: ${why}`);
	if (!isPlainObject(payload)) {
		throw shapeError("not a JSON object");
	}
	const derived =
		kind === "job" ? jobRecordShape(payload, shapeError) : connectorShape(payload, shapeError);
	if (createHash("sha256").update(buf).digest("hex") !== digest) {
		throw new Error(
			`${addr} (cited on ${citedFrom}) content does not hash to its own address (sha256 mismatch)`,
		);
	}
	return { kind, ...derived };
}

// The connector branch of auditSnapshot: parse_evidence's checks, mirrored.
function connectorShape(payload, shapeError) {
	if (!nonEmptyString(payload.source)) {
		throw shapeError("lacks a non-empty string 'source'");
	}
	const provenance = payload.provenance;
	if (!isPlainObject(provenance)) {
		throw shapeError("lacks a 'provenance' object");
	}
	if (!Array.isArray(provenance.calls) || provenance.calls.length === 0) {
		throw shapeError("provenance.calls must be a non-empty list");
	}
	const endpoints = [];
	for (const call of provenance.calls) {
		if (!isPlainObject(call)) {
			throw shapeError("every provenance call must be an object");
		}
		if (!nonEmptyString(call.endpoint)) {
			throw shapeError("every provenance call needs a non-empty string 'endpoint'");
		}
		if (!nonEmptyString(call.url)) {
			throw shapeError("every provenance call needs a non-empty string 'url'");
		}
		if (!endpoints.includes(call.endpoint)) endpoints.push(call.endpoint);
	}
	if (!isIsoDate(provenance.accessed)) {
		throw shapeError("provenance.accessed must be a YYYY-MM-DD date string");
	}
	if (payload.query !== null && payload.query !== undefined && typeof payload.query !== "string") {
		throw shapeError("'query', when present, must be a string");
	}
	return {
		source: payload.source,
		endpoints,
		query: payload.query ?? null,
		retrieved: provenance.accessed,
	};
}

// The job-record branch of auditSnapshot: parse_job_record's checks,
// mirrored — the record's identity in full, and an artifact manifest that
// holds paths and sizes, never the payloads the cluster already holds.
function jobRecordShape(payload, shapeError) {
	if (!nonEmptyString(payload.gateway)) {
		throw shapeError("lacks a non-empty string 'gateway'");
	}
	if (typeof payload.job_id !== "string" || !/^\d+$/.test(payload.job_id)) {
		throw shapeError("'job_id' must be a string of digits");
	}
	if (typeof payload.run_name !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(payload.run_name)) {
		throw shapeError("'run_name' must be 1-64 characters of letters, digits, '-' and '_'");
	}
	if (!("template" in payload)) {
		throw shapeError("must carry 'template' (null for a raw submit)");
	}
	if (payload.template !== null && !nonEmptyString(payload.template)) {
		throw shapeError("'template' must be a non-empty name or null (a raw submit)");
	}
	if (typeof payload.arguments_digest !== "string" || !/^[0-9a-f]{64}$/.test(payload.arguments_digest)) {
		throw shapeError("'arguments_digest' must be a 64-character sha256 hex digest");
	}
	if (typeof payload.state !== "string" || payload.state.trim() === "") {
		throw shapeError("lacks a non-empty string 'state'");
	}
	if (!isIsoDate(payload.observed)) {
		throw shapeError("'observed' must be a YYYY-MM-DD calendar date");
	}
	let artifacts = null;
	if (payload.artifacts !== undefined && payload.artifacts !== null) {
		artifacts = payload.artifacts;
		if (!isPlainObject(artifacts)) {
			throw shapeError("'artifacts', when present, must be an object");
		}
		if ("content_b64" in artifacts) {
			throw shapeError("artifacts must not carry file contents ('content_b64') — the record holds the manifest, not the payloads");
		}
		if (!Array.isArray(artifacts.files) || artifacts.files.length === 0) {
			throw shapeError("artifacts.files must be a non-empty list");
		}
		for (const entry of artifacts.files) {
			if (!isPlainObject(entry)) {
				throw shapeError("every artifacts.files entry must be an object");
			}
			if ("content_b64" in entry) {
				throw shapeError("artifacts must not carry file contents ('content_b64' in a files entry)");
			}
			if (!nonEmptyString(entry.path)) {
				throw shapeError("every artifacts.files entry needs a non-empty string 'path'");
			}
			if (!optionalNonNegativeInt(entry.size)) {
				throw shapeError("artifacts file 'size', when present, must be a non-negative integer");
			}
		}
		if (!optionalNonNegativeInt(artifacts.total_bytes)) {
			throw shapeError("artifacts 'total_bytes', when present, must be a non-negative integer");
		}
		if (artifacts.run_name !== undefined && artifacts.run_name !== payload.run_name) {
			throw shapeError("artifacts.run_name does not match the record's run_name");
		}
	}
	return {
		source: payload.gateway,
		job_id: payload.job_id,
		template: payload.template,
		arguments_digest: payload.arguments_digest,
		state: payload.state,
		artifacts,
		retrieved: payload.observed,
	};
}

// The shared reference-resolution guard: a confidence's subject and an
// item's supports link are the same shape — a field naming a hypothesis
// entry recorded earlier (the recorder only appends, so it can never write
// a forward or dangling reference).
function namesEarlierHypothesis(known, at, field, ref) {
	if (!known.has(ref)) {
		throw new Error(`${at} ${field}: ${JSON.stringify(ref)} names no earlier hypothesis entry`);
	}
}

// Validates the project notebook the recorder writes (ADR 0003): every line
// of notebook.jsonl parses into a typed, dated entry — one of the five
// types, ids sequenced per type — whose evidence item cites a snapshot that
// exists, hashes to its own address, parses as the shape the item declares
// (a connector output or a gateway job record, ADR 0004), and agrees with
// the item it backs (source and retrieval date always; endpoints and query
// for a connector item, job identity and artifact manifest for a job-record
// item). An observation carries an entry-level grade and may link its
// evidence to an earlier hypothesis entry (`supports`); a confidence names
// the earlier hypothesis it judges — references that point nowhere fail.
// Extra snapshot files are tolerated — the recorder's write order orphans
// snapshots, never entries. Returns the counts and raw bytes the
// attestation names; throws on any failure.
export function auditNotebook(thetaDirArg) {
	// Canonicalize the directory itself: mount aliases (/var vs /private/var)
	// would otherwise fail the snapshot containment check below.
	const thetaDir = fs.realpathSync(thetaDirArg);
	const notebookPath = path.join(thetaDir, "notebook.jsonl");
	let st = null;
	try {
		st = fs.statSync(notebookPath);
	} catch {
		// missing is the common failure: the recorder never produced anything
	}
	if (st === null || !st.isFile()) {
		throw new Error(`notebook.jsonl is missing in ${thetaDir}: the recorder never produced one`);
	}
	const notebookBuf = fs.readFileSync(notebookPath);
	let text;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(notebookBuf);
	} catch (e) {
		throw new Error(`corrupt notebook.jsonl: ${e.message}`);
	}
	if (text === "") {
		throw new Error("no entries in notebook.jsonl — the recorder never produced anything");
	}
	const lines = text.replace(/\n$/, "").split("\n");
	const entries = [];
	for (let i = 0; i < lines.length; i++) {
		const where = `notebook.jsonl line ${i + 1}`;
		if (lines[i].trim() === "") {
			throw new Error(`${where} is blank — the recorder never writes blank lines`);
		}
		let entry;
		try {
			entry = JSON.parse(lines[i]);
		} catch (e) {
			throw new Error(`${where} is not JSON: ${e.message}`);
		}
		if (!isPlainObject(entry)) {
			throw new Error(`${where} is not a JSON object`);
		}
		entries.push(entry);
	}
	const snapshots = new Map(); // address -> derived fields, each file read once
	const seen = new Map(); // type -> count so far, for per-type id sequencing
	const knownHypotheses = new Set(); // ids of earlier hypothesis entries
	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i];
		const where = `notebook.jsonl line ${i + 1}`;
		const spec = NOTEBOOK_TYPES[entry.type];
		if (spec === undefined) {
			throw new Error(
				`${where} type: expected one of ${Object.keys(NOTEBOOK_TYPES).join(", ")}, got ${JSON.stringify(entry.type)}`,
			);
		}
		const count = (seen.get(entry.type) ?? 0) + 1;
		seen.set(entry.type, count);
		const wantId = `${spec.prefix}-${String(count).padStart(4, "0")}`;
		if (entry.id !== wantId) {
			throw new Error(
				`${where} id: expected ${wantId} (the recorder sequences ids per type from 1), got ${JSON.stringify(entry.id)}`,
			);
		}
		if (!isIsoDate(entry.date)) {
			throw new Error(
				`${where} date: expected a YYYY-MM-DD calendar date, got ${JSON.stringify(entry.date)}`,
			);
		}
		if (typeof entry.text !== "string" || entry.text.trim() === "") {
			throw new Error(
				`${where} text: expected non-empty text, got ${JSON.stringify(entry.text)}`,
			);
		}
		// A grade rates a source. Only an observation carries one at entry
		// level; on any other type the field is the grade/confidence merge
		// the vocabulary forbids.
		if (spec.graded) {
			if (!NOTEBOOK_GRADES.has(entry.grade)) {
				throw new Error(
					`${where} grade: expected one of asserted, cross-checked, re-executed, got ${JSON.stringify(entry.grade)}`,
				);
			}
		} else if (entry.grade !== undefined) {
			throw new Error(
				`${where} grade: only an observation carries an entry-level grade — judgment is the confidence entry type, and the two never merge`,
			);
		}
		// A confidence names the hypothesis it judges; the reference must
		// resolve to an earlier hypothesis entry, like an item's supports.
		// The field is confidence-only — a `hypothesis` field anywhere else
		// is a shape the recorder can never write.
		if (spec.judges) {
			if (!nonEmptyString(entry.hypothesis)) {
				throw new Error(
					`${where} hypothesis: expected the judged hypothesis id, got ${JSON.stringify(entry.hypothesis)}`,
				);
			}
			namesEarlierHypothesis(knownHypotheses, where, "hypothesis", entry.hypothesis);
		} else if (entry.hypothesis !== undefined) {
			throw new Error(
				`${where} hypothesis: only a confidence entry names a judged hypothesis`,
			);
		}
		const evidencePresent = entry.evidence !== undefined;
		if (spec.evidence === "required" && !evidencePresent) {
			throw new Error(
				`${where} evidence: expected a non-empty list, got ${JSON.stringify(entry.evidence)}`,
			);
		}
		if (spec.evidence === "forbidden" && evidencePresent) {
			throw new Error(
				`${where} evidence: a confidence entry carries none — judgment is not a source claim`,
			);
		}
		if (evidencePresent && (!Array.isArray(entry.evidence) || entry.evidence.length === 0)) {
			throw new Error(
				`${where} evidence: expected a non-empty list, got ${JSON.stringify(entry.evidence)}`,
			);
		}
		for (let j = 0; evidencePresent && j < entry.evidence.length; j++) {
			const item = entry.evidence[j];
			const at = `${where} evidence item ${j + 1}`;
			if (!isPlainObject(item)) {
				throw new Error(`${at}: expected an object, got ${JSON.stringify(item)}`);
			}
			// Two evidence shapes (ADR 0003 connector output, ADR 0004 job
			// record); the item's own fields declare which one it cites, and
			// an ambiguous item — both markers or neither — is not a shape
			// the recorder writes.
			const itemIsConnector = "endpoints" in item;
			const itemIsJob = "job_id" in item;
			if (itemIsConnector === itemIsJob) {
				throw new Error(
					`${at}: expected a connector item (endpoints) or a job-record item (job_id), got ${JSON.stringify(item)}`,
				);
			}
			if (!nonEmptyString(item.source)) {
				throw new Error(
					`${at} source: expected a non-empty string, got ${JSON.stringify(item.source)}`,
				);
			}
			if (itemIsConnector) {
				if (
					!Array.isArray(item.endpoints) ||
					item.endpoints.length === 0 ||
					item.endpoints.some((e) => !nonEmptyString(e))
				) {
					throw new Error(
						`${at} endpoints: expected a non-empty list of non-empty strings, got ${JSON.stringify(item.endpoints)}`,
					);
				}
				if (item.query !== null && typeof item.query !== "string") {
					throw new Error(
						`${at} query: expected a string or null, got ${JSON.stringify(item.query)}`,
					);
				}
			} else {
				if (typeof item.job_id !== "string" || !/^\d+$/.test(item.job_id)) {
					throw new Error(
						`${at} job_id: expected a string of digits, got ${JSON.stringify(item.job_id)}`,
					);
				}
				if (!("template" in item) || (item.template !== null && !nonEmptyString(item.template))) {
					throw new Error(
						`${at} template: expected a non-empty name or null, got ${JSON.stringify(item.template)}`,
					);
				}
				if (typeof item.arguments_digest !== "string" || !/^[0-9a-f]{64}$/.test(item.arguments_digest)) {
					throw new Error(
						`${at} arguments_digest: expected a 64-character sha256 hex digest, got ${JSON.stringify(item.arguments_digest)}`,
					);
				}
				if (typeof item.state !== "string" || item.state.trim() === "") {
					throw new Error(
						`${at} state: expected a non-empty string, got ${JSON.stringify(item.state)}`,
					);
				}
				if (item.query !== undefined) {
					throw new Error(
						`${at} query: a job-record item carries no query — the record's arguments ride the snapshot and the digest`,
					);
				}
			}
			if (!isIsoDate(item.retrieved)) {
				throw new Error(
					`${at} retrieved: expected a YYYY-MM-DD calendar date, got ${JSON.stringify(item.retrieved)}`,
				);
			}
			if (!NOTEBOOK_GRADES.has(item.grade)) {
				throw new Error(
					`${at} grade: expected one of asserted, cross-checked, re-executed, got ${JSON.stringify(item.grade)}`,
				);
			}
			// The recorder refuses cross-checked on a job record (a retrieval's
			// mark); a notebook carrying it anyway is not recorder-shaped.
			if (itemIsJob && item.grade === "cross-checked") {
				throw new Error(
					`${at} grade: a job-record item is graded asserted or re-executed, got ${JSON.stringify(item.grade)}`,
				);
			}
			if (item.supports !== undefined) {
				if (entry.type !== "observation") {
					throw new Error(
						`${at} supports: an evidence-to-hypothesis link rides an observation's evidence item`,
					);
				}
				namesEarlierHypothesis(knownHypotheses, at, "supports", item.supports);
			}
			// The recorder's single --grade flag stamps the observation and
			// its item together; a divergence is not a shape it can write.
			if (entry.type === "observation" && item.grade !== entry.grade) {
				throw new Error(
					`${at} grade: ${JSON.stringify(item.grade)} diverges from the observation's own grade (${JSON.stringify(entry.grade)}) — the recorder stamps both from one flag`,
				);
			}
			const addr = /^evidence\/([0-9a-f]{64})\.json$/.exec(item.snapshot);
			if (!addr) {
				throw new Error(
					`${at} snapshot: expected an evidence/<sha256>.json address, got ${JSON.stringify(item.snapshot)}`,
				);
			}
			const kind = itemIsJob ? "job" : "connector";
			let derived = snapshots.get(item.snapshot);
			if (derived === undefined) {
				derived = auditSnapshot(thetaDir, item.snapshot, addr[1], where, kind);
				snapshots.set(item.snapshot, derived);
			} else if (derived.kind !== kind) {
				throw new Error(
					`${at} snapshot is cited as both a connector output and a job record`,
				);
			}
			if (item.source !== derived.source) {
				throw new Error(
					`${at} source ${JSON.stringify(item.source)} does not match its snapshot (${JSON.stringify(derived.source)})`,
				);
			}
			if (itemIsConnector) {
				if (JSON.stringify(item.endpoints) !== JSON.stringify(derived.endpoints)) {
					throw new Error(
						`${at} endpoints do not match the snapshot's calls (${derived.endpoints.join(", ")})`,
					);
				}
				if (item.query !== derived.query) {
					throw new Error(
						`${at} query does not match its snapshot (${JSON.stringify(derived.query)})`,
					);
				}
			} else {
				if (item.job_id !== derived.job_id) {
					throw new Error(
						`${at} job_id does not match its snapshot (${JSON.stringify(derived.job_id)})`,
					);
				}
				if (item.template !== derived.template) {
					throw new Error(
						`${at} template does not match its snapshot (${JSON.stringify(derived.template)})`,
					);
				}
				if (item.arguments_digest !== derived.arguments_digest) {
					throw new Error(
						`${at} arguments_digest does not match its snapshot (${JSON.stringify(derived.arguments_digest)})`,
					);
				}
				if (item.state !== derived.state) {
					throw new Error(
						`${at} state does not match its snapshot (${JSON.stringify(derived.state)})`,
					);
				}
				// The item omits the manifest when none was fetched; the
				// snapshot's null means the same thing.
				const itemArtifacts = item.artifacts === undefined ? null : item.artifacts;
				if (JSON.stringify(itemArtifacts) !== JSON.stringify(derived.artifacts)) {
					throw new Error(
						`${at} artifact manifest does not match its snapshot (${JSON.stringify(derived.artifacts)})`,
					);
				}
				// The recorder refuses re-executed without the manifest; a
				// notebook carrying the claim anyway is not recorder-shaped.
				if (derived.artifacts === null && item.grade === "re-executed") {
					throw new Error(
						`${at} grade re-executed without the snapshot's artifact manifest — fetch the artifacts first or grade asserted`,
					);
				}
			}
			if (item.retrieved !== derived.retrieved) {
				throw new Error(
					`${at} retrieved ${JSON.stringify(item.retrieved)} does not match its snapshot (${JSON.stringify(derived.retrieved)})`,
				);
			}
		}
		if (entry.type === "hypothesis") knownHypotheses.add(entry.id);
	}
	return { entries: entries.length, snapshots: snapshots.size, notebookBuf };
}

// ---------------------------------------------------------------------------
// Shell command inspection
//
// The script attestation judges a bash command STRING, not structured
// arguments. These helpers implement a conservative POSIX-ish read: enough
// shell to know which word is the program being executed, refusing
// everything they cannot model. Unmodelled forms (expansions, arithmetic,
// process substitution, nested `bash -c` strings) leave words unresolvable
// and fail closed.

// Lexes a command into an ordered mix of words and operators. Words carry
// their quote-stripped value; operators are runs of `;&|<>()` (a leading
// file-descriptor digit is absorbed: `2>&1` lexes as the operator `2>&`
// followed by the word `1`) and unquoted newlines. Quoting groups,
// backslash escapes (a backslash-newline is a line continuation and
// contributes nothing), and `#` at word start comments to end of line. An
// unterminated quote consumes the rest of the string — a command the shell
// itself would reject. Heredoc bodies are consumed here, at the raw-line
// level: the lines after the command line belong to each pending `<<`
// delimiter in order, and the terminator is the delimiter ALONE on its
// line — quote-stripped or whitespace-padded lookalikes are body text.
function shellLex(command) {
	const toks = [];
	const heredocs = [];
	let expectDelim = null; // "<<" | "<<-" while a delimiter is expected
	// A carriage return is a WORD character to bash (a pasted CRLF leaves
	// the \r inside the filename); only \n ends a line.
	const isOp = (c) => /[ \t\f\v\n;&|<>()]/.test(c);
	const isOpNoSpace = (c) => /[;&|<>()]/.test(c);
	let i = 0;
	while (i < command.length) {
		const ch = command[i];
		if (ch === "\n") {
			expectDelim = null; // an unterminated << is invalid shell
			if (heredocs.length > 0) {
				i++;
				for (const h of heredocs) {
					let terminator = false;
					while (i <= command.length) {
						const nl = command.indexOf("\n", i);
						const end = nl === -1 ? command.length : nl;
						const line = command.slice(i, end);
						if ((h.tabs ? line.replace(/^\t+/, "") : line) === h.delim) {
							i = nl === -1 ? command.length : nl + 1;
							terminator = true;
							break;
						}
						if (nl === -1) {
							i = command.length;
							break;
						}
						i = nl + 1;
					}
					if (!terminator) i = command.length;
				}
				heredocs.length = 0;
			} else {
				i++;
			}
			toks.push({ t: "o", v: "\n" });
			continue;
		}
		if (/[ \t\f\v]/.test(ch)) {
			i++;
			continue;
		}
		if (ch === "#") {
			while (i < command.length && command[i] !== "\n") i++;
			continue;
		}
		// fd-prefixed redirection: the digits join the following <>& run
		let j = i;
		while (j < command.length && /[0-9]/.test(command[j])) j++;
		if (j > i && j < command.length && /[<>]/.test(command[j])) {
			while (j < command.length && /[<>&]/.test(command[j])) j++;
			const op = command.slice(i, j);
			toks.push({ t: "o", v: op });
			expectDelim = op.includes("<<") && !op.includes("<<<") ? "<<" : null;
			i = j;
			// a dash attached to the heredoc operator marks the
			// tab-stripping form and belongs to the operator
			if (expectDelim === "<<" && command[i] === "-") {
				expectDelim = "<<-";
				i++;
			}
			continue;
		}
		if (isOpNoSpace(ch)) {
			while (j < command.length && isOpNoSpace(command[j])) j++;
			const run = command.slice(i, j);
			i = j;
			// emit canonical operators, splitting runs: `);` is two
			// operators, while &&, ||, |&, <<, >>, <<<, &>, &>> stay whole
			for (let k = 0; k < run.length; ) {
				const three = run.slice(k, k + 3);
				const two = run.slice(k, k + 2);
				let op = run[k];
				if (three === "<<<" || three === "&>>") op = three;
				else if (
					two === "&&" ||
					two === "||" ||
					two === "|&" ||
					two === "<<" ||
					two === ">>" ||
					two === "&>" ||
					two === ">&"
				) {
					op = two;
				}
				toks.push({ t: "o", v: op });
				// a heredoc expects its delimiter next; every other
				// operator ends that expectation
				expectDelim = op === "<<" ? "<<" : null;
				k += op.length;
			}
			// a dash attached to `<<` is the <<- operator, not the start
			// of the delimiter word
			if (expectDelim === "<<" && command[i] === "-") {
				expectDelim = "<<-";
				i++;
			}
			continue;
		}
		// a word: quoting groups, backslash escapes the next character
		let w = "";
		let quoted = false;
		while (i < command.length && !isOp(command[i])) {
			const c = command[i];
			if (c === "'") {
				quoted = true;
				let k = i + 1;
				while (k < command.length && command[k] !== "'") k++;
				w += command.slice(i + 1, k);
				i = Math.min(k + 1, command.length);
			} else if (c === '"') {
				quoted = true;
				let k = i + 1;
				while (k < command.length && command[k] !== '"') k++;
				for (let q = i + 1; q < k; q++) {
					if (command[q] === "\\" && /[$`"\\\n]/.test(command[q + 1] ?? "")) q++;
					w += command[q] ?? "";
				}
				i = Math.min(k + 1, command.length);
			} else if (c === "`") {
				// command substitution: consume the span raw as one
				// unresolvable word — the module refuses what it cannot
				// model, and a hidden cd inside must not silently divert
				// the anchor
				quoted = true;
				let k = i + 1;
				while (k < command.length) {
					if (command[k] === "\\") k += 2;
					else if (command[k] === "`") break;
					else k++;
				}
				w += command.slice(i, Math.min(k + 1, command.length));
				i = Math.min(k + 1, command.length);
			} else if (c === "\\") {
				// backslash-newline (and backslash-\r\n) is a continuation
				if (command[i + 1] === "\n") i += 2;
				else if (command[i + 1] === "\r" && command[i + 2] === "\n") i += 3;
				else {
					w += command[i + 1] ?? "";
					i += 2;
				}
			} else {
				w += c;
				i++;
			}
		}
		if (expectDelim) {
			// the delimiter is the word as-is; `<<-` only changes how the
			// terminator line is matched (leading tabs stripped)
			heredocs.push({ delim: w, tabs: expectDelim === "<<-" });
			expectDelim = null;
		}
		// an empty word matters only as a quoted heredoc delimiter
		if (w !== "" || quoted) toks.push({ t: "w", v: w });
	}
	return toks;
}

// The command's words, quote-stripped, in order (operators dropped).
export function shellTokens(command) {
	return shellLex(command)
		.filter((tok) => tok.t === "w")
		.map((tok) => tok.v);
}

// Interpreters execute their first program word; wrappers pass through to a
// program after their own flags, numeric arguments, and assignments.
// (`builtin` runs only shell builtins, so it is not a wrapper.)
const INTERPRETERS = new Set(["python3", "python", "bash", "sh", "zsh", "env", "uv"]);
const WRAPPERS = new Set([
	"timeout", "nohup", "nice", "stdbuf", "watch", "sudo", "time", "exec",
	"command",
]);

// A wrapper's known flags: an unknown one fails the wrapper before the
// program runs, so the program search ends. stdbuf's take glued values
// (-oL); the lists stay deliberately short — an unlisted flag is only a
// refusal, never a false attestation.
const wrapperAcceptsFlag = (wrapper, flag) => {
	switch (wrapper) {
		case "command":
			return flag === "-p" || flag === "-v" || flag === "-V";
		case "nice":
			return flag === "-n";
		case "time":
			return flag === "-p";
		case "nohup":
		case "exec":
			return false;
		case "timeout":
			return (
				flag === "-k" ||
				flag === "-s" ||
				flag === "--foreground" ||
				flag === "--preserve-status"
			);
		case "stdbuf":
			return /^-[oei]/.test(flag);
		case "sudo":
			// only execute-carrying flags; -l/-e/-V/-h/-k/-K run nothing
			// and must not keep the program search alive
			return (
				/^-[AabCcDEgHiInPpRrSsTt]$/.test(flag) ||
				flag === "--preserve-env" ||
				flag === "--login" ||
				flag === "--shell" ||
				flag.startsWith("--user=")
			);
		case "watch":
			return /^-[dgnptbcex]$/.test(flag);
		default:
			return false;
	}
};
const isInterpreter = (w) => INTERPRETERS.has(w) || /^python\d+(\.\d+)?$/.test(w);

// Pipe spellings: `|` and bash's `|&` share every semantic the audit
// models (members run in subshells; a guarded pipeline guards all).
const isPipe = (v) => v === "|" || v === "|&";

// Control-flow keywords: whether the body ran is exactly what an
// attestation would have to prove, and the audit does not model it — a
// command headed by one of these words fails closed.
const COMPOUND = new Set([
	"if", "then", "elif", "else", "fi", "while", "until", "do", "done",
	"for", "in", "case", "esac", "select", "function", "{", "}", "!",
]);

// True when the simple command at cdIdx (whose last consumed word ends
// just before `after`) is backgrounded with `&` or sits in a pipeline —
// both run it in a subshell, so a cd there never moves the parent cwd.
// Redirections between the command and the `&` are stepped over.
function subshellConfined(toks, cdIdx, after) {
	const isRedirect = (v) => v.includes("<") || v.includes(">");
	let k = after;
	while (k < toks.length && toks[k].t === "o") {
		const v = toks[k].v;
		if (isRedirect(v)) {
			k++;
			while (k < toks.length && toks[k].t === "o") k++;
			k++; // the redirection's target word
			continue;
		}
		if (isPipe(v) || v === "&") return true;
		break; // any other operator ends the simple command
	}
	// Backward to the start of the pipeline segment: words of the same
	// segment (an assignment or a redirect's target may precede the cd)
	// belong to it, and a pipe before the boundary means the cd runs in a
	// subshell.
	for (let b = cdIdx - 1; b >= 0; b--) {
		const t = toks[b];
		if (t.t === "w") continue;
		const v = t.v;
		if (isPipe(v)) return true;
		if (isRedirect(v)) continue;
		return false; // a boundary or stray operator ends the look
	}
	return false;
}

// True when the command EXECUTES the target script: a word in program
// position — the command word itself, or the program word after an
// interpreter or wrapper chain — resolves canonically to exactly the
// target. Relative words resolve against the session cwd (or a `cd`
// earlier in the command). Words that merely mention the path —
// arguments, comments, heredoc bodies, redirection targets — never
// attest, and neither does a copy of the script elsewhere on disk.
// Short-circuit operators are modelled conservatively: a segment after
// `&&` attests only when its chain runs to the command's end unbroken (a
// non-error overall result then proves every `&&`-chained segment ran;
// newlines directly after the operator continue the list); a segment
// after `||` never attests, because success and skip are
// indistinguishable in the overall exit status. Control flow (if, while,
// case, for, brace groups) is refused outright — whether the body ran is
// exactly what an attestation would have to prove.
export function commandResolvesToScript(command, target, root) {
	// cwd anchors relative words; null means the shell went somewhere the
	// audit cannot know (cd through an expansion), so relative words can
	// no longer attest.
	let cwd = root;
	const resolvesTo = (w, direct = false) => {
		// expansion-shaped spellings ($X, ~x, `x`) expand to something
		// else in the real shell — a same-named literal file proves
		// nothing, so they never qualify
		if (/[$`]/.test(w) || w.startsWith("~")) return false;
		// open("file/") and open("file/.") fail — realpath would collapse
		// both onto the file, so reject the spellings first
		if (w === "" || /\/(\.|\.\.)?$/.test(w)) return false;
		// bash executes a slash-containing word directly; a slash-less one
		// goes through PATH, which the audit does not model
		if (direct && !w.includes("/")) return false;
		if (!path.isAbsolute(w) && cwd === null) return false;
		const p = path.isAbsolute(w) ? w : path.resolve(cwd, w);
		try {
			const real = fs.realpathSync(p);
			if (real !== target) return false;
			// direct execution needs the execute bit; an interpreter
			// operand only needs to be openable
			if (direct) fs.accessSync(real, fs.constants.X_OK);
			return true;
		} catch {
			return false;
		}
	};
	const toks = shellLex(command);
	// A trailing newline ends the last line, not a statement — the
	// &&-tail proof must not count it as a break.
	while (
		toks.length > 0 &&
		toks[toks.length - 1].t === "o" &&
		toks[toks.length - 1].v === "\n"
	) {
		toks.pop();
	}
	// A CDPATH mention makes later bare-relative cds land somewhere the
	// audit cannot know — bash searches CDPATH before the working
	// directory, and a `read CDPATH` assigns it without the = spelling.
	// (`./x` and `../x` bypass it; so do absolute paths.)
	const cdpathAt = toks.findIndex(
		(t) => t.t === "w" && (t.v === "CDPATH" || t.v.startsWith("CDPATH=")),
	);
	// Operators that decouple the overall exit status from the `&&` chain
	// in progress: once one follows, the chain's later segments can no
	// longer be proven to have run. `|` is deliberately absent — pipeline
	// members run unconditionally.
	const breaksChain = (op) =>
		op === ";" || op === "\n" || op === "&" || op === "||" || op === ")";
	// Index of the next chain-breaking operator at or after each token.
	const nextBreak = new Array(toks.length).fill(-1);
	for (let k = toks.length - 1; k >= 0; k--) {
		nextBreak[k] =
			toks[k].t === "o" && breaksChain(toks[k].v) ? k : (nextBreak[k + 1] ?? -1);
	}
	// Bash opens a simple command's redirections BEFORE running it: one
	// that provably fails stops the command, and a rescuing tail
	// (`; echo ok`) still exits 0. An attestation therefore requires
	// every redirection from its word to the next separator to look
	// runnable against the anchor current at that point. `)` does not
	// stop the scan — a redirection after it applies to the whole
	// parenthesized command.
	const endsSegment = (v) =>
		v === ";" || v === "\n" || v === "&" || v === "&&" || v === "||" ||
		v === "(" || isPipe(v);
	const redirectUnsafe = (fromIdx) => {
		const closed = new Set(); // fds closed by N>&- in this scan
		let k = fromIdx;
		while (k < toks.length && !(toks[k].t === "o" && endsSegment(toks[k].v))) {
			const t = toks[k];
			if (
				t.t === "o" &&
				(t.v.includes("<") || t.v.includes(">")) &&
				!t.v.includes("<<")
			) {
				let m = k + 1;
				while (m < toks.length && toks[m].t === "o") m++;
				const target = toks[m]?.t === "w" ? toks[m].v : undefined;
				// invalid, expansion-shaped, or glob-shaped targets cannot
				// be judged (a multi-match glob is an ambiguous redirect)
				if (
					target === undefined ||
					target === "" ||
					/[$`]/.test(target) ||
					target.includes("*") ||
					target.includes("?") ||
					target.includes("[")
				) {
					return true;
				}
				// Only `>&digit` / `>&-` duplicate or close an fd (only
				// 0-2 are guaranteed open; a closed source is a bad fd) —
				// after every other spelling the word is a filename
				const isDup = t.v === ">&" || /^\d*>&$/.test(t.v);
				const fd = /^(\d+)/.exec(t.v)?.[1] ?? (t.v.includes(">") ? "1" : "0");
				if (isDup && target === "-") {
					closed.add(fd); // until a file redirect reopens it
					k = m + 1;
					continue;
				}
				if (isDup && /^[0-9]+$/.test(target)) {
					if (!/^[012]$/.test(target) || closed.has(target)) return true;
					k = m + 1;
					continue;
				}
				// a fd-prefixed dup takes an fd operand only — a file word
				// is bash's ambiguous redirect (the bare >&file form is a
				// both-streams file redirect and falls through)
				if (/^\d+>&$/.test(t.v)) return true;
				const p =
					cwd === null
						? (path.isAbsolute(target) ? target : null)
						: (path.isAbsolute(target) ? target : path.resolve(cwd, target));
				if (p === null) return true; // anchor unknown
				const writing = t.v.includes(">");
				if (writing) {
					let dir;
					try {
						dir = fs.realpathSync(path.dirname(p)); // ENOTDIR/ELOOP
					} catch {
						return true;
					}
					if (!fs.statSync(dir).isDirectory()) return true;
					let st = null;
					try {
						st = fs.statSync(p);
					} catch (e) {
						if (e.code !== "ENOENT") return true; // ELOOP, EACCES…
					}
					if (st === null) {
						// something exists at the path but does not resolve:
						// a dangling symlink bash would open through
						let entry = null;
						try {
							entry = fs.lstatSync(p);
						} catch (e) {
							if (e.code !== "ENOENT") return true;
						}
						if (entry !== null) return true;
					}
					try {
						// an existing target must be a writable file; a new
						// one needs a writable directory to be created in
						fs.accessSync(st !== null ? p : dir, fs.constants.W_OK);
					} catch {
						return true;
					}
					if (st?.isDirectory()) return true; // EISDIR
				} else {
					let real;
					try {
						real = fs.realpathSync(p); // ENOENT/ELOOP/ENOTDIR
					} catch {
						return true;
					}
					if (fs.statSync(real).isDirectory()) return true; // EISDIR
					try {
						fs.accessSync(real, fs.constants.R_OK);
					} catch {
						return true;
					}
				}
				// a file redirect opens its fd, reopening a closed one
				closed.delete(fd);
				k = m + 1;
				continue;
			}
			k++;
		}
		return false;
	};
	// Program-position state, per simple command (restarted at every
	// operator): "prefix" = still consuming wrappers, flags, and
	// assignments; "program" = the next word is the executed program;
	// "args" = the program word is behind us and nothing later executes.
	// Reachability of the current segment: "open" runs unconditionally,
	// "and"/"or" follow a short-circuit operator. `awaiting` marks an
	// &&/|| operand still expected — a newline (or comment line) directly
	// after the operator continues the list instead of ending it.
	let phase = "prefix";
	let guard = "open";
	let awaiting = false;
	let envChain = false; // the program word waits after env
	let lastWrapper = null; // the wrapper whose args are being consumed
	let headWord = null; // the word that opened the program phase
	let timeoutNum = false; // timeout's one duration operand is consumed
	let pendingValue = false; // the next word is a wrapper flag's value
	let pendingClose = false; // the last operator was a closing paren
	let execHeaded = false; // this segment's head is exec
	let execPend = false; // exec's interpreter still awaits its operand
	let segStart = 0; // token index where the current segment began
	const frames = []; // cwd and guard at each open subshell
	let i = 0;
	while (i < toks.length) {
		const tok = toks[i];
		if (tok.t === "o") {
			const op = tok.v;
			if (op.includes("<") || op.includes(">")) {
				// a redirection's target is the next word — operator runs
				// may split (`<>` lexes as `<` then `>`), so skip any
				// stray operators before it. A `(` there is process
				// substitution: unmodelled, refused outright. A redirect
				// does not clear pendingClose — the word after it still
				// completes a command substitution. The parse is more
				// permissive than bash on invalid redirections (e.g. an
				// ambiguous `2>&` target): those cannot pair with a
				// non-error result unless a rescuing tail exits 0, and a
				// provably-failing redirection taints the segment below.
				i++;
				while (i < toks.length && toks[i].t === "o") {
					if (toks[i].v === "(") return false;
					i++;
				}
				if (
					execHeaded &&
					frames.length === 0 &&
					(op === ">&" || /^\d*>&$/.test(op)) &&
					toks[i]?.t === "w" &&
					(toks[i].v === "-" || /^\d+-$/.test(toks[i].v))
				) {
					// exec with a redirect-only list closes (or moves, the
					// N- form) the fd for the whole shell — a later
					// segment's dup would abort it
					return false;
				}
				i++;
				continue;
			}
			pendingClose = false;
			envChain = false; // a new simple command begins
			lastWrapper = null;
			headWord = null;
			timeoutNum = false;
			// a replaced shell makes every later segment phantom
			if (execPend && frames.length === 0) return false;
			execHeaded = false;
			if (op === "&&") {
				guard = "and";
				awaiting = true;
			} else if (op === "||") {
				guard = "or";
				awaiting = true;
			} else if (op === "(") {
				// a subshell starts at the parent cwd and inherits the
				// guard — a separator inside may not drop below it
				frames.push({ cwd, guard });
			} else if (op === ")") {
				const frame = frames.pop();
				cwd = frame?.cwd ?? cwd; // …and its cd dies with it
				guard = frame?.guard ?? guard; // pipeline siblings keep it
				awaiting = false;
				pendingClose = true;
				execPend = false; // a subshell replacement ends with it
				// `) (` adjacency (newlines aside) is a function
				// definition's body: the body defines, it does not run
				let k = i + 1;
				while (k < toks.length && toks[k].t === "o" && toks[k].v === "\n") k++;
				if (toks[k]?.t === "o" && toks[k].v === "(") return false;
			} else if (isPipe(op)) {
				// pipeline members share the pipeline's reachability —
				// a guarded pipeline guards every member
				awaiting = false;
			} else if (op === "\n" && awaiting) {
				// the AND-OR list continues past the newline
			} else {
				// a separator resets to the innermost subshell's
				// inherited guard, never below it
				guard = frames.length > 0 ? frames[frames.length - 1].guard : "open";
				awaiting = false;
			}
			phase = "prefix"; // every operator ends the simple command
			i++;
			segStart = i;
			continue;
		}
		const wordIdx = i;
		const w = tok.v;
		i++;
		// A word directly after `)` — redirections between included, they
		// do not clear the pending close — completes a command
		// substitution or process substitution (`$(pwd)/x`, `>(…) x`):
		// expansion output the audit cannot model. Refused.
		if (pendingClose) return false;
		awaiting = false;
		// the value of a value-taking wrapper flag is never a program
		if (pendingValue) {
			pendingValue = false;
			continue;
		}
		// A guarded segment's program word attests only when its execution
		// is provable: open segments always run; an `&&`-guarded one only
		// inside a chain that reaches the command's end unbroken.
		const provable = guard === "open" || (guard === "and" && nextBreak[wordIdx] === -1);
		const skippable = /^-/.test(w) || /^\d+$/.test(w) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(w);
		if (phase === "args") continue;
		if (phase === "program") {
			// An interpreter flag may take the next word as its value — or
			// be the read-stdin operand `-`; a numeric or assignment word
			// would itself be the script operand (env is the exception: it
			// consumes NAME=VALUE pairs). The program search ends, and no
			// later word in this segment can attest.
			const assignment = /^[A-Za-z_][A-Za-z0-9_]*=/.test(w);
			if (envChain && assignment) {
				// a PATH reassignment makes interpreter resolution unknowable
				if (w.startsWith("PATH=")) phase = "args";
				continue; // env K=V pairs keep waiting
			}
			if (/^-/.test(w) || /^\d+$/.test(w) || assignment) {
				phase = "args";
				// the operand position of an exec'd interpreter was eaten
				// by a flag or value: the shell was replaced regardless —
				// a subshell replacement dies with its subshell
				if (execHeaded && frames.length === 0) return false;
				continue;
			}
			if (isInterpreter(w) || WRAPPERS.has(w)) {
				// A wrapper (or env) execs its program word, which may
				// itself be an interpreter — the chain continues. After a
				// plain interpreter the word is the script operand
				// (python3 env x.py runs a file named env): the search
				// ends at the fall-through below.
				if (headWord === "env" || WRAPPERS.has(headWord)) {
					envChain = w === "env"; // only env itself consumes pairs
					continue;
				}
			}
			phase = "args";
			if (provable && !redirectUnsafe(segStart) && resolvesTo(w)) return true;
			// exec replaces the shell: an unresolved program word means
			// every later segment is phantom — unless the replacement is
			// subshell-confined
			if (execHeaded && frames.length === 0) return false;
			continue;
		}
		// prefix phase: this word is the command word
		if (skippable) {
			// Command-prefix material: assignments may precede the command
			// word itself (before any wrapper is consumed), flags follow
			// the wrapper they belong to, and only timeout always takes a
			// numeric duration operand. A skippable-shaped word with no
			// such home is itself the program — the shell would fail to
			// find it — and the search ends.
			if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w) && lastWrapper === null) {
				// a PATH reassignment makes interpreter resolution unknowable
				if (w.startsWith("PATH=")) phase = "args";
				continue;
			}
			if (/^-/.test(w) && lastWrapper !== null) {
				// mode flags that run nothing: command prints, sudo -v
				// refreshes credentials
				if (
					(lastWrapper === "command" && /^-[vV]$/.test(w)) ||
					(lastWrapper === "sudo" && w === "-v")
				) {
					phase = "args";
					continue;
				}
				// an unknown flag fails the wrapper before the program runs
				if (!wrapperAcceptsFlag(lastWrapper, w)) phase = "args";
				// sudo's prompt string takes any value — the next word is
				// consumed, never a program
				if (lastWrapper === "sudo" && w === "-p") pendingValue = true;
				continue;
			}
			if (/^\d+$/.test(w) && lastWrapper === "timeout" && !timeoutNum) {
				timeoutNum = true; // timeout takes exactly one duration
				continue;
			}
			phase = "args";
			continue;
		}
		if (COMPOUND.has(w)) return false; // control flow is refused outright
		// exit ends the shell: no later segment runs; trap can arrange the
		// same (a DEBUG/ERR handler exiting before the command); eval,
		// builtin, and source reparsing can end it from argument position.
		// All die with a subshell, so depth 0 only.
		if (
			frames.length === 0 &&
			(w === "exit" ||
				w === "trap" ||
				w === "eval" ||
				w === "builtin" ||
				w === "." ||
				w === "source")
		) {
			return false;
		}
		if (w === "set") {
			// noexec parses without executing anything; noclobber makes
			// ordinary > redirections fail on existing files; restricted
			// forbids '/' in command names
			for (let s = i; s < toks.length && toks[s].t === "w"; s++) {
				if (
					/^-+[^-]*[nCr]/.test(toks[s].v) ||
					toks[s].v === "noexec" ||
					toks[s].v === "noclobber"
				) {
					return false;
				}
			}
		}
		if (WRAPPERS.has(w)) {
			lastWrapper = w;
			headWord ??= w; // for exec-with-closes detection
			if (w === "exec") execHeaded = true;
			continue;
		}
		if (w === "cd" || w === "pushd") {
			// exec'ing a special builtin ends the shell too
			if (execHeaded && frames.length === 0) return false;
			// Consume the directory argument, past cd's own flags (-L,
			// -P, …) and `--`. The anchor moves only when the cd provably
			// ran and succeeded in the parent shell: open and foreground,
			// or `&&`-guarded in a chain that reaches the command's end
			// (the caller's non-error result gate then proves every
			// chained segment exited 0). A cd backgrounded with `&` or
			// anywhere in a pipeline runs in a subshell — the parent
			// anchor stays exactly — and `pushd -n` is a dry run. Any
			// other cd — `||`-guarded, decoupled by a later separator,
			// CDPATH-shadowed, expansion-sourced, bare, or resolving to
			// nothing on disk now — leaves the shell somewhere the audit
			// cannot know, and later relative words can no longer attest.
			let d = i;
			let dry = false; // pushd -n never changes the directory
			let badFlag = false; // bash rejects unknown cd/pushd options
			while (toks[d]?.t === "w" && /^-/.test(toks[d].v) && toks[d].v !== "--") {
				const flag = toks[d].v;
				const known =
					(w === "cd" && /^-[LP]+$/.test(flag)) ||
					(w === "pushd" && (flag === "-n" || /^[+-]\d+$/.test(flag)));
				if (w === "pushd" && (flag === "-n" || /^[+-]\d+$/.test(flag))) dry = true;
				if (!known) badFlag = true;
				d++;
			}
			if (toks[d]?.t === "w" && toks[d].v === "--") d++;
			const dir = toks[d]?.t === "w" ? toks[d].v : null;
			if (dir === null) {
				cwd = null; // bare cd goes HOME; bare pushd swaps
				i = d;
			} else {
				i = d + 1;
				const subshellCd = subshellConfined(toks, wordIdx, i);
				const cdpathShadowed =
					cdpathAt !== -1 &&
					cdpathAt < wordIdx &&
					!path.isAbsolute(dir) &&
					!dir.startsWith("./") &&
					!dir.startsWith("../");
				const p =
					cwd === null
						? (path.isAbsolute(dir) ? dir : null)
						: (path.isAbsolute(dir) ? dir : path.resolve(cwd, dir));
				let real = null;
				if (p !== null) {
					try {
						const r = fs.realpathSync(p);
						if (fs.statSync(r).isDirectory()) real = r;
					} catch {
						// unresolvable now: it may have existed at run time
					}
				}
				if (!subshellCd && !dry) {
					// a cd whose redirection may have failed, whose options
					// bash would reject, or that never provably ran loses
					// the anchor
					cwd =
						real !== null &&
						provable &&
						!cdpathShadowed &&
						!badFlag &&
						!redirectUnsafe(segStart)
							? real
							: null;
				}
			}
			phase = "args";
			continue;
		}
		if (w === "popd") {
			cwd = null; // restores an older directory the audit never knew
			phase = "args";
			continue;
		}
		phase = isInterpreter(w) ? "program" : "args";
		envChain = w === "env";
		headWord = w;
		if (execHeaded && isInterpreter(w)) execPend = true;
		if (provable && !redirectUnsafe(segStart) && resolvesTo(w, true)) return true;
		// exec replaces the shell: an unresolved program word means every
		// later segment is phantom — unless the word opens a program phase
		// whose operand may still resolve
		if (execHeaded && frames.length === 0 && !isInterpreter(w)) return false;
	}
	return false;
}

// Collects the tool-call/result graph the spot-check attestations search.
// tool calls are assistant requests: one embedded in a system, user, or
// toolResult record is transcript corruption. The graph must be temporally
// consistent: every call needs exactly one later matching result, every
// result an earlier call — a spliced transcript pairing a result with a
// later call fails.
// One walk over the transcript's tool-call surface, shared by the graph
// and the nested-record check: each record's content array yields its
// toolCall entries, and each toolResult message yields once. Consumers
// accumulate their own state — the graph keeps record indexes and throws
// on temporal faults; the nested-record check keeps id sets and reads
// the bounded record.
function* walkToolCallsAndResults(recs) {
	let recordIndex = 0;
	for (const r of recs) {
		recordIndex += 1;
		const m = r.message;
		if (!m) continue;
		if (Array.isArray(m.content)) {
			for (const t of m.content) {
				if (t?.type === "toolCall") {
					yield { call: t, recordIndex, message: m };
				}
			}
		}
		if (r.type === "message" && m.role === "toolResult") {
			yield { result: m, recordIndex };
		}
	}
}

function collectToolGraph(recs) {
	const calls = [];
	const callOrder = new Map();
	const results = new Map();
	for (const step of walkToolCallsAndResults(recs)) {
		if (step.call === undefined) {
			const m = step.result;
			if (typeof m.toolCallId !== "string" || m.toolCallId === "") {
				throw new Error(
					`toolResult without a usable toolCallId: ${JSON.stringify(m.toolCallId)}`,
				);
			}
			if (results.has(m.toolCallId)) {
				throw new Error(`duplicate toolResult for ${m.toolCallId}`);
			}
			results.set(m.toolCallId, { recordIndex: step.recordIndex, message: m });
			continue;
		}
		const t = step.call;
		// tool calls are assistant requests: one embedded in a system,
		// user, or toolResult record is transcript corruption.
		if (step.message.role !== "assistant") {
			throw new Error(
				`toolCall in ${step.message.role} record — transcript corruption`,
			);
		}
		if (typeof t.id !== "string" || t.id === "") {
			throw new Error(`toolCall without a usable id: ${JSON.stringify(t.id)}`);
		}
		if (callOrder.has(t.id)) {
			throw new Error(`duplicate toolCall id: ${t.id}`);
		}
		callOrder.set(t.id, step.recordIndex);
		calls.push(t);
	}
	const orphans = [...results.keys()].filter((id) => !callOrder.has(id));
	const unanswered = calls.filter((t) => !results.has(t.id));
	if (orphans.length > 0) {
		throw new Error(`orphan toolResults without calls:\n${orphans.join("\n")}`);
	}
	if (unanswered.length > 0) {
		throw new Error(
			`tool calls without results:\n${unanswered.map((t) => t.id).join("\n")}`,
		);
	}
	for (const t of calls) {
		const r = results.get(t.id);
		if (r && r.recordIndex < callOrder.get(t.id)) {
			throw new Error(`toolResult for ${t.id} precedes its toolCall`);
		}
	}
	return { calls, callOrder, results };
}

// pi's suffix grammar for nested-call ids: one or more `/<n>` segments
// after the parent id (a deeper nest appends its own).
const NESTED_ID_SUFFIX = /^(?:\/\d+)+$/;

// Reads codemode's bounded record of the calls a tool made (pi keeps name,
// arguments, status — never results — as `nestedCalls` on the calling
// tool's result message) instead of assuming a flat call sequence. Each
// nested id is assigned by pi as `<parent id>/<n>` and never appears as a
// transcript record, so the record holds together only one way: every
// nested id derives from the toolCallId of the result message carrying
// it, all nested ids are unique, and none collides with a top-level call
// or result id. A fabricated record — spliced onto the wrong parent,
// duplicated, or claiming a top-level call's id — fails closed. Returns
// the nested-call count for the attestation.
export function collectNestedCalls(recs) {
	const topLevelIds = new Set();
	const nestedIds = new Set();
	let count = 0;
	for (const step of walkToolCallsAndResults(recs)) {
		if (step.call !== undefined) {
			if (nonEmptyString(step.call.id)) {
				topLevelIds.add(step.call.id);
			}
			continue;
		}
		const m = step.result;
		if (nonEmptyString(m.toolCallId)) {
			topLevelIds.add(m.toolCallId);
		}
		const nc = m.nestedCalls;
		if (nc === undefined) continue;
		if (!nonEmptyString(m.toolCallId)) {
			throw new Error("nestedCalls on a tool result without a usable toolCallId");
		}
		if (!isPlainObject(nc) || !Array.isArray(nc.calls)) {
			throw new Error(
				`nestedCalls on tool result ${m.toolCallId} is not the bounded record (an object with a calls list)`,
			);
		}
		if (nc.complete !== undefined && typeof nc.complete !== "boolean") {
			throw new Error(`nestedCalls.complete on tool result ${m.toolCallId} must be a boolean`);
		}
		for (const entry of nc.calls) {
			if (!isPlainObject(entry) || !nonEmptyString(entry.id) || !nonEmptyString(entry.name)) {
				throw new Error(
					`nestedCalls entry on tool result ${m.toolCallId} lacks the bounded record's shape (id, name)`,
				);
			}
			if (
				!entry.id.startsWith(m.toolCallId) ||
				!NESTED_ID_SUFFIX.test(entry.id.slice(m.toolCallId.length))
			) {
				throw new Error(
					`nestedCalls id ${entry.id} does not derive from its carrier's toolCallId ${m.toolCallId} — a fabricated nested record`,
				);
			}
			if (nestedIds.has(entry.id)) {
				throw new Error(`duplicate nestedCalls id: ${entry.id}`);
			}
			nestedIds.add(entry.id);
			count += 1;
		}
	}
	for (const id of nestedIds) {
		if (topLevelIds.has(id)) {
			throw new Error(
				`nestedCalls id ${id} also appears as a top-level call id — nested ids never enter the transcript`,
			);
		}
	}
	return count;
}

// The id-paired calls of one tool, recorded after the prompt — the shared
// shape of both spot-check attestations. isError is left to the caller:
// the read attestation accepts only non-error results, while the script
// attestation also reports a resolved-but-errored run distinctly.
function pairedCalls(tool, graph, userIndex) {
	const out = [];
	for (const t of graph.calls) {
		const r = graph.results.get(t.id)?.message;
		if (t.name !== tool || !r || r.toolName !== tool) continue;
		if (graph.callOrder.get(t.id) <= userIndex) continue;
		out.push({ call: t, result: r });
	}
	return out;
}

// The attestation's first line — `clean <sha>` — is the token the strike
// gate (scripts/check-strike.mjs) matches in PR bodies. One owner: this
// module formats the line and exports the pattern, the gate imports it,
// and the dogfood suite holds the pair (and dogfood.md's prose) to the
// same definition — the format cannot drift into a silent gate no-op.
export function formatCleanLine(sha) {
	return `clean ${sha}`;
}

export const CLEAN_LINE_PATTERN = /\bclean\s+([0-9a-f]{40})\b/g;

// The attestation's digest idiom — one helper for the legs and the session.
const shaText = (s) => createHash("sha256").update(s).digest("hex");

// ---------------------------------------------------------------------------
// Attestation legs
//
// One leg per spot-check. Each leg is one function over the shared spine
// (ctx) and its own CLI argument: resolve → prompt gate → paired-call scan
// → attestation lines. A leg throws on failure and returns its lines plus
// named results later legs may read (the notebook leg requires the script
// leg's result). The registry below is the only place a leg registers; it
// fixes CLI order, and auditSession itself names no leg.

// One prompt-neutrality gate, shared by every leg: a routed prompt that
// names what the leg attests is instruction, not routing.
function rejectIfPromptNames(ctx, variants, message) {
	if (ctx.promptNamesAny(variants)) {
		throw new Error(message);
	}
}

function skillReadLeg(ctx, skill) {
	const target = resolveAdvertisedSkill(ctx.root, skill, ctx.expected);
	// The skill bytes are read exactly once: the paired read result must
	// equal these validated bytes, and the attested digest hashes the same
	// buffer — no second read can separate validated from attested bytes.
	const skillBuf = fs.readFileSync(target);
	const skillText = skillBuf.toString("utf8");
	// A routed prompt must not name the selected skill or its file:
	// steering the model there is instruction, not routing. The name is
	// derived from the target's parent directory, not from the argument
	// string.
	const skillName = path.basename(path.dirname(target));
	rejectIfPromptNames(
		ctx,
		[
			ctx.normalize(skillName),
			ctx.normalize(path.basename(target)),
			ctx.normalize(target),
		],
		"spot-check prompt names the selected skill or its file — a routed task must reach it on its own",
	);
	// pi may advertise and read lexical paths through symlinked resources;
	// canonicalize the read path first, so a lexical path through a
	// symlinked checkout still matches, then compare canonically — an
	// unresolvable or external path cannot vouch for the target. Read
	// arguments (offset/limit) are not judged: the recorded result text
	// must equal the current file contents, so only a read of the whole
	// file can satisfy the check no matter what arguments were passed.
	// The read must also occur after the recorded prompt: a read spliced
	// before the user record was not caused by it.
	const hit = pairedCalls("read", ctx.graph, ctx.userIndex).some(({ call: t, result: r }) => {
		if (!(r.isError === false && t.arguments?.path)) {
			return false;
		}
		try {
			if (fs.realpathSync(t.arguments.path) !== target) return false;
		} catch {
			return false;
		}
		const resultText = Array.isArray(r.content)
			? r.content
					.filter((c) => c?.type === "text")
					.map((c) => c.text)
					.join("")
			: (typeof r.content === "string" ? r.content : "");
		return resultText === skillText;
	});
	if (!hit) {
		throw new Error("selected file never opened");
	}
	return {
		lines:
			`selected-file-opened ${target}\n` +
			`skill-content ${shaText(skillBuf)}`,
		target,
	};
}

function scriptExecLeg(ctx, script) {
	// The script argument resolves like the skill argument, but scripts
	// are not advertised: an existing regular file inside the checkout
	// is the criterion. The bytes are read exactly once — the attested
	// digest hashes the validated buffer.
	const target = resolveCheckoutScript(ctx.root, script);
	const scriptBuf = fs.readFileSync(target);
	// A routed prompt must not name the selected script or its path:
	// the script is part of the skill's capability, and naming it is
	// instruction, not routing.
	rejectIfPromptNames(
		ctx,
		[ctx.normalize(path.basename(target)), ctx.normalize(target)],
		"spot-check prompt names the selected script or its path — a routed task must reach it on its own",
	);
	// Execution, not mention: a bash call qualifies when its command
	// names the checkout's copy in program position, the call follows
	// the recorded prompt, and the paired result reports no error. A
	// copy of the script elsewhere on disk — or the path as an
	// argument, comment, heredoc body, or redirection target — does
	// not attest.
	let hit = false;
	let sawErroredRun = false;
	for (const { call: t, result: r } of pairedCalls("bash", ctx.graph, ctx.userIndex)) {
		if (typeof t.arguments?.command !== "string") continue;
		if (!commandResolvesToScript(t.arguments.command, target, ctx.root)) {
			continue;
		}
		if (r.isError === false) {
			hit = true;
			break;
		}
		sawErroredRun = true;
	}
	if (!hit) {
		throw new Error(
			sawErroredRun
				? "checkout script execution failed: the bash tool result is an error"
				: `checkout script never executed: ${target}`,
		);
	}
	return {
		lines:
			`script-executed ${target}\n` +
			`script-content ${shaText(scriptBuf)}`,
		target,
		arg: script,
	};
}

function notebookLeg(ctx, notebook) {
	// The notebook-written attestation extends the script-executed leg:
	// notebook files alone — however well-formed — attest nothing
	// without the session's executed checkout copy of the recorder,
	// so the script argument must be the recorder itself.
	const script = ctx.results.get(SCRIPT_LEG);
	if (script === undefined) {
		throw new Error(
			"the notebook-written attestation requires the script leg — pass the theta-notebook recorder as the third argument",
		);
	}
	let recorder;
	try {
		recorder = fs.realpathSync(
			path.join(ctx.skillRoot, "theta-notebook", "scripts", "notebook.py"),
		);
	} catch {
		throw new Error(
			"the notebook-written attestation requires the theta-notebook recorder as the script argument — the checkout has no such script",
		);
	}
	if (script.target !== recorder) {
		throw new Error(
			`the notebook-written attestation requires the theta-notebook recorder as the script argument, got: ${script.arg}`,
		);
	}
	// The routed prompt must not name the notebook file either — the
	// artifact is part of the skill's capability, and naming it is
	// instruction, not routing.
	rejectIfPromptNames(
		ctx,
		[ctx.normalize("notebook.jsonl")],
		"spot-check prompt names the notebook file — a routed task must reach it on its own",
	);
	const thetaDir = resolveNotebookDir(ctx.root, notebook);
	const report = auditNotebook(thetaDir);
	return {
		lines:
			`notebook-written ${thetaDir}\n` +
			`notebook-entries ${report.entries}\n` +
			`notebook-evidence ${report.snapshots}\n` +
			`notebook-digest ${shaText(report.notebookBuf)}`,
		thetaDir,
	};
}

// The script leg's registry name — the notebook leg reads its result by
// this key, so the binding is a constant, not a magic string.
const SCRIPT_LEG = "script";

// The attestation-leg registry: CLI order, and the one place a new leg
// registers. `main` maps positional arguments onto this order; `-` skips a
// leg's slot.
export const ATTESTATION_LEGS = [
	{ name: "skill", run: skillReadLeg },
	{ name: SCRIPT_LEG, run: scriptExecLeg },
	{ name: "notebook", run: notebookLeg },
];

// Audits one dogfood session directory against the checkout at the current
// HEAD and returns the attestation. Throws on any failure. `legs` is an
// ordered array of { leg, arg } pairs — leg entries from ATTESTATION_LEGS,
// one spot-check each: every leg runs against the shared spine, appends its
// own attestation lines in the order given, and may expose named results
// later legs read (the notebook leg requires the script leg's result).
export function auditSession(dir, rootArg, legs = []) {
	if (!Array.isArray(legs)) {
		throw new Error("legs must be an array of { leg, arg } pairs");
	}
	const root = fs.realpathSync(rootArg);
	// Mount aliases (e.g. /var vs /private/var on macOS) give the same tree
	// two spellings; lexical containment accepts either spelling of root.
	const rootAliases = [...new Set([rootArg, root])];
	// The pi transcript is named `<ISO instant>_<uuid>.jsonl` (grammar
	// observed on pi 1.4.0 sessions and pinned by the golden fixtures).
	// A gated session's dir also holds the gate log (`gate.jsonl`, since M5 S2) and
	// an RPC leg its raw event capture (`raw-rpc-events.jsonl`, since M5
	// S3), so counting bare *.jsonl over-claims the dir. Match the
	// transcript's own name grammar; the exactly-one invariant is over
	// transcripts and stays.
	const transcriptName =
		/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/;
	const files = fs.readdirSync(dir).filter((f) => transcriptName.test(f));
	if (files.length !== 1) {
		throw new Error(`expected exactly 1 session transcript (the ISO-instant-named .jsonl), found ${files.length}`);
	}
	if (fs.existsSync(`${dir}/watchdog`)) {
		throw new Error("watchdog fired: run exceeded 300s");
	}
	let bootExit;
	let bootErr;
	let bootExitRaw;
	let bootErrBuf;
	let piVersion;
	let nodeVersion;
	let promptWanted;
	// Read each evidence file exactly once: the same bytes are validated here
	// and hashed into the attestation, so a later mutation cannot produce a
	// successful attestation whose hashes identify invalid evidence.
	try {
		bootExitRaw = fs.readFileSync(`${dir}/exit-status`, "utf8");
		bootErrBuf = fs.readFileSync(`${dir}/stderr.txt`);
		bootExit = bootExitRaw.trim();
		bootErr = bootErrBuf.length;
		piVersion = fs.readFileSync(`${dir}/pi-version`, "utf8").trim().replace(/^v/, "");
		nodeVersion = fs
			.readFileSync(`${dir}/node-version`, "utf8")
			.trim()
			.replace(/^v/, "");
		promptWanted = fs.readFileSync(`${dir}/prompt.txt`, "utf8");
	} catch {
		throw new Error(
			"missing process-evidence files (exit-status, stderr.txt, pi-version, node-version, prompt.txt)",
		);
	}
	if (!ge(piVersion, "1.4.0")) {
		throw new Error(`pi ${piVersion} is below the supported 1.4.0 floor`);
	}
	if (!ge(nodeVersion, "22.19.0")) {
		throw new Error(`node ${nodeVersion} is below the supported 22.19.0 floor`);
	}
	if (bootExit !== "0" || bootErr !== 0) {
		throw new Error(`boot not clean: exit ${bootExit}, stderr ${bootErr} bytes`);
	}
	// assume-unchanged (lowercase h) and skip-worktree (uppercase S) index
	// entries hide tracked-file modifications from git status; either fails
	// the audit.
	const flagged = execSync("git ls-files -v", { cwd: root })
		.toString()
		.split("\n")
		.filter((l) => /^[hsS]/.test(l));
	if (flagged.length > 0) {
		throw new Error(
			`index entries marked assume-unchanged or skip-worktree:\n${flagged.join("\n")}`,
		);
	}
	// The transcript is hashed as raw file bytes and decoded strictly: lossy
	// UTF-8 replacement or normalization would let byte-corrupt evidence pass.
	const transcriptBuf = fs.readFileSync(`${dir}/${files[0]}`);
	let text;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(transcriptBuf);
	} catch (e) {
		throw new Error(`corrupt transcript: ${e.message}`);
	}
	// Strip only the trailing newline terminator: blank interior lines are
	// malformed JSONL and fail closed in the parse below.
	const lines = text.replace(/\n$/, "").split("\n");
	const recs = lines.map((l) => {
		try {
			return JSON.parse(l);
		} catch (e) {
			throw new Error(`corrupt transcript: ${e.message}`);
		}
	});
	const sessionRecs = recs.filter((r) => r.type === "session");
	if (sessionRecs.length !== 1) {
		throw new Error(
			`expected exactly 1 session record, found ${sessionRecs.length}`,
		);
	}
	// A one-shot transcript is ONE linear chain rooted at the session record:
	// ids are unique, record 0 is the session, and every later record's
	// parentId is the previous record's id (the schema's single null-parent
	// root exception is the first record after the session). Disconnected
	// roots, self-parents, DAG ancestry, and spliced records all fail.
	const seenIds = new Set();
	let prevId = null;
	let rootExceptions = 0;
	for (let i = 0; i < recs.length; i++) {
		const id = recs[i].id;
		const pid = recs[i].parentId;
		if (id === undefined || id === null || id === "") {
			throw new Error(`record ${i} has no usable id`);
		}
		if (seenIds.has(id)) {
			throw new Error(`duplicate record id: ${id}`);
		}
		seenIds.add(id);
		if (i === 0) {
			if (recs[i].type !== "session") {
				throw new Error("record 0 must be the session record");
			}
		} else if (pid === undefined || pid === null) {
			rootExceptions += 1;
			if (rootExceptions > 1) {
				throw new Error(`record ${i} is an extra disconnected root`);
			}
		} else if (pid !== prevId) {
			throw new Error(
				`record ${i} breaks the linear chain (parent ${pid}, expected ${prevId})`,
			);
		}
		prevId = id;
	}
	// Nested calls (codemode's bounded record) are transcript structure,
	// not a spot-check concern: every session is checked, legs or not.
	const nestedCount = collectNestedCalls(recs);
	const sysRecs = recs.filter(
		(r) => r.type === "message" && r.message?.role === "system",
	);
	// Count records that carry a skills section at all — a later null patch
	// removes the advertisement and must fail loudly, not pass silently.
	const skillsRecs = sysRecs.filter(
		(r) => r.message?.sections !== undefined && "skills" in r.message.sections,
	);
	if (skillsRecs.length !== 1) {
		throw new Error(
			`expected exactly 1 skills-bearing system record, found ${skillsRecs.length}`,
		);
	}
	const sess = recs.find((r) => r.type === "session");
	if (!sess || sess.cwd !== root) {
		throw new Error(`session cwd mismatch: expected ${root}`);
	}
	const userRecs = recs.filter(
		(r) => r.type === "message" && r.message?.role === "user",
	);
	if (userRecs.length !== 1) {
		throw new Error(`expected exactly 1 user record, found ${userRecs.length}`);
	}
	const userIndex = recs.indexOf(userRecs[0]);
	// Record order is part of the evidence: the session identity, the model
	// selection, and the skill advertisement must all be recorded before the
	// prompt they answer — a spliced transcript advertising skills after
	// seeing the task fails here.
	const orderOf = (pred) => {
		const idx = recs.findIndex(pred);
		return idx === -1 ? Number.POSITIVE_INFINITY : idx;
	};
	const sessionOrder = orderOf((r) => r.type === "session");
	const modelOrder = orderOf((r) => r.type === "model_change");
	const skillsOrder = orderOf(
		(r) =>
			r.type === "message" &&
			r.message?.role === "system" &&
			r.message?.sections !== undefined &&
			"skills" in r.message.sections,
	);
	if (
		sessionOrder > userIndex ||
		modelOrder > userIndex ||
		skillsOrder > userIndex
	) {
		throw new Error(
			"transcript order violation: session, model_change, and skills records must precede the user prompt",
		);
	}
	// A completed one-shot ends with the assistant's response: a transcript
	// truncated at a record boundary cannot attest a full session. A final
	// assistant record that still carries a tool request, a length-truncated
	// stop reason, an error, or no text at all is not a completed response.
	const last = recs[recs.length - 1];
	const lastContent = last?.message?.content;
	const endsWithToolCall =
		Array.isArray(lastContent) &&
		lastContent.some((c) => c?.type === "toolCall");
	const lastText = Array.isArray(lastContent)
		? lastContent.filter((c) => c?.type === "text").map((c) => c.text).join("")
		: (typeof lastContent === "string" ? lastContent : "");
	if (
		last?.type !== "message" ||
		last?.message?.role !== "assistant" ||
		endsWithToolCall ||
		lastText === ""
	) {
		throw new Error(
			"transcript does not end with a non-empty assistant response — truncated session",
		);
	}
	if (last.message.stopReason !== "stop" || last.message.errorMessage) {
		throw new Error(
			`incomplete final assistant response: stopReason ${last.message.stopReason}${last.message.errorMessage ? ", error " + last.message.errorMessage : ""}`,
		);
	}
	const userRec = userRecs[0];
	const userText = Array.isArray(userRec?.message?.content)
		? userRec.message.content
				.filter((c) => c?.type === "text")
				.map((c) => c.text)
				.join("")
		: (typeof userRec?.message?.content === "string" ? userRec.message.content : null);
	if (userText !== promptWanted) {
		throw new Error("prompt mismatch: the session did not run the recorded prompt");
	}
	const wantModel = fs.readFileSync(`${dir}/expected-model`, "utf8").trim().split(/\s+/);
	const changes = recs.filter((r) => r.type === "model_change");
	if (changes.length !== 1) {
		throw new Error(`expected exactly 1 model_change record, found ${changes.length}`);
	}
	if (changes[0].provider !== wantModel[0] || changes[0].modelId !== wantModel[1]) {
		throw new Error(
			`model mismatch: ran ${changes[0].provider}/${changes[0].modelId}, expected ${wantModel[0]}/${wantModel[1]}`,
		);
	}
	// Every assistant record carries its own provider/model: a record that
	// contradicts the model_change metadata means provider fallback or
	// recombined evidence.
	const assistantModels = recs
		.filter((r) => r.type === "message" && r.message?.role === "assistant")
		.map((r) => `${r.message.provider}/${r.message.model}`);
	const wrongModelRecords = assistantModels.filter(
		(pm) => pm !== `${wantModel[0]}/${wantModel[1]}`,
	);
	if (wrongModelRecords.length > 0) {
		throw new Error(
			`assistant records contradict the expected model: ${wrongModelRecords.join(", ")}`,
		);
	}
	const skillsText =
		typeof skillsRecs[0].message.sections.skills === "string"
			? skillsRecs[0].message.sections.skills
			: "";
	const advertisements = extractLocations(skillsText);
	const inventoryText = fs.readFileSync(
		`${root}/test/expected-skills.json`,
		"utf8",
	);
	const inv = JSON.parse(inventoryText);
	const skillRoot = manifestSkillRoot(root);
	const names = inv.vendored.map((e) => e.name).concat(inv["self-authored"]);
	// Advertisement identity is the name/location pair: an inventory skill
	// must be advertised at an allowed spelling of its own checkout location
	// — the manifest path resolved against either spelling of the checkout
	// root (mount aliases). Canonicalization is an additional containment
	// check, not a substitute: an arbitrary external alias cannot impersonate
	// a checkout skill, and locations that do not resolve on disk are
	// rejected.
	const inventoryNames = new Set(names);
	const manifestEntry = manifestSkillEntry(root);
	const canonical = new Map();
	for (const rec of advertisements) {
		if (canonical.has(rec.name)) {
			throw new Error(`duplicate advertised skill name: ${rec.name}`);
		}
		try {
			canonical.set(rec.name, fs.realpathSync(rec.location));
		} catch {
			throw new Error(
				`advertised location does not resolve on disk: ${rec.location}`,
			);
		}
		if (inventoryNames.has(rec.name)) {
			const allowed = rootAliases.map(
				(r) => `${path.resolve(r, manifestEntry)}/${rec.name}/SKILL.md`,
			);
			if (!allowed.includes(rec.location)) {
				throw new Error(
					`inventory skill ${rec.name} advertised from outside the checkout: ${rec.location}`,
				);
			}
		}
		if (
			!inventoryNames.has(rec.name) &&
			canonical.get(rec.name).startsWith(root + path.sep)
		) {
			throw new Error(
				`host skill ${rec.name} resolves inside the checkout: ${rec.location}`,
			);
		}
	}
	const missing = [];
	for (const n of names) {
		const p = `${skillRoot}/${n}/SKILL.md`;
		if (canonical.get(n) !== p) missing.push(n);
	}
	if (missing.length > 0) {
		throw new Error(`NOT advertised: ${missing.join(", ")}`);
	}
	const expected = new Set(names.map((n) => `${skillRoot}/${n}/SKILL.md`));
	// An advertised record is an extra when its lexical location or its
	// canonical target lies at or inside the checkout without being
	// inventory — canonicalizing alone would hide a checkout symlink
	// pointing outside, and host-level skills outside the checkout are the
	// environment. Every advertised location must also resolve to a real
	// SKILL.md file: a record pointing at the checkout root itself is
	// checkout-affiliated, not a host skill.
	const extras = [...canonical.entries()]
		.filter(([n, p]) => {
			if (expected.has(p)) return false;
			const lexical =
				advertisements.find((r) => r.name === n)?.location ?? "";
			return (
				rootAliases.some((r) => lexical.startsWith(r + path.sep)) ||
				p === root ||
				p.startsWith(root + path.sep)
			);
		})
		.map(([n]) => n);
	for (const [n, p] of canonical) {
		if (path.basename(p) !== "SKILL.md" || !fs.statSync(p).isFile()) {
			throw new Error(
				`advertised location for ${n} is not a SKILL.md file: ${p}`,
			);
		}
	}
	if (extras.length > 0) {
		throw new Error(`UNEXPECTED advertised skills:\n${extras.join("\n")}`);
	}
	// A duplicate alias (one inventory skill also reachable through a second
	// in-checkout symlink) collapses in the canonical set, so the count of
	// checkout-affiliated records must match the inventory exactly.
	const checkoutRecords = advertisements.filter((rec) =>
		canonical.get(rec.name)?.startsWith(root + path.sep),
	);
	if (checkoutRecords.length !== names.length) {
		throw new Error(
			`expected ${names.length} checkout skill advertisements, found ${checkoutRecords.length}`,
		);
	}
	const dirty = gitStatus(root);
	if (dirty) {
		throw new Error(`working tree dirty:\n${dirty}`);
	}
	const head = execSync("git rev-parse HEAD", { cwd: root }).toString().trim();
	const preHead = fs.readFileSync(`${dir}/pre-head`, "utf8").trim();
	if (head !== preHead) {
		throw new Error(`HEAD moved since the run: ${preHead} -> ${head}`);
	}
	const manifestSha = fs.readFileSync(`${dir}/manifest-sha256`, "utf8").trim();
	const curManifest = manifestSha256(root);
	if (curManifest !== manifestSha) {
		throw new Error("package.json changed since the run");
	}
	let out =
		`${formatCleanLine(head)}\n` +
		`transcript ${createHash("sha256").update(transcriptBuf).digest("hex")}\n` +
		`exit-status ${shaText(bootExitRaw)}\n` +
		`stderr ${shaText(bootErrBuf)}\n` +
		`pi ${piVersion}\n` +
		`node ${nodeVersion}\n` +
		`provider ${wantModel[0]}\n` +
		`model ${wantModel[1]}\n` +
		`inventory ${shaText(inventoryText)}\n` +
		`prompt ${shaText(promptWanted)}\n` +
		`nested-calls ${nestedCount}`;
	// The spot-check attestations — skill read, script execution, notebook
	// written — share one tool-call/result graph and one prompt-neutrality
	// gate, and every leg runs through one interface (see Attestation legs
	// above): legs append their lines in the order given, and each may read
	// earlier legs' named results from ctx.
	if (legs.length > 0) {
		// Cross-script lookalikes (Cyrillic і for Latin i) survive NFKC, so
		// the recorded prompt must be pure ASCII: the operator's task is
		// English text, and anything else fails closed.
		if (/[^\x00-\x7F]/.test(promptWanted)) {
			throw new Error(
				"spot-check prompt contains non-ASCII characters — cross-script lookalikes are not auditable",
			);
		}
		// The name comparison strips case, separators, and punctuation from
		// both sides — so LiteratureReview, literature_review, "literature
		// review", and SKILL.md all match their canonical forms.
		const normalize = (s) =>
			s.toLowerCase().normalize("NFKC").replace(/[^a-z0-9]/g, "");
		const promptNorm = normalize(promptWanted);
		const ctx = {
			root,
			userIndex,
			expected,
			skillRoot,
			normalize,
			promptNamesAny: (variants) => variants.some((v) => v && promptNorm.includes(v)),
			graph: collectToolGraph(recs),
			results: new Map(),
		};
		for (const { leg, arg } of legs) {
			const result = leg.run(ctx, arg);
			out += `\n${result.lines}`;
			ctx.results.set(leg.name, result);
		}
	}
	// Final state recheck: the audited bytes and the cited HEAD must still
	// describe the tree at attestation time.
	const dirtyFinal = gitStatus(root);
	if (dirtyFinal) {
		throw new Error(`working tree dirty at attestation time:\n${dirtyFinal}`);
	}
	const headFinal = execSync("git rev-parse HEAD", { cwd: root }).toString().trim();
	if (headFinal !== head) {
		throw new Error(`HEAD moved during audit: ${head} -> ${headFinal}`);
	}
	return out;
}

function manifestSkillEntry(root) {
	const manifest = JSON.parse(fs.readFileSync(`${root}/package.json`, "utf8"));
	const raw = manifest.pi?.skills ?? ["./skills"];
	if (
		!Array.isArray(raw) ||
		raw.length !== 1 ||
		typeof raw[0] !== "string" ||
		/[*?[\]{}]/.test(raw[0])
	) {
		throw new Error("audit supports a single plain-directory pi.skills entry");
	}
	const resolved = path.resolve(root, raw[0]);
	const realRoot = fs.realpathSync(root);
	const realResolved = fs.realpathSync(resolved);
	if (!fs.statSync(realResolved).isDirectory()) {
		throw new Error(`pi.skills entry must be a directory, got: ${raw[0]}`);
	}
	if (realResolved !== realRoot && !realResolved.startsWith(realRoot + path.sep)) {
		throw new Error(`pi.skills entry must resolve inside the checkout, got: ${raw[0]}`);
	}
	return raw[0];
}

function manifestSkillRoot(root) {
	return path.resolve(root, manifestSkillEntry(root));
}

function main(argv) {
	const [dir, ...legArgs] = argv;
	// Positional leg arguments map onto ATTESTATION_LEGS order; `-` skips a
	// leg's slot when only the later legs are wanted — the notebook leg
	// itself requires the script argument, so a `-` there fails with that
	// leg's own error.
	if (legArgs.length > ATTESTATION_LEGS.length) {
		console.error(
			`usage: audit-dogfood.mjs <session-dir> [${ATTESTATION_LEGS.map((l) => `<${l.name}>`).join(" ")}]`,
		);
		return 1;
	}
	const legs = [];
	for (let i = 0; i < legArgs.length; i++) {
		if (legArgs[i] !== "-") {
			legs.push({ leg: ATTESTATION_LEGS[i], arg: legArgs[i] });
		}
	}
	const root = fs.realpathSync(".");
	try {
		console.log(auditSession(dir, root, legs));
	} catch (e) {
		console.error(e.message);
		return 1;
	}
	return 0;
}

if (
	process.argv[1] !== undefined &&
	fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
	// process.exit truncates piped stdout on macOS; exitCode lets Node flush.
	process.exitCode = main(process.argv.slice(2));
}
