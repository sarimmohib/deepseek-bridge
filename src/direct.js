/*
 * Direct chat.deepseek.com client.
 *
 * This is the same request flow the content script uses, moved into Node so
 * Chrome does not have to stay open. The session (cookies + localStorage
 * userToken) is captured once by `deepseek --login`.
 */
import crypto from 'node:crypto';
import { Blob } from 'node:buffer';
import { BridgeError } from './agent.js';
import { solveChallenge } from './pow.js';
import { cookieHeader } from './cookies.js';
import {
  accountCount,
  accountSession,
  getAccount,
  getPrimaryAccount,
  hasAccounts,
  loadAccounts,
  markAccountExpired,
  markAccountFailure,
  markAccountSuccess,
  markAccountThrottle,
  nextAvailableAt,
  pickAccount,
  updateAccountCookies,
} from './accounts.js';

const API = 'https://chat.deepseek.com/api/v0';
const ORIGIN = 'https://chat.deepseek.com';
const CLIENT_VERSION = '2.5.0';
const DEFAULT_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const HARD_TIMEOUT = 15 * 60 * 1000;
const STREAM_IDLE_TIMEOUT = 120 * 1000;
const SETUP_IDLE_TIMEOUT = 60 * 1000;
// uploadAttachment never resets the idle timer, so this caps the whole upload.
const UPLOAD_IDLE_TIMEOUT = 10 * 60 * 1000;
const DEFAULT_RETRY_DELAYS = [700, 1800, 4000, 8000];
// Empty replies are DeepSeek's per-account rate throttle (measured: ~13
// rapid-fire sequential requests trigger it, ~10-15s to recover). Back off
// properly instead of hammering through the window.
const EMPTY_RETRY_DELAYS = [3000, 9000, 20000, 35000];

// Multi-account rotation. A request may park while every account is cooling
// down, but must never stall a caller forever. The budget is one full
// first-level account cooldown (15s, see ACCOUNT_COOLDOWN_STEPS[0]): a small
// pool waits it out instead of surfacing pointless instant 503s (0.7.8 rode the
// same window out with its 3-35s empty-reply backoff). Longer parks — expired
// accounts get 5 minutes — are further away than the budget and surface a
// retriable 503 immediately.
const ROTATION_WAIT_BUDGET_MS = 15_000;
const ROTATION_WAIT_STEP_MS = 2000;

// Account-level throttle valve. DeepSeek's empty replies are a rate window,
// and under concurrent harness load each client's private backoff still lets
// the next client hammer straight into it. These helpers publish a GLOBAL
// cool-down: every upstream acquisition waits it out, and successes decay it.
export const upstreamThrottle = { until: 0, level: 0 };
const THROTTLE_STEPS = [10_000, 20_000, 40_000, 80_000];

export function noteUpstreamThrottleEvent() {
  upstreamThrottle.level = Math.min(upstreamThrottle.level + 1, THROTTLE_STEPS.length);
  upstreamThrottle.until = Date.now() + THROTTLE_STEPS[upstreamThrottle.level - 1];
}

export function noteUpstreamSuccess() {
  upstreamThrottle.level = Math.max(0, upstreamThrottle.level - 1);
  if (upstreamThrottle.level === 0) upstreamThrottle.until = 0;
}

export function upstreamCooldownMs() {
  return Math.max(0, upstreamThrottle.until - Date.now());
}
const MAX_START_ATTEMPTS = 4;
const MAX_RECOVERY_ATTEMPTS = 4;

// Account ids are hex digests; never log more than a short prefix (tokens are
// credentials and must never reach a log line).
function shortAccountId(id) {
  return String(id || '').slice(0, 8) || '?';
}

function loadPrimarySession() {
  const account = getPrimaryAccount();
  return account ? accountSession(account) : null;
}

// A failure that says "this account is throttled or signed out", so another
// account could serve the same request. Only acted upon when the pool has more
// than one account: single-account deployments keep the 0.7.8 retry behavior.
function isAccountLevelFailure(err) {
  const code = err?.code;
  return (
    code === 'empty_reply' ||
    code === 'upload_rate_limited' ||
    code === 'not_signed_in' ||
    Number(err?.status) === 429
  );
}

function looksLikeHtml(text) {
  return /^\s*(?:<!doctype html|<html)/i.test(String(text || ''));
}

function cancelledError() {
  return new BridgeError('Client cancelled the request.', 'cancelled', 499);
}

function timeoutError() {
  return new BridgeError('Job exceeded the 15 minute limit.', 'timeout', 504);
}

function retryAfterFrom(response) {
  const raw = response?.headers?.get?.('retry-after');
  if (!raw) return 0;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : 0;
}

function isTransientStatus(status) {
  return status === 202 || status === 408 || status === 425 || status === 429 || status >= 500;
}

function isTransientError(err) {
  const code = err?.code;
  if (!code) return false;
  if (
    code === 'cancelled' ||
    code === 'timeout' ||
    code === 'not_signed_in' ||
    code === 'invalid_attachment' ||
    code === 'invalid_parent' ||
    code === 'recovery_unavailable' ||
    code === 'stream_error'
  ) {
    return false;
  }
  if (
    code === 'network_error' ||
    code === 'stream_interrupted' ||
    code === 'stream_stalled' ||
    code === 'server_busy' ||
    code === 'invalid_pow' ||
    code === 'continue_locked' ||
    // Retriable like a transient failure, but capped at one attempt overall by
    // run()'s fileRetryUsed flag so a permanently stuck file cannot loop.
    code === 'file_not_ready' ||
    // Retried by the start loop only while nothing reached the client; a
    // persistently empty model surfaces after MAX_START_ATTEMPTS.
    code === 'empty_reply' ||
    code === 'upload_rate_limited'
  ) {
    return true;
  }
  return (
    isTransientStatus(Number(err.status)) ||
    /busy|overload|rate.?limit|too many|try again|temporar|network|gateway|timed? ?out|fetch failed/i.test(
      String(err.message || ''),
    )
  );
}

function sleep(ms, signal) {
  if (!ms) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(cancelledError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort);
      resolve();
    }, ms);
    timer.unref?.();
    const onAbort = () => {
      clearTimeout(timer);
      reject(cancelledError());
    };
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

function createAttempt({ signal, deadline, idleTimeout = STREAM_IDLE_TIMEOUT }) {
  const controller = new AbortController();
  let idleTimer = null;
  let hardTimer = null;
  let disposed = false;

  const abortWith = (err) => {
    if (!controller.signal.aborted) controller.abort(err);
  };
  const onClientAbort = () => abortWith(cancelledError());
  if (signal?.aborted) onClientAbort();
  else signal?.addEventListener?.('abort', onClientAbort, { once: true });

  const remaining = Number.isFinite(deadline) ? Math.max(0, deadline - Date.now()) : 0;
  if (remaining <= 0) abortWith(timeoutError());
  else {
    hardTimer = setTimeout(() => abortWith(timeoutError()), remaining);
    hardTimer.unref?.();
  }

  const resetIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    if (disposed || controller.signal.aborted) return;
    idleTimer = setTimeout(
      () => abortWith(new BridgeError('DeepSeek stream stalled (no data).', 'stream_stalled', 504)),
      idleTimeout,
    );
    idleTimer.unref?.();
  };
  resetIdle();

  return {
    signal: controller.signal,
    resetIdle,
    dispose() {
      disposed = true;
      if (idleTimer) clearTimeout(idleTimer);
      if (hardTimer) clearTimeout(hardTimer);
      signal?.removeEventListener?.('abort', onClientAbort);
    },
  };
}

