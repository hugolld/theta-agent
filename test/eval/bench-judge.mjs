#!/usr/bin/env node
// One judge call in one fresh process (spec #136). Measured live
// (2026-11-15, five suite runs): every judge failure rode the suite
// runner's own process — TypeError "fetch failed" from its pooled
// connection state, bare even after a fresh-socket retry — while every
// fresh-process probe passed (back-to-back calls, idle gaps, container
// churn, a real rig session in between). This child resolves the named
// classifier slot from the host pi config exactly like the runner's
// preflight did, classifies, and answers one JSON verdict on stdout;
// stderr carries the full error tree, so a real failure self-diagnoses.
// The parent (bench-report.mjs runJudge) owns the verdict semantics —
// threshold, shape, retry policy; the child only transports the
// classify() outcome.
import { inspect } from "node:util";
import { pathToFileURL } from "node:url";
import { ModelRuntime, ModelRegistry } from "@earendil-works/pi-coding-agent";

// The transport class and its message live here, at the fetch that can
// fail: fetch failures answer TypeError "fetch failed" with the real
// reason (ECONNRESET, ETIMEDOUT, a certificate refusal) on error.cause —
// the verdict must carry the cause, not just the wrapper.
export function isTransportError(error) {
	return error instanceof TypeError && error.message === "fetch failed";
}

export function transportMessage(error) {
	const cause = error?.cause?.code ?? error?.cause?.message;
	return cause ? `fetch failed (${cause})` : String(error?.message ?? error);
}

// One dump shape for both failure paths (judgeMain's catch and the main
// guard's): the full error tree on stderr, so the evidence self-diagnoses.
function dump(error) {
	console.error(inspect(error, { depth: 6, breakLength: 120 }));
}

// The classify call itself. A settled result — including a stopReason
// error, which is an answer, not a throw — rides ok:true; a thrown
// error rides ok:false with the transport flag the parent's retry
// policy reads. Slot resolution happens here too: the parent preflighted
// it, but the child runs in its own process, so it re-resolves from the
// same host config and names the slot if the catalog moved underneath.
export async function judgeMain(argv, input) {
	const runtime = await ModelRuntime.create();
	const registry = new ModelRegistry(runtime);
	const model = registry.getModelOfType("classifier", argv[0], argv[1]);
	if (!model) {
		return { ok: false, transport: false, error: `judge ${argv[0]}/${argv[1]} is not in the catalog` };
	}
	try {
		const settled = await registry.classify(model, {
			state: input.state,
			questions: { [input.classify.id]: input.classify.question },
		});
		return { ok: true, settled };
	} catch (error) {
		dump(error);
		return { ok: false, transport: isTransportError(error), error: transportMessage(error) };
	}
}

// The main guard needs two conditions, not one: the node test runner
// discovers every .mjs under test/ as a test file and loads it in a
// child where argv[1] is this file and stdin is the runner's pipe,
// open forever — a bare argv check hung the suite's commit hook for 36
// minutes (2026-11-15) on the stdin read. NODE_TEST_CONTEXT is the
// runner's own marker in its child processes; a loaded-not-invoked
// child must do nothing, exactly like every other helper in test/.
if (process.env.NODE_TEST_CONTEXT === undefined && import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	try {
		const chunks = [];
		for await (const chunk of process.stdin) chunks.push(chunk);
		const input = JSON.parse(chunks.join(""));
		process.stdout.write(JSON.stringify(await judgeMain(process.argv.slice(2), input)));
	} catch (error) {
		dump(error);
		process.stdout.write(JSON.stringify({ ok: false, transport: false, error: String(error?.message ?? error) }));
	}
}
