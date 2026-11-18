// One home for the suites' notify recorder — a stub ui.notify that
// records every call — per the tree-wide shared-helper rule: the
// skill-pool suite built the tuple form locally, and the notebook-command
// suite (#182) became the second caller, so the recorder moves here in
// the object form (named fields read better than positional indexes) and
// both suites consume it.
export function recordedNotify() {
	const calls = [];
	const notify = (message, level) => calls.push({ message, level });
	return { calls, notify };
}
