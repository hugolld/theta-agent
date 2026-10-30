import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
	HELD_REASON,
	assertAuditLine,
	argumentDigest,
	canonicalJson,
	exists,
	readArgv,
	readArgvCalls,
	readAudit,
	skipReason,
	startGateway,
	startGatewayExit,
	toolText,
} from "./helpers/gateway.mjs";

// Offline tests for the typed tool (#53): the template registry and
// run_alphafold3, driven at the MCP tool-call boundary like the generic
// tools. The fixture registry in test/fixtures/gateway/templates/ is a
// synthetic template shaped like the probed production one (fixed gpu
// partition/gres, XLA_FLAGS, singularity binds, one fold_input.json) but
// carrying generic paths — the real template is institutional and never
// enters git (ADR 0004). What is asserted is external behavior only:
// tool results over the wire, files in the staging root, the audit JSONL,
// and the argv the stub sbatch received.

const templatesDir = fileURLToPath(new URL("fixtures/gateway/templates", import.meta.url));

// One AF3-native fold input, the dialect S0 confirmed on the cluster.
const foldInput = {
	name: "demo-complex",
	sequences: [
		{ type: "protein", id: "A", sequence: "MTEYKLVVVGAGGVGKSALTIQLIQNHFVDEYDPTIEDSYRKQV" },
		{ type: "ligand", id: "L", ccd: "ATP" },
	],
	modelSeeds: [1],
	dialect: "alphafold3",
	version: 1,
};

const withTemplates = { THETA_COMPUTE_TEMPLATES: templatesDir };

test("with a template registry configured, tools/list adds run_alphafold3 behind the destructive hint", { skip: skipReason }, async (t) => {
	const gateway = await startGateway(t, { env: withTemplates });

	const result = await gateway.request("tools/list", {});
	const typed = result.tools.find((tool) => tool.name === "run_alphafold3");
	assert.ok(typed, "the typed tool is registered");
	// It spends GPU time like submit_job — the theta-side submit gate
	// (S4) confirms it; the destructive hint is what reaches that gate.
	assert.equal(typed.annotations?.readOnlyHint, false);
	assert.equal(typed.annotations?.destructiveHint, true);
});

test("without a templates directory the typed tool stays unregistered", { skip: skipReason }, async (t) => {
	const gateway = await startGateway(t);

	const result = await gateway.request("tools/list", {});
	const names = result.tools.map((tool) => tool.name);
	assert.equal(names.includes("run_alphafold3"), false, "no registry configured, no typed tool");
});

