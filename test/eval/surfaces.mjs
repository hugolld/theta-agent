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
//   pool:<pack>    one domain pack's whole tree under pool/<pack> plus
//                  the class map pool/classes.json that gates what loads,
//                  content-addressed (spec #167 — the class the pool
//                  scenario binds; the pack is the re-sync unit, so a pack
//                  re-sync reds every fixture that loaded it)
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
import { readFileSync } from "node:fs";
import path from "node:path";
import { childDirs } from "../helpers/child-dirs.mjs";
import { parseFrontmatter } from "../helpers/frontmatter.mjs";
import { sortedTreeFiles } from "../helpers/tree-walk.mjs";

export const SURFACE_CLASSES = Object.freeze({
	advertisement:
		"the <available_skills> bytes every session carries, derived from every skill's frontmatter name, description, and repo-relative location, in inventory order",
	skill: "one skill's whole tree under skills/<name>, content-addressed",
	pool: "one domain pack's whole tree under pool/<pack> plus the class map pool/classes.json that gates what loads, content-addressed",
	extensions: "the extension sources under extensions/, content-addressed",
	"project-context":
		"the project-instruction bytes pi loads into the system prompt — CLAUDE.md at the repo root",
});

// The root pathspec each class's bytes live under. The land guard's probe
// set is the union over this table, so a class added to the registry widens
// the probe automatically, and a registry key without a root refuses here
// instead of escaping the guard (the digests are computed at land time
// against the landing tree — the probe is what binds them to the capture).
const SURFACE_ROOTS = Object.freeze({
	advertisement: "skills",
	skill: "skills",
	pool: "pool",
	extensions: "extensions",
	"project-context": "CLAUDE.md",
});

export function surfaceProbePaths() {
	const roots = Object.keys(SURFACE_CLASSES).map((surfaceClass) => {
		const root = SURFACE_ROOTS[surfaceClass];
		if (root === undefined) {
			throw new Error(`surface class has no probe root: ${surfaceClass}`);
		}
		return root;
	});
	return [...new Set(roots)].sort();
}

function sha256Bytes(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}

// The `path\0sha256\n` lines a tree digest is hashed over, each file's
// path prefixed with its class-relative location — the one line builder
// the whole-tree digests share (the tree rule: fileTreeDigest and the
// pool pack digest are its two callers). The sorted walk is the shared
// helper's (test/helpers/tree-walk.mjs).
function treeDigestLines(rootAbs, prefix) {
	return sortedTreeFiles(rootAbs)
		.map((rel) => `${prefix}${rel}\0${sha256Bytes(readFileSync(path.join(rootAbs, rel)))}\n`)
		.join("");
}

// Content-addressed tree digest: sorted repo-relative paths, one
// `path\0sha256\n` line per file — file bytes hashed, never embedded, so
// the digest is machine-independent and a moved or renamed file is a
// change. An empty tree refuses: a surface class that resolves to nothing
// is a typo in the class, not a digest.
export function fileTreeDigest(rootAbs) {
	const canonical = treeDigestLines(rootAbs, "");
	if (canonical === "") throw new Error(`surface tree is empty: ${rootAbs}`);
	return sha256Bytes(Buffer.from(canonical, "utf8"));
}

// The pool pack digest (spec #167): the pack's whole tree plus the class
// map that gates what loads — both are inputs to every pool-loaded
// session's advertisement (a reclass changes which skills load, exactly
// like a body edit changes what an opened skill says), so both ride one
// digest. An empty pack tree or a missing class map refuses: either is a
// typo in the class or a pool the loader could never serve, not a digest.
export function poolPackDigest(repoRoot, pack) {
	const packRoot = path.join(repoRoot, "pool", pack);
	const lines = treeDigestLines(packRoot, `pool/${pack}/`);
	if (lines === "") throw new Error(`surface tree is empty: ${packRoot}`);
	const classesFile = path.join(repoRoot, "pool", "classes.json");
	const classes = readFileSync(classesFile);
	return sha256Bytes(
		Buffer.from(`${lines}pool/classes.json\0${sha256Bytes(classes)}\n`, "utf8"),
	);
}

// The advertisement bytes as a canonical, machine-independent derivation
// of pi's <available_skills> block. Pi's own rendering XML-escapes the
// values and carries absolute locations (mount aliases and all), so the
// digest binds the stable content — name, description, repo-relative
// location — with raw values in inventory order. Any edit that changes
// what a session advertises (a description rewrite, a vendored re-sync, a
// dropped skill) moves this digest.
export function advertisementBytes(skillsRoot) {
	const dirs = childDirs(skillsRoot);
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
	if (surfaceClass.startsWith("pool:")) {
		const pack = surfaceClass.slice("pool:".length);
		// An empty pack name would digest the pool root's stray files — a
		// typo refuses, exactly like the skill class's empty name.
		if (pack === "") throw new Error(`unknown model-visible surface class: ${surfaceClass}`);
		return poolPackDigest(repoRoot, pack);
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
