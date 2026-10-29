import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { attachWebSocket, WsConnection } from './ws.js';
import { Agent, BridgeError } from './agent.js';
import { DirectClient } from './direct.js';
import { handleChatCompletions, sendError, MODELS, bridgeQueue, clampMaxUpstream } from './openai.js';
import { dashboardHtml } from './dashboard.js';
import { sessionSummary } from './session.js';
import * as accounts from './accounts.js';
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

async function readJsonBody(req) {
  const raw = await readBody(req);
  const text = raw.toString('utf8').trim();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new BridgeError('Body is not valid JSON', 'invalid_json', 400);
  }
}

// A failed `replace` must not destroy the previous pool; re-add its snapshot.
function restoreAccounts(snapshot) {
  if (!Array.isArray(snapshot) || !snapshot.length) return;
  accounts.clearAccounts();
  for (const account of snapshot) {
    try {
      accounts.addAccount({
        token: account.token,
        cookies: account.cookies,
        userAgent: account.userAgent,
        user: account.user,
        label: account.label,
      });
    } catch {
      // One malformed snapshot entry must not mask the original verification
      // failure. Tokens in the pool are validated on the way in.
    }
  }
}

// `direct` is injectable so tests (and embedding hosts) can stub the outbound
// DeepSeek client without touching the network; production always gets a real
// DirectClient.
export function createServer({ config, store, log = () => {}, direct: directClient = null }) {
  bridgeQueue.max = clampMaxUpstream(config?.maxUpstream);
  const agent = new Agent({ log });
  const direct = directClient || new DirectClient({ log });

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
        const accountInfo = accounts.accountsSummary();
        const directReady = accountInfo.count > 0;
        json(res, 200, {
          ok: true,
          version: VERSION,
          extension: agent.connected,
          direct: directReady,
          mode: directReady ? 'direct' : agent.connected ? 'extension' : 'offline',
          accounts: { count: accountInfo.count, ready: accountInfo.ready, cooling: accountInfo.cooling },
          upstream: { active: bridgeQueue.active, queued: bridgeQueue.queued, max: bridgeQueue.max },
        });
        return;
      }

      if (url.pathname === '/v1/bridge/log' && req.method === 'GET') {
        const lines = Math.min(500, Math.max(1, Number(url.searchParams.get('lines')) || 80));
        const logFile = path.join(paths.CONFIG_DIR, 'bridge.log');
        let out;
        try {
          out = fs.readFileSync(logFile, 'utf8').split('\n').slice(-lines);
        } catch {
          out = [`(no log file at ${logFile})`];
        }
        // The startup banner prints the API key; never hand it back out.
        out = out.map((line) => line.replace(/sk-ds-[a-f0-9]+/g, 'sk-ds-…'));
        json(res, 200, { lines: out });
        return;
      }

      if (url.pathname.startsWith('/v1/conversations/') && req.method === 'DELETE') {
        const key = decodeURIComponent(url.pathname.slice('/v1/conversations/'.length));
        if (!key || !store.getConversation(key)) {
          sendError(res, 404, 'No such conversation', 'not_found');
          return;
        }
        store.deleteConversation(key);
        store.flush();
        json(res, 200, { ok: true, deleted: key });
        return;
      }

      if (url.pathname === '/' && req.method === 'GET') {
        // Static dashboard: no data embedded, all fetches are auth-gated.
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(dashboardHtml);
        return;
      }

      if (!authorized) {
        sendError(res, 401, 'Invalid or missing API key. Run `deepseek key` and send it in the Authorization header.', 'invalid_api_key');
        return;
      }

      // ---- DeepSeek account pool --------------------------------------------
      // Every route below is auth-gated and exposes redacted account summaries
      // only; tokens never appear in a response body (except the legacy
      // session/token export used by the dashboard and another device's login).
      if (url.pathname === '/v1/bridge/accounts' && req.method === 'GET') {
        const summary = accounts.accountsSummary();
        json(res, 200, {
          ok: true,
          count: summary.count,
          ready: summary.ready,
          cooling: summary.cooling,
          accounts: summary.accounts,
        });
        return;
      }

      if (url.pathname === '/v1/bridge/accounts' && req.method === 'POST') {
        let body;
        try {
          body = await readJsonBody(req);
        } catch (err) {
          sendError(res, 400, err?.message || 'Body is not valid JSON', err?.code || 'invalid_json');
          return;
        }
        const token = typeof body?.token === 'string' ? body.token.trim() : '';
        if (!token || token.length < 20) {
          sendError(res, 400, 'A DeepSeek userToken (20+ characters) is required.', 'invalid_token');
          return;
        }
        const replace = body?.replace === true;
        // Snapshot before replace so a token DeepSeek rejects does not wipe the
        // pool the user already had.
        const snapshot = replace ? accounts.loadAccounts() : null;
        const replaced = replace ? accounts.clearAccounts().removed : 0;
        let result;
        try {
          result = accounts.addAccount({
            token,
            label: typeof body?.label === 'string' ? body.label.slice(0, 80) : undefined,
            cookies: Array.isArray(body?.cookies) ? body.cookies : undefined,
            userAgent: typeof body?.userAgent === 'string' ? body.userAgent : undefined,
            makePrimary: replace || body?.makePrimary === true,
          });
        } catch (err) {
          if (snapshot) restoreAccounts(snapshot);
          sendError(res, 400, err?.message || 'Could not store the token.', 'invalid_token');
          return;
        }

        try {
          // Verify the exact account that was just added: a token checked under
          // another account's cookies would be a false positive. Bounded so a
          // hung DeepSeek endpoint cannot hold the HTTP request forever.
          await direct.verify(AbortSignal.timeout(30_000), { accountId: result.account.id });
        } catch (err) {
          const warning = err?.message || String(err);
          if (result.created) accounts.removeAccount(result.account.id);
          if (snapshot) restoreAccounts(snapshot);
          log(`account verification failed: ${warning}`);
          sendError(res, 400, warning || 'DeepSeek rejected that token.', err?.code || 'not_signed_in');
          return;
        }

        const summary = accounts.accountsSummary();
        json(res, 200, {
          ok: true,
          verified: true,
          replaced,
          created: result.created,
          duplicate: result.duplicate,
          account: summary.accounts.find((entry) => entry.id === result.account.id) || null,
          count: summary.count,
          ready: summary.ready,
          cooling: summary.cooling,
          accounts: summary.accounts,
        });
        return;
      }

      if (url.pathname === '/v1/bridge/accounts' && req.method === 'DELETE') {
        const { removed } = accounts.clearAccounts();
        direct.reloadSession();
        json(res, 200, { ok: true, removed, count: 0, accounts: [] });
        return;
      }

      if (url.pathname.startsWith('/v1/bridge/accounts/') && req.method === 'DELETE') {
        const id = decodeURIComponent(url.pathname.slice('/v1/bridge/accounts/'.length));
        if (!id) {
          sendError(res, 400, 'An account id is required.', 'invalid_account_id');
          return;
        }
        if (!accounts.removeAccount(id)) {
          sendError(res, 404, `No account ${id}.`, 'not_found');
          return;
        }
        direct.reloadSession();
        json(res, 200, { ok: true, removed: id, count: accounts.accountCount() });
        return;
      }

      if (url.pathname === '/v1/bridge/session/token' && req.method === 'GET') {
        // Auth-gated like every other route: hands out the primary DeepSeek
        // login token so the dashboard can copy it or another device can run
        // `deepseek --login --manual --token`.
        const primary = accounts.getPrimaryAccount();
        if (!primary?.token) {
          json(res, 200, { ok: false, reason: 'no_session' });
          return;
        }
        const session = accounts.accountSession(primary);
        const full = url.searchParams.get('full') === '1';
        const payload = {
          ok: true,
          accountId: primary.id,
          token: session.token,
          updatedAt: session.updatedAt || null,
          cookiesCount: Array.isArray(session.cookies) ? session.cookies.length : 0,
        };
        if (full) {
          payload.cookies = Array.isArray(session.cookies) ? session.cookies : [];
          if (session.userAgent) payload.userAgent = session.userAgent;
        }
        json(res, 200, payload);
        return;
      }

      if (url.pathname === '/v1/models' && req.method === 'GET') {
        json(res, 200, { object: 'list', data: MODELS });
        return;
      }

      if (url.pathname === '/v1/bridge/status' && req.method === 'GET') {
        const session = sessionSummary();
        const accountInfo = accounts.accountsSummary();
        json(res, 200, {
          ok: true,
          version: VERSION,
          ...agent.status,
          mode: session.available ? 'direct' : agent.connected ? 'extension' : 'offline',
          direct: session,
          accounts: { count: accountInfo.count, ready: accountInfo.ready, cooling: accountInfo.cooling },
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

      if (url.pathname === '/v1/bridge/log' && req.method === 'GET') {
        const lines = Math.min(500, Math.max(1, Number(url.searchParams.get('lines')) || 80));
        const logFile = path.join(paths.CONFIG_DIR, 'bridge.log');
        let out;
        try {
          out = fs.readFileSync(logFile, 'utf8').split('\n').slice(-lines);
        } catch {
          out = [`(no log file at ${logFile})`];
        }
        // The startup banner prints the API key; never hand it back out.
        out = out.map((line) => line.replace(/sk-ds-[a-f0-9]+/g, 'sk-ds-…'));
        json(res, 200, { lines: out });
        return;
      }

      if (url.pathname.startsWith('/v1/conversations/') && req.method === 'DELETE') {
        const key = decodeURIComponent(url.pathname.slice('/v1/conversations/'.length));
        if (!key || !store.getConversation(key)) {
          sendError(res, 404, 'No such conversation', 'not_found');
          return;
        }
        store.deleteConversation(key);
        store.flush();
        json(res, 200, { ok: true, deleted: key });
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
        // Export upserts into the pool: logging in from the browser must never
        // discard accounts the user added manually.
        let added;
        try {
          added = accounts.addAccount({
            token: data.token,
            cookies: data.cookies,
            userAgent: data.userAgent,
            user: data.user || agent.lastHello?.user || null,
          });
        } catch (err) {
          throw new BridgeError(err?.message || 'Could not store the exported session.', 'session_export_failed', 400);
        }
        direct.reloadSession();
        let verified = false;
        let warning = null;
        try {
          await direct.verify(null, { accountId: added.account.id });
          verified = true;
        } catch (err) {
          warning = err?.message || String(err);
          log(`session verification failed: ${warning}`);
        }
        json(res, 200, {
          ok: true,
          verified,
          warning,
          accountId: added.account.id,
          created: added.created,
          duplicate: added.duplicate,
          ...sessionSummary(),
        });
        return;
      }

      if (url.pathname === '/v1/bridge/session/verify' && req.method === 'POST') {
        direct.reloadSession();
        const primary = accounts.getPrimaryAccount();
        if (!primary?.token) {
          throw new BridgeError('No terminal DeepSeek session. Run `deepseek --login` first.', 'not_signed_in', 401);
        }
        const user = await direct.verify(null, { accountId: primary.id });
        json(res, 200, { ok: true, user, accountId: primary.id, ...sessionSummary() });
        return;
      }

      if (url.pathname === '/v1/bridge/session' && (req.method === 'DELETE' || req.method === 'POST')) {
        const { removed } = accounts.clearAccounts();
        direct.reloadSession();
        json(res, 200, { ok: true, cleared: removed > 0, removed, ...sessionSummary() });
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
            if (typeof v.accountId === 'string') item.accountId = v.accountId;
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

      if (url.pathname === '/v1/bridge/log' && req.method === 'GET') {
        const lines = Math.min(500, Math.max(1, Number(url.searchParams.get('lines')) || 80));
        const logFile = path.join(paths.CONFIG_DIR, 'bridge.log');
        let out;
        try {
          out = fs.readFileSync(logFile, 'utf8').split('\n').slice(-lines);
        } catch {
          out = [`(no log file at ${logFile})`];
        }
        // The startup banner prints the API key; never hand it back out.
        out = out.map((line) => line.replace(/sk-ds-[a-f0-9]+/g, 'sk-ds-…'));
        json(res, 200, { lines: out });
        return;
      }

      if (url.pathname.startsWith('/v1/conversations/') && req.method === 'DELETE') {
        const key = decodeURIComponent(url.pathname.slice('/v1/conversations/'.length));
        if (!key || !store.getConversation(key)) {
          sendError(res, 404, 'No such conversation', 'not_found');
          return;
        }
        store.deleteConversation(key);
        store.flush();
        json(res, 200, { ok: true, deleted: key });
        return;
      }

      if (url.pathname === '/v1/conversations' && req.method === 'GET') {
        const items = Object.entries(store.data.conversations).map(([key, v]) => {
          const item = {
            key,
            sessionId: v.sessionId,
            parentId: v.parentId,
            turns: v.turns,
            model: v.model,
            updatedAt: v.updatedAt,
          };
          // Conversations are account-scoped: expose which account owns one so
          // clients can see rotation happening without seeing credentials.
          if (typeof v.accountId === 'string') item.accountId = v.accountId;
          return item;
        });
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
