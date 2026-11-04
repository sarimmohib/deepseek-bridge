#!/usr/bin/env node
/*
 * Cross-platform command for deepseek-bridge.
 *
 *   deepseek                 start in the background (or report it is running)
 *   deepseek serve           run in the foreground
 *   deepseek stop            stop the background process
 *   deepseek status          show bridge status
 *   deepseek ui              open the web dashboard in a browser
 *   deepseek models          one line per model
 *   deepseek models --info   model details + pasteable dsh config snippet
 *   deepseek chat "hello"    send a chat message
 *   deepseek "hello"         shorthand for chat
 *   deepseek login           paste a userToken (hidden prompt)
 *   deepseek login <token>   add one account to the pool
 *   deepseek login <a> <b>   add several accounts in one run
 *   deepseek accounts        list / remove / clear the stored DeepSeek accounts
 *   deepseek --logout        delete every terminal account
 *   deepseek session         show session metadata
 *   deepseek version         show local and GitHub versions
 *   deepseek update          fast-forward a git checkout
 *   deepseek key             print the API key
 *   deepseek logs            print the log path and the last lines
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig, paths, saveConfig } from '../src/config.js';
import { MODELS } from '../src/openai.js';
import {
  dshProfileSnippet,
  modelDetailLines,
  modelSummaryLines,
  openaiEnvSnippet,
} from '../src/modelinfo.js';
import * as rules from '../src/rules.js';
import { sessionSummary } from '../src/session.js';
import * as accounts from '../src/accounts.js';
import {
  ROOT,
  VERSION,
  compareVersions,
  fetchLatestVersion,
  gitState,
  readLocalVersion,
  updateFromGit,
} from '../src/version.js';
import { autostartStatus, probeTools, runInstaller, tailscaleInfo } from '../src/installer.js';
import { collectNetworkInfo, createStyle, printStartup } from '../src/tui.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = path.join(HERE, 'ds-bridge.js');
const CHAT = path.join(HERE, 'ds-chat.js');
const LOG = path.join(paths.CONFIG_DIR, 'bridge.log');

const args = process.argv.slice(2);
const first = args[0];
const known = new Set([
  'start', 'serve', 'stop', 'status', 'chat', 'key',
  'logs', 'login', 'logout', 'session', 'version', 'update', 'help',
  'ui', 'models', 'accounts', 'rules', 'install', 'setup',
]);
const AUTO_UPDATE_INTERVAL = 6 * 60 * 60 * 1000;

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
if (first === '--update') { command = 'update'; rest = args.slice(1); }
if (first === '--version' || first === '-v') {
  console.log(`deepseek-bridge ${VERSION}`);
  process.exit(0);
}

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

// A TCP probe, not a fetch: it stays false while the listener is still bound
// even if the old process no longer answers HTTP. `deepseek update` restarts
// the bridge immediately after stopping it, and a restart that races the old
// listener used to lose the configured port (the daemon moved to port+1 and
// every client that reads config.json was left behind).
function portOpen(port, host = '127.0.0.1', timeout = 400) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    const done = (open) => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeout);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

async function waitForPortClosed(port, ms = 6000, host = '127.0.0.1') {
  const target = host === '0.0.0.0' || host === '::' || host === '[::]' ? '127.0.0.1' : host;
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!(await portOpen(port, target))) return true;
    await sleep(120);
  }
  return !(await portOpen(port, target));
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

function cleanToken(value) {
  return String(value || '')
    .replace(/\r/g, '')
    .split('\n')[0]
    .trim()
    .replace(/^["']|["']$/g, '')
    .replace(/^Bearer\s+/i, '')
    .trim();
}

function readAllStdin(timeoutMs = 30_000) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    let data = '';
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      stdin.removeListener('data', onData);
      stdin.removeListener('end', finish);
      stdin.removeListener('error', finish);
      stdin.pause();
      resolve(data);
    };
    const onData = (chunk) => {
      data += chunk.toString('utf8');
      if (/[\r\n]/.test(data)) finish();
    };
    const timer = setTimeout(finish, timeoutMs);
    timer.unref?.();
    stdin.on('data', onData);
    stdin.on('end', finish);
    stdin.on('error', finish);
    stdin.resume();
  });
}

function readHidden(question) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const stdout = process.stdout;
    stdout.write(question);
    if (!stdin.isTTY) {
      readAllStdin().then((data) => resolve(cleanToken(data)));
      return;
    }

    const wasRaw = stdin.isRaw;
    let raw = false;
    try {
      stdin.setRawMode(true);
      raw = true;
    } catch {
      // Some Windows terminals do not support raw mode. Canonical input still
      // works; it just echoes the token while it is being pasted.
    }
    stdin.resume();
    let value = '';
    let done = false;
    const cleanup = () => {
      if (done) return;
      done = true;
      stdin.removeListener('data', onData);
      stdin.removeListener('end', finish);
      if (raw) {
        try {
          stdin.setRawMode(Boolean(wasRaw));
        } catch {
          /* ignore */
        }
      }
      stdin.pause();
      stdout.write('\n');
    };
    const finish = () => {
      const token = value.trim();
      cleanup();
      resolve(token);
    };
    const onData = (chunk) => {
      const text = chunk.toString('utf8').replace(/\x1b\[[0-9;?]*[A-Za-z~]/g, '');
      for (const char of text) {
        if (char === '\r' || char === '\n') {
          finish();
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
    stdin.on('end', finish);
  });
}

function readTokenFile(file) {
  return fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map(cleanToken)
    .filter(Boolean);
}

function tokensFromArgs(args) {
  const tokens = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--token' || arg === '-t') {
      const value = args[++i];
      if (value) tokens.push(value);
      continue;
    }
    if (arg.startsWith('--token=')) {
      tokens.push(arg.slice('--token='.length));
      continue;
    }
    if (arg === '--token-file' || arg === '-f') {
      const file = args[++i];
      if (!file) throw new Error('--token-file needs a path');
      tokens.push(...readTokenFile(file));
      continue;
    }
    if (arg.startsWith('--token-file=')) {
      tokens.push(...readTokenFile(arg.slice('--token-file='.length)));
      continue;
    }
    if (arg === '--label') {
      i++; // the label is not a positional token
      continue;
    }
    if (arg.startsWith('-')) continue;
    // Bare positional token, e.g. `deepseek login <token>`.
    tokens.push(arg);
  }
  return tokens.map(cleanToken).filter(Boolean);
}

