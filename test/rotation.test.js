/*
 * Multi-account rotation tests for src/direct.js.
 *
 * Every request is mocked: no DeepSeek network access, no real tokens. The
 * account pool lives in a throwaway DS_BRIDGE_HOME so the developer's real
 * config directory is never touched.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { digestHex } from '../src/pow.js';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-bridge-rotation-'));
process.env.DS_BRIDGE_HOME = home;
const accounts = await import('../src/accounts.js');
const { DirectClient, upstreamThrottle } = await import('../src/direct.js');
const { paths } = await import('../src/config.js');

const realFetch = globalThis.fetch;

const tokenA = 'rotation-account-a-token-long-enough-001';
const tokenB = 'rotation-account-b-token-long-enough-002';

const expireAt = Date.now() + 300_000;
const challenge = {
  algorithm: 'DeepSeekHashV1',
  challenge: digestHex(`rotation-salt_${expireAt}_0`),
  salt: 'rotation-salt',
  difficulty: 1,
  signature: 'rotation-signature',
  expire_at: expireAt,
  target_path: '/api/v0/chat/completion',
};

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function streamResponse(events) {
  return new Response(events.join(''), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function successStream(text) {
  return streamResponse([
    'event: ready\n',
    'data: {"request_message_id":1,"response_message_id":2}\n\n',
    `data: ${JSON.stringify({ v: { response: { fragments: [{ type: 'RESPONSE', content: text }] } } })}\n\n`,
    'event: close\n',
    'data: {}\n\n',
  ]);
}

// A clean stream with zero fragments: DeepSeek's per-account rate throttle.
function emptyReplyStream() {
  return streamResponse([
    'event: ready\n',
    'data: {"request_message_id":1,"response_message_id":2}\n\n',
    'event: close\n',
    'data: {}\n\n',
  ]);
}

function sessionIdFor(token) {
  return `sess-${token.slice(-3)}`;
}

function fileIdFor(token) {
  return `file-${token.slice(-3)}`;
}

function uploadResponse(token) {
  return jsonResponse({
    code: 0,
    data: {
      biz_code: 0,
      biz_data: { id: fileIdFor(token), status: 'SUCCESS', file_name: 'a.txt', model_kind: 1, token_usage: 0 },
    },
  });
}

function uploadRateLimited() {
  // Live shape: HTTP 200 with a biz_code/biz_msg rate-limit rejection.
  return jsonResponse({ code: 0, msg: '', data: { biz_code: 1, biz_msg: 'rate limit reached' } });
}

/**
 * Mock DeepSeek API. `completion(token, init)` decides the completion response;
 * `upload(token, init)` the upload response (defaults to success).
 * Every request is recorded in `authLog` with the bearer token it used.
 */
function mockFetch({ completion, upload = uploadResponse, authLog = [] } = {}) {
  return async (url, init = {}) => {
    const target = String(url);
    const token = String(init.headers?.authorization || '').replace(/^Bearer\s+/, '');
    authLog.push({ target, token });
    if (target.endsWith('/chat_session/create')) {
      return jsonResponse({
        code: 0,
        data: { biz_code: 0, biz_data: { chat_session: { id: sessionIdFor(token) } } },
      });
    }
    if (target.endsWith('/chat/create_pow_challenge')) {
      return jsonResponse({ code: 0, data: { biz_code: 0, biz_data: { challenge } } });
    }
    if (target.endsWith('/chat/completion')) {
      if (!completion) throw new Error('completion should not be needed');
      return completion(token, init);
    }
    if (target.endsWith('/file/upload_file')) return upload(token, init);
    if (target.endsWith('/chat/resume_stream') || target.endsWith('/chat/continue')) {
      throw new Error('recovery should not be needed in rotation tests');
    }
    throw new Error(`unexpected URL ${target}`);
  };
}

function freshPool() {
  accounts.clearAccounts();
  const a = accounts.addAccount({ token: tokenA }).account;
  const b = accounts.addAccount({ token: tokenB }).account;
  return { a, b };
}

function completionCalls(authLog) {
  return authLog.filter((entry) => entry.target.endsWith('/chat/completion'));
}

