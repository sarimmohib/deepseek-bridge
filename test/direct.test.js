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

function baseFetch(onCompletion, onContinue, onResume, onUpload) {
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
    if (target.endsWith('/file/upload_file')) {
      if (!onUpload) throw new Error('upload_file should not be needed');
      return onUpload(init);
    }
    if (target.endsWith('/chat/resume_stream')) {
      if (!onResume) throw new Error('resume_stream should not be needed');
      return onResume(init);
    }
    if (target.endsWith('/chat/continue')) return onContinue(init);
    throw new Error(`unexpected URL ${target}`);
  };
}

// Live upload response shape: the file is created PENDING and ingested
// asynchronously; biz_data carries file_name/model_kind/token_usage/error_code.
function uploadResponse(id, name, status = 'PENDING') {
  return jsonResponse({
    code: 0,
    data: { biz_code: 0, biz_data: { id, status, file_name: name, model_kind: 1, token_usage: 0, error_code: 0 } },
  });
}

// Live user-message snapshot frame: each referenced file's object is embedded
// in the message with its ingestion status.
function fileSnapshotFrame(file) {
  return `data: ${JSON.stringify({
    v: { chat_messages: [{ role: 'USER', content: 'use the attached file', files: [file] }] },
  })}\n\n`;
}

const txtAttachment = { name: 'a.txt', mime: 'text/plain', dataBase64: Buffer.from('file body').toString('base64') };

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
        // Live streams flip the status to FINISHED before the terminal
        // marker; a replay that closed while WIP is treated as interrupted.
        'data: {"p":"response/status","o":"SET","v":"FINISHED"}\n\n',
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

test('treats a close while still WIP as interrupted and resumes to completion', async () => {
  saveSession({ token, cookies: [] });
  const client = new DirectClient({ retryDelays: [0, 0, 0] });
  let completionCalls = 0;
  let resumeCalls = 0;
  let continueCalls = 0;
  let resumeBody = null;

  globalThis.fetch = baseFetch(
    () => {
      completionCalls++;
      return streamResponse([
        'event: ready\n',
        'data: {"request_message_id":1,"response_message_id":2}\n\n',
        'data: {"v":{"response":{"message_id":2,"status":"WIP","fragments":[{"type":"RESPONSE","content":"Hello"}]}}}\n\n',
        'data: {"p":"response/fragments/-1/content","o":"APPEND","v":" world"}\n\n',
        // Live failure: the terminal marker arrives while response/status is
        // still WIP. This must not come back as a complete reply.
        'event: close\n',
        'data: {}\n\n',
      ]);
    },
    () => {
      continueCalls++;
      throw new Error('continue should not be needed');
    },
    (init) => {
      resumeCalls++;
      resumeBody = JSON.parse(init.body);
      // Recovery replay: the full message so far (already streamed), the
      // missing suffix, then the status reaching FINISHED before the close.
      return streamResponse([
        'event: ready\n',
        'data: {"response_message_id":2}\n\n',
        'data: {"v":{"response":{"message_id":2,"status":"WIP","fragments":[{"type":"RESPONSE","content":"Hello world"}]}}}\n\n',
        'data: {"p":"response/fragments/-1/content","o":"APPEND","v":"!"}\n\n',
        'data: {"p":"response/status","o":"SET","v":"FINISHED"}\n\n',
        'event: close\n',
        'data: {"click_behavior":"none","auto_resume":false}\n\n',
      ]);
    },
  );

  const deltas = [];
  const result = await client.run(
    { prompt: 'wip close', thinking: true, search: false, attachments: [] },
    { onDelta: (delta) => deltas.push(delta) },
  );

  assert.equal(completionCalls, 1);
  assert.equal(resumeCalls, 1, 'WIP close must enter the /chat/resume_stream recovery path');
  assert.equal(continueCalls, 0);
  assert.deepEqual(resumeBody, { chat_session_id: 'sess_test', message_id: 2 });
  // The replayed snapshot must not resend the text already streamed.
  assert.deepEqual(deltas, [
    { kind: 'content', text: 'Hello' },
    { kind: 'content', text: ' world' },
    { kind: 'content', text: '!' },
  ]);
  assert.equal(result.sessionId, 'sess_test');
  assert.equal(result.messageId, 2);
  assert.equal(result.finish, 'stop');
});

