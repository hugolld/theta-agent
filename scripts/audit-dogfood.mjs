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
			/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
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
			core: [Number(m[1]), Number(m[2]), Number(m[3])],
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
		if (nx && ny) return Number(x) - Number(y);
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

// The advertised skill locations live in one <available_skills> block inside
// the skills section pi maintains (message.sections.skills).
export function extractLocations(skillsText) {
	const section = skillsText.match(/<available_skills>([\s\S]*?)<\/available_skills>/);
	if (!section) return null;
	return new Set(
		[...section[1].matchAll(/<location>([\s\S]*?)<\/location>/g)].map((m) =>
			decodeXmlEntities(m[1]),
		),
	);
}

// Resolves the spot-check's skill argument to an absolute checkout path and
// requires it to be one of the advertised SKILL.md files — traversal and
// non-skill paths are rejected.
export function resolveAdvertisedSkill(root, skill, expected) {
	const target = path.resolve(root, skill);
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
export function auditSession(dir, root, skill) {
	const files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
	if (files.length !== 1) {
		throw new Error(`expected exactly 1 session file, found ${files.length}`);
	}
	if (fs.existsSync(`${dir}/watchdog`)) {
		throw new Error("watchdog fired: run exceeded 300s");
	}
	let bootExit;
	let bootErr;
	let piVersion;
	let nodeVersion;
	try {
		bootExit = fs.readFileSync(`${dir}/exit-status`, "utf8").trim();
		bootErr = fs.readFileSync(`${dir}/stderr.txt`).length;
		piVersion = fs.readFileSync(`${dir}/pi-version`, "utf8").trim().replace(/^v/, "");
		nodeVersion = fs
			.readFileSync(`${dir}/node-version`, "utf8")
			.trim()
			.replace(/^v/, "");
		fs.readFileSync(`${dir}/prompt.txt`, "utf8");
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
	const text = fs.readFileSync(`${dir}/${files[0]}`, "utf8");
	const lines = text.trim().split("\n").filter(Boolean);
	const recs = lines.map((l) => {
		try {
			return JSON.parse(l);
		} catch (e) {
			throw new Error(`corrupt transcript: ${e.message}`);
		}
	});
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
	const promptWanted = fs.readFileSync(`${dir}/prompt.txt`, "utf8");
	const userRec = recs.find((r) => r.message?.role === "user");
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
	const locations = extractLocations(skillsText);
	if (!locations) {
		throw new Error("no available_skills section in system records");
	}
	const inv = JSON.parse(fs.readFileSync("test/expected-skills.json", "utf8"));
	const skillRoot = manifestSkillRoot(root);
	const names = inv.vendored.map((e) => e.name).concat(inv["self-authored"]);
	// pi may advertise lexical paths through symlinked resources; canonicalize
	// every advertised location before comparing, so content outside the
	// checkout cannot pose as contained evidence. Unresolvable locations
	// fail closed by omission.
	const realAdvertised = new Set(
		[...locations]
			.map((l) => {
				try {
					return fs.realpathSync(l);
				} catch {
					return null;
				}
			})
			.filter(Boolean),
	);
	const missing = [];
	for (const n of names) {
		const p = `${skillRoot}/${n}/SKILL.md`;
		if (!realAdvertised.has(p)) missing.push(n);
	}
	if (missing.length > 0) {
		throw new Error(`NOT advertised: ${missing.join(", ")}`);
	}
	const expected = new Set(names.map((n) => `${skillRoot}/${n}/SKILL.md`));
	const extras = [...realAdvertised].filter((l) => !expected.has(l));
	if (extras.length > 0) {
		throw new Error(`UNEXPECTED advertised skills:\n${extras.join("\n")}`);
	}
	const dirty = execSync("git status --porcelain --untracked-files=all").toString().trim();
	if (dirty) {
		throw new Error(`working tree dirty:\n${dirty}`);
	}
	const head = execSync("git rev-parse HEAD").toString().trim();
	const preHead = fs.readFileSync(`${dir}/pre-head`, "utf8").trim();
	if (head !== preHead) {
		throw new Error(`HEAD moved since the run: ${preHead} -> ${head}`);
	}
	const manifestSha = fs.readFileSync(`${dir}/manifest-sha256`, "utf8").trim();
	const curManifest = createHash("sha256")
		.update(fs.readFileSync("package.json"))
		.digest("hex");
	if (curManifest !== manifestSha) {
		throw new Error("package.json changed since the run");
	}
	const sha = (p) => createHash("sha256").update(fs.readFileSync(p)).digest("hex");
	let out =
		`clean ${head}\n` +
		`transcript ${createHash("sha256").update(text).digest("hex")}\n` +
		`exit-status ${sha(`${dir}/exit-status`)}\n` +
		`stderr ${sha(`${dir}/stderr.txt`)}\n` +
		`pi ${piVersion}\n` +
		`node ${nodeVersion}\n` +
		`provider ${wantModel[0]}\n` +
		`model ${wantModel[1]}\n` +
		`inventory ${sha("test/expected-skills.json")}`;
	if (skill !== undefined) {
		const target = resolveAdvertisedSkill(root, skill, expected);
		const calls = [];
		const results = new Map();
		for (const r of recs) {
			const m = r.message;
			if (!m) continue;
			if (Array.isArray(m.content))
				for (const t of m.content) if (t?.type === "toolCall") calls.push(t);
			if (m.role === "toolResult") results.set(m.toolCallId, m);
		}
		const hit = calls.some((t) => {
			const r = results.get(t.id);
			return (
				t.name === "read" && t.arguments?.path === target && r && r.isError === false
			);
		});
		if (!hit) {
			throw new Error("NOT used");
		}
		out += `\nused ${target}\nskill-content ${sha(target)}`;
	}
	return out;
}

function manifestSkillRoot(root) {
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
	return realResolved;
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