test.after(() => {
  globalThis.fetch = realFetch;
  upstreamThrottle.level = 0;
  upstreamThrottle.until = 0;
  accounts.clearAccounts();
  fs.rmSync(home, { recursive: true, force: true });
});

test('rotates to a second account on a clean empty reply without sleeping', async () => {
  const { a, b } = freshPool();
  const authLog = [];
  const logs = [];
  const ready = [];
  globalThis.fetch = mockFetch({
    authLog,
    completion: (token) => {
      if (token === tokenA) return emptyReplyStream();
      if (token === tokenB) return successStream('from B');
      throw new Error(`unexpected completion token ${token}`);
    },
  });

  const client = new DirectClient({
    log: (line) => logs.push(line),
    retryDelays: [0, 0, 0],
    emptyRetryDelays: [0, 0, 0],
  });
  const deltas = [];
  const started = Date.now();
  const result = await client.run(
    { prompt: 'rotate me', thinking: true, search: false, attachments: [] },
    { onDelta: (delta) => deltas.push(delta), onReady: (info) => ready.push(info) },
  );
  const elapsed = Date.now() - started;

  assert.equal(result.accountId, b.id, 'the reply must come from the second account');
  assert.equal(result.sessionId, sessionIdFor(tokenB));
  assert.deepEqual(deltas, [{ kind: 'content', text: 'from B' }]);
  assert.ok(
    ready.some((info) => info.accountId === b.id),
    'onReady must report the rotated account',
  );

  const cooled = accounts.getAccount(a.id);
  assert.ok(cooled.cooldownUntil > Date.now(), 'the throttled account must be cooling down');
  assert.equal(cooled.throttleHits, 1);
  assert.equal(cooled.throttleLevel, 1);
  assert.equal(cooled.lastError.code, 'empty_reply');

  // The old behavior would retry the same account 4 times (3/9/20/35s).
  const attempts = completionCalls(authLog);
  assert.equal(attempts.length, 2, 'A is tried exactly once, then B serves the request');
  assert.deepEqual(
    attempts.map((entry) => entry.token),
    [tokenA, tokenB],
  );
  assert.ok(elapsed < 2000, `rotation must not use the empty-reply schedule (took ${elapsed}ms)`);

  assert.ok(
    logs.some(
      (line) =>
        line.includes('rotated account') &&
        line.includes(a.id.slice(0, 8)) &&
        line.includes(b.id.slice(0, 8)),
    ),
    'the rotation must be logged with both account ids',
  );
  for (const line of logs) {
    assert.ok(!line.includes(tokenA), 'a log line leaked token A');
    assert.ok(!line.includes(tokenB), 'a log line leaked token B');
  }
});

test('rotates on not_signed_in and parks the expired account', async () => {
  const { a, b } = freshPool();
  const authLog = [];
  globalThis.fetch = mockFetch({
    authLog,
    completion: (token) => {
      if (token === tokenA) {
        return jsonResponse({ code: 401, msg: 'not logged in' }, 401);
      }
      return successStream('from B');
    },
  });

  const client = new DirectClient({ retryDelays: [0, 0, 0], emptyRetryDelays: [0, 0, 0] });
  const deltas = [];
  const result = await client.run(
    { prompt: 'expired account', thinking: true, attachments: [] },
    { onDelta: (delta) => deltas.push(delta) },
  );

  assert.equal(result.accountId, b.id);
  assert.deepEqual(deltas, [{ kind: 'content', text: 'from B' }]);
  const expired = accounts.getAccount(a.id);
  assert.equal(expired.lastError.code, 'not_signed_in');
  // accounts.js parks auth-looking failures for one short probe window (5 min),
  // not forever: a genuinely dead token is re-probed and rotates away again.
  assert.ok(expired.cooldownUntil > Date.now() + 4 * 60_000, 'the expired token must be parked for ~5 minutes');
  assert.ok(expired.cooldownUntil < Date.now() + 6 * 60_000, 'the expired token must not be parked indefinitely');
  assert.equal(expired.throttleHits, 0, 'an expiry is not a throttle event');
});

