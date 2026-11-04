#!/usr/bin/env node
// The pipefail lint (#139): a shell script that pipes must fail when the
// pipe's head fails — `set -o pipefail` — or argue its exception below.
// The #117 re-deploy and the M6 tickets publish both shipped a pipeline
// whose tail's success masked the head's failure; the exit-status rule
// names the disjunction, this check enforces its pipefail arm, and
// SHELL_EXCEPTIONS carries the argued other arm.
import { readdir, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

// Argued exceptions (the PROSE_EXCEPTIONS pattern in the glossary tests):
// each names why the unpiped arm of the exit-status rule applies instead.
// - gateway/deploy.sh: the one real pipeline's gated command (ssh) is its
//   tail, so its status already propagates; and the cluster login node's
//   /bin/sh is unprobed for pipefail (SSH down, 2026-11-04) — a loud
//   `set: Illegal option` there breaks every deploy. One probe confirming
//   pipefail on the cluster retires this exception.
// - scripts/gateway-probe.sh: every gated step runs unpiped by design.
const SHELL_EXCEPTIONS = new Set(["gateway/deploy.sh", "scripts/gateway-probe.sh"]);

// The textual approximation: a non-comment line carrying `|` (outside the
// `||` operator) reads as a pipeline. A pipe hidden in a string is a
// false positive — the approximation is a named residual of #139.
export function pipefailOffenders(sources) {
	const offenders = [];
	for (const [path, text] of sources) {
		if (SHELL_EXCEPTIONS.has(path)) continue;
		const lines = text.split(/\r?\n/);
		const pipelines = lines
			.map((line, index) => [line, index])
			.filter(([line]) => line.trim() !== "" && !line.trim().startsWith("#"))
			.filter(([line]) => line.replaceAll("||", " ").includes("|"));
		if (pipelines.length === 0) continue;
		if (!/set\s+[^\n]*pipefail/.test(text)) {
			offenders.push(
				`${path}: ${pipelines.length} pipeline line(s) (first at line ${pipelines[0][1] + 1}) with no pipefail`,
			);
		}
	}
	return offenders;
}

async function shellSurfaces() {
	const scripts = (await readdir(new URL("../scripts/", import.meta.url)))
		.filter((name) => name.endsWith(".sh"))
		.map((name) => `scripts/${name}`);
	return [...scripts, "gateway/deploy.sh", ".githooks/pre-commit"];
}

async function main() {
	const surfaces = await shellSurfaces();
	const sources = await Promise.all(
		surfaces.map(async (path) => [path, await readFile(path, "utf8")]),
	);
	const offenders = pipefailOffenders(sources);
	if (offenders.length > 0) {
		for (const offender of offenders) console.error(`lint:sh — ${offender}`);
		process.exit(1);
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	await main();
}
