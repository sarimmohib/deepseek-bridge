/*
 * Regression tests for the "bridge keeps terminating" bug class.
 *
 * Two independent causes were found and fixed:
 *   1. Store.flush() ran inside setInterval and threw on a failed write. An
 *      exception escaping a timer callback is an uncaught exception and kills
 *      the process (exit 1, nothing useful in bridge.log).
 *   2. A non-numeric --port was persisted as NaN -> JSON null, and the next
 *      start called server.listen(NaN) -> ERR_SOCKET_BAD_PORT at startup.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BRIDGE = path.join(ROOT, 'bin', 'ds-bridge.js');
const BAD_FILE = process.platform === 'win32' ? 'Z:/definitely/not/here/state.json' : '/definitely/not/here/state.json';

function tempHome(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsb-resilience-' + label + '-'));
}

function runBridge(home, args, timeout) {
  return spawnSync(process.execPath, [BRIDGE].concat(args || []), {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: timeout || 20000,
    env: { ...process.env, DS_BRIDGE_HOME: home, DEEPSEEK_NO_UPDATE: '1' },
  });
}

test('a failed autosave write is reported and retried instead of killing the process', async () => {
  process.env.DS_BRIDGE_HOME = tempHome('flush');
  const { Store } = await import('../src/config.js');
  const store = new Store();
  store.setConversation('key-1', { turns: 1 });
  store.file = BAD_FILE;

  let errors = 0;
  store.onFlushError = () => {
    errors++;
  };
  store.startAutosave(20);

  // Before the fix the first tick threw out of the timer callback and exited.
  await new Promise((resolve) => setTimeout(resolve, 150));

  assert.ok(errors > 0, 'the failure was surfaced through onFlushError');
  assert.equal(store.dirty, true, 'the store stays dirty so the next tick retries');
  assert.ok(store.lastFlushError, 'the last error is recorded');
  assert.equal(store.flush(), false, 'flush reports failure instead of throwing');
});

test('a throwing onFlushError observer cannot escape the autosave timer', async () => {
  process.env.DS_BRIDGE_HOME = tempHome('timer');
  const { Store } = await import('../src/config.js');
  const store = new Store();
  store.setConversation('key-2', { turns: 1 });
  store.file = BAD_FILE;
  store.onFlushError = () => {
    throw new Error('observer blew up');
  };
  store.startAutosave(20);
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.ok(true, 'reached the end without an uncaught exception');
});

test('an invalid --port is rejected without corrupting the config', () => {
  const home = tempHome('badport');
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ key: 'sk-ds-test', port: 8787 }));

  const result = runBridge(home, ['--port', 'abc']);
  assert.equal(result.status, 2, 'expected exit 2, got ' + result.status + ': ' + result.stderr);
  assert.match(result.stderr, /invalid --port/);
  assert.doesNotMatch(result.stderr, /ERR_SOCKET_BAD_PORT/);

  const saved = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
  assert.equal(saved.port, 8787, 'the previous good port is preserved');
});

test('out-of-range ports are rejected', () => {
  const home = tempHome('rangeport');
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ key: 'sk-ds-test', port: 8787 }));
  for (const bad of ['0', '70000', '-1']) {
    const result = runBridge(home, ['--port', bad]);
    assert.equal(result.status, 2, '--port ' + bad + ' should be rejected');
    assert.match(result.stderr, /invalid --port/);
  }
});

test('a config holding a null port still starts instead of throwing ERR_SOCKET_BAD_PORT', () => {
  const home = tempHome('nullport');
  // Exactly what the old bug persisted: Number('abc') is NaN, JSON writes null.
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ key: 'sk-ds-test', port: null }));

  // The bridge keeps running, so the timeout ends it; the regression is that it
  // reaches "listening" instead of throwing during listen().
  const result = runBridge(home, ['--port', '8795'], 4000);
  assert.doesNotMatch(result.stderr || '', /ERR_SOCKET_BAD_PORT|RangeError/);
  assert.match(result.stderr || '', /listening on http:\/\/127\.0\.0\.1:8795/);
});

test('the daemon installs uncaughtException and unhandledRejection guards', () => {
  const source = fs.readFileSync(BRIDGE, 'utf8');
  assert.match(source, /process\.on\('uncaughtException'/);
  assert.match(source, /process\.on\('unhandledRejection'/);
});
