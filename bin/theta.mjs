#!/usr/bin/env node
// theta — launch pi with the Theta package preloaded (M1 stage A, decision T9).
// Thin wrapper: resolve the package source, find pi, exec `pi -e <source> …`.

import { spawn, spawnSync } from 'node:child_process';
import { constants as osConstants } from 'node:os';
import process from 'node:process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const pkgRoot = fileURLToPath(new URL('..', import.meta.url));

const args = process.argv.slice(2);

if (args[0] === '-h' || args[0] === '--help') {
	const usage = [
		'theta — launch pi with the Theta package preloaded',
		'',
		'Usage: theta [--dev] [pi arguments…]',
		'',
		'  --dev   load Theta from a local checkout: the launcher\'s own repo (when run',
		'          from a source checkout) or the directory named by $THETA_DEV_ROOT',
		'  -h      show this help',
		'',
		'Anything else is passed through to pi untouched.',
	].join('\n');
	console.log(usage);
	process.exit(0);
}

// Windows is deferred to milestone M8. pi ships as pi.cmd there, which cannot be
// spawned by Node without a shell; fail with guidance instead of an EINVAL crash.
if (process.platform === 'win32') {
	console.error('theta does not support Windows yet (planned for milestone M8).');
	process.exit(1);
}

let source = pkgRoot;
if (args[0] === '--dev') {
	args.shift();
	// --dev must only load a Theta checkout the *user* vouched for, never an
	// arbitrary cwd: pi loads explicit -e sources without trust gating, so an
	// in-band check (e.g. a package.json name inside cwd) is spoofable by any
	// repository telling users to run `theta --dev`. Two out-of-band anchors:
	//  1. cwd is the launcher's own checkout (running bin/theta.mjs from the
	//     source repo — the canonical dogfood path), or
	//  2. cwd matches $THETA_DEV_ROOT, a path the user configured themselves.
	const cwd = process.cwd();
	const devRoot = process.env.THETA_DEV_ROOT;
	const samePath = (a, b) => {
		try {
			return realpathSync(a) === realpathSync(b);
		} catch {
			return false;
		}
	};
	const fromOwnCheckout = samePath(cwd, pkgRoot);
	const fromEnvAnchor = devRoot !== undefined && samePath(cwd, devRoot);
	if (!fromOwnCheckout && !fromEnvAnchor) {
		console.error(
			'--dev loads a local Theta checkout only from this checkout itself, or when the current directory matches $THETA_DEV_ROOT. Set THETA_DEV_ROOT to your theta-agent checkout to use --dev elsewhere.',
		);
		process.exit(1);
	}
	source = cwd;
}

// pi management commands parse only when they are the first token; prepending
// `-e <source>` would turn them into an agent prompt. Pass them through as-is.
const MANAGEMENT_COMMANDS = new Set([
	'install',
	'remove',
	'uninstall',
	'update',
	'list',
	'config',
	'auth',
	'mcp',
]);
const isManagementCommand = args.length > 0 && MANAGEMENT_COMMANDS.has(args[0]);

const piBin = 'pi';
const piArgs = isManagementCommand ? args : ['-e', source, ...args];

const probe = spawnSync(piBin, ['--version'], { encoding: 'utf8' });
if (probe.error) {
	reportSpawnFailure(probe.error);
	process.exit(1);
}

// Warn (but continue) when pi is older than Theta's target version (0.99.0).
// SemVer precedence: a prerelease like 0.99.0-rc.1 sorts below the 0.99.0 release.
const versionMatch = /(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(probe.stdout);
if (versionMatch) {
	const major = Number(versionMatch[1]);
	const minor = Number(versionMatch[2]);
	const patch = Number(versionMatch[3]);
	const hasPrerelease = versionMatch[4] !== undefined;
	const belowTarget =
		major === 0 && (minor < 99 || (minor === 99 && patch === 0 && hasPrerelease));
	if (belowTarget) {
		console.warn(
			`warning: found pi ${versionMatch[0]}, but Theta targets pi >= 0.99 — continuing; some features may misbehave`,
		);
	}
}

// Launch pi asynchronously so launcher-directed signals reach the child instead
// of killing theta and orphaning pi.
const child = spawn(piBin, piArgs, { stdio: 'inherit' });
child.on('error', (err) => {
	reportSpawnFailure(err);
	process.exit(1);
});

// Forward catchable termination signals aimed at theta to pi, then mirror pi's
// own exit once it terminates.
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
	process.on(signal, () => {
		if (!child.killed) child.kill(signal);
	});
}
process.on('SIGPIPE', () => {
	// theta's stdout/stderr are pi's; ignore SIGPIPE and let pi decide.
});

child.on('close', (code, signal) => {
	if (signal) {
		// Match the shell convention: a signal death exits 128 + signal number.
		process.exit(128 + signalNumberOf(signal));
	}
	process.exit(code ?? 1);
});

function signalNumberOf(signal) {
	const name = signal.startsWith('SIG') ? signal : `SIG${signal}`;
	const number = osConstants.signals[name];
	return typeof number === 'number' ? number : 1;
}

// Shared by the pi probe and the async launch: one ENOENT story, one
// everything-else story.
function reportSpawnFailure(err) {
	if (err.code === 'ENOENT') {
		console.error('pi not found. Install it with: npm install -g @earendil-works/pi-coding-agent');
	} else {
		console.error(`failed to run pi (${piBin}): ${err.message}`);
	}
}