test('single account keeps the existing empty-reply retry behavior', async () => {
  accounts.clearAccounts();
  const only = accounts.addAccount({ token: tokenA }).account;
  const authLog = [];
  globalThis.fetch = mockFetch({ authLog, completion: () => emptyReplyStream() });

  const client = new DirectClient({ retryDelays: [0, 0, 0], emptyRetryDelays: [0, 0, 0] });
  await assert.rejects(
    client.run({ prompt: 'always empty', thinking: true, attachments: [] }, {}),
    (err) => err.code === 'empty_reply' && /empty reply/i.test(err.message),
  );

  const attempts = completionCalls(authLog);
  assert.equal(attempts.length, 4, 'single-account deployments still retry MAX_START_ATTEMPTS times');
  assert.deepEqual([...new Set(attempts.map((entry) => entry.token))], [tokenA], 'no other account exists');
  assert.ok(upstreamThrottle.level > 0, 'single-account empty replies still raise the global throttle valve');
  const account = accounts.getAccount(only.id);
  assert.ok(account.cooldownUntil > Date.now(), 'the throttle is recorded for the account pool view');
  assert.equal(account.throttleHits, 1);
  upstreamThrottle.level = 0;
  upstreamThrottle.until = 0;
});

test('a bound continuation on a cooling pinned account throws account_switched with no network', async () => {
  const { a, b } = freshPool();
  accounts.markAccountThrottle(a.id, { code: 'empty_reply' });
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls++;
    throw new Error('network must not be used for a rejected continuation');
  };

  const client = new DirectClient({ retryDelays: [0, 0, 0] });
  await assert.rejects(
    client.run(
      {
        prompt: 'continue',
        sessionId: 'sess-a-owned',
        parentMessageId: 5,
        accountId: a.id,
        thinking: true,
        attachments: [],
      },
      {},
    ),
    (err) => err.code === 'account_switched' && err.status === 503,
  );

  assert.equal(fetchCalls, 0, 'account_switched must be raised before any fetch');
  assert.ok(accounts.getAccount(a.id).cooldownUntil > Date.now(), 'the pinned account is still cooling');
  assert.equal(accounts.getAccount(b.id).cooldownUntil, 0, 'the healthy account was not touched');
});

test('legacy continuations bind to the stored owner, never to a different ready account', async () => {
  const { a } = freshPool();
  // A is the first stored account (the original single-token deployment, which
  // is what legacy conversations without accountId belong to) and is cooling;
  // B is healthy but must never receive A's chat_session_id.
  accounts.markAccountThrottle(a.id, { code: 'empty_reply' });
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls++;
    throw new Error('must not cross-wire a legacy session onto another account');
  };
  const client = new DirectClient({ retryDelays: [0, 0, 0] });
  await assert.rejects(
    client.run(
      { prompt: 'legacy continue', sessionId: 'sess-legacy', parentMessageId: 9, thinking: true, attachments: [] },
      {},
    ),
    (err) => err.code === 'account_switched' && err.status === 503,
  );
  assert.equal(fetchCalls, 0);

  // Once the owner is ready again the same continuation is served by it.
  accounts.markAccountSuccess(a.id);
  const authLog = [];
  globalThis.fetch = mockFetch({ authLog, completion: (token) => successStream(`ok-${token.slice(-3)}`) });
  const result = await client.run(
    { prompt: 'legacy continue', sessionId: 'sess-legacy', parentMessageId: 9, thinking: true, attachments: [] },
    {},
  );
  assert.equal(result.accountId, a.id);
  assert.deepEqual([...new Set(authLog.map((entry) => entry.token))], [tokenA]);
});

test('mid-run throttling of a bound continuation throws account_switched instead of cross-wiring accounts', async () => {
  const { a, b } = freshPool();
  const authLog = [];
  globalThis.fetch = mockFetch({ authLog, completion: () => emptyReplyStream() });

  const client = new DirectClient({ retryDelays: [0, 0, 0], emptyRetryDelays: [0, 0, 0] });
  await assert.rejects(
    client.run(
      {
        prompt: 'continue',
        sessionId: 'sess-a-owned',
        parentMessageId: 5,
        accountId: a.id,
        thinking: true,
        attachments: [],
      },
      {},
    ),
    (err) => err.code === 'account_switched' && err.status === 503,
  );

  // Only the pinned account was contacted: its chat_session_id must never be
  // sent under account B's token.
  assert.deepEqual([...new Set(authLog.map((entry) => entry.token))], [tokenA]);
  assert.ok(accounts.getAccount(a.id).throttleHits >= 1, 'the pinned account is marked cooling');
  assert.equal(accounts.getAccount(b.id).throttleHits, 0, 'the other account never saw the conversation');
});

