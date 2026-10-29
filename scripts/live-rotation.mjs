#!/usr/bin/env node
/*
 * Live verification harness for multi-account token rotation.
 *
 * SAFETY / SECRETS
 *   - Always spawns its own bridge against a throwaway temp DS_BRIDGE_HOME and
 *     a high port (8899+). It NEVER reads or writes ~/.config/deepseek-bridge
 *     and never touches port 8787.
 *   - Real DeepSeek tokens are read from a local token file and are never
 *     printed. Every string that can reach stdout/artifacts is scrubbed.
 *   - The temp home (which contains credentials) is deleted unless --keep.
 *
 * USAGE
 *   node scripts/live-rotation.mjs baseline [--snapshot] [--requests 20]
 *   node scripts/live-rotation.mjs rotation [--requests 24] [--concurrency 3]
 *   node scripts/live-rotation.mjs api
 *   node scripts/live-rotation.mjs review
 *   node scripts/live-rotation.mjs single        (1-account pool regression on the worktree)
 *   node scripts/live-rotation.mjs all           (rotation + api + review + single)
 *
 * FLAGS
 *   --tokens N         tokens to log in (baseline always 1; rotation/all default 2)
 *   --requests N       rapid sequential chat requests per storm (default 20/24)
 *   --concurrency N    parallel requests per batch (clamped 1..6, default 3)
 *   --batches N        parallel batches (default 2)
 *   --gap MS           delay between sequential requests (default 100)
 *   --port N           first port to try (default 8899; auto-scans upward)
 *   --repo DIR         repo to run (default: this checkout)
 *   --snapshot         archive `git HEAD` to a temp dir first and run that
 *                      (baseline runs against pristine 0.7.8 even while
 *                      teammates edit the working tree)
 *   --token-file PATH  defaults to %TEMP%\ds-bridge-test-tokens.txt
 *   --timeout MS       per-request HTTP timeout (default 240000)
 *   --recovery-max MS  max time to wait for throttle recovery (default 240000)
 *   --diff-limit N     review prompt diff budget in chars (default 30000)
 *   --review-out PATH  raw review answer path (default %TEMP%\bridge-review.md)
 *   --artifact-dir DIR summaries + bridge logs (default %TEMP%\ds-bridge-live-artifacts)
 *   --keep             keep the temp DS_BRIDGE_HOME (contains credentials!)
 *   --model ID         default deepseek-reasoner
 *
 * EXIT: 0 = all criteria PASS, 1 = a FAIL, 2 = harness/setup error.
 * This file is the only file the verifier owns; it never edits the bridge.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const DEFAULT_TOKEN_FILE =
  process.env.DS_BRIDGE_TEST_TOKENS || path.join(os.tmpdir(), 'ds-bridge-test-tokens.txt');
const DEFAULT_ARTIFACT_DIR = path.join(os.tmpdir(), 'ds-bridge-live-artifacts');
const DEFAULT_REVIEW_OUT = path.join(os.tmpdir(), 'bridge-review.md');
const LOCAL_BASE = 'http://127.0.0.1';
const MAX_CONCURRENCY = 6;

/* --------------------------------------------------------------- utils --- */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const now = () => Date.now();
const stripAnsi = (s) => String(s || '').replace(/\x1b\[[0-9;]*m/g, '');

/** All loaded token strings; every output path funnels through redactText. */
const secrets = new Set();
/** Every auth-gated API/CLI payload captured for the final token-leak scan. */
const captured = [];

function redactText(value) {
  let out = String(value ?? '');
  for (const secret of secrets) {
    if (secret && secret.length >= 12) out = out.split(secret).join('[redacted-token]');
  }
  return out.replace(/sk-ds-[a-f0-9]{8,}/g, 'sk-ds-[redacted-key]');
}

function log(msg) {
  console.log(redactText(msg));
}

function section(title) {
  console.log('');
  console.log(`=== ${title} ===`);
}

function tokenId(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex').slice(0, 16);
}

function shortId(id) {
  return String(id || '').slice(0, 8);
}

function summarizeLatency(values) {
  const v = values.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (!v.length) return { count: 0 };
  const pick = (p) => v[Math.min(v.length - 1, Math.max(0, Math.ceil((p / 100) * v.length) - 1))];
  const mean = Math.round(v.reduce((a, b) => a + b, 0) / v.length);
  return { count: v.length, min: v[0], p50: pick(50), p90: pick(90), p95: pick(95), max: v[v.length - 1], mean };
}

function cleanError(message) {
  return redactText(String(message || ''))
    .replace(/\s+/g, ' ')
    .slice(0, 240);
}

/* ---------------------------------------------------------- args / cfg --- */

function usage() {
  const head = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0];
  console.log(head.replace(/^#!.*\n/, '').replace(/^\/\*/, ''));
}

function parseArgs(argv) {
  const args = argv.slice();
  let mode = 'help';
  if (args[0] && !args[0].startsWith('-')) mode = args.shift();
  const get = (name, fallback) => {
    let i = args.indexOf(name);
    if (i >= 0) {
      const v = args[i + 1];
      args.splice(i, 2);
      return v;
    }
    const pref = `${name}=`;
    i = args.findIndex((a) => a.startsWith(pref));
    if (i >= 0) {
      const v = args[i].slice(pref.length);
      args.splice(i, 1);
      return v;
    }
    return fallback;
  };
  const has = (name) => {
    const i = args.indexOf(name);
    if (i >= 0) {
      args.splice(i, 1);
      return true;
    }
    return false;
  };
  const num = (name, dflt, min, max) => {
    const raw = get(name, undefined);
    const n = Number(raw);
    if (!Number.isFinite(n)) return dflt;
    return Math.min(max, Math.max(min, Math.floor(n)));
  };
  const defaultRequests = mode === 'baseline' ? 20 : 24;
  const opts = {
    mode,
    requests: num('--requests', defaultRequests, 1, 40),
    concurrency: num('--concurrency', 3, 1, MAX_CONCURRENCY),
    batches: num('--batches', 2, 0, 4),
    gap: num('--gap', 100, 0, 60000),
    port: num('--port', 8899, 1024, 60000),
    tokens: num('--tokens', mode === 'baseline' ? 1 : 2, 1, 8),
    timeout: num('--timeout', 240000, 15000, 900000),
    recoveryMax: num('--recovery-max', 240000, 0, 900000),
    stormMax: num('--storm-max-ms', 900000, 60000, 3600000),
    diffLimit: num('--diff-limit', 30000, 2000, 120000),
    singleRequests: num('--single-requests', 12, 1, 20),
    repo: path.resolve(get('--repo', REPO_ROOT)),
    tokenFile: path.resolve(get('--token-file', DEFAULT_TOKEN_FILE)),
    artifactDir: path.resolve(get('--artifact-dir', DEFAULT_ARTIFACT_DIR)),
    reviewOut: path.resolve(get('--review-out', DEFAULT_REVIEW_OUT)),
    prompt: get('--prompt', 'Output only the single word OK.'),
    model: get('--model', 'deepseek-reasoner'),
    keep: has('--keep'),
    snapshot: has('--snapshot'),
    help: has('--help') || has('-h'),
  };
  if (mode === 'baseline') opts.tokens = 1;
  return opts;
}

/* ------------------------------------------------------- resources ----- */

const activeChildren = new Set();
const tempHomes = new Set();
const tempFiles = new Set();
let cleanedUp = false;

function killTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } else {
      process.kill(pid, 'SIGKILL');
    }
  } catch {
    /* already gone */
  }
}

async function cleanupAll() {
  if (cleanedUp) return;
  cleanedUp = true;
  for (const child of activeChildren) {
    try {
      if (child.exitCode === null && !child.killed) child.kill();
    } catch {
      /* ignore */
    }
    killTree(child.pid);
  }
  for (const file of tempFiles) {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      /* ignore */
    }
  }
  for (const home of tempHomes) {
    try {
      fs.rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    } catch {
      /* ignore */
    }
  }
}

function registerHome(dir, keep) {
  if (!keep) tempHomes.add(dir);
  return dir;
}

/* ------------------------------------------------------- tokens/auth --- */

function loadTokens(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new Error(`cannot read token file ${file}: ${err.message}`);
  }
  const tokens = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    const name = eq >= 0 ? line.slice(0, eq).trim() : `TOKEN${tokens.length + 1}`;
    const value = (eq >= 0 ? line.slice(eq + 1) : line).trim();
    if (value.length < 20) continue;
    tokens.push({ name, token: value });
    secrets.add(value);
  }
  return tokens;
}

function writeSecretFile(dir, content, label) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${label}-${crypto.randomBytes(5).toString('hex')}.txt`);
  fs.writeFileSync(file, `${content}\n`, { mode: 0o600 });
  tempFiles.add(file);
  return file;
}

function childEnv(home) {
  const env = { ...process.env, DS_BRIDGE_HOME: home, DEEPSEEK_NO_UPDATE: '1' };
  // Never inherit a real user token from the parent shell.
  delete env.DEEPSEEK_TOKEN;
  delete env.DEEPSEEK_USER_TOKEN;
  return env;
}

/* -------------------------------------------------------- ports/msgs --- */

function canListen(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
  });
}

async function findFreePort(start) {
  for (let port = start; port < start + 40; port++) {
    // eslint-disable-next-line no-await-in-loop
    if (await canListen(port)) return port;
  }
  throw new Error(`no free port in ${start}..${start + 40}`);
}

async function readHealth(port, timeoutMs = 1500) {
  try {
    const res = await fetch(`${LOCAL_BASE}:${port}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function httpJson(port, urlPath, { key, method = 'GET', body, timeoutMs = 15000, capture = true } = {}) {
  const started = now();
  const headers = {};
  if (key) headers.authorization = `Bearer ${key}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  try {
    const res = await fetch(`${LOCAL_BASE}:${port}${urlPath}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    if (capture) captured.push(text);
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* non-JSON */
    }
    return { status: res.status, ok: res.ok, json, text, ms: now() - started };
  } catch (err) {
    const aborted = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return {
      status: 0,
      ok: false,
      json: null,
      text: '',
      error: aborted ? 'timeout' : cleanError(err?.message || err),
      ms: now() - started,
    };
  }
}

/* ------------------------------------------------------------ bridge --- */

function readHomeConfig(home) {
  try {
    return JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
  } catch {
    return null;
  }
}

