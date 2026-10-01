// Tests for bin/theta.mjs — the theta launcher.
// Seams under test (agreed up front): launch, --dev, exit-code propagation,
// help, pi-missing (ENOENT), and the pi version guard.
// The "pi" binary is stubbed with a /bin/sh script on a controlled PATH.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import process from 'node:process';
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const launcher = join(root, 'bin', 'theta.mjs');
const skipOnWindows = process.platform === 'win32';

function makeStubPiDir(version, exitCode = 0) {
	const dir = mkdtempSync(join(tmpdir(), 'theta-test-bin-'));
	const script = [
		'#!/bin/sh',
		'if [ "$1" = "--version" ]; then',
		`  echo "${version}"`,
		'  exit 0',
		'fi',
		'printf \'%s\\n\' "$@" > "$PI_STUB_RECORD"',
		`exit ${exitCode}`,
	].join('\n');
	writeFileSync(join(dir, 'pi'), script, { mode: 0o755 });
	chmodSync(join(dir, 'pi'), 0o755);
	return dir;
}

function makeEmptyDir() {
	return mkdtempSync(join(tmpdir(), 'theta-test-empty-'));
}

function runTheta(args, { pathDir, cwd, record, env: extraEnv } = {}) {
	const env = { ...process.env };
	if (pathDir) env.PATH = pathDir;
	if (record) env.PI_STUB_RECORD = record;
	if (extraEnv) Object.assign(env, extraEnv);
	return spawnSync(process.execPath, [launcher, ...args], {
		encoding: 'utf8',
		env,
		cwd,
	});
}

function recordedArgs(record) {
	return readFileSync(record, 'utf8')
		.split('\n')
		.filter((line) => line.length > 0);
}

// macOS resolves /var → /private/var in the child's cwd; normalize path-like
// args on both sides so expected and recorded values compare equal.
function normalizeArg(arg) {
	if (arg.startsWith('/') && existsSync(arg)) return realpathSync(arg);
	return arg;
}

test('launch seam: runs pi -e <pkgRoot> and passes remaining args through untouched', { skip: skipOnWindows }, (t) => {
	const binDir = makeStubPiDir('pi 0.99.2');
	t.after(() => rmSync(binDir, { recursive: true, force: true }));
	const record = join(binDir, 'record.txt');

	const result = runTheta(['hello.txt', '--flag', 'x'], { pathDir: binDir, record });

	assert.equal(result.status, 0, `stderr: ${result.stderr}`);
	assert.deepEqual(recordedArgs(record).map(normalizeArg), ['-e', root, 'hello.txt', '--flag', 'x'].map(normalizeArg));
});

// A minimal theta-agent checkout fixture for --dev tests.
function makeDevCheckout() {
	const dir = mkdtempSync(join(tmpdir(), 'theta-test-dev-'));
	writeFileSync(
		join(dir, 'package.json'),
		JSON.stringify({ name: 'theta-agent', version: '0.0.2' }, null, '\t'),
	);
	return dir;
}

test('launch seam: --dev from the launcher\'s own checkout uses the cwd as the -e source', { skip: skipOnWindows }, (t) => {
	const binDir = makeStubPiDir('pi 0.99.2');
	t.after(() => rmSync(binDir, { recursive: true, force: true }));
	const record = join(binDir, 'record.txt');

	// cwd = repo root (where bin/theta.mjs lives) is the canonical dev path.
	const result = runTheta(['--dev', 'prompt.txt'], { pathDir: binDir, record, cwd: root });

	assert.equal(result.status, 0, `stderr: ${result.stderr}`);
	assert.deepEqual(recordedArgs(record).map(normalizeArg), ['-e', root, 'prompt.txt'].map(normalizeArg));
});

test('launch seam: --dev in a directory matching $THETA_DEV_ROOT is allowed', { skip: skipOnWindows }, (t) => {
	const binDir = makeStubPiDir('pi 0.99.2');
	t.after(() => rmSync(binDir, { recursive: true, force: true }));
	const record = join(binDir, 'record.txt');
	const devCwd = makeDevCheckout();
	t.after(() => rmSync(devCwd, { recursive: true, force: true }));

	const result = runTheta(['--dev', 'prompt.txt'], { pathDir: binDir, record, cwd: devCwd, env: { THETA_DEV_ROOT: devCwd } });

	assert.equal(result.status, 0, `stderr: ${result.stderr}`);
	assert.deepEqual(recordedArgs(record).map(normalizeArg), ['-e', devCwd, 'prompt.txt'].map(normalizeArg));
});

