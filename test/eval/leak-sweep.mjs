import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * The per-capture leak sweep (issue #188, the B4 retro): the
 * institutional-fact classes the land step guards mechanically, one
 * registry instead of the hand-rolled sweeps every capture strike was
 * rewriting — B4's five-fixture pass missed "the HEBMU one" because its
 * `/hebmu/` pattern was case-sensitive. The registry encodes the house
 * distinction exactly (CLAUDE.md, the public-repo rule): cluster
 * ACCOUNTS, the SSH ALIAS token, and NODE NAMES never enter a committed
 * fixture; the cluster's bare name is public — ADR 0004 names it. The
 * login node's name (`workstation`) is generic English and stays with
 * the per-capture judgment, like bibliographic payloads: the sweep
 * covers only what a fixed pattern can hold.
 *
 * Consumers: `capture.mjs land` runs the sweep over the landed fixture
 * and its snapshot and fails the land on any hit (redo the sanitize,
 * never patch the evidence); the CLI sweeps landed fixtures on demand —
 * `node test/eval/leak-sweep.mjs [ids...]` defaults to all of them, for
 * the closeout round's independent pass.
 */

/** One banned leak class: its report name and its fixed pattern. */
const LEAK_CLASSES = [
	{ name: "cluster-account", pattern: /\bu\d{7,}\b/ },
	{ name: "ssh-alias", pattern: /hebmu_cluster/i },
	{ name: "node-name", pattern: /\bgpu\d+\b/i },
];

export { LEAK_CLASSES };

/** The approved placeholder vocabulary — counted, never flagged. */
const PLACEHOLDER_PATTERN = /__REPO__|__RIG_HOME__|__HOST_[A-Z0-9_]+__/g;

/**
 * The sweep's whole result: which banned classes hit, and the approved
 * placeholder count. The failure message's contract is the class name
 * only — token bytes ride the boolean, never a string.
 */
export function sweepBytes({ transcript, snapshot, tokenBytes }) {
	const hits = new Set();
	for (const text of [transcript, snapshot]) {
		if (text === undefined) continue;
		for (const { name, pattern } of LEAK_CLASSES) {
			if (pattern.test(text)) hits.add(name);
		}
		if (tokenBytes !== undefined && text.includes(tokenBytes)) hits.add("token-bytes");
	}
	const placeholderCount =
		(`${transcript ?? ""}${snapshot ?? ""}`.match(PLACEHOLDER_PATTERN) ?? []).length;
	// A `g` flag pattern is stateful — reset lastIndex so repeated sweeps
	// of growing text count from zero every call.
	PLACEHOLDER_PATTERN.lastIndex = 0;
	return { hits: [...hits], placeholderCount };
}

/**
 * The configured gateway token's bytes, or undefined — a fresh host
 * without the token file skips the token-bytes class (reported, never
 * silently). Read once; callers pass the bytes through.
 */
export function readTokenBytes(tokenFile) {
	try {
		return readFileSync(tokenFile, "utf8").trim();
	} catch {
		return undefined;
	}
}

/**
 * The CLI: `node test/eval/leak-sweep.mjs [ids...]` sweeps landed
 * fixtures (default: all of them) and prints one report line per
 * fixture — the closeout round's independent pass in one command. Exit
 * 1 names every fixture that hit a banned class; the report's contract
 * is class names and counts, never bytes.
 */
function main() {
	const ids = process.argv.slice(2);
	const landed = readdirSync(new URL("./fixtures/", import.meta.url)).filter((name) =>
		existsSync(new URL(`./fixtures/${name}/session.jsonl`, import.meta.url)),
	);
	const targets = ids.length > 0 ? ids : landed;
	const tokenFile = path.join(homedir(), ".theta-compute-token");
	const tokenBytes = readTokenBytes(tokenFile);
	let failures = 0;
	for (const id of targets) {
		const transcript = readFileSync(new URL(`./fixtures/${id}/session.jsonl`, import.meta.url), "utf8");
		const snapshotPath = new URL(`./snapshots/${id}.json`, import.meta.url);
		const snapshot = existsSync(snapshotPath) ? readFileSync(snapshotPath, "utf8") : undefined;
		const sweep = sweepBytes({ transcript, snapshot, tokenBytes });
		const classes = sweep.hits.length > 0 ? sweep.hits.join(",") : "none";
		const tokenState = tokenBytes === undefined ? "skipped" : sweep.hits.includes("token-bytes") ? "HIT" : "absent";
		console.log(`${id}: leak-classes=${classes} placeholders=${sweep.placeholderCount} token-bytes=${tokenState}`);
		if (sweep.hits.length > 0) failures += 1;
	}
	if (tokenBytes === undefined) {
		console.log(`token-bytes check skipped — no token file at ${tokenFile} on this host`);
	}
	if (failures > 0) {
		console.error(`leak sweep: ${failures} fixture(s) hit banned classes — redo the sanitize, never patch the evidence`);
		process.exitCode = 1;
	}
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main();
}