test('completes normally when the stream closes after an explicit FINISHED status', async () => {
  saveSession({ token, cookies: [] });
  const client = new DirectClient({ retryDelays: [0, 0, 0] });
  let completionCalls = 0;

  globalThis.fetch = baseFetch(
    () => {
      completionCalls++;
      return streamResponse([
        'event: ready\n',
        'data: {"request_message_id":1,"response_message_id":2}\n\n',
        'data: {"v":{"response":{"message_id":2,"status":"WIP","fragments":[{"type":"RESPONSE","content":"Done"}]}}}\n\n',
        'data: {"p":"response/status","o":"SET","v":"FINISHED"}\n\n',
        'event: close\n',
        'data: {}\n\n',
      ]);
    },
    () => {
      throw new Error('continue should not be needed');
    },
    () => {
      throw new Error('resume_stream should not be needed');
    },
  );

  const deltas = [];
  const result = await client.run(
    { prompt: 'finished status', thinking: true, search: false, attachments: [] },
    { onDelta: (delta) => deltas.push(delta) },
  );

  assert.equal(completionCalls, 1);
  assert.deepEqual(deltas, [{ kind: 'content', text: 'Done' }]);
  assert.equal(result.messageId, 2);
  assert.equal(result.finish, 'stop');
});

test('completes normally when the stream closes without any status events', async () => {
  saveSession({ token, cookies: [] });
  const client = new DirectClient({ retryDelays: [0, 0, 0] });
  let completionCalls = 0;

  globalThis.fetch = baseFetch(
    () => {
      completionCalls++;
      return streamResponse([
        'event: ready\n',
        'data: {"request_message_id":1,"response_message_id":2}\n\n',
        'data: {"v":{"response":{"message_id":2,"fragments":[{"type":"RESPONSE","content":"Plain"}]}}}\n\n',
        'data: {"p":"response/fragments/-1/content","o":"APPEND","v":" text"}\n\n',
        'event: close\n',
        'data: {}\n\n',
      ]);
    },
    () => {
      throw new Error('continue should not be needed');
    },
    () => {
      throw new Error('resume_stream should not be needed');
    },
  );

  const deltas = [];
  const result = await client.run(
    { prompt: 'no status', thinking: true, search: false, attachments: [] },
    { onDelta: (delta) => deltas.push(delta) },
  );

  assert.equal(completionCalls, 1);
  assert.deepEqual(deltas, [
    { kind: 'content', text: 'Plain' },
    { kind: 'content', text: ' text' },
  ]);
  assert.equal(result.messageId, 2);
  assert.equal(result.finish, 'stop');
});

test('retries once when a referenced file is still PENDING at completion time', async () => {
  saveSession({ token, cookies: [] });
  const logs = [];
  const client = new DirectClient({ retryDelays: [0, 0, 0], log: (msg) => logs.push(msg) });
  let completionCalls = 0;

  globalThis.fetch = baseFetch(
    () => {
      completionCalls++;
      const file = {
        id: 'file-x',
        status: completionCalls === 1 ? 'PENDING' : 'SUCCESS',
        file_name: 'a.txt',
        token_usage: 12,
      };
      if (completionCalls === 1) {
        // Live failure shape, stripped to the minimum that triggers the gate:
        // the stream finishes while the referenced file is still PENDING, so
        // nothing trustworthy was emitted and a transparent retry is safe.
        return streamResponse([
          'event: ready\n',
          'data: {"request_message_id":1,"response_message_id":2}\n\n',
          fileSnapshotFrame(file),
          'event: close\n',
          'data: {}\n\n',
        ]);
      }
      return streamResponse([
        'event: ready\n',
        'data: {"request_message_id":1,"response_message_id":3}\n\n',
        fileSnapshotFrame(file),
        'data: {"v":{"response":{"fragments":[{"type":"RESPONSE","content":"OK"}]}}}\n\n',
        'event: close\n',
        'data: {}\n\n',
      ]);
    },
    () => {
      throw new Error('continue should not be needed');
    },
    () => {
      throw new Error('resume_stream should not be needed');
    },
    () => uploadResponse('file-x', 'a.txt'),
  );

  const deltas = [];
  const result = await client.run(
    { prompt: 'read a.txt', thinking: true, search: false, debug: true, attachments: [txtAttachment] },
    { onDelta: (delta) => deltas.push(delta) },
  );

  assert.equal(completionCalls, 2);
  assert.deepEqual(deltas, [{ kind: 'content', text: 'OK' }]);
  assert.equal(result.messageId, 3);
  assert.ok(
    logs.some((line) => line.includes('file a.txt was still processing; retrying...')),
    'the retry must be logged with the file name',
  );
  assert.ok(result.debugLines.includes('files: file-x=PENDING'), 'attempt 1 file status must be in debugLines');
  assert.ok(result.debugLines.includes('files: file-x=SUCCESS'), 'attempt 2 file status must be in debugLines');
});

