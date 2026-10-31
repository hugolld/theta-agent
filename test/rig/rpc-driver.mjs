#!/usr/bin/env node
// RPC-mode driver for the rig's gateway legs (spec #96): run one theta
// session in RPC mode, answer the submit gate's confirm headlessly, and
// capture everything to the session dir. Dogfood evidence tooling — it
// answers gate confirms without a human, so it is never a user path; it
// exists because print mode's no-op UI denies every confirm, and a gated
// submit cannot cross the submit gate there. Ported from the M5 S0 live
// leg's driver (the pattern docs/agents/dogfood.md records).
//
// Usage: node rpc-driver.mjs <checkout> <sessionDir> "<prompt>" [allow|deny]
// Environment: RIG_PROVIDER, RIG_MODEL (the session's provider and model —
// the rig runner passes what it launched with), RIG_TIMEOUT (the outer GNU
// timeout bound; the inner backstop fires only past it, so the outer 124
// contract stays the one that records a timeout).
//
// The wrapper that launches this driver owns the exit-status file: this
// driver's own exit code mirrors pi's, and on SIGTERM (GNU timeout's first
// signal) it exits 124 so the wrapper records the timeout sentinel.

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

// A bare invocation prints usage and exits 0, the runner's own help shape —
// node --test executes every file under test/ as a test file, and this file
// must pass that discovery the way run.mjs's help path does.
const argv = process.argv.slice(2);
if (argv.length === 0) {
	console.log("usage: rpc-driver.mjs <checkout> <sessionDir> <prompt> [allow|deny]");
	process.exit(0);
}
const [checkout, sessionDir, prompt, gateAnswer = "allow"] = argv;
if (!checkout || !sessionDir || !prompt) {
	console.error("usage: rpc-driver.mjs <checkout> <sessionDir> <prompt> [allow|deny]");
	process.exit(2);
}
const provider = process.env.RIG_PROVIDER ?? "zai-coding-cn";
const model = process.env.RIG_MODEL ?? "glm-5.3-flash";
mkdirSync(sessionDir, { recursive: true });
writeFileSync(path.join(sessionDir, "prompt.txt"), prompt);

// Inherit the environment, then scrub the families the M5 S0 leg named:
// ambient ANTHROPIC_* proxies break provider auth, and stale PI_* state
// must not steer the child. In the rig both are absent by construction —
// the scrub guards bare host-side runs of this driver.
const childEnv = { ...process.env };
for (const key of Object.keys(childEnv)) {
	if (key.startsWith("ANTHROPIC_") || key.startsWith("PI_")) delete childEnv[key];
}

const child = spawn(
	"node",
	[
		"bin/theta.mjs", "--dev", "--mode", "rpc",
		"--provider", provider, "--model", model,
		"--session-dir", sessionDir,
	],
	{
		cwd: checkout,
		stdio: ["pipe", "pipe", "pipe"],
		env: childEnv,
	},
);
const events = [];
let settled = false;
let lastText = "";
const stderrChunks = [];
child.stderr.on("data", (chunk) => stderrChunks.push(chunk));

const deadline = setTimeout(() => {
	console.error("driver backstop fired — the session outlived its bound");
	child.kill("SIGKILL");
	process.exit(1);
}, (Number(process.env.RIG_TIMEOUT ?? 300) + 60) * 1000);

// GNU timeout's SIGTERM: hand pi the same signal and take the 124 exit the
// watchdog contract expects, so the wrapper's exit-status file records the
// timeout exactly as the print leg does.
process.on("SIGTERM", () => {
	clearTimeout(deadline);
	if (!child.killed) child.kill("SIGTERM");
	process.exit(124);
});

function send(record) {
	child.stdin.write(JSON.stringify(record) + "\n");
}

function finish(code) {
	clearTimeout(deadline);
	writeFileSync(path.join(sessionDir, "raw-rpc-events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
	writeFileSync(path.join(sessionDir, "stdout.txt"), lastText);
	writeFileSync(path.join(sessionDir, "stderr.txt"), stderrChunks.join(""));
	child.stdin.end();
	child.on("close", () => process.exit(code));
	setTimeout(() => {
		child.kill("SIGTERM");
		setTimeout(() => process.exit(code), 2000);
	}, 5000);
}

child.stdout.setEncoding("utf8");
let buffer = "";
child.stdout.on("data", (chunk) => {
	// Split on LF only — U+2028/2029 are valid inside JSON strings.
	buffer += chunk;
	let index;
	while ((index = buffer.indexOf("\n")) !== -1) {
		const line = buffer.slice(0, index).replace(/\r$/, "");
		buffer = buffer.slice(index + 1);
		if (line === "") continue;
		let record;
		try {
			record = JSON.parse(line);
		} catch {
			continue;
		}
		events.push(record);
		handle(record);
	}
});

function handle(record) {
	// The submit gate's confirm: answer with the configured verdict. The
	// stacked gate may ask from interleaved calls; each request carries its
	// own id, and each answer matches it.
	if (record.type === "extension_ui_request" && record.method === "confirm") {
		const answer = { type: "extension_ui_response", id: record.id };
		if (gateAnswer === "deny") answer.cancelled = true;
		else answer.confirmed = true;
		send(answer);
		return;
	}
	if (record.type === "message_update" && record.assistantMessageEvent?.type === "text_delta") {
		lastText += record.assistantMessageEvent.delta;
	}
	if (record.type === "agent_settled") {
		settled = true;
		// Ask for the final assistant text as the authoritative answer.
		send({ id: "final", type: "get_last_assistant_text" });
	}
	if (record.type === "response" && record.command === "get_last_assistant_text" && record.success) {
		if (typeof record.data === "string" && record.data !== "") lastText = record.data;
		console.log(`settled; answer captured (${lastText.length} chars)`);
		finish(0);
	}
}

child.on("exit", (code) => {
	if (!settled) {
		console.error(`pi exited ${code} before settling`);
		finish(1);
	}
});

send({ id: "prompt-1", type: "prompt", message: prompt });