test("a broken registry refuses to boot, naming the cause", { skip: skipReason }, async (t) => {
	// Each case is one scratch templates directory; the gateway must exit
	// 1 with a ConfigError that names what is wrong — never boot half a
	// registry.
	const goodScript = await readFile(path.join(templatesDir, "alphafold3.sbatch"), "utf8");
	const cases = [
		{
			name: "no registry.json",
			files: {},
			refuses: /registry\.json is missing/,
		},
		{
			name: "registry.json is not valid JSON",
			files: { "registry.json": "{not json" },
			refuses: /not valid JSON/,
		},
		{
			name: "registry.json is not a mapping",
			files: { "registry.json": "[]" },
			refuses: /must map template names/,
		},
		{
			name: "the registered script does not exist",
			files: { "registry.json": JSON.stringify({ alphafold3: { script: "gone.sbatch", free: ["RUN_DIR", "JOB_NAME"], input_file: "af_input/fold_input.json", output_dir: "af_output" } }) },
			refuses: /gone\.sbatch.*does not exist/,
		},
		{
			name: "the script carries an undeclared token",
			files: {
				"registry.json": JSON.stringify({ alphafold3: { script: "t.sbatch", free: ["RUN_DIR", "JOB_NAME"], input_file: "af_input/fold_input.json", output_dir: "af_output" } }),
				"t.sbatch": goodScript.replace("{{RUN_DIR}}/af_output", "{{GPU_COUNT}}/af_output"),
			},
			refuses: /undeclared token GPU_COUNT/,
		},
		{
			name: "a declared free variable never appears in the script",
			files: {
				"registry.json": JSON.stringify({ alphafold3: { script: "t.sbatch", free: ["RUN_DIR", "JOB_NAME"], input_file: "af_input/fold_input.json", output_dir: "af_output" } }),
				"t.sbatch": "#!/bin/bash\n#SBATCH --job-name={{JOB_NAME}}\nsleep 1\n",
			},
			refuses: /declares RUN_DIR but t\.sbatch never carries its token/,
		},
		{
			name: "a free variable outside the vocabulary",
			files: {
				"registry.json": JSON.stringify({ alphafold3: { script: "t.sbatch", free: ["PARTITION"], input_file: "af_input/fold_input.json", output_dir: "af_output" } }),
				"t.sbatch": "#!/bin/bash\n#SBATCH --partition={{PARTITION}}\nsleep 1\n",
			},
			refuses: /free variable 'PARTITION'.*vocabulary is RUN_DIR and JOB_NAME/,
		},
		{
			name: "input_file escapes the run directory",
			files: {
				"registry.json": JSON.stringify({ alphafold3: { script: "t.sbatch", free: ["JOB_NAME"], input_file: "../outside.json", output_dir: "af_output" } }),
				"t.sbatch": "#!/bin/bash\n#SBATCH --job-name={{JOB_NAME}}\nsleep 1\n",
			},
			refuses: /input_file.*inside the run directory/,
		},
		{
			name: "the registry registers no alphafold3",
			files: {
				"registry.json": JSON.stringify({ boltz: { script: "t.sbatch", free: ["RUN_DIR"], input_file: "in.json", output_dir: "out" } }),
				"t.sbatch": "cd {{RUN_DIR}}\n",
			},
			refuses: /registers no alphafold3/,
		},
	];

	for (const testCase of cases) {
		const scratch = await mkdtemp(path.join(tmpdir(), "theta-templates-"));
		t.after(() => rm(scratch, { recursive: true, force: true }));
		for (const [name, content] of Object.entries(testCase.files)) {
			await writeFile(path.join(scratch, name), content, "utf8");
		}
		const { code, stderr } = await startGatewayExit(t, { env: { THETA_COMPUTE_TEMPLATES: scratch } });
		assert.equal(code, 1, `${testCase.name}: exit 1`);
		assert.match(stderr, /theta-compute: /, `${testCase.name}: the failure names itself`);
		assert.match(stderr, testCase.refuses, `${testCase.name}: the refusal says why`);
	}
});

test("run_alphafold3 stages the validated input, renders free variables only, and submits", { skip: skipReason }, async (t) => {
	const gateway = await startGateway(t, { env: withTemplates });
	const runDir = path.join(gateway.stagingRoot, "af3-demo");

	const result = await gateway.callTool("run_alphafold3", { run_name: "af3-demo", fold_input: foldInput });
	assert.equal(result.isError, false);
	assert.deepEqual(result.structuredContent, {
		job_id: "777001",
		job_name: "theta-test-user-af3-demo",
		script_path: path.join(runDir, "alphafold3.sbatch"),
		fold_input_path: path.join(runDir, "af_input", "fold_input.json"),
		output_dir: path.join(runDir, "af_output"),
	});

	// The staged fold input is the canonical serialization — sorted keys,
	// no whitespace — the same bytes the audit digest covers.
	const staged = await readFile(path.join(runDir, "af_input", "fold_input.json"), "utf8");
	assert.equal(staged, JSON.stringify(canonicalJson(foldInput)));

	// The output directory exists before submission: the template binds
	// it, and the bind needs the host directory.
	assert.equal(await exists(path.join(runDir, "af_output")), true, "the output directory was created");

	// The rendered script: every free variable substituted, the job name
	// gateway-forced to the ownership prefix, everything else the
	// template's own fixed text.
	const script = await readFile(path.join(runDir, "alphafold3.sbatch"), "utf8");
	assert.ok(script.includes("#SBATCH --job-name=theta-test-user-af3-demo"), "the ownership prefix is forced into the job name");
	assert.ok(script.includes(`cd ${runDir}`), "the run directory is rendered absolute");
	assert.ok(script.includes(`--bind ${runDir}/af_input:/root/af_input`), "the input bind renders the run directory");
	assert.ok(script.includes("#SBATCH --partition=gpu"), "the partition stays template-fixed");
	assert.ok(script.includes("#SBATCH --gres=gpu:1"), "the gres stays template-fixed");
	assert.ok(!script.includes("{{"), "no token survives the render");

	// sbatch received the rendered file path and nothing else.
	const calls = await readArgvCalls(gateway.argvLog);
	assert.deepEqual(calls, [{ program: "sbatch", args: [path.join(runDir, "alphafold3.sbatch")] }]);

	const audit = await readAudit(gateway.auditLog);
	assert.equal(audit.length, 1);
	// The minted job id rides the audit line, exactly as submit_job's.
	assertAuditLine(audit[0], {
		user: "test-user",
		tool: "run_alphafold3",
		args_sha256: argumentDigest({ run_name: "af3-demo", fold_input: foldInput }),
		decision: "ALLOW",
		job_id: "777001",
		reason: null,
		submit_capability: "on",
	});
});