test('launch seam: exits with the exit code of the spawned pi', { skip: skipOnWindows }, (t) => {
	const binDir = makeStubPiDir('pi 0.99.2', 3);
	t.after(() => rmSync(binDir, { recursive: true, force: true }));

	const result = runTheta([], { pathDir: binDir });

	assert.equal(result.status, 3);
});

test('help seam: --help prints usage, exits 0, and never spawns pi', { skip: skipOnWindows }, (t) => {
	const emptyDir = makeEmptyDir();
	t.after(() => rmSync(emptyDir, { recursive: true, force: true }));

	for (const flag of ['--help', '-h']) {
		const result = runTheta([flag], { pathDir: emptyDir });
		assert.equal(result.status, 0, `flag ${flag}: ${result.stderr}`);
		assert.match(result.stdout, /theta/i);
		assert.match(result.stdout, /--dev/i);
	}
});

test('ENOENT seam: with no pi on PATH, prints the exact install message and exits 1', { skip: skipOnWindows }, (t) => {
	const emptyDir = makeEmptyDir();
	t.after(() => rmSync(emptyDir, { recursive: true, force: true }));

	const result = runTheta(['anything'], { pathDir: emptyDir });

	assert.equal(result.status, 1);
	assert.equal(
		result.stderr.trim(),
		'pi not found. Install it with: npm install -g @earendil-works/pi-coding-agent',
	);
});

test('ENOENT seam: a non-executable pi on PATH reports the spawn error, not "not found"', { skip: skipOnWindows }, (t) => {
	const binDir = mkdtempSync(join(tmpdir(), 'theta-test-bin-'));
	t.after(() => rmSync(binDir, { recursive: true, force: true }));
	// Exists but lacks the exec bit → spawnSync fails with EACCES, not ENOENT.
	writeFileSync(join(binDir, 'pi'), '#!/bin/sh\nexit 0\n', { mode: 0o644 });

	const result = runTheta(['anything'], { pathDir: binDir });

	assert.equal(result.status, 1);
	assert.match(result.stderr, /failed to run pi/i);
	assert.doesNotMatch(result.stderr, /pi not found/);
});

test('version-guard seam: pi below 0.99.0 warns on stderr but still launches', { skip: skipOnWindows }, (t) => {
	const binDir = makeStubPiDir('pi 0.98.4');
	t.after(() => rmSync(binDir, { recursive: true, force: true }));
	const record = join(binDir, 'record.txt');

	const result = runTheta(['task'], { pathDir: binDir, record });

	assert.equal(result.status, 0, `stderr: ${result.stderr}`);
	assert.match(result.stderr, /warning/i);
	assert.match(result.stderr, /0\.99/);
	assert.deepEqual(recordedArgs(record).map(normalizeArg), ['-e', root, 'task'].map(normalizeArg));
});

test('version-guard seam: pi at or above 0.99.0 launches with no warning', { skip: skipOnWindows }, (t) => {
	const binDir = makeStubPiDir('pi 0.99.2');
	t.after(() => rmSync(binDir, { recursive: true, force: true }));
	const record = join(binDir, 'record.txt');

	const result = runTheta(['task'], { pathDir: binDir, record });

	assert.equal(result.status, 0, `stderr: ${result.stderr}`);
	assert.equal(result.stderr, '');
	assert.deepEqual(recordedArgs(record).map(normalizeArg), ['-e', root, 'task'].map(normalizeArg));
});

test('version-guard seam: a 0.99.0 prerelease (e.g. 0.99.0-rc.1) warns — SemVer places it below 0.99.0', { skip: skipOnWindows }, (t) => {
	const binDir = makeStubPiDir('pi 0.99.0-rc.1');
	t.after(() => rmSync(binDir, { recursive: true, force: true }));
	const record = join(binDir, 'record.txt');

	const result = runTheta(['task'], { pathDir: binDir, record });

	assert.equal(result.status, 0, `stderr: ${result.stderr}`);
	assert.match(result.stderr, /warning/i);
	assert.match(result.stderr, /0\.99\.0-rc\.1/);
});

test('management-command seam: pi management commands run without the -e preload', { skip: skipOnWindows }, (t) => {
	const binDir = makeStubPiDir('pi 0.99.2');
	t.after(() => rmSync(binDir, { recursive: true, force: true }));
	const record = join(binDir, 'record.txt');

	const result = runTheta(['list'], { pathDir: binDir, record });

	assert.equal(result.status, 0, `stderr: ${result.stderr}`);
	assert.deepEqual(recordedArgs(record), ['list']);
});

