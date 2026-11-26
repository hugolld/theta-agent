// One home for the gate suites' stub handler context — the confirm stub
// that records its arguments and answers the test's scripted boolean,
// with the optional session manager (absent unless a test supplies one,
// which is also how the default log sink's no-session guard gets pinned)
// and the optional session cwd (the plan-review gate reads the project
// through it). Per the tree-wide shared-helper rule: the submit-gate
// suite (#95) built the shape, and the plan-review gate suite (#203) is
// the second caller, so it moves here and both suites consume this
// module.

export function stubGateContext({ answer = false, cwd, sessionManager } = {}) {
	const calls = [];
	return {
		calls,
		...(cwd !== undefined ? { cwd } : {}),
		ui: {
			confirm: async (...args) => {
				calls.push(args);
				return answer;
			},
		},
		...(sessionManager !== undefined ? { sessionManager } : {}),
	};
}
