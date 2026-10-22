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
 *   deepseek key             print the API key
 *   deepseek extension       print the absolute extension folder
 *   deepseek logs            print the log path and the last lines
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig, paths } from '../src/config.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = path.join(HERE, 'ds-bridge.js');
const CHAT = path.join(HERE, 'ds-chat.js');
const EXTENSION = path.resolve(HERE, '..', 'extension');
const LOG = path.join(paths.CONFIG_DIR, 'bridge.log');

const args = process.argv.slice(2);
const first = args[0];
const known = new Set(['start', 'serve', 'stop', 'status', 'chat', 'key', 'extension', 'logs', 'help']);

let command = 'start';
let rest = args;
if (first && known.has(first)) {
  command = first;
  rest = args.slice(1);
} else if (first) {
  command = 'chat';
}
if (first === '--help' || first === '-h') command = 'help';

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
  const ext = health?.extension ? 'connected' : 'NOT connected';
  console.log(`
  deepseek-bridge ${started ? 'started in the background' : 'is running'}

  Base URL    http://127.0.0.1:${cfg.port}/v1
  API key     ${cfg.key}
  Extension   ${ext}
  Extension folder
              ${EXTENSION}
  Config      ${paths.CONFIG_FILE}
  Log         ${LOG}
`);

  if (!health?.extension) {
    console.log('Next: load that extension folder in Chrome (chrome://extensions → Developer mode → Load unpacked),');
    console.log('open the popup and enter the port/key above, then sign in at https://chat.deepseek.com.');
  }
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

  if (!pid) {
    if (health?.ok) {
      console.error('The bridge is running, but there is no PID file. Stop it with Ctrl+C in its terminal.');
      process.exit(1);
    }
    console.log('deepseek-bridge is not running.');
    return;
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
