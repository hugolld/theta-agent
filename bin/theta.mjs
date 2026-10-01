#!/usr/bin/env node
// theta — launch pi with the Theta package preloaded (M1 stage A, decision T9).
// Thin wrapper: resolve the package source, find pi, exec `pi -e <source> …`.

import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const pkgRoot = fileURLToPath(new URL('..', import.meta.url));

const args = process.argv.slice(2);

if (args[0] === '-h' || args[0] === '--help') {
	const usage = [
		'theta — launch pi with the Theta package preloaded',
		'',
		'Usage: theta [--dev] [pi arguments…]',
		'',
		'  --dev   load Theta from the current directory instead of the installed package',
		'  -h      show this help',
		'',
		'Anything else is passed through to pi untouched.',
	].join('\n');
	console.log(usage);
	process.exit(0);
}

let source = pkgRoot;
if (args[0] === '--dev') {
	args.shift();
	source = process.cwd();
}

const piBin = process.platform === 'win32' ? 'pi.cmd' : 'pi';
const probe = spawnSync(piBin, ['--version'], { encoding: 'utf8' });
if (probe.error) {
	console.error('pi not found. Install it with: npm install -g @earendil-works/pi-coding-agent');
	process.exit(1);
}

// Warn (but continue) when pi is older than Theta's target version.
const versionMatch = /(\d+)\.(\d+)\.(\d+)/.exec(probe.stdout);
if (versionMatch) {
	const [major, minor] = versionMatch.slice(1).map(Number);
	if (major === 0 && minor < 99) {
		console.warn(
			`warning: found pi ${versionMatch[0]}, but Theta targets pi >= 0.99 — continuing; some features may misbehave`,
		);
	}
}

const result = spawnSync(piBin, ['-e', source, ...args], { stdio: 'inherit' });
process.exit(result.status ?? 1);
