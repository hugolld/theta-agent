// Shared name-sorted child-directory enumeration: the shape behind the
// shipped-skills listing and the pool-pack listing (test/skills-library.test.mjs).
// Sync like the tree walk it sits beside — the callers build module-level
// constants from it.
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function childDirs(dirUrl) {
	return readdirSync(fileURLToPath(dirUrl), { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.sort();
}
