import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";

// Numeric semver-ish comparison: true when a >= b. Unparsable segments
// become NaN and fail closed — malformed versions never pass the floor.
export function ge(a, b) {
	const pa = a.split(".").map(Number);
	const pb = b.split(".").map(Number);
	if (pa.some(Number.isNaN) || pb.some(Number.isNaN)) return false;
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const x = pa[i] || 0;
		const y = pb[i] || 0;
		if (x !== y) return x > y;
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

// Audits one dogfood session directory against the checkout at the current
// HEAD and returns the attestation. Throws on any failure; `skill` (a
// checkout-relative SKILL.md path) additionally requires a successful read
// tool call on that exact file.
export function auditSession(dir, root, skill) {
	const files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
	if (files.length !== 1) {
		throw new Error(`expected exactly 1 session file, found ${files.length}`);
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
	if (fs.existsSync(`${dir}/watchdog`)) {
		throw new Error("watchdog fired: run exceeded 300s");
	}
	const sysRecs = recs.filter((r) => r.message?.role === "system");
	if (sysRecs.length !== 1) {
		throw new Error(`expected exactly 1 system record, found ${sysRecs.length}`);
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
	const skillsText = sysRecs[0].message?.sections?.skills ?? "";
	const locations = extractLocations(skillsText);
	if (!locations) {
		throw new Error("no available_skills section in system records");
	}
	const inv = JSON.parse(fs.readFileSync("test/expected-skills.json", "utf8"));
	const raw = manifestSkillRoots();
	if (raw.length !== 1) {
		throw new Error("audit supports a single plain-directory pi.skills entry");
	}
	const skillRoots = [path.resolve(root, raw[0])];
	const names = inv.vendored.map((e) => e.name).concat(inv["self-authored"]);
	const missing = [];
	for (const n of names) {
		const p = `${root}/skills/${n}/SKILL.md`;
		if (!locations.has(p)) missing.push(n);
	}
	if (missing.length > 0) {
		throw new Error(`NOT advertised: ${missing.join(", ")}`);
	}
	const expected = new Set(names.map((n) => `${root}/skills/${n}/SKILL.md`));
	const extras = [...locations].filter(
		(l) => skillRoots.some((r) => l.startsWith(r + "/")) && !expected.has(l),
	);
	if (extras.length > 0) {
		throw new Error(`UNEXPECTED advertised skills:\n${extras.join("\n")}`);
	}
	const dirty = execSync("git status --porcelain").toString().trim();
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
		const target = `${root}/${skill}`;
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
				t.name === "read" && t.arguments?.path === target && r && r.isError !== true
			);
		});
		if (!hit) {
			throw new Error("NOT used");
		}
		out += `\nused ${target}\nskill-content ${sha(target)}`;
	}
	return out;
}

function manifestSkillRoots() {
	const manifest = JSON.parse(fs.readFileSync("package.json", "utf8"));
	const raw = manifest.pi?.skills ?? ["./skills"];
	if (
		!Array.isArray(raw) ||
		raw.length !== 1 ||
		typeof raw[0] !== "string" ||
		/[*?[\]{}]/.test(raw[0])
	) {
		throw new Error("audit supports a single plain-directory pi.skills entry");
	}
	return raw;
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

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
	process.exit(main(process.argv.slice(2)));
}
