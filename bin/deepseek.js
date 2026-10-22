#!/usr/bin/env node
/*
 * Cross-platform command for deepseek-bridge.
 *
 *   deepseek                 start in the background (or report it is running)
 *   deepseek serve           run in the foreground
 *   deepseek stop            stop the background process
 *   deepseek status          show bridge/extension status
 *   deepseek chat "hello"    send a chat message
 *   deepseek "hello"         shorthand for chat
 *   deepseek --login         copy the browser session (extension or manual)
 *   deepseek --logout        delete the terminal session
 *   deepseek session         show session metadata
 *   deepseek key             print the API key
 *   deepseek extension       print the absolute extension folder
 *   deepseek logs            print the log path and the last lines
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig, paths } from '../src/config.js';
import { clearSession, saveSession, sessionSummary } from '../src/session.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = path.join(HERE, 'ds-bridge.js');
const CHAT = path.join(HERE, 'ds-chat.js');
const EXTENSION = path.resolve(HERE, '..', 'extension');
const LOG = path.join(paths.CONFIG_DIR, 'bridge.log');

const args = process.argv.slice(2);
const first = args[0];
const known = new Set(['start', 'serve', 'stop', 'status', 'chat', 'key', 'extension', 'logs', 'login', 'logout', 'session', 'help']);

let command = 'start';
let rest = args;
if (first && known.has(first)) {
  command = first;
  rest = args.slice(1);
} else if (first) {
  command = 'chat';
}
if (first === '--help' || first === '-h') command = 'help';
if (first === '--login' || first === '-l') { command = 'login'; rest = args.slice(1); }
if (first === '--logout') { command = 'logout'; rest = args.slice(1); }

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const baseUrl = (port) => `http://127.0.0.1:${port}`;

async function getHealth(port, timeout = 800) {
  try {
    const res = await fetch(`${baseUrl(port)}/health`, { signal: AbortSignal.timeout(timeout) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function getStatus() {
  const cfg = loadConfig();
  const health = await getHealth(cfg.port);
  if (!health) return { cfg, health: null, status: null };
  try {
    const res = await fetch(`${baseUrl(cfg.port)}/v1/bridge/status`, {
      headers: { authorization: `Bearer ${cfg.key}` },
      signal: AbortSignal.timeout(1500),
    });
    return { cfg, health, status: res.ok ? await res.json() : null };
  } catch {
    return { cfg, health, status: null };
  }
}

async function waitForBridge(ms = 15000, child = null) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const cfg = loadConfig();
    const health = await getHealth(cfg.port);
    if (health?.ok) return { cfg, health };
    if (child && child.exitCode !== null) return null;
    await sleep(250);
  }
  return null;
}

async function waitForExtension(cfg, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const health = await getHealth(cfg.port);
    if (health?.extension) return true;
    await sleep(300);
  }
  return false;
}

function readHidden(question) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const stdout = process.stdout;
    stdout.write(question);
    if (!stdin.isTTY) {
      let data = '';
      const onData = (chunk) => {
        data += chunk.toString('utf8');
        if (data.includes('\n')) {
          stdin.removeListener('data', onData);
          resolve(data.split(/\r?\n/)[0].trim());
        }
      };
      stdin.on('data', onData);
      stdin.resume();
      return;
    }

    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    let value = '';
    const cleanup = () => {
      stdin.removeListener('data', onData);
      stdin.setRawMode(Boolean(wasRaw));
      stdin.pause();
      stdout.write('\n');
    };
    const onData = (chunk) => {
      const text = chunk.toString('utf8').replace(/\x1b\[[0-9;?]*[A-Za-z~]/g, '');
      for (const char of text) {
        if (char === '\r' || char === '\n') {
          cleanup();
          resolve(value.trim());
          return;
        }
        if (char === '\u0003') {
          cleanup();
          process.exit(130);
        }
        if (char === '\u007f' || char === '\b') {
          value = value.slice(0, -1);
          continue;
        }
        value += char;
      }
    };
    stdin.on('data', onData);
  });
}

function printSessionSummary(summary, { prefix = '  ', showMode = true } = {}) {
  if (showMode) console.log(`${prefix}Mode        direct${summary.available ? ' (Chrome not required)' : ' — run deepseek --login'}`);
  if (!summary.available) return;
  if (summary.user) console.log(`${prefix}Account     ${summary.user}`);
  console.log(`${prefix}Cookies     ${summary.cookies}`);
  if (summary.expiresAt) console.log(`${prefix}Expires     ${summary.expiresAt}`);
  console.log(`${prefix}Session     ${summary.file}`);
}

function tailLog(lines = 30) {
  try {
    const text = fs.readFileSync(LOG, 'utf8').trim().split('\n');
    if (text.length) console.error(text.slice(-lines).join('\n'));
  } catch {
    /* no log yet */
  }
}

