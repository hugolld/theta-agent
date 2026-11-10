// Shared sorted tree walk (at its shared home since the replay net's
// surface digests became the second caller of the shape): depth-first,
// entries name-sorted per directory. The order is not incidental — it is
// the canonical form's bones for every tree digest built on top (the flat
// `path\0sha` lines of test/eval/surfaces.mjs, the nested manifests of
// test/skills-library.test.mjs), and failure messages list files in walk
// order. Files only: an empty directory leaves no trace (git checkouts
// carry none; a digest built on this walk moves if one appears, which is
// the loud way to learn about it).

import { readdirSync } from "node:fs";
import path from "node:path";

export function sortedTreeFiles(rootAbs) {
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
	return files;
}
