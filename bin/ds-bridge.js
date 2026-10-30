#!/usr/bin/env node
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createServer } from '../src/server.js';
import { loadConfig, saveConfig, Store, paths } from '../src/config.js';
import { sessionSummary } from '../src/session.js';
import { accountsSummary } from '../src/accounts.js';
import { MODELS } from '../src/openai.js';
import { VERSION } from '../src/version.js';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const log = (msg) => {
  const t = new Date().toTimeString().slice(0, 8);
  console.error(`\x1b[2m${t}\x1b[0m ${msg}`);
};

const extensionDir = fileURLToPath(new URL('../extension', import.meta.url));

if (flag('--help') || flag('-h')) {
  console.log(`deepseek-bridge — OpenAI-compatible API in front of chat.deepseek.com

Usage:
  ds-bridge [--port 8787] [--reset-key] [--verbose]

The bridge listens on 127.0.0.1 only. Run 'deepseek --login' once to copy the
browser session into the terminal; extension/ is the optional fallback. Add
more accounts with 'deepseek --login --manual --token <userToken>' — the pool is
unlimited and requests rotate automatically on per-account rate limits. Then call:

  curl http://127.0.0.1:8787/v1/chat/completions \\
    -H "authorization: Bearer $DS_BRIDGE_KEY" \\
    -H "content-type: application/json" \\
    -d '{"model":"deepseek-reasoner","messages":[{"role":"user","content":"hi"}],"stream":true}'
`);
  process.exit(0);
}

let config = loadConfig();
if (flag('--reset-key')) {
  const crypto = await import('node:crypto');
  config = saveConfig({ key: `sk-ds-${crypto.randomBytes(24).toString('hex')}` });
  log('generated a new API key');
}
if (value('--port') !== undefined) {
  const requested = value('--port');
  const parsed = Number(requested);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    // Never persist a bad port: Number('abc') is NaN, JSON turns it into
    // null, and the next start then calls server.listen(NaN) and dies with
    // ERR_SOCKET_BAD_PORT before it can print anything useful.
    log(`invalid --port '${requested}': expected an integer from 1 to 65535`);
    process.exit(2);
  }
  config = saveConfig({ port: parsed });
}

const store = new Store();
store.startAutosave();
const session = sessionSummary();
const accountInfo = accountsSummary();
const { server, close } = createServer({ config, store, log });
log(`deepseek-bridge ${VERSION} starting on ${config.host}:${config.port}`);

const listen = (port, attempts = 10) =>
  new Promise((resolve, reject) => {
    const onError = (err) => {
      server.removeListener('error', onError);
      if (err.code === 'EADDRINUSE' && attempts > 0) {
        log(`port ${port} is busy, trying ${port + 1}`);
        resolve(listen(port + 1, attempts - 1));
      } else reject(err);
    };
    server.once('error', onError);
    server.listen(port, config.host, () => {
      server.removeListener('error', onError);
      resolve(port);
    });
  });

// Defensive: a config written by an older build can hold null/NaN here.
// Fall back to the default instead of throwing ERR_SOCKET_BAD_PORT.
const configuredPort = Number.isInteger(config.port) && config.port >= 0 && config.port <= 65535
  ? config.port
  : 8787;
if (configuredPort !== config.port) {
  log(`stored port ${JSON.stringify(config.port)} is invalid; using ${configuredPort}`);
  config = saveConfig({ port: configuredPort });
}
const port = await listen(configuredPort);
if (port !== config.port) config = saveConfig({ port });

fs.mkdirSync(paths.CONFIG_DIR, { recursive: true, mode: 0o700 });
fs.writeFileSync(paths.PID_FILE, `${process.pid}\n`, { mode: 0o600 });
const removePid = () => {
  try {
    if (fs.readFileSync(paths.PID_FILE, 'utf8').trim() === String(process.pid)) fs.unlinkSync(paths.PID_FILE);
  } catch {
    /* already gone */
  }
};
process.on('exit', removePid);

const base = `http://${config.host}:${port}`;
console.log(`
  ┌──────────────────────────────────────────────────────────────┐
  │  deepseek-bridge                                             │
  └──────────────────────────────────────────────────────────────┘

  Base URL   ${base}/v1
  API key    ${config.key}
  Models     ${MODELS.map((m) => m.id).join(', ')}

  Mode       ${session.available ? `direct (${accountInfo.count} account${accountInfo.count === 1 ? '' : 's'})` : 'extension / not configured'}
  Accounts   ${accountInfo.count ? `${accountInfo.count} stored · ${accountInfo.ready} ready · ${accountInfo.cooling} cooling · unlimited pool` : 'none — run `deepseek --login` or `deepseek --login --manual`'}
  Session    ${session.available ? session.file : 'run `deepseek --login` to copy it from Chrome'}

  Next steps
${session.available ? '   1. Test:  deepseek chat "hello"' : '   1. Extension: chrome://extensions → Developer mode → Load unpacked\n      → select ' + extensionDir + '\n   2. Open the extension popup, set port ' + config.port + ' and paste the API key.\n   3. Sign in at https://chat.deepseek.com in a normal tab.\n   4. Run:  deepseek --login'}

  Add more accounts any time:  deepseek --login --manual --token <userToken>
  Inspect the pool:            deepseek accounts

  Config     ${paths.CONFIG_FILE}
  State      ${paths.STATE_FILE}
  Log        ${paths.CONFIG_DIR}/bridge.log
`);

log(`listening on ${base} (loopback only)`);

let shuttingDown = false;
const shutdown = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  store.flush();
  try {
    accounts.flushAccountsNow?.();
  } catch {
    /* best effort on the way out */
  }
  close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// The bridge is a long-lived daemon: a single unexpected throw from a timer,
// a socket handler, or a background write must not terminate the process and
// drop every in-flight request. Log it (bridge.log) and keep serving. Without
// this, an uncaught exception exits with code 1 and no visible reason — the
// "process keeps terminating" symptom.
function reportFatal(kind, err) {
  const detail = err && err.stack ? err.stack : String(err);
  log(`${kind}: ${detail}`);
}
process.on('uncaughtException', (err) => reportFatal('uncaught exception', err));
process.on('unhandledRejection', (reason) => reportFatal('unhandled rejection', reason));