function normalizeAttemptError(err, attempt, outerSignal) {
  if (outerSignal?.aborted) return cancelledError();
  const reason = attempt?.signal?.reason;
  if (attempt?.signal?.aborted && reason) {
    if (reason instanceof BridgeError) return reason;
    if (reason instanceof Error) {
      return new BridgeError(reason.message, reason.code || 'stream_stalled', reason.status || 504);
    }
  }
  if (err instanceof BridgeError) return err;
  if (err?.name === 'AbortError') {
    return attempt?.signal?.aborted ? new BridgeError('DeepSeek stream was interrupted.', 'stream_interrupted', 502) : cancelledError();
  }
  if (err instanceof TypeError || /fetch failed|terminated|network/i.test(String(err?.message || ''))) {
    return new BridgeError(`DeepSeek network error: ${err?.message || err}`, 'network_error', 502);
  }
  return new BridgeError(err?.message || String(err), err?.code || 'deepseek_error', err?.status || 502);
}

/**
 * Return the part of `incoming` that is not already represented by `existing`.
 * Continue/resume responses can replay the complete assistant message; this
 * keeps the bridge from sending that replay to the client a second time.
 */
function missingSuffix(existing, incoming) {
  if (!incoming) return '';
  if (!existing) return incoming;
  if (incoming === existing) return '';
  if (incoming.startsWith(existing)) return incoming.slice(existing.length);
  if (existing.endsWith(incoming)) return '';

  // KMP: longest prefix of `incoming` that is also a suffix of `existing`.
  const prefix = new Uint32Array(incoming.length);
  for (let i = 1, j = 0; i < incoming.length; i++) {
    while (j > 0 && incoming[i] !== incoming[j]) j = prefix[j - 1];
    if (incoming[i] === incoming[j]) j++;
    prefix[i] = j;
  }
  let matched = 0;
  for (let i = 0; i < existing.length; i++) {
    while (matched > 0 && existing[i] !== incoming[matched]) matched = prefix[matched - 1];
    if (existing[i] === incoming[matched]) matched++;
    if (matched === incoming.length) {
      if (i === existing.length - 1) return '';
      matched = prefix[matched - 1];
    }
  }
  return matched > 0 ? incoming.slice(matched) : incoming;
}

function fullMessageFromJson(json) {
  const data = json?.data?.biz_data ?? json?.data ?? json;
  const candidates = [data?.message, data?.chat_message, data];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue;
    if (Array.isArray(candidate.fragments) || typeof candidate.content === 'string') return candidate;
    if (candidate.message && typeof candidate.message === 'object') return candidate.message;
  }
  return null;
}

function applyFullMessage(message, emit) {
  if (!message) return;
  const copy = { ...message };
  if (copy.fragments && !Array.isArray(copy.fragments)) copy.fragments = Object.values(copy.fragments);
  if (Array.isArray(copy.fragments) && copy.fragments.length) {
    const acc = createAccumulator(emit);
    acc.applyMessage({ v: { response: copy } });
    return;
  }
  if (typeof copy.content === 'string' && copy.content) emit({ kind: 'content', text: copy.content });
}

/* ----------------------------------------------------------- sse parser --- */

function normalizeStatus(value) {
  // Exact matches first: the hot path never pays for toUpperCase().
  if (value === 'FINISHED' || value === 'WIP') return value;
  if (typeof value !== 'string') return null;
  const upper = value.toUpperCase();
  if (upper === 'FINISHED') return 'FINISHED';
  if (upper === 'WIP') return 'WIP';
  // ANY other observed status (STOPPED, PAUSED, whatever DeepSeek adds) is
  // passed through uppercased: the completion gates treat "not explicitly
  // FINISHED" as resumable, so new statuses are handled without changes here.
  return upper;
}

/**
 * Lifecycle status carried by an SSE event, if any: 'FINISHED', 'WIP', or
 * null when the event says nothing about it. Accepted shapes (live captures):
 *   - snapshots: {v:{response:{status|quasi_status:'...'}}} (usually with
 *     fragments), {v:{status:'...'}} when v is the response itself, and
 *     {v:{response:{...}}} reached through a patch value;
 *   - JSON patches: {p:'response/status'|'response/quasi_status',o:'SET',v:'...'}
 *     (the leaf segment decides, so deeper/shorter paths work too);
 *   - BATCH patches whose sub-patches carry any of the shapes above.
 * O(1)-ish per event: property reads and a leaf-segment check; BATCH only
 * scans that one event's small sub-patch list. Unknown status strings map to
 * null so run() keeps today's behavior for flows this does not recognize.
 */
function extractStatus(data) {
  if (!data || typeof data !== 'object') return null;
  if (data.o === 'BATCH' && Array.isArray(data.v)) {
    let found = null;
    for (const sub of data.v) {
      const seen = extractStatus(sub);
      if (seen) found = seen;
    }
    return found;
  }
  if (typeof data.p === 'string') {
    const leaf = data.p.slice(data.p.lastIndexOf('/') + 1);
    if (leaf === 'status' || leaf === 'quasi_status') return normalizeStatus(data.v);
    // SET of a whole sub-object (e.g. p:'response') may carry the status.
    return data.v && typeof data.v === 'object' ? extractStatus({ v: data.v }) : null;
  }
  const v = data.v;
  const response = v && typeof v === 'object' ? v.response ?? v : data.response;
  if (!response || typeof response !== 'object') return null;
  return normalizeStatus(response.status ?? response.quasi_status);
}

/* File lifecycle objects embedded in SSE frames (live shape: the completion's
 * user-message snapshot carries each referenced file as
 * {"id":"file-...","status":"SUCCESS|PENDING|ERROR|FAILED","file_name":...}). */

const FILE_SCAN_MAX_DEPTH = 6;
const FILE_SCAN_MAX_NODES = 256;

/**
 * Collect file objects from one SSE frame into `into` (id -> {status, name}).
 * The walk accepts a file object at any depth but is capped by depth and a
 * per-frame node budget, so even a large replay snapshot stays O(small);
 * frames are JSON.parse output, so cycles are impossible.
 */
function collectFileStatus(data, into) {
  if (!data || typeof data !== 'object') return;
  let budget = FILE_SCAN_MAX_NODES;
  const walk = (node, depth) => {
    if (budget <= 0 || depth > FILE_SCAN_MAX_DEPTH) return;
    if (node == null || typeof node !== 'object') return;
    budget--;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    const id = node.id;
    if (typeof id === 'string' && id.startsWith('file-') && typeof node.status === 'string') {
      into[id] = { status: node.status, name: typeof node.file_name === 'string' ? node.file_name : null };
      return; // a file object is a leaf for this purpose
    }
    for (const key of Object.keys(node)) walk(node[key], depth + 1);
  };
  walk(data, 0);
}

