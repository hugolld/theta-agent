// One home for the suites' registerCommand recorder — register the
// extension against a stub pi object whose only method records every
// registration — per the tree-wide shared-helper rule: the
// notebook-command suite (#182) built the stub inline, and the
// roadmap-command suite (#186) became the second caller, so the
// recorder moves here beside recordedNotify and both suites consume
// it. Named fields read better than positional indexes; the
// single-registration assert stays each suite's own — the helper
// records, the test asserts what its own command owes.
export function recordedRegister(register) {
	const calls = [];
	register({
		registerCommand: (name, options) => calls.push({ name, options }),
	});
	return calls;
}