test('management-command seam: every documented pi management command is passed through', { skip: skipOnWindows }, (t) => {
	const binDir = makeStubPiDir('pi 0.99.2');
	t.after(() => rmSync(binDir, { recursive: true, force: true }));

	for (const command of ['install', 'remove', 'uninstall', 'update', 'list', 'config', 'auth', 'mcp']) {
		const record = join(binDir, `record-${command}.txt`);
		const result = runTheta([command, '--flag', 'x'], { pathDir: binDir, record });
		assert.equal(result.status, 0, `command ${command}: ${result.stderr}`);
		assert.deepEqual(recordedArgs(record), [command, '--flag', 'x']);
	}
});

test('management-command seam: --dev before a management command still drops --dev and passes the command through', { skip: skipOnWindows }, (t) => {
	const binDir = makeStubPiDir('pi 0.99.2');
	t.after(() => rmSync(binDir, { recursive: true, force: true }));
	const record = join(binDir, 'record.txt');

	const result = runTheta(['--dev', 'list'], { pathDir: binDir, record });

	assert.equal(result.status, 0, `stderr: ${result.stderr}`);
	assert.deepEqual(recordedArgs(record), ['list']);
});

test('signal seam: pi dying by signal exits 128 + signal number', { skip: skipOnWindows }, (t) => {
	const binDir = mkdtempSync(join(tmpdir(), 'theta-test-bin-'));
	t.after(() => rmSync(binDir, { recursive: true, force: true }));
	// A stub pi that kills itself with SIGTERM (signal 15) on launch.
	writeFileSync(
		join(binDir, 'pi'),
		['#!/bin/sh', 'if [ "$1" = "--version" ]; then echo "pi 0.99.2"; exit 0; fi', 'kill -TERM $$'].join('\n'),
		{ mode: 0o755 },
	);
	chmodSync(join(binDir, 'pi'), 0o755);

	const result = runTheta([], { pathDir: binDir });

	assert.equal(result.status, 128 + 15, `stderr: ${result.stderr}`);
});

test('signal seam: SIGSEGV death exits 139 and SIGKILL death exits 137 (platform signal numbers)', { skip: skipOnWindows }, (t) => {
	const cases = [
		['SEGV', 11],
		['KILL', 9],
	];
	for (const [sigName, num] of cases) {
		const binDir = mkdtempSync(join(tmpdir(), 'theta-test-bin-'));
		t.after(() => rmSync(binDir, { recursive: true, force: true }));
		writeFileSync(
			join(binDir, 'pi'),
			[
				'#!/bin/sh',
				'if [ "$1" = "--version" ]; then echo "pi 0.99.2"; exit 0; fi',
				`kill -${sigName} $$`,
			].join('\n'),
			{ mode: 0o755 },
		);
		chmodSync(join(binDir, 'pi'), 0o755);

		const result = runTheta([], { pathDir: binDir });

		assert.equal(result.status, 128 + num, `signal ${sigName}: stderr ${result.stderr}`);
	}
});

test('signal-forwarding seam: SIGTERM aimed at theta is forwarded to pi, which exits 143', { skip: skipOnWindows }, async () => {
	const binDir = mkdtempSync(join(tmpdir(), 'theta-test-bin-'));
	rmSync(binDir, { recursive: true, force: true }); // cleanup handled below via promise
	const readyFlag = join(binDir, 'ready');
	const deathReport = join(binDir, 'death.txt');
	mkdirSync(binDir, { recursive: true });
	// A stub pi that announces readiness, waits, and records how it died.
	// /bin-absolute tools because PATH holds only this stub dir.
	writeFileSync(
		join(binDir, 'pi'),
		[
			'#!/bin/sh',
			'if [ "$1" = "--version" ]; then echo "pi 0.99.2"; exit 0; fi',
			'/usr/bin/touch "$READY_FLAG"',
			'trap "echo TERM-handled > \"$DEATH_REPORT\"; exit 143" TERM',
			'while [ ! -f "$DEATH_REPORT" ]; do /bin/sleep 0.05; done',
		].join('\n'),
		{ mode: 0o755 },
	);
	chmodSync(join(binDir, 'pi'), 0o755);

	const env = {
		...process.env,
		PATH: binDir,
		READY_FLAG: readyFlag,
		DEATH_REPORT: deathReport,
	};
	const child = spawn(process.execPath, [launcher], { env });
	try {
		// Wait for pi to be up, then signal theta (the parent) specifically.
		await waitFor(() => existsSync(readyFlag), 5000, 'pi readiness');
		child.kill('SIGTERM');
		const { status, signal } = await closeOf(child);
		assert.equal(status, 143, `theta should mirror pi's TERM exit; signal=${signal}`);
		assert.equal(readFileSync(deathReport, 'utf8').trim(), 'TERM-handled');
	} finally {
		if (!child.killed) child.kill('SIGKILL');
		rmSync(binDir, { recursive: true, force: true });
	}
});

