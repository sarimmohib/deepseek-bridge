/*
 * DeepSeek Bridge — content script (runs on chat.deepseek.com).
 *
 * All HTTP happens here, inside the site's own origin, so the session cookies,
 * WAF token and localStorage user token are exactly the ones the web app uses.
 * The service worker only relays to the bridge and solves PoW.
 */

const API = 'https://chat.deepseek.com/api/v0';
const CLIENT_VERSION = '2.5.0';

const active = new Map(); // jobId -> AbortController

/* --------------------------------------------------------------- utils --- */

function getToken() {
  try {
    const raw = localStorage.getItem('userToken');
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const token = typeof parsed === 'string' ? parsed : parsed?.value;
    return token && typeof token === 'string' && token.length > 20 ? token : null;
  } catch {
    return null;
  }
}

function baseHeaders(token) {
  return {
    authorization: `Bearer ${token}`,
    'x-client-bundle-id': 'com.deepseek.chat',
    'x-client-locale': (navigator.language || 'en_US').replace('-', '_'),
    'x-client-platform': 'web',
    'x-client-timezone-offset': String(-new Date().getTimezoneOffset() * 60),
    'x-client-version': CLIENT_VERSION,
  };
}

function headers(token, extra = {}) {
  return { ...baseHeaders(token), 'content-type': 'application/json', ...extra };
}

function uploadHeaders(token, pow) {
  return { ...baseHeaders(token), accept: '*/*', 'x-ds-pow-response': pow };
}

async function api(path, { token, body, method = 'POST', extraHeaders } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: headers(token, extraHeaders),
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`DeepSeek API ${path} returned HTTP ${res.status}: ${text.slice(0, 160)}`);
  }
  if (json.code !== 0 || (json.data && json.data.biz_code !== 0)) {
    const bizMsg = json.data?.biz_msg || json.msg || `HTTP ${res.status}`;
    const err = new Error(`DeepSeek ${path}: ${bizMsg}`);
    err.code = bizMsg;
    err.status = res.status;
    throw err;
  }
  return json.data?.biz_data ?? {};
}

/* ------------------------------------------------------------------ pow --- */

async function powHeader(token, targetPath) {
  // A solved challenge is single-use: the server answers INVALID_POW_RESPONSE
  // (HTTP 200, JSON body) if the same response is sent twice, so always ask for
  // a fresh challenge before each completion.
  const data = await api('/chat/create_pow_challenge', { token, body: { target_path: targetPath } });
  const challenge = data.challenge;
  if (!challenge) throw new Error('DeepSeek did not return a PoW challenge');

  const solved = await chrome.runtime.sendMessage({ type: 'ds.pow', challenge });
  if (!solved?.ok) throw new Error(`PoW solve failed: ${solved?.error || 'unknown'}`);

  return btoa(JSON.stringify(solved.answer));
}

/* ------------------------------------------------------------ attachments --- */

