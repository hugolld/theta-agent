// The replay net's provenance surfaces (spec #133): the classes of bytes
// a fixture's digests bind. The digest-scope decision — landed here,
// pinned by test/eval/surfaces.test.mjs, recorded in docs/agents/eval.md —
// is one digest per model-visible surface class:
//
//   advertisement  the <available_skills> bytes every session's system
//                  record carries, derived from every skill's frontmatter
//                  name, description, and repo-relative location
//   skill:<name>   one skill's whole tree under skills/<name>,
//                  content-addressed
//   extensions     the extension sources under extensions/,
//                  content-addressed
//   project-context  the project-instruction bytes pi loads into the
//                  system prompt — CLAUDE.md at the repo root, embedded
//                  as the <project_instructions> block every session
//                  carries (spec #133's review round: the connector
//                  capture demonstrably included this surface)
//
// A fixture's provenance manifest declares one digest per class its
// session's model-visible context included; the net recomputes each from
// the live tree, and a mismatch reds naming the fixture — the capture is
// stale, and the eval-capture doctrine (ADR 0007) says a model-visible
// change lands only with a fresh capture. Scoping is per session, honest
// to what the model actually saw: a connector capture binds the
// advertisement (every session sees every skill's advertisement line), the
// project context, and the connector's own tree, but not another skill's
// body — its bytes were never model-visible in that session. Pi-owned
// sections (preamble, tools, rules, docs) stay out: they are the
// installed pi's bytes, pinned by the rig image, not this repo's. The
// class registry is open: a later strike adds a class when a scenario's
// surface demands one, and the registry pin forces that to be a decision,
// not an accident.

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseFrontmatter } from "../helpers/frontmatter.mjs";

export const SURFACE_CLASSES = Object.freeze({
	advertisement:
		"the <available_skills> bytes every session carries, derived from every skill's frontmatter name, description, and repo-relative location, in inventory order",
	skill: "one skill's whole tree under skills/<name>, content-addressed",
	extensions: "the extension sources under extensions/, content-addressed",
	"project-context":
		"the project-instruction bytes pi loads into the system prompt — CLAUDE.md at the repo root",
});

function sha256Bytes(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}

// Content-addressed tree digest: sorted repo-relative paths, one
// `path\0sha256\n` line per file — file bytes hashed, never embedded, so
// the digest is machine-independent and a moved or renamed file is a
// change. An empty tree refuses: a surface class that resolves to nothing
// is a typo in the class, not a digest.
export function fileTreeDigest(rootAbs) {
	const files = [];
	const walk = (dir, prefix) => {
		for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
			a.name < b.name ? -1 : 1,
		)) {
			if (entry.isDirectory()) {
				walk(path.join(dir, entry.name), `${prefix}${entry.name}/`);
			} else {
				files.push(`${prefix}${entry.name}`);
			}
		}
	};
	walk(rootAbs, "");
	if (files.length === 0) throw new Error(`surface tree is empty: ${rootAbs}`);
	const canonical = files
		.map((rel) => `${rel}\0${sha256Bytes(readFileSync(path.join(rootAbs, rel)))}\n`)
		.join("");
	return sha256Bytes(Buffer.from(canonical, "utf8"));
}

// The advertisement bytes as a canonical, machine-independent derivation
// of pi's <available_skills> block. Pi's own rendering XML-escapes the
// values and carries absolute locations (mount aliases and all), so the
// digest binds the stable content — name, description, repo-relative
// location — with raw values in inventory order. Any edit that changes
// what a session advertises (a description rewrite, a vendored re-sync, a
// dropped skill) moves this digest.
export function advertisementBytes(skillsRoot) {
	const dirs = readdirSync(skillsRoot, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.sort();
	const lines = dirs.map((dir) => {
		const { name, description } = parseFrontmatter(
			readFileSync(path.join(skillsRoot, dir, "SKILL.md"), "utf8"),
		);
		return `<skill><name>${name}</name><description>${description}</description><location>skills/${dir}/SKILL.md</location></skill>`;
	});
	return `${lines.join("\n")}\n`;
}

export function surfaceDigest(surfaceClass, repoRoot) {
	if (surfaceClass === "advertisement") {
		return sha256Bytes(
			Buffer.from(advertisementBytes(path.join(repoRoot, "skills")), "utf8"),
		);
	}
	if (surfaceClass.startsWith("skill:")) {
		const name = surfaceClass.slice("skill:".length);
		// An empty name would resolve to the whole skills tree — a class
		// typo must refuse, not silently bind everything.
		if (name === "") throw new Error(`unknown model-visible surface class: ${surfaceClass}`);
		return fileTreeDigest(path.join(repoRoot, "skills", name));
	}
	if (surfaceClass === "extensions") {
		return fileTreeDigest(path.join(repoRoot, "extensions"));
	}
	if (surfaceClass === "project-context") {
		// The single file pi embeds as <project_instructions>; hashed as
		// bytes, like every surface.
		return sha256Bytes(readFileSync(path.join(repoRoot, "CLAUDE.md")));
	}
	throw new Error(`unknown model-visible surface class: ${surfaceClass}`);
}