function startBackground(extraArgs = []) {
  fs.mkdirSync(paths.CONFIG_DIR, { recursive: true, mode: 0o700 });
  const out = fs.openSync(LOG, 'a');
  const child = spawn(process.execPath, [BRIDGE, ...extraArgs], {
    detached: true,
    stdio: ['ignore', out, out],
    windowsHide: true,
    env: process.env,
  });
  child.unref();
  fs.closeSync(out);
  return child;
}

async function ensureRunning(extraArgs = []) {
  const current = loadConfig();
  const health = await getHealth(current.port);
  if (health?.ok) return { cfg: current, health, started: false };

  const child = startBackground(extraArgs);
  const found = await waitForBridge(15000, child);
  if (!found) {
    console.error('deepseek-bridge did not start. Last log lines:');
    tailLog();
    process.exit(1);
  }
  return { ...found, started: true };
}

function printStatus(cfg, health, started = false) {
  const session = sessionSummary();
  const ext = health?.extension ? 'connected' : 'not connected';
  console.log(`
  deepseek-bridge ${started ? 'started in the background' : 'is running'}

  Base URL    http://127.0.0.1:${cfg.port}/v1
  API key     ${cfg.key}
  Mode        ${session.available ? 'direct' : health?.extension ? 'extension' : 'not ready'}
  Extension   ${ext}${session.available ? ' (optional in direct mode)' : ''}
  Extension folder
              ${EXTENSION}
  Config      ${paths.CONFIG_FILE}
  Log         ${LOG}
`);

  if (session.available) {
    printSessionSummary(session, { showMode: false });
    return;
  }

  if (health?.extension) {
    console.log('Extension mode is ready. Run `deepseek --login` to copy the session into the terminal');
    console.log('and stop paying the Chrome RAM cost on every request.');
    return;
  }

  console.log('Next: load that extension folder in Chrome (chrome://extensions → Developer mode → Load unpacked),');
  console.log('open the popup and enter the port/key above, sign in at https://chat.deepseek.com,');
  console.log('then run `deepseek --login` to copy the session into the terminal.');
}

function runForeground(script, scriptArgs = []) {
  const child = spawn(process.execPath, [script, ...scriptArgs], {
    stdio: 'inherit',
    env: process.env,
    windowsHide: false,
  });
  child.on('exit', (code, signal) => {
    if (signal) {
      try {
        process.kill(process.pid, signal);
      } catch {
        process.exit(1);
      }
    } else {
      process.exit(code ?? 0);
    }
  });
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      try {
        child.kill(sig);
      } catch {
        /* already exited */
      }
    });
  }
}