function createAccumulator(emit) {
  const state = { response: null, lastPath: null };

  function flush() {
    const frags = state.response?.fragments;
    if (!Array.isArray(frags)) return;
    for (const frag of frags) {
      const prev = frag.__emitted || 0;
      const text = typeof frag.content === 'string' ? frag.content : '';
      if (text.length > prev) {
        const kind = frag.type === 'THINK' ? 'reasoning' : frag.type === 'RESPONSE' ? 'content' : null;
        if (kind) emit({ kind, text: text.slice(prev) });
        frag.__emitted = text.length;
      }
    }
  }

  function child(node, key) {
    if (key === '-1') return Array.isArray(node) ? node[node.length - 1] : undefined;
    return node?.[key];
  }

  function assign(parent, key, value) {
    if (!parent) return;
    if (key === '-1' && Array.isArray(parent)) parent[parent.length - 1] = value;
    else parent[key] = value;
  }

  function applyPath(path, op, value) {
    if (!path) return;
    const parts = String(path).split('/').filter(Boolean);
    if (parts[0] === 'response') parts.shift();

    if (op === 'BATCH') {
      for (const sub of value || []) {
        const subPath = sub.p ? `${path.replace(/\/$/, '')}/${sub.p}` : path;
        applyPath(subPath, sub.o || 'SET', sub.v);
      }
      return;
    }

    if (parts.length === 0) {
      if (op === 'SET' && value && typeof value === 'object') {
        state.response = value.response ? { ...state.response, ...value } : value;
      }
      return;
    }
    let node = state.response;
    for (let i = 0; i < parts.length - 1; i++) {
      node = child(node, parts[i]);
      if (node == null) return;
    }
    const key = parts[parts.length - 1];

    if (op === 'SET') {
      assign(node, key, value);
    } else if (op === 'APPEND') {
      const existing = child(node, key);
      if (Array.isArray(existing)) existing.push(...(Array.isArray(value) ? value : [value]));
      else if (typeof existing === 'string') assign(node, key, existing + (value ?? ''));
      else if (typeof value === 'string') assign(node, key, value);
      else assign(node, key, value);
    } else if (op === 'PREPEND') {
      const existing = child(node, key);
      assign(node, key, typeof existing === 'string' ? (value ?? '') + existing : value);
    } else if (op === 'REMOVE') {
      if (Array.isArray(node) && key === '-1') node.pop();
    } else {
      assign(node, key, value);
    }

    state.lastPath = path;
    flush();
  }

  function applyMessage(msg) {
    if (msg == null || typeof msg !== 'object') return;

    if (msg.p === undefined && msg.v !== undefined) {
      if (typeof msg.v === 'string') {
        if (state.lastPath) applyPath(state.lastPath, 'APPEND', msg.v);
        else if (Array.isArray(state.response?.fragments) && state.response.fragments.length) {
          const last = state.response.fragments[state.response.fragments.length - 1];
          last.content = (last.content || '') + msg.v;
          flush();
        }
      } else if (msg.v && typeof msg.v === 'object' && !Array.isArray(msg.v)) {
        if (msg.v.response) state.response = msg.v.response;
        else if (state.response) Object.assign(state.response, msg.v);
        else state.response = msg.v;
        flush();
      }
      return;
    }

    if (msg.p !== undefined) {
      const op = msg.o || (typeof msg.v === 'string' ? 'APPEND' : 'SET');
      applyPath(msg.p, op, msg.v);
    }
  }

  return { applyMessage, state };
}

function parseSSEStream(buffer, onEvent) {
  let idx;
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx).replace(/\r$/, '');
    buffer = buffer.slice(idx + 1);
    if (line === '') {
      onEvent.dispatch();
      continue;
    }
    if (line.startsWith(':')) continue;
    if (line.startsWith('event:')) onEvent.setEvent(line.slice(6).trim());
    else if (line.startsWith('data:')) onEvent.pushData(line.slice(5).trim());
  }
  return buffer;
}

function sseHandler(handlers) {
  let eventName = null;
  let dataLines = [];
  return {
    setEvent(name) {
      eventName = name;
    },
    pushData(line) {
      dataLines.push(line);
    },
    dispatch() {
      const name = eventName || 'message';
      const raw = dataLines.join('\n');
      eventName = null;
      dataLines = [];
      if (handlers.debugLines) handlers.debugLines.push(`${name} ${raw}${raw ? '' : '(empty)'}`.slice(0, 300));
      if (!raw) {
        // close/finish events are often sent with no data. The stream reader
        // must still see them, otherwise a clean EOF looks like a truncation.
        handlers.onEvent?.(name, {});
        return;
      }
      let data;
      try {
        data = JSON.parse(raw);
      } catch {
        return;
      }
      handlers.onEvent(name, data);
    },
  };
}

/* ------------------------------------------------------------- cookies --- */

function parseSetCookie(line) {
  if (!line || typeof line !== 'string') return null;
  const [pair, ...attrs] = line.split(';');
  const eq = pair.indexOf('=');
  if (eq <= 0) return null;
  const cookie = {
    name: pair.slice(0, eq).trim(),
    value: pair.slice(eq + 1).trim(),
    domain: 'chat.deepseek.com',
    hostOnly: true,
    path: '/',
    secure: false,
    httpOnly: false,
    sameSite: null,
    expirationDate: null,
  };
  for (const attr of attrs) {
    const i = attr.indexOf('=');
    const key = (i < 0 ? attr : attr.slice(0, i)).trim().toLowerCase();
    const value = i < 0 ? '' : attr.slice(i + 1).trim();
    if (key === 'domain') {
      cookie.domain = value.toLowerCase();
      cookie.hostOnly = false;
    } else if (key === 'path') {
      cookie.path = value || '/';
    } else if (key === 'secure') {
      cookie.secure = true;
    } else if (key === 'httponly') {
      cookie.httpOnly = true;
    } else if (key === 'samesite') {
      cookie.sameSite = value || null;
    } else if (key === 'max-age') {
      const seconds = Number(value);
      if (Number.isFinite(seconds)) cookie.expirationDate = Date.now() / 1000 + seconds;
    } else if (key === 'expires') {
      const time = Date.parse(value);
      if (Number.isFinite(time)) cookie.expirationDate = time / 1000;
    }
  }
  if (cookie.expirationDate && cookie.expirationDate <= Date.now() / 1000) return null;
  return cookie;
}

/* --------------------------------------------------------------- client --- */

export class DirectClient {
  constructor({ log = () => {}, retryDelays = DEFAULT_RETRY_DELAYS, emptyRetryDelays = EMPTY_RETRY_DELAYS } = {}) {
    this.log = log;
    this.retryDelays = Array.isArray(retryDelays) && retryDelays.length ? retryDelays : DEFAULT_RETRY_DELAYS;
    this.emptyRetryDelays =
      Array.isArray(emptyRetryDelays) && emptyRetryDelays.length ? emptyRetryDelays : EMPTY_RETRY_DELAYS;
    // Kept in sync for compatibility with the old single-session API; every
    // run uses its own ctx={accountId,session} so concurrent runs never share
    // (or race) a session.
    this.session = loadPrimarySession();
  }

  nextRetryDelay(index, retryAfter = 0, delays = this.retryDelays) {
    if (retryAfter > 0) return Math.min(60_000, retryAfter);
    const base = delays[Math.min(index, delays.length - 1)];
    return base > 0 ? base + Math.floor(Math.random() * 250) : 0;
  }

  /** More than one account: requests rotate instead of retrying one token. */
  get hasMultipleAccounts() {
    return accountCount() > 1;
  }

  get available() {
    return hasAccounts();
  }

  reloadSession() {
    this.session = loadPrimarySession();
    return this.session;
  }

  /** Per-run account context: the token/cookies snapshot plus its account id. */
  contextFor(account) {
    return { accountId: account.id, session: accountSession(account) };
  }

  captureCookies(res, ctx) {
    let lines = [];
    try {
      lines = res.headers.getSetCookie?.() || [];
    } catch {
      lines = [];
    }
    if (!lines.length) {
      const raw = res.headers.get('set-cookie');
      if (raw) lines = [raw];
    }
    if (!lines.length) return;
    const cookies = lines.map(parseSetCookie).filter(Boolean);
    if (!cookies.length) return;
    // Cookies belong to the account that made the request, never the singleton.
    const updated = updateAccountCookies(ctx.accountId, cookies);
    if (!updated) return;
    ctx.session = accountSession(updated);
    // Legacy single-account views still read this.session.
    if (!this.hasMultipleAccounts) this.session = ctx.session;
  }

  baseHeaders(ctx) {
    const session = ctx?.session;
    if (!session?.token) {
      throw new BridgeError(
        'No terminal DeepSeek session. Run `deepseek --login` in a terminal where the bridge extension can copy your browser session.',
        'not_signed_in',
        401,
      );
    }
    const headers = {
      authorization: `Bearer ${session.token}`,
      'user-agent': session.userAgent || DEFAULT_UA,
      'x-client-bundle-id': 'com.deepseek.chat',
      'x-client-locale': 'en_US',
      'x-client-platform': 'web',
      'x-client-timezone-offset': String(-new Date().getTimezoneOffset() * 60),
      'x-client-version': CLIENT_VERSION,
      accept: '*/*',
      origin: ORIGIN,
      referer: `${ORIGIN}/`,
      'accept-language': 'en-US,en;q=0.9',
    };
    const cookie = cookieHeader(session);
    if (cookie) headers.cookie = cookie;
    return headers;
  }

