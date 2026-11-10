// The repository root as a path, one home for the three callers the
// replay net added (capture.mjs and both eval suites) — the same
// "resolve ../.. from this file" shape extracted at its second caller,
// per the tree-wide shared-helper rule. Computed from this file's own
// location, so it stays correct no matter which depth imports it.
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