async function stopBridge() {
  const cfg = loadConfig();
  const health = await getHealth(cfg.port);
  let pid = null;
  try {
    pid = Number(fs.readFileSync(paths.PID_FILE, 'utf8').trim()) || null;
  } catch {
    /* no pid file */
  }

  if (!health?.ok) {
    // The server is already down. Remove a stale PID instead of risking a
    // signal to an unrelated process that reused the PID.
    if (pid) {
      try {
        fs.unlinkSync(paths.PID_FILE);
      } catch {
        /* already gone */
      }
    }
    console.log('deepseek-bridge is not running.');
    return;
  }

  if (!pid) {
    console.error('The bridge is running, but there is no PID file. Stop it with Ctrl+C in its terminal.');
    process.exit(1);
  }

  try {
    process.kill(pid, 'SIGTERM');
  } catch (err) {
    if (err.code !== 'ESRCH') {
      console.error(`Could not stop PID ${pid}: ${err.message}`);
      process.exit(1);
    }
  }

  const end = Date.now() + 4000;
  while (Date.now() < end && (await getHealth(cfg.port))) await sleep(150);
  if (await getHealth(cfg.port)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
    await sleep(300);
  }
  try {
    fs.unlinkSync(paths.PID_FILE);
  } catch {
    /* already gone */
  }
  console.log('deepseek-bridge stopped.');
}

function printLogs() {
  console.log(LOG);
  try {
    const text = fs.readFileSync(LOG, 'utf8').trim().split('\n');
    if (text.length) {
      console.log('');
      console.log(text.slice(-40).join('\n'));
    }
  } catch {
    console.log('(no log yet)');
  }
}