test('a rate-limited upload rotates immediately instead of burning the upload retry schedule', async () => {
  const { a, b } = freshPool();
  const authLog = [];
  globalThis.fetch = mockFetch({
    authLog,
    completion: (token) => successStream(`ok-${token.slice(-3)}`),
    upload: (token) => (token === tokenA ? uploadRateLimited() : uploadResponse(token)),
  });

  const client = new DirectClient({ retryDelays: [0, 0, 0], emptyRetryDelays: [0, 0, 0] });
  const attachment = {
    name: 'a.txt',
    mime: 'text/plain',
    dataBase64: Buffer.from('attachment that forces an upload').toString('base64'),
  };
  const started = Date.now();
  const result = await client.run({ prompt: 'upload', thinking: true, attachments: [attachment] }, {});
  const elapsed = Date.now() - started;

  assert.equal(result.accountId, b.id);
  const uploads = authLog.filter((entry) => entry.target.endsWith('/file/upload_file'));
  assert.deepEqual(
    uploads.map((entry) => entry.token),
    [tokenA, tokenB],
    'one rejected upload on A, then one re-upload on B (file ids are account-scoped)',
  );
  assert.ok(elapsed < 2000, `the upload rate-limit must not be absorbed on one account (took ${elapsed}ms)`);
  const throttled = accounts.getAccount(a.id);
  assert.equal(throttled.lastError.code, 'upload_rate_limited');
  assert.equal(throttled.throttleHits, 1);
});

test('file ids are cached per account because DeepSeek file ids are account-scoped', async () => {
  const { a, b } = freshPool();
  const authLog = [];
  globalThis.fetch = mockFetch({
    authLog,
    completion: (token) => successStream(`ok-${token.slice(-3)}`),
  });

  const client = new DirectClient({ retryDelays: [0, 0, 0] });
  const attachment = {
    name: 'same.txt',
    mime: 'text/plain',
    dataBase64: Buffer.from('identical attachment bytes').toString('base64'),
  };
  const first = await client.run({ prompt: 'one', thinking: true, attachments: [attachment] }, {});
  const second = await client.run({ prompt: 'two', thinking: true, attachments: [{ ...attachment }] }, {});

  assert.equal(first.accountId, a.id);
  assert.equal(second.accountId, b.id, 'the least-recently-used account serves the second run');
  const uploads = authLog.filter((entry) => entry.target.endsWith('/file/upload_file'));
  assert.deepEqual(
    uploads.map((entry) => entry.token),
    [tokenA, tokenB],
    'the same bytes must be re-uploaded on the new account',
  );

  // The cache still prevents a second upload of the same bytes on the same
  // account (harness retries re-send attachments).
  const third = await client.run({ prompt: 'three', thinking: true, attachments: [attachment] }, {});
  assert.equal(third.accountId, a.id);
  assert.equal(
    authLog.filter((entry) => entry.target.endsWith('/file/upload_file')).length,
    2,
    'the cached file id is reused on the same account',
  );
});

test('two concurrent fresh runs are served by different accounts', async () => {
  const { a, b } = freshPool();
  const authLog = [];
  const completed = [];
  globalThis.fetch = mockFetch({
    authLog,
    completion: async (token) => {
      completed.push(token);
      await new Promise((resolve) => setTimeout(resolve, 20));
      return successStream(`ok-${token.slice(-3)}`);
    },
  });

  const client = new DirectClient({ retryDelays: [0, 0, 0] });
  const [first, second] = await Promise.all([
    client.run({ prompt: 'one', thinking: true, attachments: [] }, {}),
    client.run({ prompt: 'two', thinking: true, attachments: [] }, {}),
  ]);

  assert.deepEqual(
    [first.accountId, second.accountId].sort(),
    [a.id, b.id].sort(),
    'concurrent runs must not share one account',
  );
  assert.equal(new Set(completed).size, 2, 'each run used a different authorization token');
});

