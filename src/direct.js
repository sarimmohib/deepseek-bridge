/*
 * Direct chat.deepseek.com client.
 *
 * This is the same request flow the content script uses, moved into Node so
 * Chrome does not have to stay open. The session (cookies + localStorage
 * userToken) is captured once by `deepseek --login`.
 */
import { Blob } from 'node:buffer';
import { BridgeError } from './agent.js';
import { solveChallenge } from './pow.js';
import { cookieHeader, loadSession, updateSessionCookies } from './session.js';

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
const MAX_START_ATTEMPTS = 4;
const MAX_RECOVERY_ATTEMPTS = 4;

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
    code === 'continue_locked'
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
  constructor({ log = () => {}, retryDelays = DEFAULT_RETRY_DELAYS } = {}) {
    this.log = log;
    this.retryDelays = Array.isArray(retryDelays) && retryDelays.length ? retryDelays : DEFAULT_RETRY_DELAYS;
    this.session = loadSession();
  }

  nextRetryDelay(index, retryAfter = 0) {
    if (retryAfter > 0) return Math.min(60_000, retryAfter);
    const delays = this.retryDelays;
    const base = delays[Math.min(index, delays.length - 1)];
    return base > 0 ? base + Math.floor(Math.random() * 250) : 0;
  }

  get available() {
    return Boolean(this.session?.token);
  }

  reloadSession() {
    this.session = loadSession();
    return this.session;
  }

  captureCookies(res) {
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
    const updated = updateSessionCookies(cookies);
    if (updated) this.session = updated;
  }

  baseHeaders() {
    const session = this.session;
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

  async request(path, { method = 'POST', body, form = false, headers = {}, signal } = {}) {
    const finalHeaders = { ...this.baseHeaders(), ...headers };
    if (!form) finalHeaders['content-type'] = 'application/json';
    const res = await fetch(`${API}${path}`, {
      method,
      headers: finalHeaders,
      body: method === 'GET' ? undefined : form ? body : JSON.stringify(body ?? {}),
      signal,
      redirect: 'follow',
    });
    this.captureCookies(res);
    return res;
  }

  async api(path, { method = 'POST', body, headers = {}, signal } = {}) {
    const res = await this.request(path, { method, body, headers, signal });
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

  async verify(signal) {
    // /users is not consistently available to the web API. A PoW challenge is
    // a small authenticated call and proves the copied token and cookies work.
    const data = await this.api('/chat/create_pow_challenge', {
      body: { target_path: '/api/v0/chat/completion' },
      signal,
    });
    if (!data.challenge) throw new BridgeError('DeepSeek did not return a PoW challenge.', 'deepseek_error');
    return null;
  }

  async createSession(signal) {
    const data = await this.api('/chat_session/create', { body: {}, signal });
    const id = data.chat_session?.id;
    if (!id) throw new BridgeError('DeepSeek did not create a chat session.', 'deepseek_error');
    return id;
  }

  async powHeader(targetPath, signal) {
    const data = await this.api('/chat/create_pow_challenge', { body: { target_path: targetPath }, signal });
    const challenge = data.challenge;
    if (!challenge) throw new BridgeError('DeepSeek did not return a PoW challenge.', 'deepseek_error');
    const answer = solveChallenge(challenge);
    return Buffer.from(JSON.stringify(answer), 'utf8').toString('base64');
  }

  async uploadAttachment(att, signal) {
    if (!att?.dataBase64) throw new BridgeError('Attachment has no data.', 'invalid_attachment', 400);
    const bytes = Buffer.from(att.dataBase64, 'base64');
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: att.mime || 'application/octet-stream' }), att.name || 'file');
    const pow = await this.powHeader('/api/v0/file/upload_file', signal);
    const res = await this.request('/file/upload_file', {
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
      } else if (isTransientStatus(res.status) || /busy|overload|rate.?limit|too many|try again|temporar/i.test(String(msg))) {
        code = 'server_busy';
      }
      throw new BridgeError(`file upload failed (${att.name || 'file'}): ${msg}`, code, res.status || 502);
    }
    const id = json?.data?.biz_data?.id;
    if (!id) throw new BridgeError(`file upload did not return an id (${att.name || 'file'})`, 'upload_failed', 502);
    return id;
  }

  async withTransientRetry(fn, { signal, deadline, label, idleTimeout = SETUP_IDLE_TIMEOUT, attempts = 4 } = {}) {
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
      this.log(`${label || 'DeepSeek request'} failed (${last.message}); retrying...`);
      await sleep(this.nextRetryDelay(i, last.retryAfter), signal);
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
    if (bizCode === 24 || /locked|still generating|try again/i.test(String(bizMsg))) {
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

  async startCompletion({
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
  }) {
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

    const res = await this.request('/chat/completion', {
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

  async consumeSSE(res, { onDelta, onReady, resetIdle, debugLines, signal }) {
    if (!res.body?.getReader) {
      throw new BridgeError('DeepSeek returned an empty event stream.', 'stream_interrupted', 502);
    }

    let messageId = null;
    let title = null;
    let usage = null;
    let terminal = false;
    const acc = createAccumulator(onDelta);
    const handler = sseHandler({
      debugLines,
      onEvent(name, data) {
        if (name === 'ready') {
          const responseId = data.response_message_id ?? data.responseMessageId ?? null;
          if (responseId != null) messageId = responseId;
          onReady?.({
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
          if (data && (data.v !== undefined || data.p !== undefined)) acc.applyMessage(data);
          return;
        }
        if (name === 'error') {
          const detail = String(data.msg || data.message || 'DeepSeek stream error').slice(0, 160);
          throw new BridgeError(detail, 'stream_error', 502);
        }
        acc.applyMessage(data);
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

    if (signal?.aborted) {
      throw signal.reason || new BridgeError('DeepSeek stream was interrupted.', 'stream_interrupted', 502);
    }
    if (!terminal) {
      throw new BridgeError('DeepSeek stream ended before the completion marker.', 'stream_interrupted', 502);
    }
    return { messageId, title, usage };
  }

  async readRecoveryResponse(res, { collected, attempt, debugLines }) {
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

    return this.consumeSSE(res, {
      onDelta: (delta) => {
        collected[delta.kind] += delta.text;
      },
      resetIdle: attempt.resetIdle,
      debugLines,
      signal: attempt.signal,
    });
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

  async recover({ sessionId, messageId, emit, emitted, signal, deadline, debugLines, cause }) {
    let usage = null;
    let title = null;

    for (let i = 0; i < MAX_RECOVERY_ATTEMPTS; i++) {
      if (signal?.aborted) throw cancelledError();
      if (Date.now() >= deadline) throw timeoutError();

      const attempt = createAttempt({ signal, deadline, idleTimeout: STREAM_IDLE_TIMEOUT });
      const collected = { content: '', reasoning: '' };
      let failure = null;
      try {
        this.log(`reply interrupted; resuming message ${messageId} (attempt ${i + 1}/${MAX_RECOVERY_ATTEMPTS})...`);
        const res = await this.request('/chat/continue', {
          body: {
            chat_session_id: sessionId,
            message_id: messageId,
            fallback_to_resume: true,
          },
          headers: { accept: '*/*' },
          signal: attempt.signal,
        });
        if (debugLines) {
          debugLines.push(
            `continue http ${res.status} type=${res.headers.get('content-type')} len=${res.headers.get('content-length')}`,
          );
        }
        const outcome = await this.readRecoveryResponse(res, { collected, attempt, debugLines });
        this.emitMissing(emitted, collected, emit);
        if (outcome.usage) usage = outcome.usage;
        if (outcome.title) title = outcome.title;
        if (outcome.messageId != null) messageId = outcome.messageId;
        this.log(
          `reply resumed message=${messageId} recovered=${collected.content.length}c/${collected.reasoning.length}c`,
        );
        return { sessionId, messageId, usage, title, finish: 'stop', debugLines };
      } catch (err) {
        failure = normalizeAttemptError(err, attempt, signal);
        // A failed continuation may still have streamed useful text. Keep the
        // new suffix, then try again from the updated message state.
        this.emitMissing(emitted, collected, emit);
        if (failure.code === 'cancelled' || failure.code === 'timeout' || failure.code === 'not_signed_in') {
          throw failure;
        }
        if (!isTransientError(failure)) {
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
        this.log(`resume attempt failed (${failure.message}); retrying...`);
      } finally {
        attempt.dispose();
      }
      await sleep(this.nextRetryDelay(i, failure.retryAfter), signal);
    }
  }

  async run(payload, handlers = {}, { signal } = {}) {
    const session = this.reloadSession();
    if (!session?.token) {
      throw new BridgeError(
        'No terminal DeepSeek session. Run `deepseek --login` first.',
        'not_signed_in',
        401,
      );
    }

    const debugLines = payload.debug === true ? [] : null;
    const deadline = Date.now() + HARD_TIMEOUT;
    const emitted = { content: '', reasoning: '' };
    const emit = (delta) => {
      if (!delta?.text) return;
      if (delta.kind === 'reasoning') emitted.reasoning += delta.text;
      else emitted.content += delta.text;
      handlers.onDelta?.(delta);
    };

    try {
      if (signal?.aborted) throw cancelledError();
      if (!session.token) {
        throw new BridgeError('DeepSeek user token is missing. Run `deepseek --login` again.', 'not_signed_in', 401);
      }

      const sessionId =
        payload.sessionId ||
        (await this.withTransientRetry((attemptSignal) => this.createSession(attemptSignal), {
          signal,
          deadline,
          label: 'DeepSeek session creation',
        }));

      const fileIds = [];
      for (const att of payload.attachments || []) {
        const t0 = Date.now();
        const fileId = await this.withTransientRetry((attemptSignal) => this.uploadAttachment(att, attemptSignal), {
          signal,
          deadline,
          label: `upload ${att.name || 'file'}`,
          idleTimeout: UPLOAD_IDLE_TIMEOUT,
        });
        fileIds.push(fileId);
        if (debugLines) {
          debugLines.push(
            `upload ${att.name || 'file'} ${att.mime || '?'} ${Math.round((((att.dataBase64 || '').length * 0.75) / 1024))}k -> ${fileId} ${Date.now() - t0}ms`,
          );
        }
      }

      handlers.onReady?.({ sessionId });

      let messageId = null;
      let title = null;
      let usage = null;
      let startFailures = 0;

      for (;;) {
        if (signal?.aborted) throw cancelledError();
        if (Date.now() >= deadline) throw timeoutError();

        const pow = await this.withTransientRetry(
          (attemptSignal) => this.powHeader('/api/v0/chat/completion', attemptSignal),
          { signal, deadline, label: 'DeepSeek PoW challenge' },
        );

        const attempt = createAttempt({ signal, deadline, idleTimeout: STREAM_IDLE_TIMEOUT });
        let failure = null;
        try {
          const res = await this.startCompletion({
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
          });

          const stream = await this.consumeSSE(res, {
            onDelta: emit,
            onReady: (info) => {
              if (info.messageId != null) messageId = info.messageId;
              handlers.onReady?.({ sessionId, ...info });
            },
            resetIdle: attempt.resetIdle,
            debugLines,
            signal: attempt.signal,
          });
          if (stream.messageId != null) messageId = stream.messageId;
          if (stream.title) title = stream.title;
          if (stream.usage) usage = stream.usage;
          return { sessionId, messageId, usage, title, finish: 'stop', debugLines };
        } catch (err) {
          failure = normalizeAttemptError(err, attempt, signal);
        } finally {
          attempt.dispose();
        }

        if (failure.code === 'cancelled' || failure.code === 'timeout') throw failure;

        const canRecover =
          messageId != null &&
          failure.code !== 'invalid_parent' &&
          failure.code !== 'not_signed_in' &&
          failure.code !== 'invalid_pow';
        if (canRecover) {
          return this.recover({ sessionId, messageId, emit, emitted, signal, deadline, debugLines, cause: failure });
        }

        if (emitted.content || emitted.reasoning) throw failure;
        if (!isTransientError(failure) || startFailures >= MAX_START_ATTEMPTS - 1) throw failure;

        this.log(`completion attempt failed (${failure.message}); retrying from the start...`);
        await sleep(this.nextRetryDelay(startFailures, failure.retryAfter), signal);
        startFailures++;
      }
    } catch (err) {
      if (signal?.aborted) throw cancelledError();
      throw err instanceof BridgeError ? err : normalizeAttemptError(err, null, signal);
    }
  }
}
