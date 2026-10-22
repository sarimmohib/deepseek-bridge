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
      thinking: false,
      attachments: [],
    },
    { onDelta: (delta) => deltas.push(delta) },
  );

  assert.equal(completionBody.chat_session_id, 'sess_test');
  assert.equal(completionBody.prompt, 'say OK!');
  assert.equal(completionBody.thinking_enabled, false);
  assert.deepEqual(deltas, [
    { kind: 'content', text: 'OK' },
    { kind: 'content', text: '!' },
  ]);
  assert.equal(result.sessionId, 'sess_test');
  assert.equal(result.messageId, 2);
  assert.equal(result.finish, 'stop');
});