async function startBridge({ repo, home, portStart, logFile }) {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const requestedPort = await findFreePort(portStart);
  const out = fs.openSync(logFile, 'a');
  const child = spawn(process.execPath, [path.join(repo, 'bin', 'ds-bridge.js'), '--port', String(requestedPort)], {
    cwd: repo,
    env: childEnv(home),
    stdio: ['ignore', out, out],
    windowsHide: true,
  });
  fs.closeSync(out);
  activeChildren.add(child);
  child.once('exit', () => activeChildren.delete(child));

  const deadline = now() + 25000;
  let health = null;
  let port = requestedPort;
  while (now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    health = await readHealth(requestedPort);
    if (health?.ok) break;
    const cfg = readHomeConfig(home);
    if (cfg?.port && cfg.port !== requestedPort) {
      // eslint-disable-next-line no-await-in-loop
      health = await readHealth(Number(cfg.port));
      if (health?.ok) {
        port = Number(cfg.port);
        break;
      }
    }
    if (child.exitCode !== null) throw new Error(`bridge exited early (code ${child.exitCode}); see ${logFile}`);
    // eslint-disable-next-line no-await-in-loop
    await sleep(250);
  }
  if (!health?.ok) throw new Error(`bridge did not become healthy on port ${requestedPort} (see ${logFile})`);

  const cfg = readHomeConfig(home);
  if (!cfg?.key) throw new Error(`bridge config missing api key in ${home}`);
  return { child, port, key: cfg.key, health, logFile, home, repo };
}

async function stopBridge(bridge) {
  if (!bridge) return;
  activeChildren.delete(bridge.child);
  killTree(bridge.child.pid);
  const deadline = now() + 10000;
  while (now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    if (!(await readHealth(bridge.port, 500))) return;
    // eslint-disable-next-line no-await-in-loop
    await sleep(250);
  }
  try {
    bridge.child.kill('SIGKILL');
  } catch {
    /* ignore */
  }
}

function readBridgeLog(bridge) {
  try {
    return fs.readFileSync(bridge.logFile, 'utf8');
  } catch {
    return '';
  }
}

/* --------------------------------------------------------------- CLI --- */

function runCli({ repo, home, args, timeoutMs = 120000 }) {
  return new Promise((resolve) => {
    const started = now();
    const child = spawn(process.execPath, [path.join(repo, 'bin', 'deepseek.js'), ...args], {
      cwd: repo,
      env: childEnv(home),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    activeChildren.add(child);
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, timeoutMs);
    timer.unref?.();
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      activeChildren.delete(child);
      captured.push(stdout, stderr);
      resolve({
        code: code ?? (signal ? -1 : 0),
        signal,
        timedOut,
        ms: now() - started,
        stdout: redactText(stripAnsi(stdout)),
        stderr: redactText(stripAnsi(stderr)),
      });
    });
  });
}

function runNodeModule({ repo, home, code, env = {}, timeoutMs = 30000 }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--input-type=module', '--eval', code], {
      cwd: repo,
      env: { ...childEnv(home), ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    activeChildren.add(child);
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => killTree(child.pid), timeoutMs);
    timer.unref?.();
    child.stdout.on('data', (c) => {
      stdout += c.toString('utf8');
    });
    child.stderr.on('data', (c) => {
      stderr += c.toString('utf8');
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      activeChildren.delete(child);
      resolve({ code: code ?? 0, stdout: redactText(stdout), stderr: redactText(stderr) });
    });
  });
}

/* ------------------------------------------------------------ chats --- */