test('rotation never logs or reports tokens', async () => {
  const { a, b } = freshPool();
  const logs = [];
  globalThis.fetch = mockFetch({
    completion: (token) => (token === tokenA ? emptyReplyStream() : successStream('safe')),
  });

  const client = new DirectClient({
    log: (line) => logs.push(line),
    retryDelays: [0, 0, 0],
    emptyRetryDelays: [0, 0, 0],
  });
  const result = await client.run({ prompt: 'no leaks', thinking: true, attachments: [] }, {});
  assert.equal(result.accountId, b.id);

  const payloads = [logs.join('\n'), JSON.stringify(accounts.listAccounts()), JSON.stringify(accounts.accountsSummary())];
  for (const payload of payloads) {
    assert.ok(!payload.includes(tokenA), 'token A leaked');
    assert.ok(!payload.includes(tokenB), 'token B leaked');
  }
  assert.ok(
    logs.some((line) => line.includes(a.id.slice(0, 8))),
    'account ids (short) are visible in rotation logs',
  );
});

test('public API stays compatible: available, hasMultipleAccounts, reloadSession, verify(accountId)', async () => {
  const { a, b } = freshPool();
  const authLog = [];
  globalThis.fetch = mockFetch({ authLog, completion: () => successStream('ok') });

  const client = new DirectClient({ retryDelays: [0, 0, 0] });
  assert.equal(client.available, true);
  assert.equal(client.hasMultipleAccounts, true);
  assert.equal(client.reloadSession().token, tokenA, 'reloadSession returns the primary account session');
  assert.equal(client.session.token, tokenA);

  await client.verify(null, { accountId: b.id });
  assert.equal(authLog.at(-1).token, tokenB, 'verify(accountId) checks the requested account');

  accounts.clearAccounts();
  accounts.addAccount({ token: tokenA });
  assert.equal(client.hasMultipleAccounts, false);
  assert.equal(client.available, true);
});

test('a first-level cooldown is waited out instead of failing fast', async () => {
  const { a, b } = freshPool();
  // Both accounts just took their first throttle: 15s cooldown. The request
  // must park in the bounded wait loop (rotating into a pointless 503 was the
  // storm regression) and not 503 instantly. Aborting proves the wait is
  // entered in ~150ms, without paying the real 15s in the suite.
  accounts.markAccountThrottle(a.id, { code: 'empty_reply' });
  accounts.markAccountThrottle(b.id, { code: 'empty_reply' });
  assert.ok(accounts.nextAvailableAt() > Date.now() + 10_000, 'both accounts are cooling');

  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls++;
    throw new Error('no account should be contacted while every account cools');
  };
  const client = new DirectClient({ retryDelays: [0, 0, 0] });
  const controller = new AbortController();
  let settled = false;
  const outcome = client
    .run({ prompt: 'wait out the cooldown', thinking: true, attachments: [] }, {}, { signal: controller.signal })
    .then(
      (result) => {
        settled = true;
        return { result };
      },
      (err) => {
        settled = true;
        return { err };
      },
    );

  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(settled, false, 'the request must wait for the cooldown, not surface an instant account_unavailable');
  assert.equal(fetchCalls, 0, 'no account is contacted while the pool is cooling');

  controller.abort();
  const { err } = await outcome;
  assert.equal(err.code, 'cancelled', 'the cancel path still interrupts the cooldown wait');
});

test('stays retriable when every account is parked far in the future', async () => {
  accounts.clearAccounts();
  const a = accounts.addAccount({ token: tokenA }).account;
  const b = accounts.addAccount({ token: tokenB }).account;
  accounts.markAccountExpired(a.id, 'expired A');
  accounts.markAccountExpired(b.id, 'expired B');

  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls++;
    throw new Error('no account should be contacted');
  };
  assert.ok(paths.ACCOUNTS_FILE.startsWith(home), 'the pool lives in the test home');

  const client = new DirectClient({ retryDelays: [0, 0, 0] });
  await assert.rejects(
    client.run({ prompt: 'nobody home', thinking: true, attachments: [] }, {}),
    (err) => err.code === 'account_unavailable' && err.status === 503 && /cooling down/i.test(err.message),
  );
  assert.equal(fetchCalls, 0, 'parked accounts are not contacted');
});