test("while the submit capability is off, run_alphafold3 holds like submit_job", { skip: skipReason }, async (t) => {
	const gateway = await startGateway(t, {
		env: { ...withTemplates, THETA_COMPUTE_SUBMIT_CAPABILITY: "off" },
	});
	const args = { run_name: "af3-demo", fold_input: foldInput };

	const held = await gateway.callTool("run_alphafold3", args);
	assert.equal(held.isError, true);
	assert.match(toolText(held), /the submit capability is off/);

	// The hold is pre-dispatch: nothing staged, nothing submitted.
	assert.equal(await exists(path.join(gateway.stagingRoot, "af3-demo")), false, "no run directory written");
	assert.deepEqual(await readArgv(gateway.argvLog), []);

	const audit = await readAudit(gateway.auditLog);
	assert.equal(audit.length, 1);
	assertAuditLine(audit[0], {
		user: "test-user",
		tool: "run_alphafold3",
		args_sha256: argumentDigest(args),
		decision: "HOLD",
		job_id: null,
		reason: HELD_REASON,
		submit_capability: "off",
	});
});

test("run_alphafold3 refuses malformed fold input at the guard", { skip: skipReason }, async (t) => {
	const gateway = await startGateway(t, { env: withTemplates });
	const attacks = [
		{ name: "not an object", fold_input: "MTEYK", refuses: /expected a JSON object/ },
		{ name: "empty name", fold_input: { ...foldInput, name: "" }, refuses: /name must be a non-empty string/ },
		{ name: "no sequences", fold_input: { ...foldInput, sequences: [] }, refuses: /sequences must be a non-empty list/ },
		{ name: "wrong dialect", fold_input: { ...foldInput, dialect: "boltz" }, refuses: /dialect must be "alphafold3"/ },
		{ name: "wrong version", fold_input: { ...foldInput, version: 2 }, refuses: /version must be 1/ },
		{ name: "seeds not integers", fold_input: { ...foldInput, modelSeeds: [true] }, refuses: /modelSeeds must be a list of integers/ },
		{ name: "bad run name", fold_input: foldInput, run_name: "no spaces", refuses: /run name/ },
	];

	for (const attack of attacks) {
		const result = await gateway.callTool("run_alphafold3", {
			run_name: attack.run_name ?? "af3-demo",
			fold_input: attack.fold_input,
		});
		assert.equal(result.isError, true, `${attack.name}: refused`);
		assert.match(toolText(result), attack.refuses, `${attack.name}: the refusal says why`);
	}

	// Nothing was staged and nothing was submitted.
	assert.equal(await exists(path.join(gateway.stagingRoot, "af3-demo")), false, "no run directory written");
	assert.deepEqual(await readArgv(gateway.argvLog), []);

	const audit = await readAudit(gateway.auditLog);
	assert.equal(audit.length, attacks.length, "one DENY line per refused call");
	for (const line of audit) {
		assert.equal(line.decision, "DENY");
		assert.equal(line.tool, "run_alphafold3");
		assert.equal(line.job_id, null);
	}
});

test("override attempts are refused — partition, gres, and binds are template-fixed", { skip: skipReason }, async (t) => {
	const gateway = await startGateway(t, { env: withTemplates });
	const attacks = [
		{ name: "partition", extra: { partition: "cpu" } },
		{ name: "gres", extra: { gres: "gpu:2" } },
		{ name: "directives", extra: { directives: { partition: "gpu" } } },
	];

	for (const attack of attacks) {
		const result = await gateway.callTool("run_alphafold3", {
			run_name: "af3-demo",
			fold_input: foldInput,
			...attack.extra,
		});
		assert.equal(result.isError, true, `${attack.name}: refused`);
		assert.match(
			toolText(result),
			/fixed by the template/,
			`${attack.name}: the refusal names the fixed contract`,
		);
	}

	assert.deepEqual(await readArgv(gateway.argvLog), [], "nothing was submitted");
	const audit = await readAudit(gateway.auditLog);
	assert.equal(audit.length, attacks.length, "one DENY line per override attempt");
	for (const line of audit) {
		assert.equal(line.decision, "DENY");
		assert.equal(line.tool, "run_alphafold3");
	}
});
