import fs from 'node:fs';
import http from 'node:http';
import crypto from 'node:crypto';
import { attachWebSocket, WsConnection } from './ws.js';
import { Agent, BridgeError } from './agent.js';
import { DirectClient } from './direct.js';
import { handleChatCompletions, sendError, MODELS, bridgeQueue } from './openai.js';
import { clearSession, loadSession, saveSession, sessionSummary } from './session.js';
import { loadConfig, paths } from './config.js';
import { VERSION } from './version.js';

const MAX_BODY = 40 * 1024 * 1024;

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new BridgeError('Request body too large', 'payload_too_large', 413));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function createServer({ config, store, log = () => {} }) {
  const agent = new Agent({ log });
  const direct = new DirectClient({ log });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);

    // CORS: the bridge only listens on loopback, so a permissive policy is fine
    // and makes browser-based clients (and the extension options page) work.
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-headers', 'authorization, content-type, x-api-key');
    res.setHeader('access-control-allow-methods', 'GET, POST, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Re-read config per request so edits (model default, system prompt,
    // context-switch threshold, key rotation) apply without a restart. Only
    // trust a config we could fully parse — a missing or corrupt file must
    // not rotate the API key out from under connected clients, so the
    // startup object stays as the fallback. persist:false avoids a write
    // storm when the file predates the current defaults.
    try {
      JSON.parse(fs.readFileSync(paths.CONFIG_FILE, 'utf8'));
      config = loadConfig({ persist: false });
    } catch {
      // keep the startup config
    }

    const authHeader = req.headers.authorization || '';
    const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    const provided = bearer || req.headers['x-api-key'] || url.searchParams.get('key') || '';
    const authorized = safeEqual(provided, config.key);

    try {
      if (url.pathname === '/health') {
        const directSession = loadSession();
        json(res, 200, {
          ok: true,
          version: VERSION,
          extension: agent.connected,
          direct: Boolean(directSession),
          mode: directSession ? 'direct' : agent.connected ? 'extension' : 'offline',
          upstream: { active: bridgeQueue.active, queued: bridgeQueue.queued, max: bridgeQueue.max },
        });
        return;
      }

      if (url.pathname === '/' && req.method === 'GET') {
        const status = agent.status;
        const session = sessionSummary();
        const mode = session.available ? 'direct' : status.connected ? 'extension' : 'offline';
        const html = `<!doctype html><meta charset="utf-8"><title>deepseek-bridge</title>
<style>body{font:14px/1.5 ui-monospace,monospace;max-width:720px;margin:40px auto;padding:0 20px;background:#0b0f14;color:#c9d1d9}
b{color:#7ee787}.bad{color:#ff7b72}.k{color:#79c0ff}code{background:#161b22;padding:2px 6px;border-radius:4px}</style>
<h2>deepseek-bridge</h2>
<p>Version: <b>${VERSION}</b></p>
<p>Mode: <b class="${mode === 'offline' ? 'bad' : ''}">${mode}</b></p>
<p>Direct session: <b class="${session.available ? '' : 'bad'}">${session.available ? (session.user || 'signed in') : 'not configured'}</b>
${session.available ? ` (${session.cookies} cookies)` : ' — run <code>deepseek --login</code>'}</p>
<p>Extension: <b class="${status.connected ? '' : 'bad'}">${status.connected ? 'connected' : 'not connected'}</b>
 (${status.connections} socket(s)${status.lastHello ? `, version ${status.lastHello.version || '?'}` : ''})</p>
<p>Active jobs: ${status.activeJobs}</p>
<p>Base URL: <code>http://${config.host}:${config.port}/v1</code></p>
<p>Key: <code>${config.key.slice(0, 10)}…</code> (see <code>${paths.CONFIG_FILE}</code>)</p>
<p>Models: ${MODELS.map((m) => `<code>${m.id}</code>`).join(' ')}</p>
<p>State: <code>${paths.STATE_FILE}</code></p>`;
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(html);
        return;
      }

      if (!authorized) {
        sendError(res, 401, 'Invalid or missing API key. Run `deepseek key` and send it in the Authorization header.', 'invalid_api_key');
        return;
      }

      if (url.pathname === '/v1/models' && req.method === 'GET') {
        json(res, 200, { object: 'list', data: MODELS });
        return;
      }

      if (url.pathname === '/v1/bridge/status' && req.method === 'GET') {
        const session = sessionSummary();
        json(res, 200, {
          ok: true,
          version: VERSION,
          ...agent.status,
          mode: session.available ? 'direct' : agent.connected ? 'extension' : 'offline',
          direct: session,
          extension: {
            connected: agent.connected,
            connections: agent.connections.size,
            lastHello: agent.lastHello,
          },
          config: { port: config.port, host: config.host, model: config.defaultModel },
          capabilities: {
            vision: true,
            files: true,
            parallelToolCalls: true,
            reasoningEffort: 'hint-only',
            contextWindow: 890880,
          },
          upstream: { active: bridgeQueue.active, queued: bridgeQueue.queued, max: bridgeQueue.max },
        });
        return;
      }

      if (url.pathname === '/v1/bridge/session' && req.method === 'GET') {
        json(res, 200, { ok: true, ...sessionSummary() });
        return;
      }

      if (url.pathname === '/v1/bridge/session/export' && req.method === 'POST') {
        const data = await agent.exportSession({ timeout: 45000 });
        if (!data?.token || !Array.isArray(data.cookies)) {
          throw new BridgeError('Chrome returned an incomplete session.', 'session_export_failed');
        }
        saveSession({
          token: data.token,
          cookies: data.cookies,
          userAgent: data.userAgent,
          user: data.user || agent.lastHello?.user || null,
        });
        direct.reloadSession();
        let verified = false;
        let warning = null;
        try {
          await direct.verify();
          verified = true;
        } catch (err) {
          warning = err?.message || String(err);
          log(`session verification failed: ${warning}`);
        }
        json(res, 200, {
          ok: true,
          verified,
          warning,
          ...sessionSummary(),
        });
        return;
      }

      if (url.pathname === '/v1/bridge/session/verify' && req.method === 'POST') {
        direct.reloadSession();
        if (!direct.available) {
          throw new BridgeError('No terminal DeepSeek session. Run `deepseek --login` first.', 'not_signed_in', 401);
        }
        const user = await direct.verify();
        json(res, 200, { ok: true, user, ...sessionSummary() });
        return;
      }

      if (url.pathname === '/v1/bridge/session' && (req.method === 'DELETE' || req.method === 'POST')) {
        const cleared = clearSession();
        direct.reloadSession();
        json(res, 200, { ok: true, cleared, ...sessionSummary() });
        return;
      }

      if (url.pathname === '/v1/bridge/reload-extension' && req.method === 'POST') {
        const sent = agent.connections.size;
        agent.broadcast({ type: 'reload-extension' });
        json(res, 200, { ok: true, sent });
        return;
      }

      if (url.pathname === '/v1/bridge/conversations' && req.method === 'GET') {
        const conversations = Object.entries(store.data.conversations)
          .map(([key, v]) => {
            const item = {
              key,
              model: v.model,
              turns: v.turns,
              tokensIn: Number.isFinite(v.tokensIn) ? v.tokensIn : 0,
              tokensOut: Number.isFinite(v.tokensOut) ? v.tokensOut : 0,
              updatedAt: v.updatedAt,
            };
            if (Number.isFinite(v.sessionTokens)) item.sessionTokens = v.sessionTokens;
            if (typeof v.preview === 'string') item.preview = v.preview;
            return item;
          })
          .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
          .slice(0, 100);
        json(res, 200, {
          conversations,
          upstream: { active: bridgeQueue.active, queued: bridgeQueue.queued, max: bridgeQueue.max },
        });
        return;
      }

      if (url.pathname === '/v1/conversations' && req.method === 'GET') {
        const items = Object.entries(store.data.conversations).map(([key, v]) => ({
          key,
          sessionId: v.sessionId,
          parentId: v.parentId,
          turns: v.turns,
          model: v.model,
          updatedAt: v.updatedAt,
        }));
        json(res, 200, { object: 'list', data: items });
        return;
      }

      if (url.pathname === '/v1/conversations' && req.method === 'DELETE') {
        store.data.conversations = {};
        store.dirty = true;
        store.flush();
        json(res, 200, { ok: true, cleared: true });
        return;
      }

      if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
        const raw = await readBody(req);
        let body;
        try {
          body = JSON.parse(raw.toString('utf8') || '{}');
        } catch {
          sendError(res, 400, 'Body is not valid JSON', 'invalid_json');
          return;
        }
        await handleChatCompletions(req, res, body, { agent, direct, store, config, log });
        return;
      }

      sendError(res, 404, `No route for ${req.method} ${url.pathname}`, 'not_found');
    } catch (err) {
      log(`http error: ${err?.stack || err}`);
      sendError(res, err?.status || 500, err?.message || 'Internal error', err?.code || 'internal_error');
    }
  });

  attachWebSocket(server, {
    path: '/agent',
    onConnection: (conn, url) => {
      if (!safeEqual(url.searchParams.get('key') || '', config.key)) {
        conn.close(4001, 'bad key');
        return;
      }
      agent.attach(conn, url.searchParams);
    },
  });

  // Keep the extension service worker awake and detect half-open sockets.
  const heartbeat = setInterval(() => {
    agent.broadcast({ type: 'ping', at: Date.now() });
    for (const conn of agent.connections) {
      if (!(conn instanceof WsConnection)) continue;
      if (Date.now() - conn.lastSeen > 120000) conn.close(4002, 'idle');
    }
  }, 20000);
  heartbeat.unref?.();

  return { server, agent, close: () => clearInterval(heartbeat) };
}