function waitFor(predicate, timeoutMs, what) {
	const start = Date.now();
	return new Promise((resolve, reject) => {
		const tick = () => {
			if (predicate()) return resolve();
			if (Date.now() - start > timeoutMs) return reject(new Error(`timeout waiting for ${what}`));
			setTimeout(tick, 25);
		};
		tick();
	});
}

function closeOf(child) {
	return new Promise((resolve) => child.on('close', (status, signal) => resolve({ status, signal })));
}

test('--dev validation seam: --dev in a foreign directory is rejected even when its manifest spoofs the theta-agent name', { skip: skipOnWindows }, (t) => {
	const binDir = makeStubPiDir('pi 0.99.2');
	t.after(() => rmSync(binDir, { recursive: true, force: true }));
	const foreignDir = mkdtempSync(join(tmpdir(), 'theta-test-spoof-'));
	t.after(() => rmSync(foreignDir, { recursive: true, force: true }));
	// Spoofed manifest: attacker-controlled content claims to be theta-agent.
	writeFileSync(
		join(foreignDir, 'package.json'),
		JSON.stringify({ name: 'theta-agent', version: '0.0.2', pi: { extensions: './extensions' } }, null, '\t'),
	);

	const result = runTheta(['--dev'], { pathDir: binDir, cwd: foreignDir });

	assert.equal(result.status, 1);
	assert.match(result.stderr, /THETA_DEV_ROOT/);
	// The stub record file is only written when pi actually launches.
	assert.ok(!existsSync(join(binDir, 'record.txt')), 'pi must not be launched for a spoofed --dev cwd');
});

test('--dev validation seam: --dev in an unrelated directory without THETA_DEV_ROOT fails with a clear error', { skip: skipOnWindows }, (t) => {
	const binDir = makeStubPiDir('pi 0.99.2');
	t.after(() => rmSync(binDir, { recursive: true, force: true }));
	const emptyDir = makeEmptyDir();
	t.after(() => rmSync(emptyDir, { recursive: true, force: true }));

	const result = runTheta(['--dev'], { pathDir: binDir, cwd: emptyDir });

	assert.equal(result.status, 1);
	assert.match(result.stderr, /THETA_DEV_ROOT/);
});

test('--dev validation seam: THETA_DEV_ROOT pointing elsewhere does not unlock the current directory', { skip: skipOnWindows }, (t) => {
	const binDir = makeStubPiDir('pi 0.99.2');
	t.after(() => rmSync(binDir, { recursive: true, force: true }));
	const elsewhere = makeDevCheckout();
	t.after(() => rmSync(elsewhere, { recursive: true, force: true }));
	const foreignDir = mkdtempSync(join(tmpdir(), 'theta-test-mismatch-'));
	t.after(() => rmSync(foreignDir, { recursive: true, force: true }));

	// cwd does not match THETA_DEV_ROOT → still rejected.
	const result = runTheta(['--dev'], { pathDir: binDir, cwd: foreignDir, env: { THETA_DEV_ROOT: elsewhere } });

	assert.equal(result.status, 1);
	assert.match(result.stderr, /THETA_DEV_ROOT/);
	assert.ok(!existsSync(join(binDir, 'record.txt')), 'pi must not be launched when cwd mismatches the anchor');
});

test('launch-failure seam: pi disappearing between probe and launch reports the spawn error, not silent exit 1', { skip: skipOnWindows }, (t) => {
	const binDir = mkdtempSync(join(tmpdir(), 'theta-test-bin-'));
	t.after(() => rmSync(binDir, { recursive: true, force: true }));
	// A stub pi that deletes itself after answering the version probe, so the
	// launch spawnSync hits ENOENT even though the probe succeeded.
	// /bin/rm is absolute because PATH contains only this stub dir.
	writeFileSync(
		join(binDir, 'pi'),
		['#!/bin/sh', 'if [ "$1" = "--version" ]; then echo "pi 0.99.2"; /bin/rm -f "$0"; exit 0; fi', 'exit 0'].join('\n'),
		{ mode: 0o755 },
	);
	chmodSync(join(binDir, 'pi'), 0o755);

	const result = runTheta(['task'], { pathDir: binDir });

	assert.equal(result.status, 1);
	assert.match(result.stderr, /pi not found|failed to run pi/);
});
