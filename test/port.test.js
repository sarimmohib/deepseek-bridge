/*
 * Regression tests for the "bridge moved its own port" failure.
 *
 * `ds-bridge.js` used to answer EADDRINUSE by binding port+1, port+2, ... and
 * then SAVING the new port to config.json. The saved port is what dsh (its
 * `baseURL`), the dashboard proxy and the remote stack read, so a restart that
 * raced the old listener left the bridge healthy on 8789 while every client
 * kept dialling 8787 and reported a transport error. These tests pin the new
 * contract: the saved port is authoritative, a busy port is a loud failure,
 * an already-running bridge is an idempotent no-op, and the opt-in
 * `--port-next` fallback is never persisted.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BRIDGE = path.join(ROOT, 'bin', 'ds-bridge.js');

function tempHome(label) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsb-port-' + label + '-'));
  fs.writeFileSync(
    path.join(home, 'config.json'),
    JSON.stringify({ key: 'sk-ds-test-port', port: 8787, autoUpdate: false, systemPreset: 'none' }),
  );
  return home;
}

function setPort(home, port) {
  const file = path.join(home, 'config.json');
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...cfg, port }));
}

function readPort(home) {
  return JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8')).port;
}

function env(home) {
  return { ...process.env, DS_BRIDGE_HOME: home, DEEPSEEK_NO_UPDATE: '1' };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function occupy(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

async function health(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(700) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

async function waitForHealth(port, ms = 12000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const found = await health(port);
    if (found) return found;
    await new Promise((r) => setTimeout(r, 150));
  }
  return null;
}

function runBridge(home, args, timeout = 16000) {
  return spawnSync(process.execPath, [BRIDGE].concat(args || []), {
    cwd: ROOT,
    encoding: 'utf8',
    timeout,
    env: env(home),
  });
}

test('a busy saved port fails loudly and is not rewritten', async () => {
  const port = await freePort();
  const blocker = await occupy(port);
  const home = tempHome('busy');
  setPort(home, port);
  try {
    const result = runBridge(home);
    assert.equal(result.status, 1, 'expected exit 1: ' + result.stderr);
    assert.match(result.stderr, /already in use/);
    assert.match(result.stderr, /Refusing to move/);
    assert.doesNotMatch(result.stderr, /trying \d+/);
    assert.equal(readPort(home), port, 'the saved port must be untouched');
  } finally {
    blocker.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('a second bridge on the same port is an idempotent no-op', async () => {
  const port = await freePort();
  const home = tempHome('twin');
  setPort(home, port);

  const first = spawn(process.execPath, [BRIDGE], { cwd: ROOT, env: env(home), stdio: 'ignore' });
  try {
    const ready = await waitForHealth(port);
    assert.ok(ready, 'the first bridge should become healthy');

    const second = runBridge(home, [], 8000);
    assert.equal(second.status, 0, 'expected a clean exit: ' + second.stderr);
    assert.match(second.stderr, /already listening/);

    const still = await health(port);
    assert.ok(still, 'the original bridge keeps serving');
    assert.equal(readPort(home), port);
  } finally {
    first.kill();
    await new Promise((resolve) => {
      if (first.exitCode !== null) return resolve();
      first.once('exit', resolve);
      setTimeout(resolve, 3000);
    });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('--port-next hops for that run only and never saves the new port', async () => {
  const blocked = await freePort();
  const next = blocked + 1;
  if (await health(next)) {
    // Port blocked+1 is already serving something else; skip this pairing.
    return;
  }
  const blocker = await occupy(blocked);
  const home = tempHome('next');
  setPort(home, blocked);

  const child = spawn(process.execPath, [BRIDGE, '--port-next'], {
    cwd: ROOT,
    env: env(home),
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => (stderr += chunk));
  try {
    const ready = await waitForHealth(next);
    assert.ok(ready, 'expected the fallback port to serve: ' + stderr);
    assert.match(stderr, /for this run only/);
    assert.equal(readPort(home), blocked, 'the fallback port must not be persisted');
  } finally {
    child.kill();
    blocker.close();
    await new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.once('exit', resolve);
      setTimeout(resolve, 3000);
    });
    fs.rmSync(home, { recursive: true, force: true });
  }
});
