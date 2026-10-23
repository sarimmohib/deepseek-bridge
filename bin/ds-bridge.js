#!/usr/bin/env node
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createServer } from '../src/server.js';
import { loadConfig, saveConfig, Store, paths } from '../src/config.js';
import { sessionSummary } from '../src/session.js';
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
browser session into the terminal; extension/ is the optional fallback. Then call:

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
if (value('--port')) config = saveConfig({ port: Number(value('--port')) });

const store = new Store();
store.startAutosave();
const session = sessionSummary();
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

const port = await listen(config.port);
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

  Mode       ${session.available ? 'direct (terminal session)' : 'extension / not configured'}
  Session    ${session.available ? session.file : 'run `deepseek --login` to copy it from Chrome'}

  Next steps
${session.available ? '   1. Test:  deepseek chat "hello"' : '   1. Extension: chrome://extensions → Developer mode → Load unpacked\n      → select ' + extensionDir + '\n   2. Open the extension popup, set port ' + config.port + ' and paste the API key.\n   3. Sign in at https://chat.deepseek.com in a normal tab.\n   4. Run:  deepseek --login'}

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
  close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
