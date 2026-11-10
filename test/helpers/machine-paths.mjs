// Shared host-machine path vocabulary (at its shared home since the eval
// capture's sanitizer became the second caller of the shape): the path
// prefixes that identify the operator's machine — any user's home on a Mac
// (/Users/) or a Linux host (/home/), and the Homebrew root — as opposed
// to rig-internal container paths, which carry no machine identity.
// test/eval/capture.mjs checks these plus the live homedir() over each
// sanitized transcript; the dogfood golden fixtures check the literal list
// over fixture bytes. One vocabulary, two guards.

import { homedir } from "node:os";

export const MACHINE_PATH_PREFIXES = Object.freeze(["/Users/", "/home/", "/opt/homebrew"]);

export function machinePathPrefixes() {
	return [...MACHINE_PATH_PREFIXES, homedir()];
}