test('rejects with file_not_ready after exactly two attempts when the file never becomes ready', async () => {
  saveSession({ token, cookies: [] });
  const client = new DirectClient({ retryDelays: [0, 0, 0] });
  let completionCalls = 0;

  globalThis.fetch = baseFetch(
    () => {
      completionCalls++;
      return streamResponse([
        'event: ready\n',
        'data: {"request_message_id":1,"response_message_id":2}\n\n',
        fileSnapshotFrame({ id: 'file-x', status: 'PENDING', file_name: 'a.txt' }),
        'event: close\n',
        'data: {}\n\n',
      ]);
    },
    () => {
      throw new Error('continue should not be needed');
    },
    () => {
      throw new Error('resume_stream should not be needed');
    },
    () => uploadResponse('file-x', 'a.txt'),
  );

  const deltas = [];
  await assert.rejects(
    client.run(
      { prompt: 'stuck file', thinking: true, search: false, attachments: [txtAttachment] },
      { onDelta: (delta) => deltas.push(delta) },
    ),
    (err) => {
      assert.equal(err.code, 'file_not_ready');
      assert.equal(err.status, 504);
      assert.match(err.message, /had not finished processing a\.txt/);
      return true;
    },
  );
  // messageId is set (ready fired), so this also proves the failure never
  // entered recover(): the resume/continue mocks throw and would have changed
  // both the call count and the surfaced error.
  assert.equal(completionCalls, 2, 'exactly one transparent retry, then the error surfaces');
  assert.deepEqual(deltas, []);
});

test('completes in a single attempt when every referenced file is already SUCCESS', async () => {
  saveSession({ token, cookies: [] });
  const client = new DirectClient({ retryDelays: [0, 0, 0] });
  let completionCalls = 0;
  let completionBody = null;

  globalThis.fetch = baseFetch(
    (init) => {
      completionCalls++;
      completionBody = JSON.parse(init.body);
      return streamResponse([
        'event: ready\n',
        'data: {"request_message_id":1,"response_message_id":2}\n\n',
        fileSnapshotFrame({ id: 'file-x', status: 'SUCCESS', file_name: 'a.txt', token_usage: 12 }),
        'data: {"v":{"response":{"fragments":[{"type":"RESPONSE","content":"OK"}]}}}\n\n',
        'event: close\n',
        'data: {}\n\n',
      ]);
    },
    () => {
      throw new Error('continue should not be needed');
    },
    () => {
      throw new Error('resume_stream should not be needed');
    },
    () => uploadResponse('file-x', 'a.txt', 'SUCCESS'),
  );

  const deltas = [];
  const result = await client.run(
    { prompt: 'ready file', thinking: true, search: false, attachments: [txtAttachment] },
    { onDelta: (delta) => deltas.push(delta) },
  );

  assert.equal(completionCalls, 1);
  assert.deepEqual(completionBody.ref_file_ids, ['file-x']);
  assert.deepEqual(deltas, [{ kind: 'content', text: 'OK' }]);
  assert.equal(result.messageId, 2);
  assert.equal(result.finish, 'stop');
});

test('surfaces file_not_ready to the client when content was already emitted', async () => {
  saveSession({ token, cookies: [] });
  const client = new DirectClient({ retryDelays: [0, 0, 0] });
  let completionCalls = 0;

  globalThis.fetch = baseFetch(
    () => {
      completionCalls++;
      // The model answered while the file was still PENDING — the common live
      // failure shape. A transparent retry would duplicate the emitted text,
      // so the error must surface after this single attempt.
      return streamResponse([
        'event: ready\n',
        'data: {"request_message_id":1,"response_message_id":2}\n\n',
        fileSnapshotFrame({ id: 'file-x', status: 'PENDING', file_name: 'a.txt' }),
        'data: {"v":{"response":{"fragments":[{"type":"RESPONSE","content":"I could not read the file"}]}}}\n\n',
        'event: close\n',
        'data: {}\n\n',
      ]);
    },
    () => {
      throw new Error('continue should not be needed');
    },
    () => {
      throw new Error('resume_stream should not be needed');
    },
    () => uploadResponse('file-x', 'a.txt'),
  );

  const deltas = [];
  await assert.rejects(
    client.run(
      { prompt: 'late file', thinking: true, search: false, attachments: [txtAttachment] },
      { onDelta: (delta) => deltas.push(delta) },
    ),
    (err) => {
      assert.equal(err.code, 'file_not_ready');
      assert.equal(err.status, 504);
      return true;
    },
  );
  assert.equal(completionCalls, 1, 'emitted text cannot be retried transparently');
  assert.deepEqual(deltas, [{ kind: 'content', text: 'I could not read the file' }]);
});

