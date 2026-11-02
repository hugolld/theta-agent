// One escape for regex needles across the test tree — the shared-helper
// rule's own catch: the shape appeared in skills-library's wordPattern
// and submit-gate's matcher before the one-home guard made the third
// caller, so it gets one home here (helpers/gateway.mjs's pattern).

export function escapeRegExp(text) {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
