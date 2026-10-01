// Tests for bin/theta.mjs — the theta launcher.
// Seams under test (agreed up front): launch, --dev, exit-code propagation,
// help, pi-missing (ENOENT), and the pi version guard.
// The "pi" binary is stubbed with a /bin/sh script on a controlled PATH.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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

function runTheta(args, { pathDir, cwd, record } = {}) {
	const env = { ...process.env };
	if (pathDir) env.PATH = pathDir;
	if (record) env.PI_STUB_RECORD = record;
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

test('launch seam: --dev drops the flag and uses the cwd as the -e source', { skip: skipOnWindows }, (t) => {
	const binDir = makeStubPiDir('pi 0.99.2');
	t.after(() => rmSync(binDir, { recursive: true, force: true }));
	const record = join(binDir, 'record.txt');
	const devCwd = mkdtempSync(join(tmpdir(), 'theta-test-cwd-'));
	t.after(() => rmSync(devCwd, { recursive: true, force: true }));

	const result = runTheta(['--dev', 'prompt.txt'], { pathDir: binDir, record, cwd: devCwd });

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
