// The judge stubs' answer sample, type-anchored to the installed pi-ai's
// declared ClassifierBoolAnswer (the M6 S2 retro's second automated
// check): the benchmark tests stub classify() answers, and a stub shape
// pi never produces teaches the suite a lie — the S2 draft stub answered
// a bare boolean while pi answers { type: "bool", probability }, and the
// suite stayed green while every clean live verdict would have failed the
// leg. This file is the one place the offline shape meets the declared
// one: tsc --noEmit checks it (tsconfig includes exactly this file under
// checkJs), and every stub imports the sample instead of hand-writing
// literals. The day pi-ai's answer type drifts, typecheck reds here,
// naming this file.

/** The shape a stopped bool classify() verdict answers with. */
export const BOOL_ANSWER_SAMPLE =
	/** @type {import("@earendil-works/pi-ai").ClassifierBoolAnswer} */ ({ type: "bool", probability: 0.87 });
