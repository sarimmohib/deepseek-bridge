import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { digestHex } from '../src/pow.js';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-bridge-direct-'));
process.env.DS_BRIDGE_HOME = home;
const { DirectClient } = await import('../src/direct.js');
const { saveSession } = await import('../src/session.js');

const realFetch = globalThis.fetch;
const token = 'direct-test-token-that-is-long-enough';
const expireAt = Date.now() + 300_000;
const challenge = {
  algorithm: 'DeepSeekHashV1',
  challenge: digestHex(`test-salt_${expireAt}_0`),
  salt: 'test-salt',
  difficulty: 1,
  signature: 'test-signature',
  expire_at: expireAt,
  target_path: '/api/v0/chat/completion',
};

function jsonResponse(value) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

test.after(() => {
  globalThis.fetch = realFetch;
  fs.rmSync(home, { recursive: true, force: true });
});

test('direct client creates a session, solves PoW, and parses the patch stream', async () => {
  saveSession({ token, cookies: [] });
  const client = new DirectClient();
  let completionBody = null;

  globalThis.fetch = async (url, init = {}) => {
    const target = String(url);
    if (target.endsWith('/chat_session/create')) {
      return jsonResponse({
        code: 0,
        data: { biz_code: 0, biz_data: { chat_session: { id: 'sess_test' } } },
      });
    }
    if (target.endsWith('/chat/create_pow_challenge')) {
      return jsonResponse({ code: 0, data: { biz_code: 0, biz_data: { challenge } } });
    }
    if (target.endsWith('/chat/completion')) {
      completionBody = JSON.parse(init.body);
      const pow = JSON.parse(Buffer.from(init.headers['x-ds-pow-response'], 'base64').toString('utf8'));
      assert.equal(pow.answer, 0);
      assert.equal(init.headers.authorization, `Bearer ${token}`);
      const stream = [
        'event: ready\n',
        'data: {"request_message_id":1,"response_message_id":2}\n\n',
        'data: {"v":{"response":{"fragments":[{"type":"RESPONSE","content":"OK"}]}}}\n\n',
        'data: {"p":"response/fragments/-1/content","o":"APPEND","v":"!"}\n\n',
        'event: close\n',
        'data: {}\n\n',
      ].join('');
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    throw new Error(`unexpected URL ${target}`);
  };

  const deltas = [];
  const result = await client.run(
    {
      sessionId: null,
      parentMessageId: null,
      prompt: 'say OK!',
      modelType: 'default',
      thinking: true,
      attachments: [],
    },
    { onDelta: (delta) => deltas.push(delta) },
  );

  assert.equal(completionBody.chat_session_id, 'sess_test');
  assert.equal(completionBody.prompt, 'say OK!');
  assert.equal(completionBody.thinking_enabled, true);
  assert.deepEqual(deltas, [
    { kind: 'content', text: 'OK' },
    { kind: 'content', text: '!' },
  ]);
  assert.equal(result.sessionId, 'sess_test');
  assert.equal(result.messageId, 2);
  assert.equal(result.finish, 'stop');
});

function streamResponse(events) {
  return new Response(events.join(''), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function baseFetch(onCompletion, onContinue, onResume) {
  return async (url, init = {}) => {
    const target = String(url);
    if (target.endsWith('/chat_session/create')) {
      return jsonResponse({
        code: 0,
        data: { biz_code: 0, biz_data: { chat_session: { id: 'sess_test' } } },
      });
    }
    if (target.endsWith('/chat/create_pow_challenge')) {
      return jsonResponse({ code: 0, data: { biz_code: 0, biz_data: { challenge } } });
    }
    if (target.endsWith('/chat/completion')) return onCompletion(init);
    if (target.endsWith('/chat/resume_stream')) {
      if (!onResume) throw new Error('resume_stream should not be needed');
      return onResume(init);
    }
    if (target.endsWith('/chat/continue')) return onContinue(init);
    throw new Error(`unexpected URL ${target}`);
  };
}

test('resumes a truncated stream with /chat/resume_stream without duplicating content', async () => {
  saveSession({ token, cookies: [] });
  const client = new DirectClient({ retryDelays: [0, 0, 0] });
  let resumeBody = null;
  let continueCalls = 0;
  let completionCalls = 0;

  globalThis.fetch = baseFetch(
    () => {
      completionCalls++;
      return streamResponse([
        'event: ready\n',
        'data: {"request_message_id":1,"response_message_id":2}\n\n',
        'data: {"v":{"response":{"fragments":[{"type":"RESPONSE","content":"Hello"}]}}}\n\n',
        // No event: close. This is what a dropped or truncated connection
        // looks like and must not be treated as a successful completion.
      ]);
    },
    () => {
      continueCalls++;
      throw new Error('continue should not be needed');
    },
    (init) => {
      resumeBody = JSON.parse(init.body);
      // Live-verified replay: a full-state snapshot repeating everything
      // generated before the disconnect, then APPEND deltas for the rest.
      return streamResponse([
        'event: ready\n',
        'data: {"response_message_id":2}\n\n',
        'data: {"v":{"response":{"message_id":2,"status":"WIP","fragments":[{"type":"RESPONSE","content":"Hello"}]}}}\n\n',
        'data: {"p":"response/fragments/-1/content","o":"APPEND","v":" world"}\n\n',
        'event: close\n',
        'data: {"click_behavior":"none","auto_resume":false}\n\n',
      ]);
    },
  );

  const deltas = [];
  const result = await client.run(
    { prompt: 'say hello', thinking: true, search: false, attachments: [] },
    { onDelta: (delta) => deltas.push(delta) },
  );

  assert.equal(completionCalls, 1);
  assert.equal(continueCalls, 0);
  assert.deepEqual(resumeBody, { chat_session_id: 'sess_test', message_id: 2 });
  assert.deepEqual(deltas, [
    { kind: 'content', text: 'Hello' },
    { kind: 'content', text: ' world' },
  ]);
  assert.equal(result.messageId, 2);
});

test('retries a server-busy completion before any output', async () => {
  saveSession({ token, cookies: [] });
  const client = new DirectClient({ retryDelays: [0, 0, 0] });
  let completionCalls = 0;

  globalThis.fetch = baseFetch(
    () => {
      completionCalls++;
      if (completionCalls === 1) {
        return new Response(JSON.stringify({ code: 0, data: { biz_code: 500, biz_msg: 'Server is busy' } }), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        });
      }
      return streamResponse([
        'event: ready\n',
        'data: {"request_message_id":1,"response_message_id":2}\n\n',
        'data: {"v":{"response":{"fragments":[{"type":"RESPONSE","content":"OK"}]}}}\n\n',
        'event: close\n',
        'data: {}\n\n',
      ]);
    },
    () => {
      throw new Error('continue should not be needed');
    },
  );

  const deltas = [];
  const result = await client.run(
    { prompt: 'say OK', thinking: true, search: false, attachments: [] },
    { onDelta: (delta) => deltas.push(delta) },
  );

  assert.equal(completionCalls, 2);
  assert.deepEqual(deltas, [{ kind: 'content', text: 'OK' }]);
  assert.equal(result.messageId, 2);
});

test('retries a network failure before any output', async () => {
  saveSession({ token, cookies: [] });
  const client = new DirectClient({ retryDelays: [0, 0, 0] });
  let completionCalls = 0;

  globalThis.fetch = baseFetch(
    () => {
      completionCalls++;
      if (completionCalls === 1) throw new TypeError('fetch failed');
      return streamResponse([
        'event: ready\n',
        'data: {"request_message_id":1,"response_message_id":2}\n\n',
        'data: {"v":{"response":{"fragments":[{"type":"RESPONSE","content":"NET_OK"}]}}}\n\n',
        'event: close\n',
        'data: {}\n\n',
      ]);
    },
    () => {
      throw new Error('continue should not be needed');
    },
  );

  const deltas = [];
  const result = await client.run(
    { prompt: 'network test', thinking: true, search: false, attachments: [] },
    { onDelta: (delta) => deltas.push(delta) },
  );

  assert.equal(completionCalls, 2);
  assert.deepEqual(deltas, [{ kind: 'content', text: 'NET_OK' }]);
  assert.equal(result.messageId, 2);
});

test('accepts a full-message response from /chat/resume_stream', async () => {
  saveSession({ token, cookies: [] });
  const client = new DirectClient({ retryDelays: [0, 0, 0] });
  let continueCalls = 0;

  globalThis.fetch = baseFetch(
    () =>
      streamResponse([
        'event: ready\n',
        'data: {"request_message_id":1,"response_message_id":2}\n\n',
        'data: {"v":{"response":{"fragments":[{"type":"RESPONSE","content":"FULL"}]}}}\n\n',
      ]),
    () => {
      continueCalls++;
      throw new Error('continue should not be needed');
    },
    () =>
      // Live shape: the message finished minutes ago, so resume_stream answers
      // with a biz_code 22 JSON wrapper carrying the finished message.
      jsonResponse({
        code: 0,
        msg: '',
        data: {
          biz_code: 22,
          biz_msg: 'invalid message status',
          biz_data: {
            id: 2,
            status: 'FINISHED',
            fragments: [{ type: 'RESPONSE', content: 'FULL MESSAGE' }],
          },
        },
      }),
  );

  const deltas = [];
  const result = await client.run(
    { prompt: 'full message', thinking: true, search: false, attachments: [] },
    { onDelta: (delta) => deltas.push(delta) },
  );

  assert.equal(continueCalls, 0);
  assert.deepEqual(deltas, [
    { kind: 'content', text: 'FULL' },
    { kind: 'content', text: ' MESSAGE' },
  ]);
  assert.equal(result.messageId, 2);
});

test('retries a truncated continuation and keeps only the missing suffix', async () => {
  saveSession({ token, cookies: [] });
  const client = new DirectClient({ retryDelays: [0, 0, 0] });
  let resumeCalls = 0;
  let continueCalls = 0;
  let continueBody = null;

  globalThis.fetch = baseFetch(
    () =>
      streamResponse([
        'event: ready\n',
        'data: {"request_message_id":1,"response_message_id":2}\n\n',
        'data: {"v":{"response":{"fragments":[{"type":"RESPONSE","content":"Hello"}]}}}\n\n',
      ]),
    (init) => {
      continueCalls++;
      continueBody = JSON.parse(init.body);
      return streamResponse([
        'data: {"v":{"response":{"fragments":[{"type":"RESPONSE","content":"Hello world"}]}}}\n\n',
        'event: close\n',
        'data: {}\n\n',
      ]);
    },
    () => {
      resumeCalls++;
      return streamResponse([
        'data: {"v":{"response":{"fragments":[{"type":"RESPONSE","content":"Hello wor"}]}}}\n\n',
      ]);
    },
  );

  const deltas = [];
  const result = await client.run(
    { prompt: 'resume twice', thinking: true, search: false, attachments: [] },
    { onDelta: (delta) => deltas.push(delta) },
  );

  assert.equal(resumeCalls, 1);
  assert.equal(continueCalls, 1);
  assert.deepEqual(continueBody, {
    chat_session_id: 'sess_test',
    message_id: 2,
    fallback_to_resume: true,
  });
  assert.deepEqual(deltas, [
    { kind: 'content', text: 'Hello' },
    { kind: 'content', text: ' wor' },
    { kind: 'content', text: 'ld' },
  ]);
  assert.equal(result.messageId, 2);
});

test('falls back to /chat/continue when /chat/resume_stream cannot resume', async () => {
  saveSession({ token, cookies: [] });
  const client = new DirectClient({ retryDelays: [0, 0, 0] });
  const calls = [];
  let resumeBody = null;
  let continueBody = null;

  globalThis.fetch = baseFetch(
    () =>
      streamResponse([
        'event: ready\n',
        'data: {"request_message_id":1,"response_message_id":2}\n\n',
        'data: {"v":{"response":{"fragments":[{"type":"RESPONSE","content":"Hello"}]}}}\n\n',
      ]),
    (init) => {
      calls.push('continue');
      continueBody = JSON.parse(init.body);
      return streamResponse([
        'data: {"v":{"response":{"fragments":[{"type":"RESPONSE","content":"Hello world"}]}}}\n\n',
        'event: close\n',
        'data: {}\n\n',
      ]);
    },
    (init) => {
      calls.push('resume_stream');
      resumeBody = JSON.parse(init.body);
      // Live shape: an id resume_stream refuses comes back as biz_code 26
      // with no biz_data, which must not end recovery — /chat/continue
      // still succeeds for the same message.
      return jsonResponse({
        code: 0,
        msg: '',
        data: { biz_code: 26, biz_msg: 'invalid message id', biz_data: null },
      });
    },
  );

  const deltas = [];
  const result = await client.run(
    { prompt: 'resume fallback', thinking: true, search: false, attachments: [] },
    { onDelta: (delta) => deltas.push(delta) },
  );

  assert.deepEqual(calls, ['resume_stream', 'continue']);
  assert.deepEqual(resumeBody, { chat_session_id: 'sess_test', message_id: 2 });
  assert.deepEqual(continueBody, {
    chat_session_id: 'sess_test',
    message_id: 2,
    fallback_to_resume: true,
  });
  // /chat/continue replays the full message; only the suffix may be re-sent.
  assert.deepEqual(deltas, [
    { kind: 'content', text: 'Hello' },
    { kind: 'content', text: ' world' },
  ]);
  assert.equal(result.messageId, 2);
});

test('surfaces a pre-ready error event without retrying', async () => {
  saveSession({ token, cookies: [] });
  const client = new DirectClient({ retryDelays: [0, 0, 0] });
  let completionCalls = 0;

  globalThis.fetch = baseFetch(
    () => {
      completionCalls++;
      return streamResponse([
        'event: error\n',
        'data: {"msg":"Content flagged by moderation"}\n\n',
      ]);
    },
    () => {
      throw new Error('continue should not be needed');
    },
  );

  const deltas = [];
  await assert.rejects(
    client.run(
      { prompt: 'flagged prompt', thinking: true, search: false, attachments: [] },
      { onDelta: (delta) => deltas.push(delta) },
    ),
    (err) => {
      assert.equal(err.code, 'stream_error');
      assert.match(err.message, /Content flagged by moderation/);
      return true;
    },
  );
  assert.deepEqual(deltas, []);
  assert.equal(completionCalls, 1);
});
