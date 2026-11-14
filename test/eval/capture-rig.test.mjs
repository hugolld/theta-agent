// Pins the rig invocation a scenario drives (spec #134): the prompt comes
// from the checked-in list, the legs ride in order, and exactly the
// scenarios that declare `gateway: true` carry the rig's --gateway flag —
// the one credential-bearing extension an eval capture can make, spent
// only where the surface demands the gateway (the gate refusal).

import assert from "node:assert/strict";
import { test } from "node:test";
import { rigArgs } from "./capture.mjs";
import { SCENARIOS } from "./scenarios.mjs";

const scenarioById = (id) => SCENARIOS.find((s) => s.id === id);

test("the rig invocation runs the scenario's prompt with a bound, dir, and legs", () => {
	const connector = scenarioById("connector");
	const args = rigArgs(connector, "/tmp/ev");
	assert.match(args[0], /test\/rig\/run\.mjs$/);
	assert.equal(args[1], "run");
	assert.equal(args[2], connector.prompt);
	assert.deepEqual(args.slice(3, 7), ["--timeout", "600", "--session-dir", "/tmp/ev"]);
	const legs = [];
	for (let i = 7; i < args.length; i++) {
		assert.equal(args[i], "--leg");
		legs.push(args[++i]);
	}
	assert.deepEqual(legs, connector.legs);
});

test("exactly the gateway scenarios pass --gateway, and every leg rides in order", () => {
	for (const scenario of SCENARIOS) {
		const args = rigArgs(scenario, "/tmp/ev");
		assert.equal(
			args.filter((arg) => arg === "--gateway").length,
			scenario.gateway === true ? 1 : 0,
			`${scenario.id}: --gateway must ride exactly when the scenario declares it`,
		);
		const legs = [];
		for (let i = 0; i < args.length; i++) {
			if (args[i] === "--leg") legs.push(args[++i]);
		}
		assert.deepEqual(legs, scenario.legs, `${scenario.id}: leg order drifted`);
	}
});