async function manualLogin() {
  console.log('');
  console.log('  Manual login (no extension needed)');
  console.log('');
  console.log('  1. Open https://chat.deepseek.com in Chrome and sign in.');
  console.log('  2. Open DevTools (F12) → Console, paste this and press Enter:');
  console.log('');
  console.log("       copy((()=>{const v=localStorage.getItem('userToken');try{const p=JSON.parse(v);return typeof p==='string'?p:p.value}catch{return v}})())");
  console.log('');
  console.log('  3. Paste the copied token below. It will not be echoed.');
  console.log('');
  const token = (await readHidden('  userToken: '))
    .replace(/^["']|["']$/g, '')
    .replace(/^Bearer\s+/i, '')
    .trim();
  if (!token || token.length < 20) {
    console.error('That does not look like a DeepSeek user token.');
    process.exit(1);
  }
  saveSession({ token, cookies: [] });
  const { cfg } = await ensureRunning();
  let verified = false;
  let warning = null;
  try {
    const res = await fetch(`${baseUrl(cfg.port)}/v1/bridge/session/verify`, {
      method: 'POST',
      headers: { authorization: `Bearer ${cfg.key}` },
      signal: AbortSignal.timeout(30000),
    });
    const data = await res.json().catch(() => ({}));
    verified = res.ok;
    if (!res.ok) warning = data?.error?.message || `HTTP ${res.status}`;
  } catch (err) {
    warning = err?.message || String(err);
  }
  console.log('');
  console.log('  DeepSeek session saved');
  console.log('');
  printSessionSummary(sessionSummary());
  if (!verified && warning) {
    console.log('');
    console.log(`  Warning: ${warning}`);
  }
  console.log('');
  if (verified) {
    console.log('  Chrome is not needed for requests. Re-run this command when the session expires.');
  } else {
    console.log('  The token was saved, but DeepSeek did not confirm it.');
    console.log('  If requests fail, run `deepseek --login` again.');
  }
}

async function login() {
  if (rest.includes('--manual')) return manualLogin();
  const { cfg } = await ensureRunning();
  const health = await getHealth(cfg.port);
  if (!health?.extension) {
    console.log('Waiting for the DeepSeek Bridge extension in Chrome...');
    if (!(await waitForExtension(cfg, 35000))) {
      console.error('Chrome is not connected to the bridge.');
      console.error('Open Chrome, load the extension folder below, sign in at https://chat.deepseek.com, then retry:');
      console.error(`  ${EXTENSION}`);
      console.error('  deepseek --login');
      console.error('  Or use the no-extension manual flow: deepseek --login --manual');
      process.exit(1);
    }
  }

  console.log('Copying chat.deepseek.com cookies and user token from Chrome...');
  let res;
  try {
    res = await fetch(`${baseUrl(cfg.port)}/v1/bridge/session/export`, {
      method: 'POST',
      headers: { authorization: `Bearer ${cfg.key}` },
      signal: AbortSignal.timeout(50000),
    });
  } catch (err) {
    console.error(`Login failed: ${err?.message || err}`);
    process.exit(1);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`Login failed: ${data?.error?.message || `HTTP ${res.status}`}`);
    process.exit(1);
  }

  console.log('');
  console.log('  DeepSeek session copied to the terminal');
  console.log('');
  printSessionSummary(data);
  if (data.verified === false) {
    if (data.warning) {
      console.log('');
      console.log(`  Warning: ${data.warning}`);
    }
    console.log('');
    console.log('  The session was saved, but DeepSeek did not confirm it yet.');
    console.log('  If requests fail, run `deepseek --login` again.');
  } else {
    console.log('');
    console.log('  Chrome and the extension are no longer needed for requests.');
    console.log('  If DeepSeek asks you to sign in again, run: deepseek --login');
  }
}

async function logout() {
  const cfg = loadConfig();
  const health = await getHealth(cfg.port);
  let cleared = false;
  if (health?.ok) {
    try {
      const res = await fetch(`${baseUrl(cfg.port)}/v1/bridge/session`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${cfg.key}` },
        signal: AbortSignal.timeout(3000),
      });
      cleared = res.ok;
    } catch {
      cleared = false;
    }
  }
  if (!cleared) clearSession();
  console.log('DeepSeek terminal session removed.');
}

function printSession() {
  const summary = sessionSummary();
  console.log('');
  if (!summary.available) {
    console.log('  Mode        extension / not configured');
    console.log('  Run         deepseek --login');
    console.log('');
    return;
  }
  printSessionSummary(summary);
  console.log('');
}

function printHelp() {
  console.log(`deepseek-bridge — OpenAI-compatible API for chat.deepseek.com

Usage:
  deepseek                 Start the bridge in the background and show status
  deepseek start           Same as deepseek
  deepseek serve           Run the bridge in the foreground
  deepseek stop            Stop the background bridge
  deepseek status          Show the bridge and extension status
  deepseek chat "hello"    Send a chat message (starts the bridge if needed)
  deepseek "hello"         Shorthand for deepseek chat "hello"
  deepseek --login         Copy the chat.deepseek.com session from Chrome once
  deepseek --login --manual  Paste userToken from DevTools (no extension needed)
  deepseek --logout        Delete the terminal session (fall back to extension)
  deepseek session         Show the stored terminal session
  deepseek key             Print the API key
  deepseek extension       Print the absolute extension folder
  deepseek logs            Print the log path and the last lines
  deepseek help            Show this help

Start options:
  deepseek start --port 9000
  deepseek serve --port 9000
`);
}

let keepAlive = false;

if (command === 'help') {
  printHelp();
} else if (command === 'start') {
  const { cfg, health, started } = await ensureRunning(rest);
  printStatus(cfg, health, started);
} else if (command === 'serve') {
  const cfg = loadConfig();
  const health = await getHealth(cfg.port);
  if (health?.ok) {
    printStatus(cfg, health, false);
    console.log('Stop it first with `deepseek stop` if you want to run it in the foreground.');
  } else {
    runForeground(BRIDGE, rest);
    keepAlive = true;
  }
} else if (command === 'stop') {
  await stopBridge();
} else if (command === 'status') {
  const { cfg, health, status } = await getStatus();
  if (!health?.ok) {
    console.log('deepseek-bridge is not running.');
    console.log(`Start it with: deepseek`);
  } else {
    printStatus(cfg, health, false);
    if (status) console.log(`Queue: ${JSON.stringify(status)}`);
  }
} else if (command === 'login') {
  await login();
} else if (command === 'logout') {
  await logout();
} else if (command === 'session') {
  printSession();
} else if (command === 'chat') {
  await ensureRunning();
  runForeground(CHAT, rest);
  keepAlive = true;
} else if (command === 'key') {
  console.log(loadConfig().key);
} else if (command === 'extension') {
  console.log(EXTENSION);
} else if (command === 'logs') {
  printLogs();
} else {
  printHelp();
}

if (!keepAlive) process.exit(0);