async function chat(opts) {
  const started = now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  timer.unref?.();
  try {
    const res = await fetch(`${LOCAL_BASE}:${opts.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${opts.key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: opts.model,
        messages: opts.messages || [{ role: 'user', content: opts.prompt }],
        stream: false,
      }),
      signal: controller.signal,
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* non-JSON */
    }
    const choice = json?.choices?.[0];
    const message = choice?.message || {};
    const content = typeof message.content === 'string' ? message.content : '';
    const reasoning = typeof message.reasoning_content === 'string' ? message.reasoning_content : '';
    const code = json?.error?.code || json?.error?.type || (res.ok && !content.trim() ? 'empty_content' : null);
    const ok = res.ok && Boolean((content + reasoning).trim());
    const keepText = opts.captureText === true;
    return {
      ok,
      status: res.status,
      code: ok ? null : code || 'http_error',
      message: cleanError(json?.error?.message || ''),
      contentLen: content.length,
      reasoningLen: reasoning.length,
      finish: choice?.finish_reason ?? null,
      usage: json?.usage ?? null,
      latencyMs: now() - started,
      timeout: false,
      ...(keepText ? { content: redactText(content), reasoning: redactText(reasoning) } : {}),
    };
  } catch (err) {
    const aborted = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return {
      ok: false,
      status: 0,
      code: aborted ? 'client_timeout' : 'client_network_error',
      message: cleanError(err?.message || err),
      latencyMs: now() - started,
      timeout: aborted,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Retry exactly once, and only on transport-level errors (never on rate-limit replies). */
async function chatWithNetRetry(opts) {
  let result = await chat(opts);
  if (!result.ok && result.code === 'client_network_error') {
    await sleep(4000);
    result = await chat(opts);
    result.networkRetried = true;
  }
  return result;
}

function recordSummary(records) {
  const total = records.length;
  const ok = records.filter((r) => r.ok).length;
  const byCode = {};
  for (const r of records) {
    if (!r.ok) byCode[r.code || 'unknown'] = (byCode[r.code || 'unknown'] || 0) + 1;
  }
  return {
    total,
    ok,
    failed: total - ok,
    successRate: total ? Number((ok / total).toFixed(3)) : null,
    byCode,
    latency: summarizeLatency(records.map((r) => r.latencyMs)),
  };
}

function labelRecords(records, phase) {
  return records.map((r, i) => ({ phase, index: i + 1, ...r, at: new Date().toISOString() }));
}

/* -------------------------------------------------------- log analysis --- */

function analyzeLog(text) {
  const clean = stripAnsi(text);
  const lines = clean.split(/\r?\n/).filter((line) => line.trim());
  const tests = {
    startRetry: /retrying from the start/i,
    freshSessionRetry: /fresh session/i,
    emptyReply: /empty reply|empty_reply/i,
    throttleWords: /rate.?limit|throttl|too many|429/i,
    upstreamValve: /upstream|cooldown|backoff/i,
    // Rotation log lines emitted by DirectClient.run/runAttempt:
    //   "rotated account <id8> -> <id8> after <code>"
    //   "account <id8> failed (<code>); rotating to another account"
    //   "The DeepSeek account ... replaying on a fresh session." (account_switched)
    // Keep these strict: the normal "chat ok ... account=<id8> ..." line must
    // not count as rotation evidence.
    rotation: /rotated account|rotating to another account|account_switched|replaying on a fresh session/i,
    rotationPair: /\b[a-f0-9]{8}\b\s*(?:->|=>|→)\s*\b[a-f0-9]{8}\b/i,
    accountUse: /\baccount[=: ]+[a-f0-9]{8}\b/i,
    chatOk: /chat ok mode=/i,
    chatFailed: /chat failed/i,
    verify: /verify/i,
  };
  const counts = {};
  const samples = {};
  for (const [key, re] of Object.entries(tests)) {
    counts[key] = 0;
    samples[key] = [];
    for (const line of lines) {
      if (re.test(line)) {
        counts[key]++;
        if (samples[key].length < 8) samples[key].push(cleanError(line));
      }
    }
  }
  return { lines: lines.length, counts, samples, text: clean };
}

function logTail(text, maxLines = 25) {
  return stripAnsi(text)
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .slice(-maxLines)
    .map((line) => cleanError(line));
}

/* ------------------------------------------------- accounts / state --- */

function accountView(account) {
  if (!account || typeof account !== 'object') return null;
  const cooldownUntil = Number(account.cooldownUntil) || 0;
  const view = {
    id: account.id,
    label: account.label ?? null,
    user: account.user ?? null,
    cookies: Array.isArray(account.cookies) ? account.cookies.length : Number(account.cookies) || 0,
    addedAt: account.addedAt ?? null,
    lastUsedAt: account.lastUsedAt ?? null,
    lastSuccessAt: account.lastSuccessAt ?? null,
    cooldownUntil: cooldownUntil || null,
    throttleLevel: Number(account.throttleLevel) || 0,
    throttleHits: Number(account.throttleHits) || 0,
    successCount: Number(account.successCount) || 0,
    failureCount: Number(account.failureCount) || 0,
    lastError: account.lastError ?? null,
    state: cooldownUntil > now() ? `cooling ${Math.ceil((cooldownUntil - now()) / 1000)}s` : 'ready',
  };
  // Defensive: never let a token sneak through, even if a future server
  // accidentally included one.
  if (view.label && [...secrets].some((s) => String(view.label).includes(s))) view.label = '[redacted-token]';
  return view;
}

async function getAccounts(bridge) {
  const res = await httpJson(bridge.port, '/v1/bridge/accounts', { key: bridge.key, timeoutMs: 10000 });
  if (!res.ok || !Array.isArray(res.json?.accounts)) return { available: false, res };
  return {
    available: true,
    count: Number(res.json.count) || res.json.accounts.length,
    accounts: res.json.accounts.map(accountView),
    res,
  };
}

function readAccountsFile(home) {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(home, 'accounts.json'), 'utf8'));
    return Array.isArray(data?.accounts) ? data.accounts : [];
  } catch {
    return null;
  }
}

/** Compare the serialized payload against every known token; any hit is a leak. */
function containsSecret(text) {
  const hay = String(text || '');
  for (const secret of secrets) {
    if (hay.includes(secret)) return true;
    // Prefix check catches accidental partial dumps too.
    if (hay.includes(secret.slice(0, 24))) return true;
  }
  return false;
}

/** Scan every captured auth-gated API payload and CLI output for token leaks. */
function scanCapturedLeaks(name, extraTexts = []) {
  const texts = [...captured, ...extraTexts];
  const hits = texts.filter((text) => containsSecret(text));
  if (hits.length) fail(name, `${hits.length} captured payload(s) contained a token substring`);
  else pass(name, `${texts.length} API/CLI/log payloads scanned, no token substrings`);
}

/* ------------------------------------------------------- assertions --- */

const verdicts = [];

function verdict(name, status, detail, extra) {
  verdicts.push({ name, status, detail, extra });
  const extraText = extra && Object.keys(extra).length ? ` ${redactText(JSON.stringify(extra))}` : '';
  log(`${status.padEnd(4)} ${name}${detail ? ` — ${detail}` : ''}${extraText}`);
}

function pass(name, detail, extra) {
  verdict(name, 'PASS', detail, extra);
}

function fail(name, detail, extra) {
  verdict(name, 'FAIL', detail, extra);
}

function skip(name, detail) {
  verdict(name, 'SKIP', detail);
}

function warn(name, detail, extra) {
  verdict(name, 'WARN', detail, extra);
}

function hasFailures() {
  return verdicts.some((v) => v.status === 'FAIL');
}

/* ------------------------------------------------------ repo snapshot --- */

function snapshotRepo(repo, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const archive = spawnSync('git', ['-C', repo, 'archive', '--format=tar', 'HEAD'], {
    maxBuffer: 128 * 1024 * 1024,
    encoding: 'buffer',
    windowsHide: true,
  });
  if (archive.status !== 0) throw new Error(`git archive failed: ${cleanError(archive.stderr?.toString())}`);
  // Windows' bsdtar does not reliably read a piped archive, so write it to a
  // temporary file next to dest and extract that.
  const tarFile = `${dest}.tar`;
  fs.writeFileSync(tarFile, archive.stdout);
  let untar;
  try {
    untar = spawnSync('tar', ['-x', '-f', tarFile, '-C', dest], {
      maxBuffer: 128 * 1024 * 1024,
      windowsHide: true,
    });
  } finally {
    fs.rmSync(tarFile, { force: true });
  }
  if (untar.status !== 0) throw new Error(`tar extract failed: ${cleanError(untar.stderr?.toString())}`);
  return dest;
}

function readJsonFile(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/* ------------------------------------------------------ mode helpers --- */

function newArtifacts(opts, name) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(opts.artifactDir, `${name}-${stamp}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeArtifact(dir, name, value) {
  const file = path.join(dir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return file;
}

async function addAccountViaCli({ repo, home, token, label, timeoutMs = 120000 }) {
  const file = writeSecretFile(path.dirname(home), token, 'token');
  const result = await runCli({
    repo,
    home,
    args: ['--login', '--manual', '--token-file', file],
    timeoutMs,
  });
  const combined = `${result.stdout}\n${result.stderr}`;
  result.mentionsAccounts = /account/i.test(combined);
  result.tokenLeaked = containsSecret(combined);
  result.label = label;
  return result;
}

function pickRecoveryPrompt() {
  return `Recovery probe ${crypto.randomBytes(4).toString('hex')}. Output only the single word RECOVERED.`;
}

/* ------------------------------------------------------------ baseline --- */

async function modeBaseline(opts) {
  const single = opts.mode === 'single';
  const art = newArtifacts(opts, single ? 'single' : 'baseline');
  captured.length = 0;
  const run = {
    mode: single ? 'single' : 'baseline',
    startedAt: new Date().toISOString(),
    artifacts: art,
    repo: opts.repo,
    snapshot: false,
    params: {
      requests: opts.requests,
      concurrency: opts.concurrency,
      batches: opts.batches,
      port: opts.port,
      model: opts.model,
    },
  };
  let repo = opts.repo;
  if (opts.snapshot) {
    repo = snapshotRepo(opts.repo, path.join(art, 'repo-snapshot'));
    run.snapshot = true;
    run.snapshotVersion = readJsonFile(path.join(repo, 'package.json'))?.version || null;
    log(`baseline snapshot: git HEAD -> ${repo} (v${run.snapshotVersion || '?'})`);
  }
  run.repo = repo;
  const tokens = loadTokens(opts.tokenFile);
  if (!tokens.length) throw new Error(`no tokens in ${opts.tokenFile}`);
  run.tokenNames = tokens.slice(0, 1).map((t) => t.name);

  const home = registerHome(fs.mkdtempSync(path.join(os.tmpdir(), 'dsbridge-baseline-')), opts.keep);
  run.home = home;
  const bridge = await startBridge({ repo, home, portStart: opts.port, logFile: path.join(art, 'bridge.log') });
  run.port = bridge.port;
  run.bridgeVersion = bridge.health?.version || null;
  log(`bridge v${run.bridgeVersion} on port ${bridge.port}, temp home ${home}`);

  try {
    section('baseline setup / login (1 account)');
    const login = await addAccountViaCli({ repo, home, token: tokens[0].token, label: tokens[0].name });
    run.login = { code: login.code, ms: login.ms, timedOut: login.timedOut, tokenLeaked: login.tokenLeaked, mentionsAccounts: login.mentionsAccounts };
    log(`CLI login exit=${login.code} ${login.ms}ms${login.tokenLeaked ? ' TOKEN LEAK IN CLI OUTPUT' : ''}`);
    if (login.code !== 0) log(cleanError(login.stdout || login.stderr));
    const sessionRes = await httpJson(bridge.port, '/v1/bridge/session', { key: bridge.key });
    run.sessionAvailable = Boolean(sessionRes.json?.available);
    log(`session available: ${run.sessionAvailable}`);
    const acct = await getAccounts(bridge);
    run.accountsEndpointAvailable = acct.available;
    if (acct.available) {
      run.poolCount = acct.count;
      log(`pool count before load: ${acct.count}`);
      // Lead criterion 3: a pool of exactly one account must behave like 0.7.8.
      if (run.poolCount === 1) pass('single-account pool (exactly 1 account)');
      else fail('single-account pool (exactly 1 account)', `count=${run.poolCount}`);
    } else if (single) {
      fail('single-account pool (exactly 1 account)', 'accounts endpoint missing');
    }

    section('preflight');
    let preflight = await chatWithNetRetry({
      port: bridge.port,
      key: bridge.key,
      prompt: opts.prompt,
      model: opts.model,
      timeoutMs: opts.timeout,
    });
    if (!preflight.ok) {
      log(`preflight failed (${preflight.code}: ${preflight.message}); one retry after 15s (network tolerance)`);
      await sleep(15000);
      preflight = await chat({ port: bridge.port, key: bridge.key, prompt: opts.prompt, model: opts.model, timeoutMs: opts.timeout });
    }
    run.preflight = preflight;
    log(`preflight: ${preflight.ok ? 'ok' : `failed ${preflight.code}`} ${preflight.latencyMs}ms`);

    // Initial quiet period so a preflight burst does not blur the throttle onset.
    await sleep(3000);

    section(`rapid sequential burst (${opts.requests} requests, ${opts.gap}ms gap)`);
    const seq = [];
    let consecutiveNetwork = 0;
    const seqStart = now();
    for (let i = 0; i < opts.requests; i++) {
      if (consecutiveNetwork >= 3) {
        log('3 consecutive transport failures — uplink looks unstable; stopping the burst');
        break;
      }
      if (now() - seqStart > opts.stormMax) {
        log(`burst time budget (${opts.stormMax}ms) exceeded after ${seq.length} requests — stopping to stay network-gentle`);
        break;
      }
      // eslint-disable-next-line no-await-in-loop
      const r = await chat({ port: bridge.port, key: bridge.key, prompt: opts.prompt, model: opts.model, timeoutMs: opts.timeout });
      r.index = i + 1;
      seq.push(r);
      consecutiveNetwork = r.code === 'client_network_error' ? consecutiveNetwork + 1 : 0;
      const statusText = r.ok ? 'ok' : `${r.code}${r.status ? `(http ${r.status})` : ''}`;
      log(
        `seq ${String(i + 1).padStart(2)} ${String(r.latencyMs).padStart(6)}ms ${statusText}` +
          `${r.contentLen ? ` out=${r.contentLen}c` : ''}`,
      );
      if (opts.gap) await sleep(opts.gap);
    }
    run.sequential = { summary: recordSummary(seq), records: labelRecords(seq, 'seq') };

    section(`parallel batches (${opts.batches} x ${opts.concurrency}, <=6 concurrent)`);
    const par = [];
    for (let b = 1; b <= opts.batches; b++) {
      const batch = Array.from({ length: opts.concurrency }, (_, i) =>
        chat({
          port: bridge.port,
          key: bridge.key,
          prompt: `${opts.prompt} (batch ${b} lane ${i + 1})`,
          model: opts.model,
          timeoutMs: opts.timeout,
        }),
      );
      // eslint-disable-next-line no-await-in-loop
      const results = await Promise.all(batch);
      results.forEach((r, i) => {
        r.batch = b;
        r.lane = i + 1;
        par.push(r);
      });
      const line = results.map((r) => (r.ok ? 'ok' : r.code)).join(', ');
      log(`batch ${b}: ${line} (${results.map((r) => r.latencyMs).join('/')}ms)`);
      if (b < opts.batches) await sleep(5000);
    }
    run.parallel = { summary: recordSummary(par), records: labelRecords(par, 'parallel') };

    const all = [...seq, ...par];
    const failures = all.filter((r) => !r.ok);
    run.all = recordSummary(all);
    // 0.7.8 absorbs shallow throttle windows inside its own retry backoff:
    // requests succeed but with a huge latency. Treat 3x the preflight latency
    // (min 8s) as "throttled" so recovery is measured even with zero failures.
    const thresholdMs = Math.max(8000, Math.round((preflight.latencyMs || 3000) * 3));
    const interimLog = analyzeLog(readBridgeLog(bridge));
    const slowRequests = all.filter((r) => r.ok && r.latencyMs > thresholdMs);
    const throttleObserved = failures.length > 0 || slowRequests.length > 0 || interimLog.counts.startRetry > 0;
    run.throttle = {
      observed: throttleObserved,
      thresholdMs,
      slowSuccessCount: slowRequests.length,
      firstSlowIndex: slowRequests.length ? slowRequests[0].index ?? null : null,
      emptyReplyCount: failures.filter((r) => r.code === 'empty_reply').length,
      firstFailureIndex: failures.length ? failures[0].index ?? null : null,
      failureCodes: recordSummary(failures).byCode,
      logRetryLines: interimLog.counts.startRetry,
      maxLatencyMs: run.all.latency.max ?? null,
    };
    log(
      `throttle: observed=${throttleObserved} slow(>${thresholdMs}ms)=${slowRequests.length} ` +
        `failures=${failures.length} logRetries=${interimLog.counts.startRetry}`,
    );

    section('recovery');
    if (!throttleObserved) {
      run.recovery = { needed: false, note: 'no failures and no slow replies observed; no recovery window to measure' };
      log('no throttle observed — no recovery needed');
    } else {
      const probePrompt = pickRecoveryPrompt();
      const probes = [];
      const recoveryStart = now();
      let recovered = false;
      while (now() - recoveryStart <= opts.recoveryMax) {
        // eslint-disable-next-line no-await-in-loop
        await sleep(Math.min(15000, Math.max(0, opts.recoveryMax - (now() - recoveryStart))));
        if (now() - recoveryStart > opts.recoveryMax) break;
        // eslint-disable-next-line no-await-in-loop
        const probe = await chat({
          port: bridge.port,
          key: bridge.key,
          prompt: probePrompt,
          model: opts.model,
          timeoutMs: opts.timeout,
        });
        probes.push({ waitedMs: now() - recoveryStart, ...probe, message: cleanError(probe.message) });
        log(
          `recovery probe @+${Math.round((now() - recoveryStart) / 1000)}s: ${probe.ok ? 'ok' : probe.code}` +
            ` (${probe.latencyMs}ms, threshold ${thresholdMs}ms)`,
        );
        // Recovered = a fresh request served at a normal latency again.
        if (probe.ok && probe.latencyMs <= thresholdMs) {
          recovered = true;
          break;
        }
      }
      run.recovery = {
        needed: true,
        recovered,
        recoveredAfterMs: recovered ? probes[probes.length - 1].waitedMs : null,
        thresholdMs,
        probes: probes.map((p) => ({
          waitedMs: p.waitedMs,
          ok: p.ok,
          code: p.code,
          status: p.status,
          latencyMs: p.latencyMs,
        })),
      };
    }

    section('state / log analysis');
    const statusRes = await httpJson(bridge.port, '/v1/bridge/status', { key: bridge.key });
    run.status = statusRes.ok
      ? {
          mode: statusRes.json?.mode,
          direct: statusRes.json?.direct
            ? {
                available: statusRes.json.direct.available,
                accounts: statusRes.json.direct.accounts ?? statusRes.json.direct.accountsCount ?? null,
                user: statusRes.json.direct.user ?? null,
              }
            : null,
          upstream: statusRes.json?.upstream ?? null,
        }
      : { error: statusRes.error || `http ${statusRes.status}` };
    const healthRes = await readHealth(bridge.port);
    run.health = healthRes;
    log(`status mode=${run.status.mode} upstream=${JSON.stringify(run.status.upstream)}`);

    const logText = readBridgeLog(bridge);
    run.log = analyzeLog(logText);
    run.logSamples = Object.fromEntries(Object.entries(run.log.samples).filter(([, v]) => v.length));
    fs.writeFileSync(path.join(art, 'bridge-combined.log'), logText, 'utf8');
    log(
      `log: lines=${run.log.lines} retries=${run.log.counts.startRetry} freshSession=${run.log.counts.freshSessionRetry} ` +
        `empty=${run.log.counts.emptyReply} chatFailed=${run.log.counts.chatFailed}`,
    );
    if (run.logSamples.emptyReply?.length) log(`empty-reply log sample: ${run.logSamples.emptyReply[0]}`);
    if (run.logSamples.freshSessionRetry?.length) log(`fresh-session log sample: ${run.logSamples.freshSessionRetry[0]}`);

    section('baseline verdict');
    captured.push(logText);
    const setupOk = login.code === 0 && run.sessionAvailable;
    if (!setupOk) fail('baseline setup', `login exit ${login.code}, session available ${run.sessionAvailable}`);
    else pass('baseline setup', '1-token session live on temp home');
    const anySuccess = all.some((r) => r.ok) && preflight.ok;
    if (!anySuccess) fail('baseline traffic', 'no successful DeepSeek reply at all');
    else pass('baseline traffic', `preflight ok; ${run.all.ok}/${run.all.total} requests succeeded`);
    if (login.tokenLeaked) fail('token redaction in CLI output', 'a token string appeared in CLI output');
    if (run.poolCount === 1) {
      const rotLines = (run.log.counts.rotation || 0) + (run.log.counts.rotationPair || 0);
      if (rotLines === 0) pass('single-account regression: no rotation log lines');
      else fail('single-account regression: no rotation log lines', `${rotLines} rotation-like lines with a 1-account pool`);
      if (run.throttle.observed) pass('single-account regression: throttle absorbed by retries', JSON.stringify(run.throttle));
      else warn('single-account regression: thin throttle evidence', 'no retry/slow-reply evidence in this run');
    }
    scanCapturedLeaks(single ? 'token leak scan (single-account)' : 'token leak scan (baseline)');

    run.finishedAt = new Date().toISOString();
    run.verdicts = verdicts.slice();
    const summaryFile = writeArtifact(art, 'baseline-summary.json', run);
    log(`summary: ${summaryFile}`);
    log('');
    log('BASELINE NUMBERS');
    log(
      `  sequential: ${run.sequential.summary.ok}/${run.sequential.summary.total} ok, p50 ${run.sequential.summary.latency.p50}ms, ` +
        `p95 ${run.sequential.summary.latency.p95}ms, max ${run.sequential.summary.latency.max}ms`,
    );
    log(`  parallel:   ${run.parallel.summary.ok}/${run.parallel.summary.total} ok`);
    log(`  all:        ${run.all.ok}/${run.all.total} ok, failures ${JSON.stringify(run.all.byCode)}, empty_reply x${run.throttle.emptyReplyCount}`);
    log(`  recovery:   ${JSON.stringify(run.recovery)}`);
    return run;
  } finally {
    await stopBridge(bridge);
    try {
      fs.writeFileSync(path.join(art, 'bridge-final.log'), readBridgeLog(bridge), 'utf8');
    } catch {
      /* ignore */
    }
  }
}

/* ------------------------------------------------------------ rotation --- */

async function modeRotation(opts) {
  const art = newArtifacts(opts, 'rotation');
  captured.length = 0;
  const run = {
    mode: 'rotation',
    startedAt: new Date().toISOString(),
    artifacts: art,
    repo: opts.repo,
    params: {
      requests: opts.requests,
      concurrency: opts.concurrency,
      batches: opts.batches,
      model: opts.model,
    },
  };
  const tokens = loadTokens(opts.tokenFile);
  if (tokens.length < 2) throw new Error(`rotation needs 2 tokens, found ${tokens.length} in ${opts.tokenFile}`);
  const live = tokens.slice(0, 2);
  run.accounts = live.map((t) => ({ name: t.name, id: tokenId(t.token) }));

  const home = registerHome(fs.mkdtempSync(path.join(os.tmpdir(), 'dsbridge-rotation-')), opts.keep);
  run.home = home;
  const bridge = await startBridge({ repo: opts.repo, home, portStart: opts.port, logFile: path.join(art, 'bridge.log') });
  run.port = bridge.port;
  run.bridgeVersion = bridge.health?.version || null;
  run.packageVersion = readJsonFile(path.join(opts.repo, 'package.json'))?.version || null;
  log(`bridge v${run.bridgeVersion} on port ${bridge.port} (repo package ${run.packageVersion})`);

  try {
    section('A. add both accounts through the new CLI');
    const logins = [];
    for (const token of live) {
      // eslint-disable-next-line no-await-in-loop
      const login = await addAccountViaCli({ repo: opts.repo, home, token: token.token, label: token.name });
      logins.push({ name: token.name, code: login.code, ms: login.ms, tokenLeaked: login.tokenLeaked, mentionsAccounts: login.mentionsAccounts });
      log(`login ${token.name}: exit=${login.code} ${login.ms}ms`);
      if (login.code !== 0) log(cleanError(login.stderr || login.stdout));
    }
    run.logins = logins;
    let acct = await getAccounts(bridge);
    if (acct.available) {
      run.poolAfterAdd = { count: acct.count, ids: acct.accounts.map((a) => a.id) };
      if (acct.count === 2) pass('pool has 2 accounts after CLI login', `ids ${acct.accounts.map((a) => shortId(a.id)).join(', ')}`);
      else fail('pool has 2 accounts after CLI login', `count=${acct.count}`, run.poolAfterAdd);
    } else {
      const file = readAccountsFile(home);
      if (file) {
        run.poolAfterAdd = { count: file.length, ids: file.map((a) => a.id) };
        if (file.length === 2) pass('pool has 2 accounts after CLI login (accounts.json)', 'accounts endpoint not available yet');
        else fail('pool has 2 accounts after CLI login', `file count=${file.length}`);
      } else {
        fail('pool has 2 accounts after CLI login', 'no accounts endpoint and no accounts.json');
      }
    }

    section('B. dedupe on re-add');
    const dup = await addAccountViaCli({ repo: opts.repo, home, token: live[0].token, label: `${live[0].name}-dup` });
    acct = await getAccounts(bridge);
    const dupCount = acct.available ? acct.count : readAccountsFile(home)?.length;
    run.dedupe = { exit: dup.code, count: dupCount };
    log(`re-add ${live[0].name}: exit=${dup.code}, pool count=${dupCount}`);
    if (dup.code === 0 && dupCount === 2) pass('duplicate token is deduped (still 2 accounts)');
    else if (dup.code === 0 && dupCount === 3) fail('duplicate token created a second account', `count=${dupCount}`);
    else fail('dedupe re-add command failed', `exit=${dup.code} count=${dupCount}`);

    section('C. unlimited pool: add a 3rd (fake, local-only) account then remove it');
    const fakeToken = `fake-live-verify-${crypto.randomBytes(24).toString('hex')}`;
    secrets.add(fakeToken);
    const addFake = await runNodeModule({
      repo: opts.repo,
      home,
      env: { FAKE_TOKEN: fakeToken },
      code: `import { addAccount } from './src/accounts.js';
try {
  const result = addAccount({ token: process.env.FAKE_TOKEN, label: 'live-verify-fake' });
  console.log(JSON.stringify({ ok: true, created: result?.created, count: result?.count }));
} catch (err) {
  console.log(JSON.stringify({ ok: false, error: String(err?.message || err) }));
}`,
    });
    let fakeOk = false;
    try {
      fakeOk = JSON.parse(addFake.stdout.trim().split(/\r?\n/).pop() || '{}').ok === true;
    } catch {
      fakeOk = false;
    }
    if (!fakeOk) {
      run.fakeAccount = { added: false, stderr: cleanError(addFake.stderr) };
      fail('add 3rd (fake) account locally', cleanError(addFake.stderr) || 'addAccount() did not confirm');
    } else {
      acct = await getAccounts(bridge);
      let accounts = acct.available ? acct.accounts : (readAccountsFile(home) || []).map(accountView);
      const fake = accounts.find((a) => String(a.label || '') === 'live-verify-fake');
      const count3 = accounts.length;
      run.fakeAccount = { added: true, count: count3, id: fake?.id ?? null };
      log(`fake account added locally: pool count=${count3}`);
      if (count3 === 3) pass('pool accepts a 3rd account (unbounded, local-only add)', `count=${count3}`);
      else fail('pool did not accept a 3rd account', `count=${count3}`);

      let remove = { code: null };
      let removedVia = null;
      if (fake?.id) {
        remove = await runCli({ repo: opts.repo, home, args: ['accounts', 'remove', fake.id], timeoutMs: 60000 });
        removedVia = 'cli';
        if (remove.code !== 0) {
          const del = await httpJson(bridge.port, `/v1/bridge/accounts/${encodeURIComponent(fake.id)}`, {
            key: bridge.key,
            method: 'DELETE',
          });
          if (del.ok) {
            removedVia = 'api';
            remove = { code: 0, stdout: del.text };
          }
        }
      }
      acct = await getAccounts(bridge);
      accounts = acct.available ? acct.accounts : (readAccountsFile(home) || []).map(accountView);
      run.fakeAccount.removedVia = removedVia;
      run.fakeAccount.countAfterRemove = accounts.length;
      log(`fake account removed via ${removedVia || 'n/a'}: pool count=${accounts.length}`);
      if (accounts.length === 2) pass('fake account removed from the pool', `via ${removedVia}`);
      else fail('fake account remove failed', `count=${accounts.length}`);
    }

    section('D. conversation continuity (account-scoped chat_session)');
    const contPrompt1 = `Conversation check ${crypto.randomBytes(4).toString('hex')}. Reply with the single word ALPHA.`;
    const turn1 = await chat({
      port: bridge.port,
      key: bridge.key,
      prompt: contPrompt1,
      model: opts.model,
      timeoutMs: opts.timeout,
      captureText: true,
    });
    run.continuity = { turn1: { ok: turn1.ok, code: turn1.code, latencyMs: turn1.latencyMs } };
    let contOk = false;
    let contSeen = false;
    if (turn1.ok && turn1.content) {
      const logBefore = analyzeLog(readBridgeLog(bridge)).counts.chatOk || 0;
      const turn2 = await chat({
        port: bridge.port,
        key: bridge.key,
        model: opts.model,
        timeoutMs: opts.timeout,
        captureText: true,
        messages: [
          { role: 'user', content: contPrompt1 },
          { role: 'assistant', content: turn1.content },
          { role: 'user', content: 'Now replay the single word BETA.' },
        ],
      });
      const logAfter = analyzeLog(readBridgeLog(bridge));
      contSeen = /cont=true/.test(logAfter.text);
      contOk = turn2.ok;
      run.continuity.turn2 = { ok: turn2.ok, code: turn2.code, latencyMs: turn2.latencyMs };
      log(`continuation request: ${turn2.ok ? 'ok' : turn2.code} ${turn2.latencyMs}ms, cont=true in log: ${contSeen}`);
      void logBefore;
    } else {
      log(`conversation continuity skipped: first turn ${turn1.ok ? 'empty' : turn1.code}`);
    }
    if (contOk && contSeen) pass('conversation continuation works across the account-aware plan', 'bridge log shows cont=true');
    else if (contOk) warn('conversation continuation works across the account-aware plan', 'request ok but no cont=true log line observed');
    else fail('conversation continuation works across the account-aware plan', `turn2 ${run.continuity.turn2?.code || 'not run'}`);

    section('E. rotation storm');
    const stormStart = now();
    const seq = [];
    let consecutiveNetwork = 0;
    let throttleSnapshot = null;
    const takeThrottleSnapshot = async (reason) => {
      if (throttleSnapshot) return;
      const snap = await getAccounts(bridge);
      throttleSnapshot = {
        reason,
        atMs: now(),
        accounts: snap.available ? snap.accounts : (readAccountsFile(home) || []).map(accountView),
      };
      const cooled = throttleSnapshot.accounts.filter((a) => a.state !== 'ready');
      log(
        `throttle snapshot (${reason}): ${throttleSnapshot.accounts
          .map((a) => `${shortId(a.id)} state=${a.state} hits=${a.throttleHits} level=${a.throttleLevel}`)
          .join('; ')}${cooled.length ? '' : ' (no account cooling at snapshot time)'}`,
      );
    };
    for (let i = 0; i < opts.requests; i++) {
      if (consecutiveNetwork >= 3) {
        log('3 consecutive transport failures — uplink unstable; stopping the storm');
        break;
      }
      if (now() - stormStart > opts.stormMax) {
        log(`storm time budget (${opts.stormMax}ms) exceeded after ${seq.length} requests — stopping to stay network-gentle`);
        break;
      }
      // eslint-disable-next-line no-await-in-loop
      const r = await chat({ port: bridge.port, key: bridge.key, prompt: opts.prompt, model: opts.model, timeoutMs: opts.timeout });
      r.index = i + 1;
      seq.push(r);
      consecutiveNetwork = r.code === 'client_network_error' ? consecutiveNetwork + 1 : 0;
      log(`seq ${String(i + 1).padStart(2)} ${String(r.latencyMs).padStart(6)}ms ${r.ok ? 'ok' : `${r.code}${r.status ? `(http ${r.status})` : ''}`}`);
      if (!r.ok && ['account_unavailable', 'empty_reply', 'server_busy'].includes(r.code)) {
        // eslint-disable-next-line no-await-in-loop
        await takeThrottleSnapshot(`seq ${r.index} ${r.code}`);
      } else if (!throttleSnapshot) {
        // Local-only poll (no DeepSeek traffic): catch a cooldown window that is
        // absorbed transparently by waiting, so it never surfaces as a failure.
        // eslint-disable-next-line no-await-in-loop
        const snap = await getAccounts(bridge);
        const cooling = snap.available ? snap.accounts.filter((a) => a.state !== 'ready') : [];
        if (cooling.length) {
          throttleSnapshot = { reason: `cooling observed after seq ${r.index}`, atMs: now(), accounts: snap.accounts };
          log(
            `throttle snapshot (${throttleSnapshot.reason}): ${cooling
              .map((a) => `${shortId(a.id)} state=${a.state} hits=${a.throttleHits} level=${a.throttleLevel} cooldownUntil=${a.cooldownUntil}`)
              .join('; ')}`,
          );
        }
      }
      if (opts.gap) await sleep(opts.gap);
    }
    run.sequential = { summary: recordSummary(seq), records: labelRecords(seq, 'seq') };

    const par = [];
    for (let b = 1; b <= opts.batches; b++) {
      const batch = Array.from({ length: opts.concurrency }, (_, i) =>
        chat({
          port: bridge.port,
          key: bridge.key,
          prompt: `${opts.prompt} (rotation batch ${b} lane ${i + 1})`,
          model: opts.model,
          timeoutMs: opts.timeout,
        }),
      );
      // eslint-disable-next-line no-await-in-loop
      const results = await Promise.all(batch);
      results.forEach((r, i) => {
        r.batch = b;
        r.lane = i + 1;
        par.push(r);
      });
      log(`batch ${b}: ${results.map((r) => (r.ok ? 'ok' : r.code)).join(', ')}`);
      if (results.some((r) => !r.ok && ['account_unavailable', 'empty_reply', 'server_busy'].includes(r.code))) {
        // eslint-disable-next-line no-await-in-loop
        await takeThrottleSnapshot(`batch ${b}`);
      }
      if (b < opts.batches) await sleep(5000);
    }
    run.parallel = { summary: recordSummary(par), records: labelRecords(par, 'parallel') };
    const all = [...seq, ...par];
    run.storm = { ...recordSummary(all), durationMs: now() - stormStart };

    section('F. rotation evidence / account state');
    acct = await getAccounts(bridge);
    if (acct.available) {
      run.accountsAfter = acct.accounts;
      for (const a of acct.accounts) {
        log(
          `account ${shortId(a.id)} label=${a.label || '-'} cookies=${a.cookies} state=${a.state} ` +
            `throttleLevel=${a.throttleLevel} hits=${a.throttleHits} ok=${a.successCount} fail=${a.failureCount}` +
            `${a.lastError?.code ? ` lastError=${a.lastError.code}` : ''}`,
        );
      }
    } else {
      run.accountsAfter = (readAccountsFile(home) || []).map(accountView);
      log('accounts endpoint unavailable; read accounts.json directly');
    }
    const logText = readBridgeLog(bridge);
    run.log = analyzeLog(logText);
    run.logSamples = Object.fromEntries(Object.entries(run.log.samples).filter(([, v]) => v.length));
    fs.writeFileSync(path.join(art, 'bridge-combined.log'), logText, 'utf8');

    section('rotation verdict');
    const emptyReplyCount = all.filter((r) => !r.ok && r.code === 'empty_reply').length;
    const accountUnavailableCount = all.filter((r) => !r.ok && r.code === 'account_unavailable').length;
    const { successRate, failed, byCode } = run.storm;
    run.emptyReplyCount = emptyReplyCount;
    run.accountUnavailableCount = accountUnavailableCount;
    run.throttleSnapshot = throttleSnapshot;
    if (successRate !== null && successRate >= 0.85 && emptyReplyCount === 0) {
      pass('storm success rate', `${run.storm.ok}/${run.storm.total} = ${successRate}`, { byCode });
    } else if (emptyReplyCount > 0) {
      fail('no final empty_reply during storm', `empty_reply x${emptyReplyCount}`, { byCode });
    } else if (successRate !== null && successRate >= 0.7) {
      warn(
        'storm success rate',
        `${run.storm.ok}/${run.storm.total} = ${successRate}; failures=${JSON.stringify(byCode)}` +
          `${accountUnavailableCount ? ` (${accountUnavailableCount}x account_unavailable = every account cooling, retriable 503)` : ''}`,
      );
    } else {
      fail('storm success rate', `${run.storm.ok}/${run.storm.total} = ${successRate}`, { byCode });
    }
    if (accountUnavailableCount > 0) {
      warn(
        'no client-visible throttle errors (only retriable 503s)',
        `${accountUnavailableCount}x account_unavailable while every account was cooling`,
        { byCode },
      );
    } else if (failed > 0) {
      warn('no client-visible throttle errors (only retriable 503s)', `residual ${JSON.stringify(byCode)}`, { byCode });
    } else {
      pass('no client-visible throttle errors', '0 failed requests');
    }
    if (failed > 0 && emptyReplyCount === 0) run.residualErrors = byCode;

    const accounts = run.accountsAfter || [];
    const usedAccounts = accounts.filter((a) => Number(a.lastUsedAt) > 0);
    const usedIds = usedAccounts.map((a) => a.id);
    const anyThrottle = accounts.some((a) => a.throttleHits > 0 || a.throttleLevel > 0);
    const rotationLog = run.log.counts.rotation || 0;
    const rotationPair = run.log.counts.rotationPair || 0;
    const eventProof = rotationLog > 0 || rotationPair > 0;
    const cooled = accounts.filter((a) => a.cooldownUntil && a.cooldownUntil > now());
    const totalSuccess = accounts.reduce((n, a) => n + (a.successCount || 0), 0);
    const maxSuccess = Math.max(0, ...accounts.map((a) => a.successCount || 0));
    const usageShare = totalSuccess ? Number((maxSuccess / totalSuccess).toFixed(2)) : null;
    run.rotationEvidence = {
      rotationLogLines: rotationLog,
      rotationPairLines: rotationPair,
      accountLogLines: run.log.counts.accountUse || 0,
      usedAccounts: usedIds.map(shortId),
      successCounts: accounts.map((a) => ({ id: a.id, short: shortId(a.id), ok: a.successCount, fail: a.failureCount, hits: a.throttleHits })),
      successShareMax: usageShare,
      anyThrottle,
      cooled: cooled.map((a) => shortId(a.id)),
      stormLatency: run.storm.latency,
    };
    log(
      `storm latency: p50=${run.sequential.summary.latency.p50}ms p95=${run.sequential.summary.latency.p95}ms ` +
        `max=${run.sequential.summary.latency.max}ms; max success share=${usageShare}`,
    );

    // Lead criterion 1a: both account ids used (lastUsedAt / successCount).
    if (accounts.length > 0 && usedIds.length === accounts.length) {
      pass('both accounts used (lastUsedAt set)', `${usedIds.length}/${accounts.length}`, { used: usedIds.map(shortId) });
    } else if (accounts.length > 1) {
      fail('both accounts used (lastUsedAt set)', `${usedIds.length}/${accounts.length} accounts have lastUsedAt`, run.rotationEvidence);
    } else {
      pass('both accounts used (lastUsedAt set)', 'single-account pool');
    }

    // Lead criterion 1b: event-based rotation evidence.
    if (eventProof && anyThrottle) {
      pass(
        'rotation event proven (rotation log + throttle accounting)',
        `rotationLines=${rotationLog + rotationPair} hits=${accounts.map((a) => `${shortId(a.id)}:${a.throttleHits}`).join(',')}`,
        run.rotationEvidence,
      );
    } else if (eventProof) {
      warn('rotation event proven (rotation log + throttle accounting)', 'rotation log line seen but no throttle accounting', run.rotationEvidence);
    } else if (anyThrottle) {
      warn('rotation event proven (rotation log + throttle accounting)', 'throttle accounting seen but the rotation log line did not match', run.rotationEvidence);
    } else {
      warn(
        'rotation event proven (rotation log + throttle accounting)',
        'no throttle surfaced during this storm; live rotation seam not exercised (unit tests cover it)',
        run.rotationEvidence,
      );
    }

    // Lead criterion 1c: throttled account has throttleHits>0 (and was cooling).
    if (anyThrottle) {
      const throttled = accounts.filter((a) => a.throttleHits > 0 || a.throttleLevel > 0);
      pass(
        'throttled account recorded (throttleHits>0)',
        throttled.map((a) => `${shortId(a.id)} hits=${a.throttleHits} level=${a.throttleLevel}`).join('; '),
        { cooled: run.rotationEvidence.cooled },
      );
    } else {
      warn('throttled account recorded (throttleHits>0)', 'no account shows throttleHits>0 in this run');
    }

    // Lead criterion 1c (cont.): prove a cooldown window actually existed —
    // captured at the first throttle/503 mid-storm, because by the time the
    // storm ends a 15s cooldown may already have expired.
    const snapAccounts = throttleSnapshot?.accounts || [];
    const snapCooled = snapAccounts.filter((a) => a.state !== 'ready' || Number(a.cooldownUntil) > 0);
    if (snapCooled.length) {
      pass(
        'account cooldown observed mid-storm',
        snapCooled
          .map((a) => `${shortId(a.id)} state=${a.state} cooldownUntil=${a.cooldownUntil} hits=${a.throttleHits}`)
          .join('; '),
        { snapshotReason: throttleSnapshot.reason },
      );
    } else if (anyThrottle) {
      warn(
        'account cooldown observed mid-storm',
        'throttleHits recorded but no cooling account in the snapshot; cooldown was shorter than the sampling gap',
        { snapshotReason: throttleSnapshot?.reason ?? null },
      );
    } else {
      warn('account cooldown observed mid-storm', 'no throttle event during the storm');
    }

    // Lead criterion 4: starvation + pool intact.
    if (accounts.length === 2) pass('pool still has both accounts after storm', `${accounts.length} accounts`);
    else fail('pool still has both accounts after storm', `${accounts.length} accounts`);
    if (accounts.length === 2 && usedIds.length === 2) {
      if (usageShare != null && usageShare >= 0.8 && totalSuccess >= 10) {
        warn(
          'no account starvation',
          `one account served ${Math.round(usageShare * 100)}% of ${totalSuccess} successes`,
          run.rotationEvidence.successCounts,
        );
      } else {
        pass(
          'no account starvation',
          `success split ${run.rotationEvidence.successCounts.map((c) => `${shortId(c.id)}:${c.ok}`).join(', ')}`,
        );
      }
    } else if (accounts.length === 2) {
      fail('no account starvation', 'at least one account was never used', run.rotationEvidence.successCounts);
    } else {
      fail('no account starvation', `pool has ${accounts.length} accounts after storm`);
    }

    section('G. recovery after cooldown');
    let recoveryResult;
    if (cooled.length) {
      const earliest = Math.min(...cooled.map((a) => a.cooldownUntil));
      const waitMs = Math.max(1000, Math.min(earliest - now() + 2000, 180000));
      log(`waiting ${Math.round(waitMs / 1000)}s for the earliest cooldown (${cooled.map((a) => shortId(a.id)).join(', ')})`);
      await sleep(waitMs);
      const probePrompt = pickRecoveryPrompt();
      let probe = await chat({ port: bridge.port, key: bridge.key, prompt: probePrompt, model: opts.model, timeoutMs: opts.timeout });
      if (!probe.ok) {
        await sleep(20000);
        probe = await chat({ port: bridge.port, key: bridge.key, prompt: pickRecoveryPrompt(), model: opts.model, timeoutMs: opts.timeout });
      }
      const after = await getAccounts(bridge);
      const afterAccounts = after.available ? after.accounts : (readAccountsFile(home) || []).map(accountView);
      const recoveredAccounts = cooled.map((c) => {
        const nowAccount = afterAccounts.find((a) => a.id === c.id);
        const coolingCleared = Boolean(nowAccount) && !(nowAccount.cooldownUntil && nowAccount.cooldownUntil > now());
        const usedAgain = Boolean(nowAccount) && nowAccount.successCount > c.successCount;
        return { id: shortId(c.id), coolingCleared, usedAgain, state: nowAccount?.state ?? null };
      });
      recoveryResult = {
        needed: true,
        waitedMs: waitMs,
        probe: { ok: probe.ok, code: probe.code, status: probe.status, latencyMs: probe.latencyMs },
        accounts: recoveredAccounts,
        accountsAfterRecovery: afterAccounts.map((a) => ({
          id: shortId(a.id),
          state: a.state,
          throttleLevel: a.throttleLevel,
          successCount: a.successCount,
        })),
      };
      if (probe.ok) pass('recovery after cooldown: fresh request succeeds', `ok after ${Math.round(waitMs / 1000)}s wait, ${probe.latencyMs}ms`);
      else fail('recovery after cooldown: fresh request succeeds', `probe still failing: ${probe.code}`, recoveryResult);
      if (recoveredAccounts.every((r) => r.coolingCleared || r.usedAgain)) {
        pass(
          'throttled account recovered (cooldown cleared or used again)',
          recoveredAccounts.map((r) => `${r.id}:${r.coolingCleared ? 'cleared' : 'used-again'}`).join(', '),
        );
      } else {
        fail(
          'throttled account recovered (cooldown cleared or used again)',
          `still cooling: ${recoveredAccounts.filter((r) => !r.coolingCleared && !r.usedAgain).map((r) => r.id).join(', ')}`,
          recoveryResult,
        );
      }
    } else {
      // No cooldown to wait out: still prove the bridge is serving after the storm.
      const probe = await chat({ port: bridge.port, key: bridge.key, prompt: pickRecoveryPrompt(), model: opts.model, timeoutMs: opts.timeout });
      recoveryResult = { needed: false, probe: { ok: probe.ok, code: probe.code, status: probe.status, latencyMs: probe.latencyMs } };
      if (probe.ok) pass('post-storm probe (no cooldown observed)', `ok ${probe.latencyMs}ms`);
      else fail('post-storm probe (no cooldown observed)', `failed ${probe.code}`);
    }
    run.recovery = recoveryResult;

    section('H. token hygiene');
    captured.push(logText);
    if (logins.some((l) => l.tokenLeaked)) fail('token redaction in CLI output', 'token appeared in CLI output');
    scanCapturedLeaks('token leak scan (API/CLI/logs)');
    if (containsSecret(JSON.stringify(run.verdicts || []))) fail('token redaction in verdicts', 'token appeared in verdict strings');
    else pass('token redaction in verdicts', 'no token strings in verdict strings');

    run.finishedAt = new Date().toISOString();
    run.verdicts = verdicts.slice();
    const summaryFile = writeArtifact(art, 'rotation-summary.json', run);
    log(`summary: ${summaryFile}`);
    return run;
  } finally {
    await stopBridge(bridge);
    try {
      fs.writeFileSync(path.join(art, 'bridge-final.log'), readBridgeLog(bridge), 'utf8');
    } catch {
      /* ignore */
    }
  }
}

/* ----------------------------------------------------------------- api --- */

async function modeApi(opts) {
  const art = newArtifacts(opts, 'api');
  captured.length = 0;
  const run = { mode: 'api', startedAt: new Date().toISOString(), artifacts: art, repo: opts.repo };
  const tokens = loadTokens(opts.tokenFile);
  if (tokens.length < 2) throw new Error(`api mode needs 2 tokens, found ${tokens.length}`);
  const [t1, t2] = tokens;
  run.tokenIds = [tokenId(t1.token), tokenId(t2.token)];
  const home = registerHome(fs.mkdtempSync(path.join(os.tmpdir(), 'dsbridge-api-')), opts.keep);
  run.home = home;
  const bridge = await startBridge({ repo: opts.repo, home, portStart: opts.port, logFile: path.join(art, 'bridge.log') });
  run.port = bridge.port;
  run.bridgeVersion = bridge.health?.version || null;
  log(`bridge v${run.bridgeVersion} on port ${bridge.port}`);

  try {
    section('A. CLI add account 1 (live verify)');
    const login1 = await addAccountViaCli({ repo: opts.repo, home, token: t1.token, label: t1.name });
    run.login1 = { code: login1.code, ms: login1.ms, tokenLeaked: login1.tokenLeaked };
    log(`login exit=${login1.code} ${login1.ms}ms`);
    if (login1.code !== 0) log(cleanError(login1.stderr || login1.stdout));

    section('B. accounts API');
    const unauth = await httpJson(bridge.port, '/v1/bridge/accounts');
    if (unauth.status === 401) pass('GET /v1/bridge/accounts requires auth');
    else fail('GET /v1/bridge/accounts requires auth', `status=${unauth.status}`);

    let list = await httpJson(bridge.port, '/v1/bridge/accounts', { key: bridge.key, timeoutMs: 10000 });
    run.listInitial = list.ok
      ? { count: list.json?.count, accounts: (list.json?.accounts || []).map(accountView), tokenLeaked: containsSecret(list.text) }
      : { error: list.error || `http ${list.status}` };
    if (list.ok) {
      if (containsSecret(list.text)) fail('accounts list leaks tokens', 'token string found in GET payload');
      else pass('accounts list leaks no tokens');
      const accounts = list.json?.accounts || [];
      if (Number(list.json?.count) === 1 && accounts.length === 1) pass('accounts list count=1 after first login');
      else fail('accounts list count=1 after first login', `count=${list.json?.count} len=${accounts.length}`);
      const a = accounts[0] || {};
      const missing = ['id', 'cookies'].filter((k) => !(k in a));
      if (!missing.length) pass('redacted account fields present', `id=${shortId(a.id)} cookies=${a.cookies}`);
      else fail('redacted account fields present', `missing ${missing.join(',')}`);
      if (a.id && a.id === tokenId(t1.token).slice(0, a.id.length)) pass('account id matches sha256(token) prefix', shortId(a.id));
      else warn('account id matches sha256(token) prefix', `got ${shortId(a.id)}`);
    } else {
      fail('GET /v1/bridge/accounts', run.listInitial.error);
    }

    section('C. POST add account 2 (live verify) + dedupe');
    const add2 = await httpJson(bridge.port, '/v1/bridge/accounts', {
      key: bridge.key,
      method: 'POST',
      body: { token: t2.token, label: t2.name },
      timeoutMs: 60000,
    });
    const add2Safe = { status: add2.status, ok: add2.ok, verified: add2.json?.verified, count: add2.json?.count, tokenLeaked: containsSecret(add2.text) };
    run.addSecond = add2Safe;
    log(`POST add: http ${add2.status} verified=${add2.json?.verified} count=${add2.json?.count}`);
    if (add2.ok && add2.json?.verified === true && Number(add2.json?.count) === 2) pass('POST add verifies live and pool count=2', `${add2.ms}ms`);
    else fail('POST add verifies live and pool count=2', `http ${add2.status} verified=${add2.json?.verified} count=${add2.json?.count}`);
    if (containsSecret(add2.text)) fail('POST add response leaks token'); else pass('POST add response leaks no token');

    const dup = await httpJson(bridge.port, '/v1/bridge/accounts', {
      key: bridge.key,
      method: 'POST',
      body: { token: t2.token, label: 'dup-live-verify' },
      timeoutMs: 60000,
    });
    run.duplicatePost = { status: dup.status, ok: dup.ok, count: dup.json?.count };
    if (dup.ok && Number(dup.json?.count) === 2) pass('POST duplicate token dedupes (count stays 2)');
    else fail('POST duplicate token dedupes (count stays 2)', `http ${dup.status} count=${dup.json?.count}`);

    section('D. health / status / session token / dashboard');
    const health = await httpJson(bridge.port, '/health');
    const accountsHealth = health.json?.accounts || {};
    run.health = { direct: health.json?.direct, accounts: accountsHealth };
    if (health.ok && Number(accountsHealth.count) === 2 && health.json?.direct === true) pass('/health reports accounts.count=2 and direct=true');
    else fail('/health reports accounts.count=2 and direct=true', JSON.stringify(run.health));

    const status = await httpJson(bridge.port, '/v1/bridge/status', { key: bridge.key });
    const directStatus = status.json?.direct || {};
    // Newer sessionSummary carries a numeric `accounts` count inside `direct`;
    // the server also exposes a top-level `accounts` object.
    const rawStatusAccounts = directStatus.accounts ?? status.json?.accounts;
    const statusAccounts =
      typeof rawStatusAccounts === 'number' ? { count: rawStatusAccounts } : rawStatusAccounts;
    run.statusAccounts = statusAccounts;
    const statusCount = Number(statusAccounts?.count ?? directStatus.accountsCount);
    if (status.ok && statusCount === 2) pass('/v1/bridge/status includes accounts count=2');
    else fail('/v1/bridge/status includes accounts count=2', `http=${status.status} got ${JSON.stringify(rawStatusAccounts ?? directStatus.accountsCount)}`);

    // The session/token endpoint deliberately returns the primary account token
    // (the dashboard needs it), so it is excluded from the leak scan.
    const sessToken = await httpJson(bridge.port, '/v1/bridge/session/token', { key: bridge.key, capture: false });
    run.sessionToken = sessToken.ok
      ? {
          ok: sessToken.json?.ok,
          tokenLength: typeof sessToken.json?.token === 'string' ? sessToken.json.token.length : 0,
          accountId: sessToken.json?.accountId ? shortId(sessToken.json.accountId) : null,
          tokenLeaked: false,
        }
      : { error: sessToken.error || `http ${sessToken.status}` };
    if (sessToken.ok && sessToken.json?.token && sessToken.json?.accountId) pass('session/token returns token + accountId', `accountId=${shortId(sessToken.json.accountId)}`);
    else fail('session/token returns token + accountId', JSON.stringify(run.sessionToken));

    const dash = await httpJson(bridge.port, '/');
    const dashText = dash.text || '';
    run.dashboard = {
      status: dash.status,
      bytes: dashText.length,
      hasAccountsMarker: /accounts/i.test(dashText),
      hasAccountsEndpoint: /\/v1\/bridge\/accounts/.test(dashText),
      hasAddToken: /add.{0,20}token|token.{0,20}add/i.test(dashText),
    };
    if (dash.ok && run.dashboard.hasAccountsMarker && run.dashboard.hasAccountsEndpoint) pass('dashboard HTML contains accounts UI');
    else fail('dashboard HTML contains accounts UI', JSON.stringify(run.dashboard));

    section('E. CLI accounts command');
    list = await httpJson(bridge.port, '/v1/bridge/accounts', { key: bridge.key });
    const ids = (list.json?.accounts || []).map((a) => a.id).filter(Boolean);
    const cliAccounts = await runCli({ repo: opts.repo, home, args: ['accounts'], timeoutMs: 30000 });
    const cliOut = `${cliAccounts.stdout}\n${cliAccounts.stderr}`;
    run.cliAccounts = {
      code: cliAccounts.code,
      tokenLeaked: containsSecret(cliOut),
      mentionsBothIds: ids.every((id) => cliOut.includes(String(id).slice(0, 8)) || cliOut.includes(id)),
      ms: cliAccounts.ms,
    };
    if (cliAccounts.code === 0) pass('`deepseek accounts` exits 0');
    else fail('`deepseek accounts` exits 0', `exit ${cliAccounts.code}: ${cleanError(cliOut).slice(0, 200)}`);
    if (!run.cliAccounts.tokenLeaked) pass('`deepseek accounts` leaks no tokens');
    else fail('`deepseek accounts` leaks no tokens');
    if (run.cliAccounts.mentionsBothIds) pass('`deepseek accounts` lists both accounts');
    else skip('`deepseek accounts` lists both accounts', 'id matching not found (accepted if output is redacted differently)');
    if (opts.repo) log(`cli output sample: ${cleanError(cliAccounts.stdout).split(/\r?\n/).filter(Boolean).slice(0, 4).join(' | ')}`);

    const cliJson = await runCli({ repo: opts.repo, home, args: ['accounts', '--json'], timeoutMs: 30000 });
    run.cliAccountsJson = { code: cliJson.code, tokenLeaked: containsSecret(cliJson.stdout) };
    if (cliJson.code === 0 && !run.cliAccountsJson.tokenLeaked) pass('`deepseek accounts --json` works and leaks no tokens');
    else if (cliJson.code !== 0) skip('`deepseek accounts --json`', 'not implemented (optional)');
    else fail('`deepseek accounts --json` leaks no tokens');

    const cliHelp = await runCli({ repo: opts.repo, home, args: ['help'], timeoutMs: 30000 });
    run.cliHelp = { code: cliHelp.code, hasAccounts: /accounts/i.test(cliHelp.stdout) };
    if (cliHelp.code === 0 && run.cliHelp.hasAccounts) pass('`deepseek help` mentions accounts');
    else fail('`deepseek help` mentions accounts', `exit=${cliHelp.code} found=${run.cliHelp.hasAccounts}`);

    section('F. DELETE remove + clear');
    let current = await httpJson(bridge.port, '/v1/bridge/accounts', { key: bridge.key });
    const second = (current.json?.accounts || []).find((a) => tokenId(t2.token).startsWith(String(a.id || '').slice(0, 8)) || a.id === tokenId(t2.token));
    const remove = second ? await httpJson(bridge.port, `/v1/bridge/accounts/${encodeURIComponent(second.id)}`, { key: bridge.key, method: 'DELETE' }) : null;
    run.deleteAccount = { id: second ? shortId(second.id) : null, status: remove?.status ?? null, ok: remove?.ok ?? false };
    current = await httpJson(bridge.port, '/v1/bridge/accounts', { key: bridge.key });
    if (remove?.ok && Number(current.json?.count) === 1) pass('DELETE /v1/bridge/accounts/:id removes one account');
    else fail('DELETE /v1/bridge/accounts/:id removes one account', JSON.stringify(run.deleteAccount));

    const clear = await httpJson(bridge.port, '/v1/bridge/accounts', { key: bridge.key, method: 'DELETE' });
    current = await httpJson(bridge.port, '/v1/bridge/accounts', { key: bridge.key });
    run.clearAccounts = { status: clear.status, ok: clear.ok, countAfter: current.json?.count };
    if (clear.ok && Number(current.json?.count) === 0) pass('DELETE /v1/bridge/accounts clears the pool');
    else fail('DELETE /v1/bridge/accounts clears the pool', JSON.stringify(run.clearAccounts));

    section('G. token hygiene');
    captured.push(readBridgeLog(bridge));
    scanCapturedLeaks('token leak scan (all API payloads + CLI output + bridge log)');
    if (containsSecret(JSON.stringify(run))) fail('api summary token hygiene', 'token appeared in summary JSON');
    else pass('api summary token hygiene', 'no token strings in summary');

    run.finishedAt = new Date().toISOString();
    run.verdicts = verdicts.slice();
    writeArtifact(art, 'api-summary.json', run);
    return run;
  } finally {
    await stopBridge(bridge);
  }
}

/* -------------------------------------------------------------- review --- */

function buildReviewBundle(repo, limit) {
  const status = spawnSync('git', ['-C', repo, 'status', '--porcelain'], { encoding: 'utf8', windowsHide: true });
  const changes = (status.stdout || '').split(/\r?\n/).filter(Boolean);
  const diff = spawnSync('git', ['-C', repo, 'diff', 'HEAD', '--', '.'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  const chunks = [];
  const byFile = String(diff.stdout || '').split(/^diff --git /m);
  const score = (file) => {
    // Lead asked for the relevant rotation hunks: accounts/direct first.
    if (/src\/accounts\.js$/.test(file)) return 130;
    if (/src\/direct\.js$/.test(file)) return 125;
    if (/src\/(cookies|session)\.js$/.test(file)) return 110;
    if (/src\/openai\.js$/.test(file)) return 105;
    if (/src\/server\.js$/.test(file)) return 100;
    if (/bin\/(deepseek|ds-bridge)\.js$/.test(file)) return 90;
    if (/src\//.test(file)) return 60;
    if (/test\//.test(file)) return 40;
    if (/README|CHANGELOG|package\.json|manifest\.json/.test(file)) return 10;
    return 5;
  };
  for (const chunk of byFile) {
    if (!chunk.trim()) continue;
    const header = chunk.split(/\r?\n/)[0];
    const m = header.match(/^a\/(\S+) b\/(\S+)/);
    const file = m ? m[2] : 'unknown';
    chunks.push({ file, text: `diff --git ${chunk}`, score: score(file) });
  }
  // Include untracked source/test files as full content (git diff does not).
  for (const line of changes) {
    if (!line.startsWith('?? ')) continue;
    const rel = line.slice(3).replace(/\/$/, '');
    if (!/^(src|test|bin|scripts)\//.test(rel)) continue;
    try {
      const content = fs.readFileSync(path.join(repo, rel), 'utf8');
      chunks.push({ file: rel, text: `new file ${rel}\n${content}`, score: score(rel) + 5 });
    } catch {
      /* skip unreadable */
    }
  }
  chunks.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
  let used = 0;
  const parts = [];
  for (const chunk of chunks) {
    if (used >= limit) break;
    const room = limit - used;
    const text = chunk.text.length > room ? `${chunk.text.slice(0, room)}\n... [truncated at ${limit} chars]` : chunk.text;
    parts.push(text);
    used += text.length;
  }
  return { text: parts.join('\n\n'), changes, files: chunks.map((c) => c.file), includedChars: used, totalChars: chunks.reduce((n, c) => n + c.text.length, 0) };
}

async function modeReview(opts) {
  const art = newArtifacts(opts, 'review');
  const run = { mode: 'review', startedAt: new Date().toISOString(), artifacts: art, repo: opts.repo };
  const tokens = loadTokens(opts.tokenFile);
  if (!tokens.length) throw new Error(`no tokens in ${opts.tokenFile}`);
  const home = registerHome(fs.mkdtempSync(path.join(os.tmpdir(), 'dsbridge-review-')), opts.keep);
  run.home = home;
  const bridge = await startBridge({ repo: opts.repo, home, portStart: opts.port, logFile: path.join(art, 'bridge.log') });
  run.port = bridge.port;
  run.bridgeVersion = bridge.health?.version || null;
  log(`bridge v${run.bridgeVersion} on port ${bridge.port}`);
  try {
    const login = await addAccountViaCli({ repo: opts.repo, home, token: tokens[0].token, label: tokens[0].name });
    run.login = { code: login.code, ms: login.ms };
    if (login.code !== 0) throw new Error(`CLI login failed (exit ${login.code}): ${cleanError(login.stderr || login.stdout)}`);

    const bundle = buildReviewBundle(opts.repo, opts.diffLimit);
    run.bundle = { includedChars: bundle.includedChars, totalChars: bundle.totalChars, files: bundle.files };
    log(`review bundle: ${bundle.includedChars}/${bundle.totalChars} chars, ${bundle.files.length} files`);
    const featureBrief = `The repository deepseek-bridge is being changed to support MULTIPLE DeepSeek web tokens in an unbounded persisted pool with automatic per-request account rotation when an account hits account-level rate limits (empty replies, HTTP 429, upload rate limits, expired tokens). Design contract:

- src/accounts.js: persisted pool <config>/accounts.json (0600, atomic, unlimited), accounts keyed by sha256(token) slice 16, fields id/token/cookies/userAgent/user/label/addedAt/updatedAt/lastUsedAt/lastSuccessAt/cooldownUntil/throttleLevel/throttleHits/successCount/failureCount/lastError. Cooldown steps [15s,45s,120s,300s,600s] escalating per throttle event, success decays one level. markAccountExpired excludes an account until re-verified. pickAccount({preferId,excludeIds}) reserves lastUsedAt and picks LRU among non-cooling accounts. Tokens never leave accounts.js except via accountSession()/legacy token endpoint; listAccounts/accountsSummary redacted.
- src/session.js: keeps the old API as a thin layer over the primary account; legacy session.json migrated on first load, kept on disk.
- src/direct.js: per-account session selection, rotation on account-level errors (empty_reply, upload_rate_limited, 429, not_signed_in/expired) only before any text was emitted; thrown code 'account_switched'; per-account cooldown instead of one global valve; in-flight requests of a throttle-hit account finish on their account.
- src/openai.js: conversation plan carries accountId, continuation pinned to the previous account; 'account_switched' triggers a fresh-session replay of the full transcript on another account (only when nothing streamed); withUpstreamSlot skips the process-global cooldown when multiple accounts exist.
- src/server.js: REST /v1/bridge/accounts (GET/POST/DELETE), health/status counts, session/token returns accountId, session/export adds an account instead of replacing, session DELETE clears the pool.
- bin/deepseek.js, bin/ds-bridge.js: --login --manual adds an account (dedupe, unlimited), --replace clears first, new \`deepseek accounts\` command (list/remove/clear), logout clears all, help/banner show pool counts.
- src/dashboard.js: accounts panel (list, refresh, delete, add token, clear all), never displays token values.

Below is the working-tree diff (trimmed). Review it as an adversarial code reviewer. Report CONCRETE bug risks in the rotation design, ordered by severity, each with file:line, the exact failure scenario, and a minimal fix. Focus on: concurrency races (two requests selecting/marking the same account; cooldown vs in-flight requests; account switch mid-stream), conversation/account mismatch (session/chat_session_id created under one account reused on another), token leakage into logs/API/dashboard/errors, cooldown math and starvation, expired-token handling, migration from legacy session.json, unlimited-pool edge cases, and restart/CLI/server consistency. Also list missing or weak tests. Do not praise; be specific and terse.`;
    run.promptChars = featureBrief.length + bundle.text.length;
    const prompt = `${featureBrief}\n\n===== WORKING-TREE DIFF =====\n${bundle.text}`;
    const result = await chat({
      port: bridge.port,
      key: bridge.key,
      prompt,
      model: opts.model,
      timeoutMs: Math.max(opts.timeout, 300000),
      captureText: true,
    });
    run.reviewRequest = { ok: result.ok, code: result.code, status: result.status, latencyMs: result.latencyMs, contentLen: result.contentLen, timeout: result.timeout };
    if (!result.ok) {
      fail('bridge-as-subagent review request', `${result.code}: ${result.message}`);
    } else {
      const raw = String(result.content || '');
      fs.writeFileSync(opts.reviewOut, raw.endsWith('\n') ? raw : `${raw}\n`, 'utf8');
      run.reviewOut = opts.reviewOut;
      run.answerChars = raw.length;
      run.answerPreview = raw.slice(0, 4000);
      pass('bridge-as-subagent review request', `${result.contentLen} chars in ${result.latencyMs}ms`);
      log(`raw answer saved to ${opts.reviewOut}`);
      log(`--- review answer preview (first 1200 chars) ---`);
      log(raw.slice(0, 1200));
      log('--- end preview (full answer in the file above) ---');
    }
    run.finishedAt = new Date().toISOString();
    run.verdicts = verdicts.slice();
    writeArtifact(art, 'review-summary.json', run);
    return run;
  } finally {
    await stopBridge(bridge);
  }
}

/* --------------------------------------------------------------- main --- */

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.mode === 'help' || opts.help) {
    usage();
    return 0;
  }
  if (!['baseline', 'rotation', 'api', 'review', 'all', 'single'].includes(opts.mode)) {
    console.error(`unknown mode: ${opts.mode}`);
    usage();
    return 2;
  }
  fs.mkdirSync(opts.artifactDir, { recursive: true });
  // `all` = the phase-2 verification sweep, ending with Lead criterion 3:
  // a single-account pool must still behave 0.7.8-like (no rotation).
  const modes = opts.mode === 'all' ? ['rotation', 'api', 'review', 'single'] : [opts.mode];
  const results = [];
  try {
    for (const mode of modes) {
      // eslint-disable-next-line no-await-in-loop
      if (mode === 'baseline') results.push(await modeBaseline({ ...opts, snapshot: opts.snapshot }));
      else if (mode === 'single') {
        // eslint-disable-next-line no-await-in-loop
        results.push(
          await modeBaseline({
            ...opts,
            mode: 'single',
            snapshot: false,
            requests: opts.singleRequests,
            batches: 1,
            concurrency: Math.min(2, opts.concurrency),
          }),
        );
      } else if (mode === 'rotation') results.push(await modeRotation(opts));
      else if (mode === 'api') results.push(await modeApi(opts));
      else if (mode === 'review') results.push(await modeReview(opts));
    }
  } finally {
    await cleanupAll();
  }
  const failed = verdicts.some((v) => v.status === 'FAIL');
  const counts = verdicts.reduce((acc, v) => {
    acc[v.status] = (acc[v.status] || 0) + 1;
    return acc;
  }, {});
  section('FINAL');
  log(`verdicts: ${JSON.stringify(counts)}`);
  if (failed) {
    log('FAILED criteria:');
    for (const v of verdicts.filter((x) => x.status === 'FAIL')) log(`  - ${v.name}: ${v.detail}`);
    return 1;
  }
  log('all criteria passed');
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch(async (err) => {
    console.error(`harness error: ${cleanError(err?.stack || err)}`);
    await cleanupAll();
    process.exitCode = 2;
  });

process.on('SIGINT', async () => {
  await cleanupAll();
  process.exit(130);
});