test('spaces consecutive uploads with a settle gap', async () => {
  saveSession({ token, cookies: [] });
  const client = new DirectClient({ retryDelays: [0, 0, 0] });
  const uploadTimes = [];
  let completionCalls = 0;

  globalThis.fetch = baseFetch(
    () => {
      completionCalls++;
      // No file frames at all: files the stream never mentions must not trip
      // the readiness gate.
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
    () => {
      throw new Error('resume_stream should not be needed');
    },
    () => {
      uploadTimes.push(Date.now());
      return uploadResponse(`file-${uploadTimes.length}`, `f${uploadTimes.length}.txt`, 'SUCCESS');
    },
  );

  const second = { ...txtAttachment, name: 'b.txt' };
  const result = await client.run(
    { prompt: 'two files', thinking: true, search: false, attachments: [txtAttachment, second] },
    {},
  );

  assert.equal(uploadTimes.length, 2);
  assert.ok(
    uploadTimes[1] - uploadTimes[0] >= 700,
    `expected a settle gap between uploads, got ${uploadTimes[1] - uploadTimes[0]}ms`,
  );
  assert.equal(completionCalls, 1);
  assert.equal(result.finish, 'stop');
});

test('retries an empty reply and succeeds on the next attempt', async () => {
  saveSession({ token, cookies: [] });
  const client = new DirectClient({ retryDelays: [0, 0, 0], emptyRetryDelays: [0, 0, 0] });
  let completionCalls = 0;

  globalThis.fetch = baseFetch(
    (init) => {
      completionCalls++;
      if (completionCalls === 1) {
        return streamResponse([
          'event: ready\ndata: {"request_message_id":1,"response_message_id":2}\n\n',
          'event: close\ndata: {}\n\n',
        ]);
      }
      return streamResponse([
        'event: ready\ndata: {"request_message_id":1,"response_message_id":2}\n\n',
        'data: {"v":{"response":{"fragments":[{"type":"RESPONSE","content":"recovered content"}]}}}\n\n',
        'event: close\ndata: {}\n\n',
      ]);
    },
    () => {
      throw new Error('continue should not be needed for an empty reply');
    },
    () => {
      throw new Error('resume_stream should not be needed for an empty reply');
    },
  );

  const deltas = [];
  const result = await client.run(
    { prompt: 'empty then good', thinking: true, search: false, attachments: [] },
    { onDelta: (delta) => deltas.push(delta) },
  );

  assert.equal(completionCalls, 2);
  assert.deepEqual(deltas, [{ kind: 'content', text: 'recovered content' }]);
  assert.equal(result.messageId, 2);
});

test('surfaces empty_reply after the start attempts are exhausted', async () => {
  saveSession({ token, cookies: [] });
  const client = new DirectClient({ retryDelays: [0, 0, 0], emptyRetryDelays: [0, 0, 0] });
  let completionCalls = 0;

  globalThis.fetch = baseFetch(() => {
    completionCalls++;
    return streamResponse([
      'event: ready\ndata: {"request_message_id":1,"response_message_id":2}\n\n',
      'event: close\ndata: {}\n\n',
    ]);
  });

  await assert.rejects(
    client.run(
      { prompt: 'always empty', thinking: true, search: false, attachments: [] },
      {},
    ),
    (err) => err.code === 'empty_reply' && /empty reply/i.test(err.message),
  );
  assert.equal(completionCalls, 4);
});

test('keeps recovering when the resume replay also ends WIP', async () => {
  saveSession({ token, cookies: [] });
  const client = new DirectClient({ retryDelays: [0, 0, 0] });
  let resumeCalls = 0;
  let continueCalls = 0;

  globalThis.fetch = baseFetch(
    () =>
      streamResponse([
        'event: ready\ndata: {"request_message_id":1,"response_message_id":2}\n\n',
        'data: {"v":{"response":{"status":"WIP","fragments":[{"type":"RESPONSE","content":"Hello"}]}}}\n\n',
        'event: close\ndata: {}\n\n',
      ]),
    () => {
      continueCalls++;
      return streamResponse([
        'data: {"v":{"response":{"status":"FINISHED","fragments":[{"type":"RESPONSE","content":"Hello world"}]}}}\n\n',
        'event: close\ndata: {}\n\n',
      ]);
    },
    () => {
      resumeCalls++;
      // The replay also ends while the message is still generating: the
      // recovery-loop WIP gate must keep the suffix and try /chat/continue.
      return streamResponse([
        'event: ready\ndata: {"request_message_id":1,"response_message_id":2}\n\n',
        'data: {"v":{"response":{"status":"WIP","fragments":[{"type":"RESPONSE","content":"Hello wor"}]}}}\n\n',
        'event: close\ndata: {}\n\n',
      ]);
    },
  );

  const deltas = [];
  const result = await client.run(
    { prompt: 'wip all the way down', thinking: true, search: false, attachments: [] },
    { onDelta: (delta) => deltas.push(delta) },
  );

  assert.equal(resumeCalls, 1);
  assert.equal(continueCalls, 1);
  assert.deepEqual(deltas, [
    { kind: 'content', text: 'Hello' },
    { kind: 'content', text: ' wor' },
    { kind: 'content', text: 'ld' },
  ]);
  assert.equal(result.finish, 'stop');
});

test('falls back to a fresh-start retry when recovery confirms an empty reply', async () => {
  saveSession({ token, cookies: [] });
  const client = new DirectClient({ retryDelays: [0, 0, 0] });
  let completionCalls = 0;
  let resumeCalls = 0;

  globalThis.fetch = baseFetch(
    () => {
      completionCalls++;
      if (completionCalls === 1) {
        // Interrupted (WIP at close) with zero fragments; recovery replays an
        // empty FINISHED message, and the run must fall through to a fresh
        // completion retry instead of failing the client.
        return streamResponse([
          'event: ready\ndata: {"request_message_id":1,"response_message_id":2}\n\n',
          'data: {"v":{"response":{"status":"WIP","fragments":[]}}}\n\n',
          'event: close\ndata: {}\n\n',
        ]);
      }
      return streamResponse([
        'event: ready\ndata: {"request_message_id":1,"response_message_id":4}\n\n',
        'data: {"v":{"response":{"status":"FINISHED","fragments":[{"type":"RESPONSE","content":"second attempt content"}]}}}\n\n',
        'event: close\ndata: {}\n\n',
      ]);
    },
    null,
    () => {
      resumeCalls++;
      return streamResponse([
        'event: ready\ndata: {"request_message_id":1,"response_message_id":2}\n\n',
        'data: {"v":{"response":{"status":"FINISHED"}}}\n\n',
        'event: close\ndata: {}\n\n',
      ]);
    },
  );

  const deltas = [];
  const result = await client.run(
    { prompt: 'empty then recovered via retry', thinking: true, search: false, attachments: [] },
    { onDelta: (delta) => deltas.push(delta) },
  );

  assert.equal(completionCalls, 2);
  assert.equal(resumeCalls, 1);
  assert.deepEqual(deltas, [{ kind: 'content', text: 'second attempt content' }]);
  assert.equal(result.messageId, 4);
});

test('empty_reply raises the global throttle and success decays it', async () => {
  saveSession({ token, cookies: [] });
  const client = new DirectClient({ retryDelays: [0, 0, 0], emptyRetryDelays: [0, 0, 0] });
  let completionCalls = 0;

  globalThis.fetch = baseFetch(
    () => {
      completionCalls++;
      return streamResponse([
        'event: ready\ndata: {"request_message_id":1,"response_message_id":2}\n\n',
        'event: close\ndata: {}\n\n',
      ]);
    },
    null,
    () => {
      throw new Error('resume_stream should not be needed');
    },
  );

  const { upstreamThrottle, upstreamCooldownMs } = await import('../src/direct.js');
  const levelBefore = upstreamThrottle.level;
  // All four attempts come back empty: the surfaced failure must leave the
  // global throttle raised (a following success is what decays it).
  await assert.rejects(
    client.run(
      { prompt: 'always empty', thinking: true, search: false, attachments: [] },
      {},
    ),
    (err) => err.code === 'empty_reply',
  );

  assert.ok(upstreamThrottle.level > levelBefore, 'throttle level should rise on empty_reply');
  assert.ok(upstreamCooldownMs() > 0, 'a cooldown window should be active');
  assert.equal(completionCalls, 4); // MAX_START_ATTEMPTS attempts, all empty
  upstreamThrottle.level = 0;
  upstreamThrottle.until = 0;
  assert.equal(upstreamCooldownMs(), 0);
});


