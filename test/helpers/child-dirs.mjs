// Shared name-sorted child-directory enumeration: the shape behind the
// shipped-skills listing and the pool-pack listing
// (test/skills-library.test.mjs) and the eval advertisement bytes
// (test/eval/surfaces.mjs). Accepts a URL or a plain path — the library
// callers hold URLs, the eval surface a path. Sync like the tree walk it
// sits beside — the callers build module-level constants from it.
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function childDirs(dir) {
	return readdirSync(dir instanceof URL ? fileURLToPath(dir) : dir, {
		withFileTypes: true,
	})
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.sort();
}
