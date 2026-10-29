/*
 * Accounts REST API tests.
 *
 * Runs against a real HTTP server with a throwaway DS_BRIDGE_HOME and a stubbed
 * DirectClient, so nothing here touches the network or the user's real config.
 * The home directory must be set before importing src/config.js, which is why
 * the bridge modules are loaded with dynamic import after the env assignment.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsb-accounts-api-'));
process.env.DS_BRIDGE_HOME = HOME;
process.env.DEEPSEEK_NO_UPDATE = '1';

const { createServer } = await import('../src/server.js');
const accounts = await import('../src/accounts.js');
const { loadConfig, Store } = await import('../src/config.js');

const TOKEN_A = 'tok_' + 'a'.repeat(40);
const TOKEN_B = 'tok_' + 'b'.repeat(40);
const TOKEN_BAD = 'tok_' + 'z'.repeat(40);
const TOKEN_C = 'tok_' + 'c'.repeat(40);
const ALL_TOKENS = [TOKEN_A, TOKEN_B, TOKEN_BAD, TOKEN_C];

let server;
let stopServer;
let base;
let key;
let store;
let fakeDirect;

function makeFakeDirect() {
  return {
    available: true,
    hasMultipleAccounts: true,
    verifyCalls: [],
    reloadSession() {
      return null;
    },
    // Mirrors the rotation-core contract: verify(signal, { accountId }).
    async verify(signal, opts = {}) {
      this.verifyCalls.push({ signal: signal || null, accountId: opts.accountId || null });
      const account = opts.accountId ? accounts.getAccount(opts.accountId) : null;
      if (account && account.token === TOKEN_BAD) {
        const err = new Error('DeepSeek rejected that token. Copy a fresh userToken and try again.');
        err.code = 'not_signed_in';
        err.status = 401;
        throw err;
      }
      return null;
    },
  };
}

function auth(extra = {}) {
  return { authorization: `Bearer ${key}`, ...extra };
}

async function request(pathname, { method = 'GET', authed = true, body, headers = {} } = {}) {
  const init = { method, headers: { ...headers } };
  if (authed) init.headers.authorization = `Bearer ${key}`;
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(`${base}${pathname}`, init);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { res, status: res.status, text, json };
}

function assertNoToken(text) {
  for (const token of ALL_TOKENS) {
    assert.equal(text.includes(token), false, 'response leaked a DeepSeek token');
  }
}

async function addAccount(token, extra = {}) {
  return request('/v1/bridge/accounts', { method: 'POST', body: { token, ...extra } });
}

test.before(async () => {
  fakeDirect = makeFakeDirect();
  const config = loadConfig();
  key = config.key;
  store = new Store();
  const created = createServer({ config, store, log: () => {}, direct: fakeDirect });
  server = created.server;
  stopServer = created.close;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (typeof stopServer === 'function') stopServer();
  if (server) await new Promise((resolve) => server.close(resolve));
  try {
    fs.rmSync(HOME, { recursive: true, force: true });
  } catch {
    /* Windows can keep a transient handle; the temp dir is disposable. */
  }
});

test('empty pool: health is public and reports zero accounts', async () => {
  const { status, text, json } = await request('/health', { authed: false });
  assert.equal(status, 200);
  assert.equal(json.ok, true);
  assert.equal(json.direct, false);
  assert.equal(json.mode, 'offline');
  assert.deepEqual(json.accounts, { count: 0, ready: 0, cooling: 0 });
  assertNoToken(text);
});

test('accounts API and session token require the bridge API key', async () => {
  const list = await request('/v1/bridge/accounts', { authed: false });
  assert.equal(list.status, 401);
  const token = await request('/v1/bridge/session/token', { authed: false });
  assert.equal(token.status, 401, 'session token must never be handed out unauthenticated');
  const wrong = await fetch(`${base}/v1/bridge/accounts`, { headers: { authorization: 'Bearer sk-ds-wrong' } });
  assert.equal(wrong.status, 401);
});