async function uploadAttachment(token, att) {
  if (!att?.dataBase64) throw new Error('attachment has no data');
  const bin = atob(att.dataBase64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const blob = new Blob([bytes], { type: att.mime || 'application/octet-stream' });
  const form = new FormData();
  form.append('file', blob, att.name || 'file');

  const pow = await powHeader(token, '/api/v0/file/upload_file');
  const res = await fetch(`${API}/file/upload_file`, {
    method: 'POST',
    headers: uploadHeaders(token, pow),
    body: form,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`file upload returned HTTP ${res.status}: ${text.slice(0, 160)}`);
  }
  const bizCode = json?.data?.biz_code;
  if (!res.ok || json.code !== 0 || (bizCode != null && bizCode !== 0)) {
    const msg = json?.data?.biz_msg || json?.msg || `HTTP ${res.status}`;
    throw new Error(`file upload failed (${att.name || 'file'}): ${msg}`);
  }
  const id = json?.data?.biz_data?.id;
  if (!id) throw new Error(`file upload did not return an id (${att.name || 'file'})`);
  return id;
}

/* ------------------------------------------------------------- sessions --- */

async function createSession(token) {
  const data = await api('/chat_session/create', { token, body: {} });
  const id = data.chat_session?.id;
  if (!id) throw new Error('Could not create a DeepSeek chat session');
  return id;
}

async function currentUser() {
  try {
    const data = await api('/users', { token: getToken(), method: 'GET' });
    return data.user?.email || data.user?.name || null;
  } catch {
    return null;
  }
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
      if (op === 'SET' && value && typeof value === 'object') state.response = value.response ? { ...state.response, ...value } : value;
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

/* ------------------------------------------------------------- job run --- */

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

function emitEvent(id, event) {
  chrome.runtime.sendMessage({ type: 'ds.event', id, event }).catch(() => {});
}

async function runJob(job) {
  const { id, payload } = job;
  const controller = new AbortController();
  active.set(id, controller);

  try {
    const token = getToken();
    if (!token) {
      emitEvent(id, {
        type: 'job.error',
        id,
        code: 'not_signed_in',
        message: 'Not signed in on chat.deepseek.com. Log in in that tab and retry.',
      });
      return;
    }

    const sessionId = payload.sessionId || (await createSession(token));
    const debugLines = payload.debug === true ? [] : null;
    if (debugLines) debugLines.push(`job start cont=${!!payload.continuation} parent=${payload.parentMessageId ?? 'null'}`);

    const fileIds = [];
    for (const att of payload.attachments || []) {
      const t0 = Date.now();
      const fileId = await uploadAttachment(token, att);
      fileIds.push(fileId);
      if (debugLines) {
        debugLines.push(
          `upload ${att.name || 'file'} ${att.mime || '?'} ${Math.round((att.dataBase64 || '').length * 0.75 / 1024)}k -> ${fileId} ${Date.now() - t0}ms`,
        );
      }
    }

    const pow = await powHeader(token, '/api/v0/chat/completion');

    emitEvent(id, { type: 'job.ready', id, sessionId });

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

    const res = await fetch(`${API}/chat/completion`, {
      method: 'POST',
      headers: headers(token, {
        'x-ds-pow-response': pow,
        accept: '*/*',
      }),
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (debugLines) {
      debugLines.push(
        `http ${res.status} type=${res.headers.get('content-type')} len=${res.headers.get('content-length')}`,
      );
    }

    // Errors arrive as plain JSON with HTTP 200. Without this check the SSE
    // parser would find no events and the caller would get an empty message.
    const contentType = res.headers.get('content-type') || '';
    if (!res.ok || contentType.includes('application/json')) {
      const text = await res.text();
      let msg = `DeepSeek completion failed (HTTP ${res.status})`;
      try {
        const j = JSON.parse(text);
        msg = j?.data?.biz_msg || j?.msg || msg;
        if (j?.code === 40301) msg = 'DeepSeek rejected the proof-of-work response (INVALID_POW_RESPONSE).';
      } catch {
        if (text) msg += `: ${text.slice(0, 160)}`;
      }
      throw Object.assign(new Error(msg), { code: 'completion_failed', status: res.status });
    }

    let messageId = null;
    let title = null;
    let usage = null;
    let status = null;

    const acc = createAccumulator((delta) => emitEvent(id, { type: 'job.delta', id, ...delta }));

    const handler = sseHandler({
      debugLines,
      onEvent(name, data) {
        if (name === 'ready') {
          messageId = data.response_message_id ?? messageId;
          emitEvent(id, { type: 'job.ready', id, sessionId, messageId, requestMessageId: data.request_message_id });
          return;
        }
        if (name === 'title') {
          title = data.content || title;
          return;
        }
        if (name === 'close') {
          return;
        }
        if (name === 'error') {
          throw Object.assign(new Error(data.msg || data.message || 'DeepSeek stream error'), { code: 'stream_error' });
        }
        acc.applyMessage(data);
        const r = acc.state.response;
        if (r) {
          if (typeof r.status === 'string' && r.status !== 'WIP') status = r.status;
          if (r.accumulated_token_usage) usage = { completion: r.accumulated_token_usage };
        }
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
      buffer += decoder.decode(value, { stream: true });
      buffer = parseSSEStream(buffer, handler);
      if (controller.signal.aborted) break;
    }
    buffer += decoder.decode();
    if (buffer.length) parseSSEStream(buffer + '\n\n', handler);
    if (debugLines) debugLines.push(`body ${bytes} bytes; tail=${JSON.stringify(buffer.slice(-160))}`);

    emitEvent(id, {
      type: 'job.done',
      id,
      sessionId,
      messageId,
      usage,
      title,
      finish: 'stop',
      debugLines,
    });
  } catch (err) {
    if (controller.signal.aborted) {
      emitEvent(id, { type: 'job.error', id, code: 'cancelled', message: 'Cancelled' });
    } else {
      emitEvent(id, {
        type: 'job.error',
        id,
        code: err?.code || 'bridge_error',
        message: String(err?.message || err),
      });
    }
  } finally {
    active.delete(id);
  }
}

/* --------------------------------------------------------------- wiring --- */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'ds.ping') {
    sendResponse({ ok: true, url: location.href, signedIn: !!getToken() });
    return false;
  }
  if (msg?.type === 'ds.job') {
    runJob(msg.job);
    sendResponse({ ok: true });
    return false;
  }
  if (msg?.type === 'ds.cancel') {
    const ctl = active.get(msg.id);
    if (ctl) ctl.abort();
    sendResponse({ ok: !!ctl });
    return false;
  }
  return false;
});

// Tell the bridge who we are (best effort, useful in its status page).
if (getToken()) {
  currentUser().then((user) => {
    if (user) chrome.runtime.sendMessage({ type: 'ds.user', user }).catch(() => {});
  });
}