function labelFromArgs(args) {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--label') return args[i + 1] || '';
    if (args[i].startsWith('--label=')) return args[i].slice('--label='.length);
  }
  return '';
}

function shortId(id) {
  const text = String(id || '');
  return text.length > 8 ? text.slice(0, 8) : text;
}

function fmtAge(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '–';
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return Math.floor(s) + 's';
  if (s < 3600) return Math.floor(s / 60) + 'm';
  if (s < 86400) return Math.floor(s / 3600) + 'h';
  return Math.floor(s / 86400) + 'd';
}

function fmtCountdown(ms) {
  const total = Math.max(0, Math.ceil(Number(ms) / 1000));
  if (total < 60) return total + 's';
  if (total < 3600) return Math.floor(total / 60) + 'm' + (total % 60 ? (total % 60) + 's' : '');
  return Math.floor(total / 3600) + 'h' + (total % 3600 ? Math.floor((total % 3600) / 60) + 'm' : '');
}

function accountLabelText(account) {
  if (!account) return '';
  if (account.label) return String(account.label);
  const user = account.user;
  if (typeof user === 'string' && user) return user;
  if (user && typeof user === 'object') return String(user.email || user.name || '');
  return '';
}

function accountStateText(account, now = Date.now()) {
  const until = Number(account && account.cooldownUntil) || 0;
  if (until > now) return 'cooling ' + fmtCountdown(until - now);
  return 'ready';
}

async function readManualTokens(args) {
  const explicit = tokensFromArgs(args);
  if (explicit.length) return explicit;
  const envToken = process.env.DEEPSEEK_TOKEN || process.env.DEEPSEEK_USER_TOKEN;
  if (envToken) return [cleanToken(envToken)].filter(Boolean);
  if (!process.stdin.isTTY) {
    const piped = await readAllStdin();
    return piped
      .split(/\r?\n/)
      .map(cleanToken)
      .filter(Boolean);
  }
  const token = cleanToken(await readHidden('  userToken (hidden): '));
  return token ? [token] : [];
}

function printSessionSummary(summary, { prefix = '  ', showMode = true } = {}) {
  if (showMode) console.log(`${prefix}Mode        direct${summary.available ? '' : ' - run deepseek login'}`);
  const count = Number(summary.accounts) || 0;
  if (!summary.available) {
    if (count) console.log(`${prefix}Accounts    ${count}`);
    return;
  }
  if (summary.user) console.log(`${prefix}Account     ${summary.user}`);
  console.log(`${prefix}Cookies     ${summary.cookies}`);
  if (count) console.log(`${prefix}Accounts    ${count} stored (unlimited pool)`);
  if (summary.expiresAt) console.log(`${prefix}Expires     ${summary.expiresAt}`);
  console.log(`${prefix}Session     ${summary.file}`);
}