test('POST /v1/bridge/accounts adds and verifies one account', async () => {
  const before = fakeDirect.verifyCalls.length;
  const { status, text, json } = await addAccount(TOKEN_A, { label: 'primary-test' });
  assert.equal(status, 200);
  assert.equal(json.ok, true);
  assert.equal(json.verified, true);
  assert.equal(json.created, true);
  assert.equal(json.count, 1);
  assert.equal(json.account.id, accounts.tokenId(TOKEN_A));
  assert.equal(json.account.label, 'primary-test');
  assert.equal(json.account.state, 'ready');
  assert.equal('token' in json.account, false);
  assert.equal(json.accounts.length, 1);
  assertNoToken(text);
  assert.equal(fakeDirect.verifyCalls.length, before + 1);
  assert.equal(fakeDirect.verifyCalls.at(-1).accountId, accounts.tokenId(TOKEN_A));
  assert.ok(fakeDirect.verifyCalls.at(-1).signal, 'verification is bounded by an abort signal');
});

test('GET /v1/bridge/accounts lists redacted summaries only', async () => {
  const { status, text, json } = await request('/v1/bridge/accounts');
  assert.equal(status, 200);
  assert.equal(json.ok, true);
  assert.equal(json.count, 1);
  assert.equal(json.accounts.length, 1);
  const account = json.accounts[0];
  assert.equal(account.id, accounts.tokenId(TOKEN_A));
  assert.equal(typeof account.cookies, 'number');
  assert.equal(typeof account.throttleHits, 'number');
  assert.equal('token' in account, false);
  assertNoToken(text);
});

test('re-adding the same token dedupes instead of growing the pool', async () => {
  const { status, json } = await addAccount(TOKEN_A, { label: 'renamed' });
  assert.equal(status, 200);
  assert.equal(json.count, 1);
  assert.equal(json.created, false);
  assert.equal(json.duplicate, true);
  assert.equal(json.account.label, 'renamed');
  assert.equal(accounts.accountCount(), 1);
});

test('a rejected token is removed again and the existing pool is kept', async () => {
  const { status, json } = await addAccount(TOKEN_BAD);
  assert.equal(status, 400);
  assert.ok(json.error);
  assert.equal(json.error.code, 'not_signed_in');
  assert.match(json.error.message, /rejected/);
  assert.equal(accounts.accountCount(), 1);
  assert.equal(accounts.getAccount(accounts.tokenId(TOKEN_BAD)), null);
  assert.ok(accounts.getAccount(accounts.tokenId(TOKEN_A)));
});

test('replace swaps the pool and keeps the new account only', async () => {
  const { status, json } = await addAccount(TOKEN_B, { replace: true });
  assert.equal(status, 200);
  assert.equal(json.count, 1);
  assert.equal(json.replaced, 1);
  assert.equal(json.account.id, accounts.tokenId(TOKEN_B));
  const ids = accounts.listAccounts().map((account) => account.id);
  assert.deepEqual(ids, [accounts.tokenId(TOKEN_B)]);
});

test('a rejected replace restores the previous pool', async () => {
  const { status } = await addAccount(TOKEN_BAD, { replace: true });
  assert.equal(status, 400);
  assert.equal(accounts.accountCount(), 1);
  assert.ok(accounts.getAccount(accounts.tokenId(TOKEN_B)), 'previous account must survive a failed replace');
});

test('health and status expose account counts but no secrets', async () => {
  const health = await request('/health', { authed: false });
  assert.equal(health.status, 200);
  assert.equal(health.json.direct, true);
  assert.equal(health.json.mode, 'direct');
  assert.equal(health.json.accounts.count, 1);
  assert.equal(health.json.accounts.ready, 1);
  assertNoToken(health.text);

  const status = await request('/v1/bridge/status');
  assert.equal(status.status, 200);
  assert.equal(status.json.accounts.count, 1);
  assert.equal(status.json.direct.accounts, 1);
  assert.equal(status.json.direct.file, path.join(HOME, 'accounts.json'));
  assertNoToken(status.text);
});

