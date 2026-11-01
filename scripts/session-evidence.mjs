// The session-evidence module: one home for the session-dir artifact
// bundle the dogfood auditor binds and attests (GLOSSARY, "Session
// evidence"). The names, the transcript's name grammar, the version
// floors, and the read-once discipline live here; the auditor reads
// through readSessionEvidence, and every writer — the rig runner and the
// test fixtures — imports SESSION_FILES instead of hand-typing names, so
// a rename fails as an import error, not as a hand-sync miss.

import { existsSync, readdirSync, readFileSync } from "node:fs";

// The artifact names every writer writes and the auditor reads. The
// watchdog sentinel is written only when the run's watchdog fired.
export const SESSION_FILES = Object.freeze({
	exitStatus: "exit-status",
	stderr: "stderr.txt",
	piVersion: "pi-version",
	nodeVersion: "node-version",
	prompt: "prompt.txt",
	expectedModel: "expected-model",
	preHead: "pre-head",
	manifestSha: "manifest-sha256",
	watchdog: "watchdog",
});

// The pi and node floors the audit enforces against the recorded runtime.
// The comparison itself stays beside the SemVer `ge` comparator in
// audit-dogfood.mjs; the constants live here so each floor literal has
// one home.
export const PI_FLOOR = "1.4.0";
export const NODE_FLOOR = "22.19.0";

// The pi transcript is named `<ISO instant>_<uuid>.jsonl` (grammar
// observed on pi 1.4.0 sessions and pinned by the golden fixtures). A
// gated session's dir also holds the gate log (`gate.jsonl`, since M5 S2)
// and an RPC leg its raw event capture (`raw-rpc-events.jsonl`, since M5
// S3), so counting bare *.jsonl over-claims the dir. Match the
// transcript's own name grammar; the exactly-one invariant is over
// transcripts and stays.
export const TRANSCRIPT_NAME =
	/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/;

// Reads the whole bundle once and returns the raw facts — no
// interpretation: the caller normalizes, compares, and hashes. Reading
// each file exactly once is this module's discipline: the same bytes are
// validated and hashed into the attestation, so a later mutation cannot
// produce a successful attestation whose hashes identify invalid
// evidence. Throws on the read failures it owns — a transcript count
// other than one, missing process files, undecodable transcript bytes;
// a missing expected-model, pre-head, or manifest digest propagates the
// raw read error, exactly as the inline reads did.
export function readSessionEvidence(dir) {
	const transcripts = readdirSync(dir).filter((f) => TRANSCRIPT_NAME.test(f));
	if (transcripts.length !== 1) {
		throw new Error(
			`expected exactly 1 session transcript (the ISO-instant-named .jsonl), found ${transcripts.length}`,
		);
	}
	let exitStatusRaw;
	let stderrBytes;
	let piVersionRaw;
	let nodeVersionRaw;
	let promptText;
	try {
		exitStatusRaw = readFileSync(`${dir}/${SESSION_FILES.exitStatus}`, "utf8");
		stderrBytes = readFileSync(`${dir}/${SESSION_FILES.stderr}`);
		piVersionRaw = readFileSync(`${dir}/${SESSION_FILES.piVersion}`, "utf8");
		nodeVersionRaw = readFileSync(`${dir}/${SESSION_FILES.nodeVersion}`, "utf8");
		promptText = readFileSync(`${dir}/${SESSION_FILES.prompt}`, "utf8");
	} catch {
		throw new Error(
			`missing process-evidence files (${[
				SESSION_FILES.exitStatus,
				SESSION_FILES.stderr,
				SESSION_FILES.piVersion,
				SESSION_FILES.nodeVersion,
				SESSION_FILES.prompt,
			].join(", ")})`,
		);
	}
	const transcriptBytes = readFileSync(`${dir}/${transcripts[0]}`);
	// The transcript is hashed as raw file bytes and decoded strictly: lossy
	// UTF-8 replacement or normalization would let byte-corrupt evidence pass.
	let transcriptText;
	try {
		transcriptText = new TextDecoder("utf-8", { fatal: true }).decode(transcriptBytes);
	} catch (e) {
		throw new Error(`corrupt transcript: ${e.message}`);
	}
	return {
		watchdogFired: existsSync(`${dir}/${SESSION_FILES.watchdog}`),
		exitStatusRaw,
		stderrBytes,
		piVersionRaw,
		nodeVersionRaw,
		promptText,
		expectedModelRaw: readFileSync(`${dir}/${SESSION_FILES.expectedModel}`, "utf8"),
		preHeadRaw: readFileSync(`${dir}/${SESSION_FILES.preHead}`, "utf8"),
		manifestShaRaw: readFileSync(`${dir}/${SESSION_FILES.manifestSha}`, "utf8"),
		transcriptName: transcripts[0],
		transcriptBytes,
		transcriptText,
	};
}
