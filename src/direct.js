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
const IDLE_TIMEOUT = 180 * 1000;

function looksLikeHtml(text) {
  return /^\s*(?:<!doctype html|<html)/i.test(String(text || ''));
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
      if (!raw) return;
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
  constructor({ log = () => {} } = {}) {
    this.log = log;
    this.session = loadSession();
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
        throw new BridgeError(
          'DeepSeek returned its web page instead of API JSON. The web session may have expired; run `deepseek --login` again.',
          'not_signed_in',
          401,
        );
      }
      throw new BridgeError(
        `DeepSeek API ${path} returned HTTP ${res.status}: ${text.slice(0, 160)}`,
        'deepseek_http_error',
        res.status || 502,
      );
    }
    if (json.code !== 0 || (json.data && json.data.biz_code != null && json.data.biz_code !== 0)) {
      const bizMsg = json.data?.biz_msg || json.msg || `HTTP ${res.status}`;
      const code = json.code === 401 || /sign in|login|token|not logged/i.test(String(bizMsg)) ? 'not_signed_in' : 'deepseek_error';
      throw new BridgeError(
        `DeepSeek ${path}: ${bizMsg}. If the browser session expired, run \`deepseek --login\` again.`,
        code,
        res.status === 200 ? 502 : res.status || 502,
      );
    }
    return json.data?.biz_data ?? {};
  }

  async verify() {
    // /users is not consistently available to the web API. A PoW challenge is
    // a small authenticated call and proves the copied token and cookies work.
    const data = await this.api('/chat/create_pow_challenge', {
      body: { target_path: '/api/v0/chat/completion' },
    });
    if (!data.challenge) throw new BridgeError('DeepSeek did not return a PoW challenge.', 'deepseek_error');
    return null;
  }

  async createSession() {
    const data = await this.api('/chat_session/create', { body: {} });
    const id = data.chat_session?.id;
    if (!id) throw new BridgeError('DeepSeek did not create a chat session.', 'deepseek_error');
    return id;
  }

  async powHeader(targetPath) {
    const data = await this.api('/chat/create_pow_challenge', { body: { target_path: targetPath } });
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
    const pow = await this.powHeader('/api/v0/file/upload_file');
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
        throw new BridgeError(
          'DeepSeek returned its web page instead of an upload response. The web session may have expired; run `deepseek --login` again.',
          'not_signed_in',
          401,
        );
      }
      throw new BridgeError(
        `file upload returned HTTP ${res.status}: ${text.slice(0, 160)}`,
        'upload_failed',
        res.status || 502,
      );
    }
    const bizCode = json?.data?.biz_code;
    if (!res.ok || json.code !== 0 || (bizCode != null && bizCode !== 0)) {
      const msg = json?.data?.biz_msg || json?.msg || `HTTP ${res.status}`;
      throw new BridgeError(`file upload failed (${att.name || 'file'}): ${msg}`, 'upload_failed');
    }
    const id = json?.data?.biz_data?.id;
    if (!id) throw new BridgeError(`file upload did not return an id (${att.name || 'file'})`, 'upload_failed');
    return id;
  }

  async run(payload, handlers = {}, { signal } = {}) {
    const session = this.reloadSession();
    if (!session) {
      throw new BridgeError(
        'No terminal DeepSeek session. Run `deepseek --login` first.',
        'not_signed_in',
        401,
      );
    }

    const debugLines = payload.debug === true ? [] : null;
    const controller = new AbortController();
    let idleTimer = null;
    let hardTimer = null;
    const abort = () => controller.abort();
    const onAbort = () => abort();

    const resetIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => controller.abort(new Error('DeepSeek stream stalled (no data).')), IDLE_TIMEOUT);
      idleTimer.unref?.();
    };

    try {
      if (signal?.aborted) throw new BridgeError('Client cancelled the request.', 'cancelled', 499);
      signal?.addEventListener?.('abort', onAbort, { once: true });
      hardTimer = setTimeout(() => controller.abort(new Error('Job exceeded the 15 minute limit.')), HARD_TIMEOUT);
      hardTimer.unref?.();
      resetIdle();

      if (!session.token) {
        throw new BridgeError('DeepSeek user token is missing. Run `deepseek --login` again.', 'not_signed_in', 401);
      }

      const sessionId = payload.sessionId || (await this.createSession());
      const fileIds = [];
      for (const att of payload.attachments || []) {
        const t0 = Date.now();
        const fileId = await this.uploadAttachment(att, controller.signal);
        fileIds.push(fileId);
        if (debugLines) {
          debugLines.push(
            `upload ${att.name || 'file'} ${att.mime || '?'} ${Math.round((att.dataBase64 || '').length * 0.75 / 1024)}k -> ${fileId} ${Date.now() - t0}ms`,
          );
        }
      }

      const pow = await this.powHeader('/api/v0/chat/completion');
      handlers.onReady?.({ sessionId });

      const body = {
        chat_session_id: sessionId,
        parent_message_id: payload.parentMessageId ?? null,
        model_type: payload.modelType || 'default',
        prompt: payload.prompt,
        ref_file_ids: fileIds,
        thinking_enabled: payload.thinking !== false,
        search_enabled: !!payload.search,
        action: null,
        preempt: false,
      };

      const res = await this.request('/chat/completion', {
        body,
        headers: { 'x-ds-pow-response': pow, accept: '*/*' },
        signal: controller.signal,
      });

      if (debugLines) {
        debugLines.push(
          `http ${res.status} type=${res.headers.get('content-type')} len=${res.headers.get('content-length')}`,
        );
      }

      const contentType = res.headers.get('content-type') || '';
      if (!res.ok || contentType.includes('application/json') || contentType.includes('text/html')) {
        const text = await res.text();
        let msg = `DeepSeek completion failed (HTTP ${res.status})`;
        try {
          const json = JSON.parse(text);
          msg = json?.data?.biz_msg || json?.msg || msg;
          if (json?.code === 40301) msg = 'DeepSeek rejected the proof-of-work response (INVALID_POW_RESPONSE).';
        } catch {
          if (looksLikeHtml(text)) {
            msg = 'DeepSeek returned its web page instead of an event stream. The web session may have expired; run `deepseek --login` again.';
          } else if (text) {
            msg += `: ${text.slice(0, 160)}`;
          }
        }
        const code = /sign in|login|token|not logged/i.test(String(msg)) ? 'not_signed_in' : 'completion_failed';
        throw new BridgeError(msg, code, res.status || 502);
      }

      let messageId = null;
      let title = null;
      let usage = null;

      const acc = createAccumulator((delta) => handlers.onDelta?.(delta));
      const handler = sseHandler({
        debugLines,
        onEvent(name, data) {
          if (name === 'ready') {
            messageId = data.response_message_id ?? messageId;
            handlers.onReady?.({
              sessionId,
              messageId,
              requestMessageId: data.request_message_id,
            });
            return;
          }
          if (name === 'title') {
            title = data.content || title;
            return;
          }
          if (name === 'close') return;
          if (name === 'error') {
            throw new BridgeError(data.msg || data.message || 'DeepSeek stream error', 'stream_error');
          }
          acc.applyMessage(data);
          const response = acc.state.response;
          if (response?.accumulated_token_usage) usage = { completion: response.accumulated_token_usage };
        },
      });

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let bytes = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value?.length || 0;
        resetIdle();
        buffer += decoder.decode(value, { stream: true });
        buffer = parseSSEStream(buffer, handler);
        if (controller.signal.aborted) break;
      }
      buffer += decoder.decode();
      if (buffer.length) parseSSEStream(buffer + '\n\n', handler);
      if (debugLines) debugLines.push(`body ${bytes} bytes; tail=${JSON.stringify(buffer.slice(-160))}`);

      if (controller.signal.aborted) {
        if (signal?.aborted) throw new BridgeError('Client cancelled the request.', 'cancelled', 499);
        const reason = controller.signal.reason;
        const message = reason instanceof Error ? reason.message : String(reason || 'DeepSeek stream stalled.');
        throw new BridgeError(message, /15 minute/i.test(message) ? 'timeout' : 'stream_stalled');
      }

      return {
        sessionId,
        messageId,
        usage,
        title,
        finish: 'stop',
        debugLines,
      };
    } catch (err) {
      if (signal?.aborted) {
        throw new BridgeError('Client cancelled the request.', 'cancelled', 499);
      }
      if (controller.signal.aborted) {
        const reason = controller.signal.reason;
        const message = reason instanceof Error ? reason.message : String(reason || 'DeepSeek stream stalled.');
        const code = /15 minute/i.test(message) ? 'timeout' : 'stream_stalled';
        throw new BridgeError(message, code);
      }
      if (err?.name === 'AbortError') throw new BridgeError('DeepSeek request was aborted.', 'cancelled', 499);
      throw err;
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
      if (hardTimer) clearTimeout(hardTimer);
      signal?.removeEventListener?.('abort', onAbort);
    }
  }
}
