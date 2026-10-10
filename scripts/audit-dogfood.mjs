import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";

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
	// Floors may be written short ("0.99", "22"); pad them to full SemVer.
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
// block could hide advertisement drift, so any other count throws. Each
// record must carry both a name and a location — advertisement identity is
// the pair, not the path alone.
export function extractLocations(skillsText) {
	const blocks = skillsText.match(/<available_skills>[\s\S]*?<\/available_skills>/g);
	if (!blocks || blocks.length !== 1) {
		throw new Error(
			`expected exactly 1 available_skills block, found ${blocks ? blocks.length : 0}`,
		);
	}
	const out = [];
	for (const record of blocks[0].match(/<skill>[\s\S]*?<\/skill>/g) ?? []) {
		const name = decodeXmlEntities(
			record.match(/<name>([\s\S]*?)<\/name>/)?.[1] ?? "",
		);
		const location = decodeXmlEntities(
			record.match(/<location>([\s\S]*?)<\/location>/)?.[1] ?? "",
		);
		if (!name || !location) {
			throw new Error("malformed skill advertisement record (missing name or location)");
		}
		out.push({ name, location });
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

// Audits one dogfood session directory against the checkout at the current
// HEAD and returns the attestation. Throws on any failure; `skill` (a
// checkout-relative SKILL.md path) additionally requires a successful read
// tool call on that exact file.
export function auditSession(dir, rootArg, skill) {
	const root = fs.realpathSync(rootArg);
	// Mount aliases (e.g. /var vs /private/var on macOS) give the same tree
	// two spellings; lexical containment accepts either spelling of root.
	const rootAliases = [...new Set([rootArg, root])];
	const files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
	if (files.length !== 1) {
		throw new Error(`expected exactly 1 session file, found ${files.length}`);
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
	if (!ge(piVersion, "0.99")) {
		throw new Error(`pi ${piVersion} is below the supported 0.99 floor`);
	}
	if (!ge(nodeVersion, "22")) {
		throw new Error(`node ${nodeVersion} is below the supported 22 floor`);
	}
	if (bootExit !== "0" || bootErr !== 0) {
		throw new Error(`boot not clean: exit ${bootExit}, stderr ${bootErr} bytes`);
	}
	// assume-unchanged and skip-worktree index entries hide tracked-file
	// modifications from git status; their presence fails the audit.
	const flagged = execSync("git ls-files -v", { cwd: root })
		.toString()
		.split("\n")
		.filter((l) => /^[hs]/.test(l));
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
	const sysRecs = recs.filter((r) => r.message?.role === "system");
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
	const userRecs = recs.filter((r) => r.message?.role === "user");
	if (userRecs.length !== 1) {
		throw new Error(`expected exactly 1 user record, found ${userRecs.length}`);
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
	// canonical target lies inside the checkout without being inventory —
	// canonicalizing alone would hide a checkout symlink pointing outside,
	// and host-level skills outside the checkout are the environment.
	const extras = [...canonical.entries()]
		.filter(([n, p]) => {
			if (expected.has(p)) return false;
			const lexical =
				advertisements.find((r) => r.name === n)?.location ?? "";
			return (
				rootAliases.some((r) => lexical.startsWith(r + path.sep)) ||
				p.startsWith(root + path.sep)
			);
		})
		.map(([n]) => n);
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
	const dirty = execSync("git status --porcelain --untracked-files=all", {
		cwd: root,
	}).toString().trim();
	if (dirty) {
		throw new Error(`working tree dirty:\n${dirty}`);
	}
	const head = execSync("git rev-parse HEAD", { cwd: root }).toString().trim();
	const preHead = fs.readFileSync(`${dir}/pre-head`, "utf8").trim();
	if (head !== preHead) {
		throw new Error(`HEAD moved since the run: ${preHead} -> ${head}`);
	}
	const manifestSha = fs.readFileSync(`${dir}/manifest-sha256`, "utf8").trim();
	const curManifest = createHash("sha256")
		.update(fs.readFileSync(`${root}/package.json`))
		.digest("hex");
	if (curManifest !== manifestSha) {
		throw new Error("package.json changed since the run");
	}
	const shaText = (s) => createHash("sha256").update(s).digest("hex");
	let out =
		`clean ${head}\n` +
		`transcript ${createHash("sha256").update(transcriptBuf).digest("hex")}\n` +
		`exit-status ${shaText(bootExitRaw)}\n` +
		`stderr ${shaText(bootErrBuf)}\n` +
		`pi ${piVersion}\n` +
		`node ${nodeVersion}\n` +
		`provider ${wantModel[0]}\n` +
		`model ${wantModel[1]}\n` +
		`inventory ${shaText(inventoryText)}`;
	if (skill !== undefined) {
		const target = resolveAdvertisedSkill(root, skill, expected);
		// The skill bytes are read exactly once: the paired read result must
		// equal these validated bytes, and the attested digest hashes the same
		// buffer — no second read can separate validated from attested bytes.
		const skillBuf = fs.readFileSync(target);
		const skillText = skillBuf.toString("utf8");
		// A routed prompt must not name the selected skill or its file:
		// steering the model there is instruction, not routing. The name is
		// derived from the target's parent directory, not from the argument
		// string, and the comparison strips case, separators, and punctuation
		// from both sides — so LiteratureReview, literature_review,
		// "literature review", and SKILL.md all match their canonical forms.
		const normalize = (s) =>
			s.toLowerCase().normalize("NFKC").replace(/[^a-z0-9]/g, "");
		const promptNorm = normalize(promptWanted);
		const skillName = path.basename(path.dirname(target));
		const promptVariants = [
			normalize(skillName),
			normalize(path.basename(target)),
			normalize(target),
		];
		if (promptVariants.some((v) => v && promptNorm.includes(v))) {
			throw new Error(
				"spot-check prompt names the selected skill or its file — a routed task must reach it on its own",
			);
		}
		const calls = [];
		const results = new Map();
		for (const r of recs) {
			const m = r.message;
			if (!m) continue;
			if (Array.isArray(m.content))
				for (const t of m.content) if (t?.type === "toolCall") calls.push(t);
			if (m.role === "toolResult") {
				if (results.has(m.toolCallId)) {
					throw new Error(`duplicate toolResult for ${m.toolCallId}`);
				}
				results.set(m.toolCallId, m);
			}
		}
		// pi may advertise and read lexical paths through symlinked resources;
		// canonicalize the read path first, so a lexical path through a
		// symlinked checkout still matches, then compare canonically — an
		// unresolvable or external path cannot vouch for the target. Read
		// arguments (offset/limit) are not judged: the recorded result text
		// must equal the current file contents, so only a read of the whole
		// file can satisfy the check no matter what arguments were passed.
		const hit = calls.some((t) => {
			const r = results.get(t.id);
			if (
				!(
					t.name === "read" &&
					r &&
					r.toolName === "read" &&
					r.isError === false &&
					t.arguments?.path
				)
			) {
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
			throw new Error("NOT used");
		}
		out += `\nused ${target}\nskill-content ${createHash("sha256").update(skillBuf).digest("hex")}`;
	}
	// Final state recheck: the audited bytes and the cited HEAD must still
	// describe the tree at attestation time.
	const dirtyFinal = execSync("git status --porcelain --untracked-files=all", {
		cwd: root,
	}).toString().trim();
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
	const [dir, skill] = argv;
	const root = fs.realpathSync(".");
	try {
		console.log(auditSession(dir, root, skill));
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
	process.exit(main(process.argv.slice(2)));
}