// Prefer a running bridge (it owns the freshest per-account stats and its own
// file lock) and fall back to the local accounts.json when it is down or too
// old to expose the accounts API.
async function resolveAccountsSource() {
  const cfg = loadConfig();
  const health = await getHealth(cfg.port);
  if (health?.ok) {
    try {
      const res = await fetch(`${baseUrl(cfg.port)}/v1/bridge/accounts`, {
        headers: { authorization: `Bearer ${cfg.key}` },
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) {
        const data = await res.json();
        return {
          source: 'bridge',
          cfg,
          accounts: Array.isArray(data.accounts) ? data.accounts : [],
          count: Math.max(0, Math.floor(Number(data.count) || 0)),
          ready: Math.max(0, Math.floor(Number(data.ready) || 0)),
          cooling: Math.max(0, Math.floor(Number(data.cooling) || 0)),
        };
      }
      // 401 usually means the bridge was started from another config dir.
    } catch {
      /* fall through to the local pool */
    }
  }
  const summary = accounts.accountsSummary();
  return {
    source: 'local',
    cfg,
    accounts: summary.accounts,
    count: summary.count,
    ready: summary.ready,
    cooling: summary.cooling,
  };
}

function printAccountsTable(data) {
  const list = data.accounts;
  if (!list.length) {
    console.log('');
    console.log('  No DeepSeek accounts stored.');
    console.log('  Add one with:  deepseek login <userToken>');
    console.log('  or:            deepseek login   (paste it at the hidden prompt)');
    console.log('');
    return;
  }
  const rows = list.map((account, index) => ({
    index: String(index + 1),
    id: shortId(account.id),
    label: accountLabelText(account) || '(no label)',
    cookies: String(Math.max(0, Math.floor(Number(account.cookies) || 0))),
    state: accountStateText(account),
    throttle: String(Math.max(0, Math.floor(Number(account.throttleHits) || 0))),
    used: account.lastUsedAt ? `${fmtAge(account.lastUsedAt)} ago` : 'never',
  }));
  const headers = {
    index: '#',
    id: 'ID',
    label: 'LABEL / USER',
    cookies: 'COOKIES',
    state: 'STATE',
    throttle: 'THROTTLE',
    used: 'LAST USED',
  };
  const width = {};
  for (const key of Object.keys(headers)) {
    width[key] = headers[key].length;
    for (const row of rows) width[key] = Math.max(width[key], String(row[key]).length);
  }
  const line = (row) =>
    '  ' +
    [
      row.index.padEnd(width.index),
      row.id.padEnd(width.id),
      row.label.padEnd(width.label),
      row.cookies.padStart(width.cookies),
      row.state.padEnd(width.state),
      row.throttle.padStart(width.throttle),
      row.used,
    ].join('  ');
  console.log('');
  console.log(
    `  DeepSeek accounts — ${data.count} stored, ${data.ready} ready, ${data.cooling} cooling` +
      (data.source === 'bridge' ? ' (live bridge)' : ' (accounts.json)'),
  );
  console.log('');
  console.log(line(headers));
  for (const row of rows) console.log(line(row));
  console.log('');
}

function printAccountsHelp() {
  console.log(`Usage:
  deepseek accounts                 List every stored DeepSeek account (unlimited pool)
  deepseek accounts --json          Machine-readable list (no token values)
  deepseek accounts remove <id|#>   Remove one account by full/partial id or 1-based index
  deepseek accounts clear           Show what clearing would remove
  deepseek accounts clear --yes     Remove every account and the legacy session file

Add accounts:
  deepseek login <userToken>                    append one account
  deepseek login <a> <b> <c>                    append several accounts
  deepseek login --token-file token.txt         append from a file (one token per line)
  DEEPSEEK_TOKEN=<userToken> deepseek login     append from the environment
  deepseek login <userToken> --replace          replace the whole pool
  deepseek login                                paste at the hidden prompt

Accounts are verified with DeepSeek before they are kept. When one account is
rate-limited the bridge cools it down and rotates the next request to another
account automatically. Run 'deepseek accounts' to see ready/cooling state.`);
}

async function accountsCommand() {
  const sub = rest[0] && !String(rest[0]).startsWith('-') ? rest[0] : 'list';
  if (rest.includes('--help') || rest.includes('-h') || sub === 'help') {
    printAccountsHelp();
    return;
  }
  if (sub === 'list') {
    const data = await resolveAccountsSource();
    if (rest.includes('--json')) {
      console.log(
        JSON.stringify(
          { count: data.count, ready: data.ready, cooling: data.cooling, source: data.source, accounts: data.accounts },
          null,
          2,
        ),
      );
      return;
    }
    printAccountsTable(data);
    return;
  }
  if (sub === 'remove') {
    await accountsRemoveCommand(rest[1]);
    return;
  }
  if (sub === 'clear') {
    await accountsClearCommand();
    return;
  }
  console.error(`Unknown accounts command: ${sub}`);
  printAccountsHelp();
  process.exitCode = 1;
}

async function accountsRemoveCommand(target) {
  if (!target) {
    console.error('Usage: deepseek accounts remove <id|index>');
    process.exitCode = 1;
    return;
  }
  const data = await resolveAccountsSource();
  let id = null;
  if (/^\d+$/.test(target)) {
    const index = Number(target) - 1;
    if (index < 0 || index >= data.accounts.length) {
      console.error(`No account at index ${target} (${data.count} stored).`);
      process.exitCode = 1;
      return;
    }
    id = data.accounts[index].id;
  } else {
    const matches = data.accounts.filter((account) => String(account.id).startsWith(target));
    if (matches.length > 1) {
      console.error(`Account id prefix "${target}" is ambiguous: ${matches.map((account) => shortId(account.id)).join(', ')}`);
      process.exitCode = 1;
      return;
    }
    id = matches.length === 1 ? matches[0].id : target;
  }

  let remaining = Math.max(0, data.count - 1);
  if (data.source === 'bridge') {
    try {
      const res = await fetch(`${baseUrl(data.cfg.port)}/v1/bridge/accounts/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${data.cfg.key}` },
        signal: AbortSignal.timeout(5000),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        console.error(`Could not remove account: ${body?.error?.message || `HTTP ${res.status}`}`);
        process.exitCode = 1;
        return;
      }
      if (Number.isFinite(Number(body.count))) remaining = Number(body.count);
    } catch (err) {
      console.error(`Could not remove account: ${err?.message || err}`);
      process.exitCode = 1;
      return;
    }
  } else if (!accounts.removeAccount(id)) {
    console.error(`No account with id ${shortId(id)}.`);
    process.exitCode = 1;
    return;
  }
  console.log(`Removed DeepSeek account ${shortId(id)} (${remaining} remaining).`);
}