  async request(path, ctx, { method = 'POST', body, form = false, headers = {}, signal } = {}) {
    const finalHeaders = { ...this.baseHeaders(ctx), ...headers };
    if (!form) finalHeaders['content-type'] = 'application/json';
    const res = await fetch(`${API}${path}`, {
      method,
      headers: finalHeaders,
      body: method === 'GET' ? undefined : form ? body : JSON.stringify(body ?? {}),
      signal,
      redirect: 'follow',
    });
    this.captureCookies(res, ctx);
    return res;
  }

  async api(path, ctx, { method = 'POST', body, headers = {}, signal } = {}) {
    const res = await this.request(path, ctx, { method, body, headers, signal });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      if (looksLikeHtml(text)) {
        const signedOut = res.status === 401 || res.status === 403;
        throw new BridgeError(
          'DeepSeek returned its web page instead of API JSON. The web session may have expired; run `deepseek --login` again.',
          signedOut ? 'not_signed_in' : 'server_busy',
          res.status || 502,
        );
      }
      throw new BridgeError(
        `DeepSeek API ${path} returned HTTP ${res.status}: ${text.slice(0, 160)}`,
        'deepseek_http_error',
        res.status || 502,
      );
    }
    if (!res.ok || json?.code !== 0 || (json?.data && json.data.biz_code != null && json.data.biz_code !== 0)) {
      const bizMsg = json?.data?.biz_msg || json?.msg || `HTTP ${res.status}`;
      let code = 'deepseek_error';
      if (json?.code === 401 || /sign in|login|token|not logged/i.test(String(bizMsg))) code = 'not_signed_in';
      else if (/invalid message id|message not found|invalid parent|not a leaf/i.test(String(bizMsg))) code = 'invalid_parent';
      else if (isTransientStatus(res.status) || /busy|overload|rate.?limit|too many|try again|temporar/i.test(String(bizMsg))) {
        code = 'server_busy';
      }
      const err = new BridgeError(
        `DeepSeek ${path}: ${bizMsg}. If the browser session expired, run \`deepseek --login\` again.`,
        code,
        res.status === 200 ? 502 : res.status || 502,
      );
      err.retryAfter = retryAfterFrom(res);
      throw err;
    }
    return json.data?.biz_data ?? {};
  }

  async verify(signal, { accountId } = {}) {
    // /users is not consistently available to the web API. A PoW challenge is
    // a small authenticated call and proves the copied token and cookies work.
    const account = accountId ? getAccount(accountId) : getPrimaryAccount();
    if (!account?.token) {
      throw new BridgeError(
        'No terminal DeepSeek session. Run `deepseek --login` first.',
        'not_signed_in',
        401,
      );
    }
    const ctx = this.contextFor(account);
    const data = await this.api('/chat/create_pow_challenge', ctx, {
      body: { target_path: '/api/v0/chat/completion' },
      signal,
    });
    if (!data.challenge) throw new BridgeError('DeepSeek did not return a PoW challenge.', 'deepseek_error');
    return null;
  }

  async createSession(ctx, signal) {
    const data = await this.api('/chat_session/create', ctx, { body: {}, signal });
    const id = data.chat_session?.id;
    if (!id) throw new BridgeError('DeepSeek did not create a chat session.', 'deepseek_error');
    return id;
  }

  async powHeader(targetPath, ctx, signal) {
    const data = await this.api('/chat/create_pow_challenge', ctx, { body: { target_path: targetPath }, signal });
    const challenge = data.challenge;
    if (!challenge) throw new BridgeError('DeepSeek did not return a PoW challenge.', 'deepseek_error');
    const answer = solveChallenge(challenge);
    return Buffer.from(JSON.stringify(answer), 'utf8').toString('base64');
  }

  async uploadAttachment(att, ctx, signal) {
    if (!att?.dataBase64) throw new BridgeError('Attachment has no data.', 'invalid_attachment', 400);
    const bytes = Buffer.from(att.dataBase64, 'base64');
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: att.mime || 'application/octet-stream' }), att.name || 'file');
    const pow = await this.powHeader('/api/v0/file/upload_file', ctx, signal);
    const res = await this.request('/file/upload_file', ctx, {
      form: true,
      body: form,
      headers: { 'x-ds-pow-response': pow, accept: '*/*' },
      signal,
    });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      if (looksLikeHtml(text)) {
        const transient = res.status === 202 || isTransientStatus(res.status);
        throw new BridgeError(
          'DeepSeek returned its web page instead of an upload response. The web session may have expired; run `deepseek --login` again.',
          transient ? 'server_busy' : 'not_signed_in',
          res.status || 502,
        );
      }
      throw new BridgeError(
        `file upload returned HTTP ${res.status}: ${text.slice(0, 160)}`,
        'upload_failed',
        res.status || 502,
      );
    }
    const bizCode = json?.data?.biz_code;
    if (!res.ok || json?.code !== 0 || (bizCode != null && bizCode !== 0)) {
      const msg = json?.data?.biz_msg || json?.msg || `HTTP ${res.status}`;
      let code = 'upload_failed';
      if (res.status === 401 || res.status === 403 || /sign in|login|token|not logged/i.test(String(msg))) {
        code = 'not_signed_in';
      } else if (/rate.?limit/i.test(String(msg))) {
        // Uploads draw from their own, stricter quota. Note the global valve
        // so every client paces while the window is open, and use the long
        // retry schedule (rate windows outlast the short backoff).
        noteUpstreamThrottleEvent();
        code = 'upload_rate_limited';
      } else if (isTransientStatus(res.status) || /busy|overload|too many|try again|temporar/i.test(String(msg))) {
        code = 'server_busy';
      }
      throw new BridgeError(`file upload failed (${att.name || 'file'}): ${msg}`, code, res.status || 502);
    }
    const id = json?.data?.biz_data?.id;
    if (!id) throw new BridgeError(`file upload did not return an id (${att.name || 'file'})`, 'upload_failed', 502);
    return id;
  }

  async withTransientRetry(
    fn,
    { signal, deadline, label, idleTimeout = SETUP_IDLE_TIMEOUT, attempts = 4, failFastAccountLevel = false } = {},
  ) {
    for (let i = 0; i < attempts; i++) {
      if (signal?.aborted) throw cancelledError();
      if (Date.now() >= deadline) throw timeoutError();
      const attempt = createAttempt({ signal, deadline, idleTimeout });
      let last;
      try {
        return await fn(attempt.signal);
      } catch (err) {
        last = normalizeAttemptError(err, attempt, signal);
      } finally {
        attempt.dispose();
      }
      if (!isTransientError(last) || i === attempts - 1) throw last;
      // With a pool, a rate-limited account is rotated instead of being
      // hammered through the long empty-reply schedule.
      if (failFastAccountLevel && isAccountLevelFailure(last)) throw last;
      this.log(`${label || 'DeepSeek request'} failed (${last.message}); retrying...`);
      await sleep(this.nextRetryDelay(i, last.retryAfter, last.code === 'upload_rate_limited' || last.code === 'empty_reply' ? this.emptyRetryDelays : undefined), signal);
    }
  }

  completionError(res, text) {
    const status = res.status || 502;
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    const bizMsg = json?.data?.biz_msg || json?.msg || '';
    let message = bizMsg || `DeepSeek completion failed (HTTP ${status})`;
    let code = 'completion_failed';

    if (json?.code === 40301 || /INVALID_POW_RESPONSE/i.test(String(bizMsg))) {
      code = 'invalid_pow';
      message = 'DeepSeek rejected the proof-of-work response (INVALID_POW_RESPONSE).';
    } else if (/invalid message id|message not found|invalid parent|not a leaf/i.test(String(bizMsg))) {
      code = 'invalid_parent';
    } else if (status === 401 || status === 403 || /sign in|login|token|not logged/i.test(String(bizMsg))) {
      code = 'not_signed_in';
    } else if (
      isTransientStatus(status) ||
      /busy|overload|rate.?limit|too many|try again|temporar/i.test(String(bizMsg))
    ) {
      code = 'server_busy';
    } else if (looksLikeHtml(text)) {
      code = 'server_busy';
      message =
        'DeepSeek returned its web page instead of an event stream. The web session may have expired; run `deepseek --login` again.';
    } else if (!bizMsg && text) {
      message += `: ${text.slice(0, 160)}`;
    }

    const err = new BridgeError(message, code, status);
    err.retryAfter = retryAfterFrom(res);
    return err;
  }

  recoveryError(res, text, json) {
    const status = res.status || 502;
    const data = json?.data;
    const bizCode = data?.biz_code;
    const bizMsg = data?.biz_msg || json?.msg || '';
    let code = 'recovery_failed';
    // 24: the message is still generating, so /chat/continue is locked. 22:
    // the message is not in a state this endpoint can resume (it usually just
    // finished; readRecoveryResponse absorbs the attached full-message
    // biz_data, this is the safety net for a bare rejection). Both are
    // transient: the next attempt uses the other recovery endpoint.
    if (
      bizCode === 24 ||
      bizCode === 22 ||
      /locked|still generating|try again|invalid message status/i.test(String(bizMsg))
    ) {
      code = 'continue_locked';
    } else if ([7, 8, 23, 26].includes(bizCode)) {
      code = 'recovery_unavailable';
    } else if (json?.code === 401 || status === 401 || status === 403 || /sign in|login|token|not logged/i.test(String(bizMsg))) {
      code = 'not_signed_in';
    } else if (status === 202 || isTransientStatus(status) || /busy|overload|rate.?limit|too many|try again|temporar/i.test(String(bizMsg))) {
      code = 'server_busy';
    } else if (looksLikeHtml(text)) {
      code = 'server_busy';
    }
    const detail = bizMsg ? `: ${bizMsg}` : text && !looksLikeHtml(text) ? `: ${text.slice(0, 160)}` : '';
    const err = new BridgeError(`DeepSeek could not resume the interrupted reply${detail}.`, code, status);
    err.retryAfter = retryAfterFrom(res);
    return err;
  }

  async startCompletion(
    {
      sessionId,
      parentMessageId,
      prompt,
      modelType,
      thinking,
      search,
      fileIds,
      pow,
      signal,
      debugLines,
    },
    ctx,
  ) {
    const body = {
      chat_session_id: sessionId,
      parent_message_id: parentMessageId ?? null,
      model_type: modelType || 'default',
      prompt,
      ref_file_ids: fileIds,
      thinking_enabled: thinking !== false,
      search_enabled: !!search,
      action: null,
      preempt: false,
    };

    const res = await this.request('/chat/completion', ctx, {
      body,
      headers: { 'x-ds-pow-response': pow, accept: '*/*' },
      signal,
    });

    if (debugLines) {
      debugLines.push(
        `http ${res.status} type=${res.headers.get('content-type')} len=${res.headers.get('content-length')}`,
      );
    }

    const contentType = res.headers.get('content-type') || '';
    if (!res.ok || contentType.includes('application/json') || contentType.includes('text/html')) {
      const text = await res.text().catch(() => '');
      throw this.completionError(res, text);
    }
    return res;
  }

  async consumeSSE(res, { onDelta, onReady, resetIdle, debugLines, signal }, ctx) {
    if (!res.body?.getReader) {
      throw new BridgeError('DeepSeek returned an empty event stream.', 'stream_interrupted', 502);
    }

    let messageId = null;
    let title = null;
    let usage = null;
    let status = null;
    let terminal = false;
    // Files referenced by this completion, as observed in embedded user-message
    // snapshot frames: id -> {status, name}. run()'s readiness gate reads this
    // to catch uploads that were still being ingested when the reply fired.
    const fileStatus = {};
    const acc = createAccumulator(onDelta);
    // A close/finish marker alone does not prove the reply is complete: the
    // message object also carries a lifecycle status that reaches 'FINISHED'
    // only once DeepSeek is done writing. Remember the strongest status seen;
    // run() treats "closed while still WIP" like any other truncation.
    const observeStatus = (data) => {
      const seen = extractStatus(data);
      if (!seen) return;
      // 'FINISHED' is terminal: a later replayed WIP snapshot must not
      // downgrade an already-finished message back to interrupted.
      if (seen === 'FINISHED' || status !== 'FINISHED') status = seen;
    };
    const observeFiles = (data) => collectFileStatus(data, fileStatus);
    const handler = sseHandler({
      debugLines,
      onEvent(name, data) {
        if (name === 'ready') {
          const responseId = data.response_message_id ?? data.responseMessageId ?? null;
          if (responseId != null) messageId = responseId;
          onReady?.({
            accountId: ctx?.accountId ?? null,
            messageId: responseId,
            requestMessageId: data.request_message_id ?? data.requestMessageId ?? null,
          });
          return;
        }
        if (name === 'title') {
          title = data.content || data.title || title;
          return;
        }
        if (name === 'close' || name === 'done') {
          terminal = true;
          return;
        }
        if (name === 'finish') {
          terminal = true;
          if (data && (data.v !== undefined || data.p !== undefined)) {
            observeStatus(data);
            acc.applyMessage(data);
            observeFiles(data);
          }
          return;
        }
        if (name === 'error') {
          const detail = String(data.msg || data.message || 'DeepSeek stream error').slice(0, 160);
          throw new BridgeError(detail, 'stream_error', 502);
        }
        acc.applyMessage(data);
        observeStatus(data);
        observeFiles(data);
        const response = acc.state.response;
        if (response?.accumulated_token_usage) {
          usage = { completion: response.accumulated_token_usage };
        }
      },
    });

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let bytes = 0;
    try {
      for (;;) {
        let chunk;
        try {
          chunk = await reader.read();
        } catch (err) {
          if (signal?.aborted) throw signal.reason || err;
          throw new BridgeError(`DeepSeek stream interrupted: ${err?.message || err}`, 'stream_interrupted', 502);
        }
        if (chunk.done) break;
        bytes += chunk.value?.length || 0;
        resetIdle?.();
        buffer += decoder.decode(chunk.value, { stream: true });
        buffer = parseSSEStream(buffer, handler);
        if (signal?.aborted) {
          throw signal.reason || new BridgeError('DeepSeek stream was interrupted.', 'stream_interrupted', 502);
        }
      }
      buffer += decoder.decode();
      if (buffer.length) parseSSEStream(buffer + '\n\n', handler);
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* already released */
      }
      if (debugLines) debugLines.push(`body ${bytes} bytes; tail=${JSON.stringify(buffer.slice(-160))}`);
    }

    if (debugLines && Object.keys(fileStatus).length) {
      debugLines.push(
        `files: ${Object.entries(fileStatus)
          .map(([id, info]) => `${id}=${info.status}`)
          .join(', ')}`,
      );
    }
    if (signal?.aborted) {
      throw signal.reason || new BridgeError('DeepSeek stream was interrupted.', 'stream_interrupted', 502);
    }
    if (!terminal) {
      throw new BridgeError('DeepSeek stream ended before the completion marker.', 'stream_interrupted', 502);
    }
    return { messageId, title, usage, status, fileStatus };
  }

  async readRecoveryResponse(res, { collected, attempt, debugLines, ctx }) {
    const contentType = res.headers.get('content-type') || '';
    if (!res.ok || contentType.includes('application/json') || contentType.includes('text/html')) {
      const text = await res.text().catch(() => '');
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
      const full = res.ok ? fullMessageFromJson(json) : null;
      if (full) {
        applyFullMessage(full, (delta) => {
          collected[delta.kind] += delta.text;
        });
        return {
          messageId: full.id ?? json?.data?.biz_data?.message_id ?? null,
          title: full.title || null,
          usage: full.accumulated_token_usage ? { completion: full.accumulated_token_usage } : null,
        };
      }
      throw this.recoveryError(res, text, json);
    }

    return this.consumeSSE(
      res,
      {
        onDelta: (delta) => {
          collected[delta.kind] += delta.text;
        },
        resetIdle: attempt.resetIdle,
        debugLines,
        signal: attempt.signal,
      },
      ctx,
    );
  }

  emitMissing(emitted, collected, emit) {
    for (const kind of ['reasoning', 'content']) {
      const text = collected[kind] || '';
      if (!text) continue;
      const add = missingSuffix(emitted[kind], text);
      if (!add) continue;
      // `emit` updates `emitted`; do not append here as well, or a second
      // recovery attempt will think the whole message is still missing.
      emit({ kind, text: add });
    }
  }

  async recover({ sessionId, messageId, emit, emitted, signal, deadline, debugLines, cause, ctx }) {
    let usage = null;
    let title = null;

    for (let i = 0; i < MAX_RECOVERY_ATTEMPTS; i++) {
      if (signal?.aborted) throw cancelledError();
      if (Date.now() >= deadline) throw timeoutError();

      // resume_stream first: while the message is still generating it replays
      // a full-state snapshot where /chat/continue only answers
      // continue_locked. Later attempts use the proven /chat/continue path.
      const endpoint = i === 0 ? '/chat/resume_stream' : '/chat/continue';
      const attempt = createAttempt({ signal, deadline, idleTimeout: STREAM_IDLE_TIMEOUT });
      const collected = { content: '', reasoning: '' };
      let failure = null;
      try {
        this.log(`reply interrupted; resuming message ${messageId} (attempt ${i + 1}/${MAX_RECOVERY_ATTEMPTS})...`);
        const body = { chat_session_id: sessionId, message_id: messageId };
        if (i > 0) body.fallback_to_resume = true;
        const res = await this.request(endpoint, ctx, {
          body,
          headers: { accept: '*/*' },
          signal: attempt.signal,
        });
        if (debugLines) {
          debugLines.push(
            `${endpoint.replace('/chat/', '')} http ${res.status} type=${res.headers.get('content-type')} len=${res.headers.get('content-length')}`,
          );
        }
        const outcome = await this.readRecoveryResponse(res, { collected, attempt, debugLines, ctx });
        this.emitMissing(emitted, collected, emit);
        if (outcome.status && outcome.status !== 'FINISHED') {
          // The replay ended while the message was still generating — same
          // failure class as the primary-stream WIP gate. emitMissing already
          // kept the recovered suffix (and stays idempotent when the catch
          // calls it again); the transient handling below tries the next
          // endpoint instead of returning a partial reply as complete.
          throw new BridgeError(
            'DeepSeek stream closed while the reply was still generating.',
            'stream_interrupted',
            502,
          );
        }
        if (outcome.usage) usage = outcome.usage;
        if (outcome.title) title = outcome.title;
        if (outcome.messageId != null) messageId = outcome.messageId;
        this.log(
          `reply resumed via ${endpoint.replace('/chat/', '')} message=${messageId} recovered=${collected.content.length}c/${collected.reasoning.length}c`,
        );
        return { sessionId, messageId, usage, title, finish: 'stop', debugLines };
      } catch (err) {
        failure = normalizeAttemptError(err, attempt, signal);
        // A failed resume may still have streamed useful text. Keep the
        // new suffix, then try again from the updated message state.
        this.emitMissing(emitted, collected, emit);
        if (failure.code === 'cancelled' || failure.code === 'timeout' || failure.code === 'not_signed_in') {
          throw failure;
        }
        // resume_stream refusing the message (biz 7/8/23/26) is a verdict
        // about that endpoint, not the recovery; the /chat/continue fallback
        // below still gets its shot.
        const fallbackToContinue = i === 0 && failure.code === 'recovery_unavailable';
        if (!isTransientError(failure) && !fallbackToContinue) {
          throw new BridgeError(
            `DeepSeek reply was interrupted and could not be resumed: ${failure.message}`,
            'recovery_failed',
            502,
          );
        }
        if (i === MAX_RECOVERY_ATTEMPTS - 1) {
          throw new BridgeError(
            `DeepSeek reply was interrupted and could not be resumed after ${MAX_RECOVERY_ATTEMPTS} attempts: ${failure.message}`,
            'recovery_failed',
            502,
          );
        }
        this.log(
          `resume attempt failed (${failure.message})${fallbackToContinue ? '; falling back to /chat/continue' : ''}; retrying...`,
        );
      } finally {
        attempt.dispose();
      }
      await sleep(this.nextRetryDelay(i, failure.retryAfter), signal);
    }
  }

  /* ---------------------------------------------------------- rotation --- */

  /**
   * Resolve the account for one run: the pinned account of a bound
   * continuation, or a fresh pick from the pool.
   */
  async selectContext(payload, { excluded, signal, deadline }) {
    if (!hasAccounts()) {
      throw new BridgeError('No terminal DeepSeek session. Run `deepseek --login` first.', 'not_signed_in', 401);
    }
    if (payload.sessionId) return this.resolveBoundContext(payload);
    if (!this.hasMultipleAccounts) {
      const account = getPrimaryAccount();
      if (!account?.token) {
        throw new BridgeError('No terminal DeepSeek session. Run `deepseek --login` first.', 'not_signed_in', 401);
      }
      return this.contextFor(account);
    }
    return this.waitForAccount({ excluded, signal, deadline });
  }

  /**
   * A DeepSeek chat_session_id exists only inside the account that created it.
   * Continuations are pinned to that account and fail with `account_switched`
   * BEFORE any network call when it is absent or cooling, so the caller can
   * replay the transcript into a fresh session instead of cross-wiring
   * accounts (which would leak one conversation into another account).
   */
  resolveBoundContext(payload) {
    if (!this.hasMultipleAccounts) {
      // Single-account deployments keep their old behavior; only a token swap
      // (the stored accountId no longer exists) must not reuse the old id.
      const account = getPrimaryAccount();
      if (!account?.token) {
        throw new BridgeError('No terminal DeepSeek session. Run `deepseek --login` first.', 'not_signed_in', 401);
      }
      if (payload.accountId && payload.accountId !== account.id) {
        throw new BridgeError(
          'The DeepSeek account that owns this conversation was replaced; replaying on a fresh session.',
          'account_switched',
          503,
        );
      }
      return this.contextFor(account);
    }
    // Legacy conversation entries carry no accountId: they were created by the
    // original single-token deployment, which the migration stored as the first
    // account. Bind to that STORED account (not "first ready" — that could pick
    // a different token and cross-wire the session id) and let the cooling
    // check below fail the continuation instead.
    const legacyOwner = loadAccounts()[0] || null;
    const targetId = payload.accountId || legacyOwner?.id || null;
    const account = targetId ? pickAccount({ preferId: targetId }) : null;
    if (!account) {
      throw new BridgeError(
        'The DeepSeek account that owns this conversation is cooling down; replaying on a fresh session.',
        'account_switched',
        503,
      );
    }
    return this.contextFor(account);
  }

  /**
   * Fresh requests: least-recently-used ready account. When every account is
   * cooling, wait briefly for the earliest one instead of failing instantly,
   * but never park the caller for long: after ROTATION_WAIT_BUDGET_MS (or when
   * the next account is further away) surface a retriable 503.
   */
  async waitForAccount({ excluded, signal, deadline }) {
    const budgetEnd = Math.min(deadline, Date.now() + ROTATION_WAIT_BUDGET_MS);
    for (;;) {
      if (signal?.aborted) throw cancelledError();
      const account = pickAccount({ excludeIds: excluded });
      if (account) return this.contextFor(account);

      const allExcluded = excluded.length >= accountCount();
      const nextAt = nextAvailableAt({ excludeIds: allExcluded ? [] : excluded });
      if (nextAt === Infinity) {
        throw new BridgeError(
          'No DeepSeek account can serve a request right now; add a token with `deepseek --login`.',
          'account_unavailable',
          503,
        );
      }
      const remaining = Math.max(0, nextAt - Date.now());
      const budget = budgetEnd - Date.now();
      if (remaining > ROTATION_WAIT_BUDGET_MS || budget <= 0) {
        throw new BridgeError(
          `Every DeepSeek account is cooling down; the next one is usable in ${Math.max(1, Math.ceil(remaining / 1000))}s. Try again shortly.`,
          'account_unavailable',
          503,
        );
      }
      await sleep(Math.max(25, Math.min(remaining + 25, ROTATION_WAIT_STEP_MS, budget)), signal);
      // Every account already failed once in this request: after the wait the
      // next sweep may retry any of them (cooldowns are short).
      if (allExcluded) excluded.length = 0;
    }
  }

  /** Record per-account health so scheduling/CLI can see why an account was skipped. */
  recordAccountFailure(accountId, failure) {
    const code = failure?.code || 'error';
    if (code === 'not_signed_in') {
      markAccountExpired(accountId, failure?.message || '');
      return;
    }
    markAccountThrottle(accountId, { retryAfterMs: Number(failure?.retryAfter) || 0, code });
  }

  /**
   * One full attempt on one account: session creation, attachment uploads, PoW
   * and the completion stream. Throws the normalized failure so run() can pick
   * between an in-account retry (single account) and a rotation.
   */
  async runAttempt(payload, handlers, { signal, deadline, emitted, emit, debugLines, ctx, bound }) {
    const session = ctx.session;
    if (!session?.token) {
      throw new BridgeError('DeepSeek user token is missing. Run `deepseek --login` again.', 'not_signed_in', 401);
    }
    // With a pool, an account-level failure rotates immediately instead of
    // sleeping through the empty-reply schedule on the same throttled token.
    const failFastAccountLevel = this.hasMultipleAccounts && !bound;

    const sessionId =
      payload.sessionId ||
      (await this.withTransientRetry((attemptSignal) => this.createSession(ctx, attemptSignal), {
        signal,
        deadline,
        label: 'DeepSeek session creation',
        failFastAccountLevel,
      }));

    const fileIds = [];
    const attachments = payload.attachments || [];
    // Uploaded file ids are account-scoped on DeepSeek: the same bytes re-upload
    // when a request rotates to another account, but never twice per account.
    if (!this.fileCache) this.fileCache = new Map();
    for (let i = 0; i < attachments.length; i++) {
      const att = attachments[i];
      const contentKey = `${ctx.accountId}|${crypto.createHash('sha256').update(att.dataBase64 || '').digest('hex')}`;
      if (this.fileCache.has(contentKey)) {
        const cached = this.fileCache.get(contentKey);
        fileIds.push(cached);
        if (debugLines) debugLines.push(`upload ${att.name || 'file'} cached -> ${cached}`);
        continue;
      }
      const t0 = Date.now();
      const fileId = await this.withTransientRetry((attemptSignal) => this.uploadAttachment(att, ctx, attemptSignal), {
        signal,
        deadline,
        label: `upload ${att.name || 'file'}`,
        idleTimeout: UPLOAD_IDLE_TIMEOUT,
        failFastAccountLevel,
      });
      this.fileCache.set(contentKey, fileId);
      if (this.fileCache.size > 60) this.fileCache.delete(this.fileCache.keys().next().value);
      fileIds.push(fileId);
      if (debugLines) {
        debugLines.push(
          `upload ${att.name || 'file'} ${att.mime || '?'} ${Math.round((((att.dataBase64 || '').length * 0.75) / 1024))}k -> ${fileId} ${Date.now() - t0}ms`,
        );
      }
      // DeepSeek ingests uploads asynchronously; back-to-back uploads raced
      // and left later files PENDING at completion time. Give every upload
      // except the last a short settle gap before the next one starts.
      if (i < attachments.length - 1) await sleep(750, signal);
    }

    handlers.onReady?.({ sessionId, accountId: ctx.accountId });

    let messageId = null;
    let title = null;
    let usage = null;
    let startFailures = 0;
    // One transparent file_not_ready retry, ever (see the failure handler).
    let fileRetryUsed = false;

    for (;;) {
      if (signal?.aborted) throw cancelledError();
      if (Date.now() >= deadline) throw timeoutError();

      const pow = await this.withTransientRetry(
        (attemptSignal) => this.powHeader('/api/v0/chat/completion', ctx, attemptSignal),
        { signal, deadline, label: 'DeepSeek PoW challenge', failFastAccountLevel },
      );

      const attempt = createAttempt({ signal, deadline, idleTimeout: STREAM_IDLE_TIMEOUT });
      let failure = null;
      try {
        const res = await this.startCompletion(
          {
            sessionId,
            parentMessageId: payload.parentMessageId ?? null,
            prompt: payload.prompt,
            modelType: payload.modelType,
            thinking: payload.thinking,
            search: payload.search,
            fileIds,
            pow,
            signal: attempt.signal,
            debugLines,
          },
          ctx,
        );

        const stream = await this.consumeSSE(
          res,
          {
            onDelta: emit,
            onReady: (info) => {
              if (info.messageId != null) messageId = info.messageId;
              handlers.onReady?.({ sessionId, ...info });
            },
            resetIdle: attempt.resetIdle,
            debugLines,
            signal: attempt.signal,
          },
          ctx,
        );
        if (stream.messageId != null) messageId = stream.messageId;
        if (stream.title) title = stream.title;
        if (stream.usage) usage = stream.usage;
        if (stream.status && stream.status !== 'FINISHED') {
          // The server sent its terminal marker while the message was still
          // generating. Same failure class as a truncation: recovery replays
          // the message and finishes it instead of returning a partial
          // reply as complete. Flows that never send a status (status null)
          // and finished streams keep today's success behavior.
          throw new BridgeError(
            'DeepSeek stream closed while the reply was still generating.',
            'stream_interrupted',
            502,
          );
        }
        // Readiness gate: a file referenced while DeepSeek was still ingesting
        // it produced answers that silently ignored the file (observed live:
        // the model cannot read a PENDING file, even minutes later). Only
        // files the stream actually reported as not-ready gate here; files
        // the stream never mentioned keep today's behavior.
        const fileStatus = stream.fileStatus || {};
        const notReady = fileIds.filter((id) => {
          const fileState = fileStatus[id]?.status;
          return fileState === 'PENDING' || fileState === 'ERROR' || fileState === 'FAILED';
        });
        if (notReady.length) {
          const names = notReady.map((id) => fileStatus[id]?.name || id).join(', ');
          const err = new BridgeError(
            `DeepSeek had not finished processing ${names} when the reply was generated.`,
            'file_not_ready',
            504,
          );
          err.fileNames = names;
          throw err;
        }
        if (!emitted.content && !emitted.reasoning) {
          // Live-observed failure mode: a clean stream (close, sometimes
          // FINISHED) whose message contains zero fragments. Useless as a
          // reply and transient in practice — throw while nothing has
          // reached the client so the start-retry loop below reruns it.
          throw new BridgeError('DeepSeek returned an empty reply.', 'empty_reply', 502);
        }
        noteUpstreamSuccess();
        return { sessionId, messageId, usage, title, finish: 'stop', debugLines };
      } catch (err) {
        failure = normalizeAttemptError(err, attempt, signal);
      } finally {
        attempt.dispose();
      }

      if (failure.code === 'cancelled' || failure.code === 'timeout') throw failure;

      // With a pool the first account-level failure ends this attempt so run()
      // can rotate; the same account is never hammered through the empty-reply
      // schedule. Single-account deployments fall through to 0.7.8 behavior.
      if (failFastAccountLevel && !emitted.content && !emitted.reasoning && isAccountLevelFailure(failure)) {
        throw failure;
      }

      // file_not_ready: one of our uploads was still being ingested when the
      // reply was generated. Two deliberate tradeoffs:
      //  - Retry as a FRESH completion, never via recover()/continue: a
      //    continue would append a second answer to a turn that already
      //    ignored the file, while a fresh start re-references the files in
      //    a new message, which have had time to ingest by now.
      //  - A retried completion re-streams the full answer, so a transparent
      //    retry is only safe before anything was emitted. Once text is on
      //    the wire the error is surfaced to the client instead (504) —
      //    openai.js passes status/code through unchanged — and the client
      //    retries the whole request. fileRetryUsed caps this at one retry
      //    so a permanently stuck file cannot loop.
      // The process-global valve only models a single-account deployment; with
      // a pool the account cools down on its own and requests rotate. (A fresh
      // multi-account attempt never reaches here: it throws at the fail-fast
      // above; bound continuations retry the pinned account, and the caller
      // replays fresh anyway.)
      if (failure.code === 'empty_reply' && !emitted.content && !emitted.reasoning && !this.hasMultipleAccounts)
        noteUpstreamThrottleEvent();
      if (failure.code === 'file_not_ready') {
        if (fileRetryUsed || emitted.content || emitted.reasoning) throw failure;
        fileRetryUsed = true;
        this.log(`file ${failure.fileNames || 'attachment'} was still processing; retrying...`);
        await sleep(this.nextRetryDelay(startFailures, failure.retryAfter, failure.code === 'empty_reply' ? this.emptyRetryDelays : undefined), signal);
        startFailures++;
        continue;
      }

      const canRecover =
        messageId != null &&
        failure.code !== 'invalid_parent' &&
        failure.code !== 'not_signed_in' &&
        failure.code !== 'invalid_pow' &&
        // Unreachable for file_not_ready (handled above), kept explicit so the
        // fresh-retry-vs-recover rule survives future reordering.
        failure.code !== 'file_not_ready' &&
        // An empty or truncated reply must be retried as a fresh
        // completion, not continued: the dangling message has nothing
        // to resume.
        failure.code !== 'empty_reply';
      if (canRecover) {
        const recovered = await this.recover({
          sessionId,
          messageId,
          emit,
          emitted,
          signal,
          deadline,
          debugLines,
          cause: failure,
          ctx,
        });
        noteUpstreamSuccess();
        if (emitted.content || emitted.reasoning) return recovered;
        // Recovery confirmed the reply is empty. Fall through to the same
        // fresh-start retry a clean empty stream gets, instead of failing
        // the client on the first try.
        messageId = recovered.messageId ?? messageId;
        if (recovered.usage) usage = recovered.usage;
        if (recovered.title) title = recovered.title;
        failure = new BridgeError('DeepSeek returned an empty reply.', 'empty_reply', 502);
      }

      if (emitted.content || emitted.reasoning) throw failure;
      if (!isTransientError(failure) || startFailures >= MAX_START_ATTEMPTS - 1) throw failure;

      this.log(`completion attempt failed (${failure.message}); retrying from the start...`);
      await sleep(this.nextRetryDelay(startFailures, failure.retryAfter, failure.code === 'empty_reply' ? this.emptyRetryDelays : undefined), signal);
      startFailures++;
    }
  }

  /**
   * Run one request, rotating across accounts on account-level throttling.
   *
   * Single-account deployments: exactly the previous behavior (that account is
   * retried through the empty-reply schedule inside runAttempt).
   * Multi-account deployments: a fresh request picks the least-recently-used
   * ready account; when it is throttled/expired the whole setup (session, file
   * uploads, PoW, stream) transparently restarts on the next account. A bound
   * continuation is never moved: it fails with `account_switched` so the caller
   * can replay the transcript into a fresh session.
   */
  async run(payload, handlers = {}, { signal } = {}) {
    const debugLines = payload.debug === true ? [] : null;
    const deadline = Date.now() + HARD_TIMEOUT;
    const emitted = { content: '', reasoning: '' };
    const emit = (delta) => {
      if (!delta?.text) return;
      if (delta.kind === 'reasoning') emitted.reasoning += delta.text;
      else emitted.content += delta.text;
      handlers.onDelta?.(delta);
    };

    const bound = Boolean(payload.sessionId);
    const excluded = [];
    const maxRotations = bound ? 0 : accountCount() + 2;
    let rotations = 0;
    let previousAccountId = null;
    let lastFailureCode = null;

    try {
      for (;;) {
        if (signal?.aborted) throw cancelledError();
        if (Date.now() >= deadline) throw timeoutError();

        const ctx = await this.selectContext(payload, { excluded, signal, deadline });
        if (previousAccountId && previousAccountId !== ctx.accountId) {
          this.log(
            `rotated account ${shortAccountId(previousAccountId)} -> ${shortAccountId(ctx.accountId)}` +
              ` after ${lastFailureCode || 'failure'}`,
          );
        }
        previousAccountId = ctx.accountId;

        try {
          const result = await this.runAttempt(payload, handlers, {
            signal,
            deadline,
            emitted,
            emit,
            debugLines,
            ctx,
            bound,
          });
          markAccountSuccess(ctx.accountId);
          return { ...result, accountId: ctx.accountId };
        } catch (err) {
          if (signal?.aborted) throw cancelledError();
          const failure = err instanceof BridgeError ? err : normalizeAttemptError(err, null, signal);
          const empty = !emitted.content && !emitted.reasoning;
          const accountLevel = isAccountLevelFailure(failure);

          if (accountLevel) this.recordAccountFailure(ctx.accountId, failure);
          else if (empty && failure.code !== 'cancelled' && failure.code !== 'timeout') {
            markAccountFailure(ctx.accountId, failure.code || 'error');
          }

          if (bound) {
            // A chat session belongs to the account that created it: never send
            // its session id under a different token. The caller replays into a
            // fresh session instead. Single-account deployments keep surfacing
            // the original failure (0.7.8 behavior).
            if (empty && accountLevel && this.hasMultipleAccounts) {
              throw new BridgeError(
                'The DeepSeek account that owns this conversation is cooling down; replaying on a fresh session.',
                'account_switched',
                503,
              );
            }
            throw failure;
          }

          if (!(empty && accountLevel && this.hasMultipleAccounts)) throw failure;

          lastFailureCode = failure.code || (Number(failure.status) === 429 ? 'server_busy' : 'error');
          this.log(
            `account ${shortAccountId(ctx.accountId)} failed (${lastFailureCode}); rotating to another account`,
          );
          excluded.push(ctx.accountId);
          // Very small pools: once every account failed once in this request,
          // stop excluding them so the next sweep may retry after cooldowns.
          if (excluded.length >= accountCount()) excluded.length = 0;
          rotations++;
          if (rotations > maxRotations) {
            throw new BridgeError(
              `DeepSeek is rate-limiting every configured account (${accountCount()} accounts). ` +
                'Try again shortly or add another token with `deepseek --login`.',
              'account_unavailable',
              503,
            );
          }
        }
      }
    } catch (err) {
      if (signal?.aborted) throw cancelledError();
      throw err instanceof BridgeError ? err : normalizeAttemptError(err, null, signal);
    }
  }
}
