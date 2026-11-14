// Pins the rig invocation a scenario drives (spec #134): the prompt comes
// from the checked-in list, the legs ride in order, and exactly the
// scenarios that declare `gateway: true` carry the rig's --gateway flag —
// the one credential-bearing extension an eval capture can make, spent
// only where the surface demands the gateway (the gate refusal).

import assert from "node:assert/strict";
import { test } from "node:test";
import { rigArgs, scenarioById } from "./capture.mjs";
import { SCENARIOS } from "./scenarios.mjs";

// The --leg pairs the invocation carries, in list order.
function legsOf(args) {
	const legs = [];
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--leg") legs.push(args[++i]);
	}
	return legs;
}

test("the rig invocation runs the scenario's prompt with a bound, dir, and legs", () => {
	const connector = scenarioById("connector");
	const args = rigArgs(connector, "/tmp/ev");
	assert.match(args[0], /test\/rig\/run\.mjs$/);
	assert.equal(args[1], "run");
	assert.equal(args[2], connector.prompt);
	assert.equal(args.indexOf("--timeout"), 3);
	assert.equal(args[args.indexOf("--timeout") + 1], "600");
	assert.equal(args.indexOf("--session-dir"), 5);
	assert.equal(args[args.indexOf("--session-dir") + 1], "/tmp/ev");
	assert.deepEqual(legsOf(args), connector.legs);
});

test("exactly the gateway scenarios pass --gateway, and every leg rides in order", () => {
	for (const scenario of SCENARIOS) {
		const args = rigArgs(scenario, "/tmp/ev");
		assert.equal(
			args.filter((arg) => arg === "--gateway").length,
			scenario.gateway === true ? 1 : 0,
			`${scenario.id}: --gateway must ride exactly when the scenario declares it`,
		);
		assert.deepEqual(legsOf(args), scenario.legs, `${scenario.id}: leg order drifted`);
	}
});
