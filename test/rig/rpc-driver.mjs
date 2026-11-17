#!/usr/bin/env node
// RPC-mode driver for the rig's gateway legs (spec #96): run one theta
// session in RPC mode, answer the submit gate's confirm headlessly, and
// capture everything to the session dir. Dogfood evidence tooling — it
// answers gate confirms without a human, so it is never a user path; it
// exists because print mode's no-op UI denies every confirm, and a gated
// submit cannot cross the submit gate there. Ported from the M5 S0 live
// leg's driver (the pattern docs/agents/dogfood.md records).
//
// Usage: node rpc-driver.mjs [--cwd <dir>] <checkout> <sessionDir> "<prompt>" [allow|deny]
// Environment: RIG_PROVIDER, RIG_MODEL (the session's provider and model —
// the rig runner passes what it launched with), RIG_TIMEOUT (the outer GNU
// timeout bound; the inner backstop fires only past it, so the outer 124
// contract stays the one that records a timeout).
//
// --cwd (spec #164) names the session's working directory — a dogfood whose
// evidence lives in an arbitrary research project's cwd, not the checkout.
// Absent, the checkout stays the default. With it, the spawn is `pi -e
// <checkout>` directly: theta --dev's trust anchor covers only the checkout
// itself (never an arbitrary cwd), and the operator naming the checkout in
// argv is the out-of-band vouch -e already asks for.
//
// The wrapper that launches this driver owns the exit-status file: this
// driver's own exit code mirrors pi's, and on SIGTERM (GNU timeout's first
// signal) it exits 124 so the wrapper records the timeout sentinel.

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { drainJsonl } from "./rpc-jsonl.mjs";
import { SESSION_FILES } from "../../scripts/session-evidence.mjs";

// A bare invocation prints usage and exits 0, the runner's own help shape —
// node --test executes every file under test/ as a test file, and this file
// must pass that discovery the way run.mjs's help path does.
const argv = process.argv.slice(2);
if (argv.length === 0) {
	console.log("usage: rpc-driver.mjs [--cwd <dir>] <checkout> <sessionDir> <prompt> [allow|deny]");
	process.exit(0);
}
// --cwd <dir> follows the rig runner's own flag convention and may sit
// anywhere in argv; everything else stays positional.
let sessionCwd;
const positional = [];
for (let i = 0; i < argv.length; i++) {
	if (argv[i] !== "--cwd") {
		positional.push(argv[i]);
		continue;
	}
	const value = argv[++i];
	if (value === undefined) {
		console.error("--cwd needs a value");
		process.exit(2);
	}
	sessionCwd = value;
}
const [checkout, sessionDir, prompt, gateAnswer = "allow"] = positional;
if (!checkout || !sessionDir || !prompt) {
	console.error("usage: rpc-driver.mjs [--cwd <dir>] <checkout> <sessionDir> <prompt> [allow|deny]");
	process.exit(2);
}
// The verdict is exact words only: a typo'd answer must refuse to run, not
// silently mean allow on a real submit.
if (gateAnswer !== "allow" && gateAnswer !== "deny") {
	console.error(`gate answer must be allow or deny, not ${JSON.stringify(gateAnswer)}`);
	process.exit(2);
}
const provider = process.env.RIG_PROVIDER ?? "zai-coding-cn";
const model = process.env.RIG_MODEL ?? "glm-5.3-flash";
mkdirSync(sessionDir, { recursive: true });
writeFileSync(path.join(sessionDir, SESSION_FILES.prompt), prompt);

// Inherit the environment, then scrub the families the M5 S0 leg named:
// ambient ANTHROPIC_* proxies break provider auth, and stale PI_* state
// must not steer the child. In the rig both are absent by construction —
// the scrub guards bare host-side runs of this driver.
const childEnv = { ...process.env };
for (const key of Object.keys(childEnv)) {
	if (key.startsWith("ANTHROPIC_") || key.startsWith("PI_")) delete childEnv[key];
}

const sessionArgs = ["--mode", "rpc", "--provider", provider, "--model", model, "--session-dir", sessionDir];
const spawnOpts = { stdio: ["pipe", "pipe", "pipe"], env: childEnv };
// The spawn shape follows the cwd (spec #164): from the checkout, the
// launcher's own `--dev` anchor vouches for it; in an arbitrary project
// cwd that anchor refuses by design, so the driver vouches the checkout
// itself the way theta does — `pi -e <checkout>`.
const child =
	sessionCwd === undefined
		? spawn("node", ["bin/theta.mjs", "--dev", ...sessionArgs], { cwd: checkout, ...spawnOpts })
		: spawn("pi", ["-e", checkout, ...sessionArgs], { cwd: sessionCwd, ...spawnOpts });
// A spawn that cannot start — pi missing from PATH, a --cwd that does not
// exist — fails as a clean exit-2 message, not an unhandled-error stack:
// the wrapper would otherwise record noise for a tooling miss.
child.on("error", (error) => {
	console.error(`driver could not spawn the session: ${error.message}`);
	process.exit(2);
});
const events = [];
let settled = false;
let finished = false;
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
	finished = true;
	clearTimeout(deadline);
	writeFileSync(path.join(sessionDir, "raw-rpc-events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
	writeFileSync(path.join(sessionDir, "stdout.txt"), lastText);
	writeFileSync(path.join(sessionDir, SESSION_FILES.stderr), stderrChunks.join(""));
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
	buffer = drainJsonl(buffer, chunk, (record) => {
		events.push(record);
		handle(record);
	});
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
	// pi dying after settle but before its final-text answer would
	// otherwise idle into the outer watchdog and be recorded as a
	// timeout; call it what it is — an unfinished capture.
	if (!settled) {
		console.error(`pi exited ${code} before settling`);
		finish(1);
	} else if (!finished) {
		console.error(`pi exited ${code} after settling without answering the final-text request`);
		finish(1);
	}
});

send({ id: "prompt-1", type: "prompt", message: prompt });