async function accountsClearCommand() {
  const data = await resolveAccountsSource();
  if (!data.count) {
    console.log('No DeepSeek accounts to remove.');
    return;
  }
  const yes = rest.includes('--yes') || rest.includes('-y') || rest.includes('--force');
  if (!yes) {
    console.log(`This deletes all ${data.count} stored DeepSeek account(s) and the legacy session.json.`);
    console.log('Re-run with --yes to confirm:');
    console.log('  deepseek accounts clear --yes');
    return;
  }
  let removed = data.count;
  if (data.source === 'bridge') {
    try {
      const res = await fetch(`${baseUrl(data.cfg.port)}/v1/bridge/accounts`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${data.cfg.key}` },
        signal: AbortSignal.timeout(5000),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        console.error(`Could not clear accounts: ${body?.error?.message || `HTTP ${res.status}`}`);
        process.exitCode = 1;
        return;
      }
      if (Number.isFinite(Number(body.removed))) removed = Number(body.removed);
    } catch (err) {
      console.error(`Could not clear accounts: ${err?.message || err}`);
      process.exitCode = 1;
      return;
    }
  } else {
    removed = accounts.clearAccounts().removed;
  }
  console.log(`Removed ${removed} DeepSeek account(s) and the legacy session file.`);
  console.log('Add a fresh login with `deepseek login <userToken>`.');
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
  const accountInfo = accounts.accountsSummary();
  const network = collectNetworkInfo({ tailscale: tailscaleInfo() });
  const tools = probeTools({ skipVersion: false }).map((tool) => ({
    id: tool.id,
    found: tool.found,
    version: tool.version,
  }));
  printStartup(
    {
      version: health?.version || readLocalVersion(),
      cfg,
      health,
      started,
      mode: session.available ? 'direct' : 'not ready',
      accounts: accountInfo,
      models: MODELS,
      tools,
      autostart: autostartStatus(),
      network,
    },
    { style: createStyle({ ascii: process.env.DEEPSEEK_ASCII === '1' }) },
  );

  if (session.available) {
    printSessionSummary(session, { showMode: false });
    return;
  }

  console.log('  Next: add a login with `deepseek login` (paste a userToken).');
  console.log('  The bridge needs at least one account before it can answer requests.');
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

  // Wait for the listener itself to disappear, not just for /health to stop
  // answering: an update restarts the bridge in the next instant, and the new
  // process must be able to bind the port saved in config.json.
  if (!(await waitForPortClosed(cfg.port, 4000, cfg.host))) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
    await waitForPortClosed(cfg.port, 3000, cfg.host);
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

function modelsCommand() {
  const cfg = loadConfig();
  if (!rest.includes('--info')) {
    for (const line of modelSummaryLines({
      models: MODELS,
      defaultModel: cfg.defaultModel,
      width: process.stdout.columns || 100,
    })) {
      console.log(line);
    }
    return;
  }

  console.log(`deepseek-bridge models  (default: ${cfg.defaultModel})`);
  console.log(`Base URL   http://127.0.0.1:${cfg.port}/v1`);
  console.log(`API key    ${cfg.key}`);
  console.log('');
  for (const model of MODELS) {
    for (const line of modelDetailLines(model, { isDefault: model.id === cfg.defaultModel })) {
      console.log(line);
    }
    console.log('');
  }

  console.log('DeepSeek Harness (dsh) profile patch — paste into ~/.dsh/profiles/web/cordis.patch.yml:');
  console.log(dshProfileSnippet({ models: MODELS, port: cfg.port, model: cfg.defaultModel }));
  console.log('  Export DEEPSEEK_BRIDGE_KEY in your shell profile, then boot `dsh web`.');
  console.log('');
  console.log('Generic OpenAI-compatible env (JSON):');
  const envJson = openaiEnvSnippet({ apiKey: cfg.key, port: cfg.port, model: cfg.defaultModel });
  console.log(envJson);
  console.log('');
  try {
    console.log('Shell export form:');
    for (const [name, value] of Object.entries(JSON.parse(envJson))) {
      console.log(`  export ${name}=${value}`);
    }
  } catch {
    /* the snippet builder always emits valid JSON */
  }
}

function writeKeyFile(destination) {
  const target = path.resolve(String(destination).replace(/^~(?=$|\/)/, os.homedir()));
  if (!target || target === os.homedir()) {
    console.error('Usage: deepseek key --file <path>');
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(path.dirname(target), 0o700);
  } catch {
    /* Windows and some filesystems do not support POSIX modes. */
  }
  fs.writeFileSync(target, loadConfig().key, { mode: 0o600 });
  try {
    fs.chmodSync(target, 0o600);
  } catch {
    /* ignore */
  }
  console.log(target);
}

async function rulesCommand() {
  const wantJson = rest.includes('--json');
  const firstWord = rest.find((arg) => !arg.startsWith('--')) || '';
  const sub = ['add', 'remove', 'rm', 'clear-learned'].includes(firstWord) ? firstWord : '';
  if (sub === 'add') {
    const at = rest.indexOf('add');
    const value = rest.slice(at + 1).filter((arg) => !arg.startsWith('--')).join(' ').trim();
    if (!value) {
      console.error('Usage: deepseek rules add "<text>" [--category NAME]');
      process.exit(1);
    }
    const catAt = rest.indexOf('--category');
    const category = catAt >= 0 ? rest[catAt + 1] : undefined;
    try {
      const added = rules.addRule({ text: value, category });
      if (wantJson) console.log(JSON.stringify(added, null, 2));
      else if (added.duplicate) console.log(`Already stored: ${added.rule.id}`);
      else console.log(`Added rule ${added.rule.id} (${rules.rulesSummary().count} total)`);
    } catch (err) {
      console.error(err?.message || String(err));
      process.exit(1);
    }
    return;
  }
  if (sub === 'remove' || sub === 'rm') {
    const at = rest.findIndex((arg) => arg === 'remove' || arg === 'rm');
    const id = rest[at + 1];
    if (!id) {
      console.error('Usage: deepseek rules remove <id>');
      process.exit(1);
    }
    const removed = rules.removeRule(id);
    if (!removed.removed) {
      console.error(`No rule ${id}.`);
      process.exit(1);
    }
    console.log(`Removed rule ${id} (${removed.count} left)`);
    return;
  }
  if (sub === 'clear-learned') {
    const cleared = rules.clearLearned();
    console.log(`Removed ${cleared.removed} learned rule(s); ${cleared.count} left.`);
    return;
  }
  const cfg = loadConfig();
  const list = rules.listRules();
  const summary = rules.rulesSummary();
  if (wantJson) {
    console.log(JSON.stringify({ systemPreset: cfg.systemPreset, systemRules: cfg.systemRules, summary, rules: list }, null, 2));
    return;
  }
  console.log(`deepseek-bridge rules  (preset: ${cfg.systemPreset || 'none'} · rules ${cfg.systemRules ? 'on' : 'off'})`);
  console.log(`${summary.count} total · ${summary.builtin} builtin · ${summary.user} user · ${summary.learned} learned`);
  console.log('');
  for (const rule of list) {
    const seen = rule.source === 'learned' ? ` seen ${rule.count}x` : '';
    console.log(`  ${rule.id}  [${rule.source}${seen}] ${rule.text}`);
  }
  console.log('');
  console.log(`Store: ${paths.RULES_FILE}`);
  console.log('Add one with: deepseek rules add "<text>"');
}

async function versionCommand() {
  const check = !rest.includes('--local');
  const asJson = rest.includes('--json');
  const local = readLocalVersion();
  const state = gitState();
  const info = {
    version: local,
    install: ROOT,
    commit: state.head || null,
    branch: state.branch || null,
    latest: null,
    updateAvailable: false,
    localAhead: false,
    error: null,
  };

  if (check) {
    try {
      const latest = await fetchLatestVersion();
      info.latest = latest.version;
      info.updateAvailable = compareVersions(latest.version, local) > 0;
      info.localAhead = compareVersions(latest.version, local) < 0;
    } catch (err) {
      info.error = err?.message || String(err);
    }
  }

  if (asJson) {
    console.log(JSON.stringify(info, null, 2));
    return;
  }

  console.log(`deepseek-bridge ${local}`);
  if (info.commit) console.log(`  Commit     ${info.commit} (${info.branch || '?'})`);
  console.log(`  Install    ${info.install}`);
  if (check) {
    if (info.error) {
      console.log(`  GitHub     unavailable (${info.error})`);
    } else {
      console.log(`  GitHub     ${info.latest}`);
      if (info.updateAvailable) console.log('  Status     update available — run `deepseek update`');
      else if (info.localAhead) console.log('  Status     local build is ahead of GitHub main');
      else console.log('  Status     up to date');
    }
  }
}

function updateFailure(result) {
  switch (result.status) {
    case 'not-git':
      return 'this install is not a git checkout; update it from a git clone or reinstall it';
    case 'dirty':
      return 'the git checkout has local changes; commit or stash them first';
    case 'not-main':
      return `the checkout is on branch ${result.state?.branch || '?'}; switch to main first`;
    case 'fetch-failed':
      return `could not fetch origin/main${result.message ? `: ${result.message}` : ''}`;
    case 'merge-failed':
      return `could not fast-forward${result.message ? `: ${result.message}` : ''}`;
    case 'git-error':
      return result.message || 'git is unavailable';
    default:
      return result.message || result.status;
  }
}

async function updateCommand() {
  const checkOnly = rest.includes('--check') || rest.includes('--dry-run');
  const restart = !rest.includes('--no-restart');
  const local = readLocalVersion();
  let latest;
  try {
    latest = (await fetchLatestVersion({ timeout: 8000 })).version;
  } catch (err) {
    console.error(`Could not check GitHub: ${err?.message || err}`);
    process.exitCode = 1;
    return;
  }

  console.log(`Installed  ${local}`);
  console.log(`GitHub     ${latest}`);
  let comparison;
  try {
    comparison = compareVersions(latest, local);
  } catch (err) {
    console.error(`GitHub returned an invalid version: ${err?.message || err}`);
    process.exitCode = 1;
    return;
  }
  if (comparison === 0) {
    console.log('Already up to date.');
    return;
  }
  if (comparison < 0) {
    console.log('The local build is ahead of GitHub main; not downgrading.');
    return;
  }
  if (checkOnly) {
    console.log('Update available. Run `deepseek update` to install it.');
    return;
  }

  const result = updateFromGit();
  if (result.status !== 'updated') {
    console.error(`Update failed: ${updateFailure(result)}.`);
    process.exitCode = 1;
    return;
  }

  try {
    saveConfig({ lastUpdateCheck: Date.now(), lastUpdateVersion: latest });
  } catch {
    /* a read-only config should not hide a successful code update */
  }

  console.log(`Updated to ${readLocalVersion()} (${result.before?.slice(0, 7)} → ${result.after?.slice(0, 7)}).`);

  const cfg = loadConfig();
  const health = await getHealth(cfg.port);
  if (health?.ok) {
    if (!restart) {
      console.log('The bridge is running; restart it with `deepseek stop && deepseek`.');
      return;
    }
    console.log('Restarting the bridge to load the new version...');
    await stopBridge();
    const { cfg: nextCfg, health: nextHealth, started } = await ensureRunning();
    printStatus(nextCfg, nextHealth, started);
  }
}

async function maybeAutoUpdate() {
  if (process.env.DEEPSEEK_NO_UPDATE === '1' || process.env.DEEPSEEK_NO_UPDATE === 'true') return;
  if (rest.includes('--no-update')) return;
  const cfg = loadConfig();
  if (!cfg.autoUpdate) return;
  const now = Date.now();
  if (now - Number(cfg.lastUpdateCheck || 0) < AUTO_UPDATE_INTERVAL) return;

  let latest;
  try {
    latest = (await fetchLatestVersion({ timeout: 4000 })).version;
  } catch {
    try {
      saveConfig({ lastUpdateCheck: now });
    } catch {
      /* ignore */
    }
    return;
  }

  try {
    saveConfig({ lastUpdateCheck: now, lastUpdateVersion: latest });
  } catch {
    /* ignore */
  }

  let comparison;
  try {
    comparison = compareVersions(latest, readLocalVersion());
  } catch {
    return;
  }
  if (comparison <= 0) return;

  const wasRunning = Boolean((await getHealth(cfg.port))?.ok);
  const result = updateFromGit();
  if (result.status !== 'updated') {
    console.log(`deepseek-bridge ${latest} is available, but auto-update could not apply it (${updateFailure(result)}).`);
    return;
  }

  console.log(`Updated deepseek-bridge to ${latest} (${result.before?.slice(0, 7)} → ${result.after?.slice(0, 7)}).`);
  if (wasRunning) {
    console.log('Restarting the bridge to load the new version...');
    await stopBridge();
    await ensureRunning();
  }
}

async function addAccountToken(cfg, token, { replace = false, label = '' } = {}) {
  let res;
  try {
    res = await fetch(`${baseUrl(cfg.port)}/v1/bridge/accounts`, {
      method: 'POST',
      headers: { authorization: `Bearer ${cfg.key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ token, ...(replace ? { replace: true } : {}), ...(label ? { label } : {}) }),
      signal: AbortSignal.timeout(40000),
    });
  } catch (err) {
    return { ok: false, error: `Login failed: ${err?.message || err}` };
  }

  // A bridge from before 0.8.0 has no accounts endpoint. Store the account
  // locally and tell the user to restart instead of failing the login.
  if (res.status === 404) {
    try {
      if (replace) accounts.clearAccounts();
      const result = accounts.addAccount({ token, label: label || undefined, makePrimary: Boolean(replace) });
      return { ok: true, local: true, account: result.account, count: result.count, created: result.created };
    } catch (err) {
      return { ok: false, error: `Could not store the token: ${err?.message || err}` };
    }
  }

  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      message: data?.error?.message || `HTTP ${res.status}`,
    };
  }
  return {
    ok: true,
    account: data?.account || {},
    count: data?.count,
    ready: data?.ready,
    cooling: data?.cooling,
    verified: data?.verified,
    warning: data?.warning,
    duplicate: data?.duplicate,
  };
}

function printLoginResult(result, { replace = false, index = 0, total = 1 } = {}) {
  const prefix = total > 1 ? `  ${String(index + 1).padStart(2)}. ` : '  ';
  if (!result.ok) {
    if (result.status === 401) {
      console.log('');
      console.log('  The running bridge rejected this CLI API key.');
      console.log(`  ${result.message}`);
      console.log('  The CLI and the bridge must use the same config directory (DS_BRIDGE_HOME).');
      return;
    }
    console.log(`${prefix}rejected: ${result.message || result.error || 'unknown error'}`);
    return;
  }

  const account = result.account || {};
  if (total > 1) {
    const id = shortId(account.id);
    const name = account.label ? ` (${account.label})` : '';
    const state = result.local
      ? `${result.count} stored`
      : `${result.count} stored, ${result.ready ?? 0} ready, ${result.cooling || 0} cooling`;
    console.log(`${prefix}${id}${name}  added  ${state}${result.duplicate ? '  (health reset)' : ''}`);
    return;
  }

  console.log('');
  console.log('  DeepSeek account added');
  console.log('');
  console.log(`  Account     ${shortId(account.id)}${account.label ? ` (${account.label})` : ''}`);
  console.log(`  Verified    ${result.verified ? 'yes - usable for requests' : 'not confirmed'}`);
  if (result.warning) console.log(`  Warning     ${result.warning}`);
  if (Number.isFinite(Number(result.count))) {
    console.log(
      `  Accounts    ${result.count} stored` +
        (Number.isFinite(Number(result.ready)) ? ` - ${result.ready} ready - ${result.cooling || 0} cooling` : ''),
    );
  }
  console.log('');
  if (result.local) {
    console.log('  The running bridge is older and has no accounts API, so it cannot use');
    console.log('  this account yet. Restart it to load the new code and the new account:');
    console.log('    deepseek stop && deepseek');
  }
  if (result.duplicate) console.log('  That token was already stored; its cooldown/health state was reset.');
  if (replace) console.log('  The previous pool was replaced.');
  if (!result.local) {
    console.log('  Add more accounts the same way any time: deepseek login <token> <token>');
    console.log('  Requests rotate automatically when DeepSeek throttles one account.');
  }
}

async function login() {
  console.log('');
  console.log('  DeepSeek login');
  console.log('');

  let tokens = [];
  try {
    tokens = tokensFromArgs(rest);
  } catch (err) {
    console.error(`Could not read the token: ${err?.message || err}`);
    process.exit(1);
  }
  if (!tokens.length) {
    const envToken = process.env.DEEPSEEK_TOKEN || process.env.DEEPSEEK_USER_TOKEN;
    if (envToken) tokens = [cleanToken(envToken)].filter(Boolean);
  }

  if (!tokens.length) {
    console.log('  1. Open https://chat.deepseek.com in a browser and sign in.');
    console.log('  2. Open DevTools (F12) -> Console, paste this and press Enter:');
    console.log('');
    console.log("       copy((()=>{const v=localStorage.getItem('userToken');try{const p=JSON.parse(v);return typeof p==='string'?p:p.value}catch{return v}})())");
    console.log('');
    console.log('  3. Paste the token below (input is hidden), or pass it directly.');
    console.log('');
    console.log('     deepseek login <userToken>');
    console.log('     deepseek login <tokenA> <tokenB> <tokenC>');
    console.log('     deepseek login --token-file token.txt');
    console.log('     DEEPSEEK_TOKEN=<userToken> deepseek login');
    console.log('     deepseek login <userToken> --replace');
    console.log('');
    console.log('  Each token adds one account to an unlimited pool; --replace clears the pool first.');
    console.log('');
    try {
      tokens = await readManualTokens([]);
    } catch (err) {
      console.error(`Could not read the token: ${err?.message || err}`);
      process.exit(1);
    }
  }
  if (!tokens.length) {
    console.error('No usable DeepSeek user token was provided.');
    console.error('Use `deepseek login <token>`, --token-file, DEEPSEEK_TOKEN, or paste it at the hidden prompt.');
    process.exit(1);
  }

  const replace = rest.includes('--replace');
  const label = labelFromArgs(rest).slice(0, 80);
  if (tokens.length > 1 && label) {
    console.error('--label can only be used when one token is supplied.');
    process.exit(1);
  }

  const valid = [];
  for (const token of tokens) {
    if (token.length < 20) {
      if (tokens.length === 1) {
        console.error('That does not look like a DeepSeek user token.');
        process.exit(1);
      }
      console.error(`Skipping a token that is too short: ${token.slice(0, 8)}...`);
      continue;
    }
    valid.push(token);
  }
  if (!valid.length) process.exit(1);

  const { cfg } = await ensureRunning();
  if (valid.length > 1) console.log(`  Adding ${valid.length} accounts...`);
  let failed = 0;
  for (let i = 0; i < valid.length; i++) {
    const useReplace = replace && i === 0;
    const result = await addAccountToken(cfg, valid[i], { replace: useReplace, label });
    if (!result.ok) failed++;
    printLoginResult(result, { replace: useReplace, index: i, total: valid.length });
  }

  if (valid.length > 1) {
    console.log('');
    console.log(`  ${valid.length - failed} added, ${failed} failed.`);
  }
  if (failed) process.exitCode = 1;
}

async function logout() {
  const cfg = loadConfig();
  const health = await getHealth(cfg.port);
  let removed = 0;
  let clearedByBridge = false;
  if (health?.ok) {
    try {
      const res = await fetch(`${baseUrl(cfg.port)}/v1/bridge/session`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${cfg.key}` },
        signal: AbortSignal.timeout(5000),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        removed = Math.max(0, Math.floor(Number(data.removed) || 0));
        clearedByBridge = true;
      }
    } catch {
      clearedByBridge = false;
    }
  }
  if (!clearedByBridge) {
    removed = accounts.clearAccounts().removed;
  } else {
    // The bridge may run from a different config dir; make sure this CLI's own
    // pool file and any legacy session.json are gone too.
    try {
      removed = Math.max(removed, accounts.clearAccounts().removed);
    } catch {
      /* best effort */
    }
  }
  if (removed) console.log(`Removed ${removed} DeepSeek account(s) and the legacy session file.`);
  else console.log('No stored DeepSeek accounts to remove.');
  console.log('Add a fresh login with `deepseek login <userToken>`.');
}

function printSession() {
  const summary = sessionSummary();
  const accountInfo = accounts.accountsSummary();
  console.log('');
  if (!summary.available) {
    console.log('  Mode        not configured');
    console.log('  Run         deepseek login');
    console.log('');
    return;
  }
  printSessionSummary(summary);
  if (accountInfo.count) {
    console.log(`  Pool        ${accountInfo.ready} ready · ${accountInfo.cooling} cooling`);
    console.log('  Accounts    run `deepseek accounts` for the full list');
  }
  console.log('');
}

function printHelp() {
  console.log(`deepseek-bridge — OpenAI-compatible API for chat.deepseek.com

Usage:
  deepseek                 Start the bridge in the background and show status
  deepseek start           Same as deepseek
  deepseek serve           Run the bridge in the foreground
  deepseek stop            Stop the background bridge
  deepseek status          Show the bridge status
  deepseek ui              Open the web dashboard in a browser
  deepseek install         Pick optional tools (Git, Tailscale, dsh) + autostart
  deepseek install --list  Show the tool catalog as JSON
  deepseek install --tools git,tailscale --autostart --yes
  deepseek models          One line per model
  deepseek models --info   Model details + pasteable dsh profile patch and env JSON
  deepseek chat "hello"    Send a chat message (starts the bridge if needed)
  deepseek "hello"         Shorthand for deepseek chat "hello"
  deepseek login           Paste userToken from DevTools at a hidden prompt
  deepseek login <token>   Add one account to the pool
  deepseek login <a> <b>   Add several accounts in one run
  deepseek login --token-file token.txt   Add tokens from a file (one per line)
  DEEPSEEK_TOKEN=<token> deepseek login    Add a token from the environment
  deepseek login <token> --replace         Replace the account pool
  deepseek accounts        List stored DeepSeek accounts (unlimited; automatic rotation)
  deepseek rules           Show the system-prompt preset and every rule
  deepseek rules --json    Machine-readable rules
  deepseek rules add "<text>" [--category NAME]
  deepseek rules remove <id>
  deepseek rules clear-learned   Drop auto-learned rules, keep builtin/user
  deepseek accounts --json Machine-readable account list (no tokens)
  deepseek accounts remove <id|index>
  deepseek accounts clear --yes   Remove every account and the legacy session file
  deepseek --logout        Delete all stored accounts
  deepseek session         Show the stored account metadata
  deepseek version         Show local and GitHub versions
  deepseek update          Update a git checkout to GitHub main
  deepseek update --check  Check for an update without installing it
  deepseek key             Print the API key
  deepseek key --file PATH Write the API key to a 0600 file for another client
  deepseek logs            Print the log path and the last lines
  deepseek help            Show this help

Start options:
  deepseek start --port 9000
  deepseek serve --port 9000
  deepseek start --no-update   Skip the automatic GitHub version check
`);
}

let keepAlive = false;

if (command === 'help') {
  printHelp();
} else if (command === 'start') {
  await maybeAutoUpdate();
  const { cfg, health, started } = await ensureRunning(rest);
  printStatus(cfg, health, started);
} else if (command === 'serve') {
  await maybeAutoUpdate();
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
    if (status?.upstream) {
      console.log(`  Queue       ${status.upstream.active} active · ${status.upstream.queued} queued · max ${status.upstream.max}`);
      console.log('');
    }
  }
} else if (command === 'login') {
  await login();
} else if (command === 'logout') {
  await logout();
} else if (command === 'session') {
  printSession();
} else if (command === 'version') {
  await versionCommand();
} else if (command === 'update') {
  await updateCommand();
} else if (command === 'chat') {
  await maybeAutoUpdate();
  await ensureRunning();
  runForeground(CHAT, rest);
  keepAlive = true;
} else if (command === 'key') {
  const fileIndex = rest.indexOf('--file');
  if (fileIndex >= 0) {
    const destination = rest[fileIndex + 1];
    if (!destination || destination.startsWith('--')) {
      console.error('Usage: deepseek key --file <path>');
      process.exit(1);
    }
    writeKeyFile(destination);
  } else {
    console.log(loadConfig().key);
  }
} else if (command === 'ui') {
  const { cfg: uiCfg } = await ensureRunning();
  const uiUrl = `http://127.0.0.1:${uiCfg.port}/`;
  const openers = { darwin: 'open', win32: 'cmd /c start', linux: 'xdg-open' };
  const [exe, ...exeArgs] = (openers[process.platform] || openers.linux).split(' ');
  try {
    const child = spawn(exe, [...exeArgs, uiUrl], { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    // no opener on this platform; the URL is printed either way
  }
  console.log(`  Dashboard: ${uiUrl}`);
  console.log('  Unlock with your API key (deepseek key).');
} else if (command === 'rules') {
  await rulesCommand();
} else if (command === 'install' || command === 'setup') {
  const code = await runInstaller(rest);
  process.exit(code);
} else if (command === 'models') {
  modelsCommand();
} else if (command === 'accounts') {
  await accountsCommand();
} else if (command === 'logs') {
  printLogs();
} else {
  printHelp();
}

if (!keepAlive) process.exit(0);
