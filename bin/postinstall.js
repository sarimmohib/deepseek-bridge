#!/usr/bin/env node
/*
 * npm postinstall hook.
 *
 * A global `npm install -g .` is the moment the user is thinking about setup,
 * so offer the wizard there. It is strictly best-effort: non-interactive
 * installs (CI, piped output) only get a hint, and the hook never fails the
 * install. Set DEEPSEEK_NO_SETUP=1 to suppress it entirely.
 */
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, 'deepseek.js');
const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
const skip = process.env.DEEPSEEK_NO_SETUP === '1' || process.env.CI === 'true' || process.env.CI === '1';

if (!interactive || skip) {
  console.log('');
  console.log('  deepseek-bridge is installed.');
  console.log('  Run `deepseek install` to add Git, Tailscale, dsh or autostart.');
  console.log('');
  process.exit(0);
}

const child = spawn(process.execPath, [CLI, 'install'], { stdio: 'inherit' });
child.on('error', () => process.exit(0));
child.on('exit', () => process.exit(0));