test('session endpoints report the pool and export the primary token', async () => {
  const summary = await request('/v1/bridge/session');
  assert.equal(summary.status, 200);
  assert.equal(summary.json.ok, true);
  assert.equal(summary.json.accounts, 1);
  assert.equal(summary.json.file, path.join(HOME, 'accounts.json'));

  const token = await request('/v1/bridge/session/token');
  assert.equal(token.status, 200);
  assert.equal(token.json.ok, true);
  assert.equal(token.json.token, TOKEN_B);
  assert.equal(token.json.accountId, accounts.tokenId(TOKEN_B));

  const full = await request('/v1/bridge/session/token?full=1');
  assert.equal(full.json.accountId, accounts.tokenId(TOKEN_B));
  assert.ok(Array.isArray(full.json.cookies));
});

test('conversation listings carry the owning accountId when present', async () => {
  const accountId = accounts.tokenId(TOKEN_B);
  store.data.conversations = {
    'conv-one': {
      model: 'deepseek-reasoner',
      turns: 2,
      sessionId: 'session-1',
      parentId: 'message-1',
      accountId,
      tokensIn: 10,
      tokensOut: 20,
      updatedAt: Date.now(),
    },
  };
  const bridge = await request('/v1/bridge/conversations');
  assert.equal(bridge.status, 200);
  assert.equal(bridge.json.conversations.length, 1);
  assert.equal(bridge.json.conversations[0].accountId, accountId);
  const plain = await request('/v1/conversations');
  assert.equal(plain.json.data[0].accountId, accountId);
  store.data.conversations = {};
});

test('DELETE /v1/bridge/accounts/:id removes one account', async () => {
  const id = accounts.tokenId(TOKEN_B);
  const { status, json } = await request(`/v1/bridge/accounts/${id}`, { method: 'DELETE' });
  assert.equal(status, 200);
  assert.equal(json.ok, true);
  assert.equal(json.removed, id);
  assert.equal(json.count, 0);
  assert.equal(accounts.accountCount(), 0);

  const again = await request(`/v1/bridge/accounts/${id}`, { method: 'DELETE' });
  assert.equal(again.status, 404);
  assert.equal(again.json.error.code, 'not_found');
});

test('DELETE /v1/bridge/accounts clears the whole pool', async () => {
  assert.equal((await addAccount(TOKEN_A)).status, 200);
  assert.equal((await addAccount(TOKEN_C)).status, 200);
  assert.equal(accounts.accountCount(), 2);
  const { status, json } = await request('/v1/bridge/accounts', { method: 'DELETE' });
  assert.equal(status, 200);
  assert.equal(json.removed, 2);
  assert.equal(json.count, 0);
  assert.equal(accounts.accountCount(), 0);
  const health = await request('/health', { authed: false });
  assert.equal(health.json.direct, false);
});

test('DELETE /v1/bridge/session clears every account and the legacy file', async () => {
  assert.equal((await addAccount(TOKEN_A)).status, 200);
  fs.writeFileSync(path.join(HOME, 'session.json'), JSON.stringify({ token: TOKEN_A, cookies: [] }));
  const { status, json } = await request('/v1/bridge/session', { method: 'DELETE' });
  assert.equal(status, 200);
  assert.equal(json.ok, true);
  assert.equal(json.removed, 1);
  assert.equal(json.cleared, true);
  assert.equal(json.accounts, 0);
  assert.equal(fs.existsSync(path.join(HOME, 'accounts.json')), false);
  assert.equal(fs.existsSync(path.join(HOME, 'session.json')), false);
});

test('POST /v1/bridge/accounts rejects malformed bodies without touching the pool', async () => {
  const noToken = await request('/v1/bridge/accounts', { method: 'POST', body: { label: 'x' } });
  assert.equal(noToken.status, 400);
  assert.equal(noToken.json.error.code, 'invalid_token');

  const shortToken = await addAccount('too-short');
  assert.equal(shortToken.status, 400);
  assert.equal(shortToken.json.error.code, 'invalid_token');

  const res = await fetch(`${base}/v1/bridge/accounts`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: '{not json',
  });
  assert.equal(res.status, 400);
  assert.equal(accounts.accountCount(), 0);
});
