import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { handleChatCompletions } from '../src/openai.js';

const failingRollout = JSON.parse(
  fs.readFileSync(new URL('./fixtures/failing-rollout.json', import.meta.url), 'utf8'),
);
const emptyDsml = fs.readFileSync(new URL('./fixtures/empty-dsml.txt', import.meta.url), 'utf8');

class FakeResponse {
  constructor() {
    this.chunks = [];
    this.headersSent = false;
    this.writableEnded = false;
    this.status = 0;
    this.listeners = new Map();
  }

  on(event, handler) {
    const list = this.listeners.get(event) || [];
    list.push(handler);
    this.listeners.set(event, list);
  }

  writeHead(status) {
    this.status = status;
    this.headersSent = true;
  }

  write(chunk) {
    this.chunks.push(String(chunk));
    return true;
  }

  end(chunk) {
    if (chunk) this.write(chunk);
    this.writableEnded = true;
  }
}

function parseSse(chunks) {
  const events = [];
  for (const line of chunks.join('').split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const payload = line.slice(6);
    if (payload === '[DONE]') continue;
    events.push(JSON.parse(payload));
  }
  return events;
}

async function replayRequest(text, toolNames, stream) {
  const res = new FakeResponse();
  const agent = {
    async run(_request, handlers) {
      handlers.onReady({ sessionId: 'sess_regression', messageId: 'msg_regression' });
      for (const char of Array.from(text)) handlers.onDelta({ kind: 'content', text: char });
      return {
        usage: { completion: 1 },
        finish: 'stop',
        sessionId: 'sess_regression',
        messageId: 'msg_regression',
      };
    },
  };
  const store = { getConversation: () => null, setConversation: () => {} };
  await handleChatCompletions(
    {},
    res,
    {
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: 'use a tool' }],
      tools: toolNames.map((name) => ({
        type: 'function',
        function: { name, description: `${name} tool`, parameters: { type: 'object', properties: {} } },
      })),
      stream,
    },
    { agent, store, log: () => {}, config: { defaultModel: 'deepseek-chat', toolMode: 'auto' } },
  );
  return stream ? parseSse(res.chunks) : JSON.parse(res.chunks.join(''));
}

async function replay(text, toolNames) {
  return replayRequest(text, toolNames, true);
}

for (const [turn, expected] of Object.entries({
  turn2: ['Bash'],
  turn8: ['Bash', 'Agent'],
  turn10: ['Bash'],
  turn11: ['Bash'],
  turn12: ['Bash'],
  turn13: ['Bash'],
})) {
  test(`HTTP stream converts failing rollout ${turn} to native tool calls`, async () => {
    const events = await replay(failingRollout[turn], ['Bash', 'Agent']);
    const content = events.map((event) => event.choices[0]?.delta?.content || '').join('');
    assert.doesNotMatch(content, /DSML|```json/);

    const toolCalls = events.flatMap((event) => event.choices[0]?.delta?.tool_calls || []);
    assert.deepEqual(
      toolCalls.map((call) => call.function.name),
      expected,
    );
    for (const call of toolCalls) {
      const args = JSON.parse(call.function.arguments);
      assert.ok(args.command || args.prompt);
    }

    const finish = events.filter((event) => event.choices[0]?.finish_reason).at(-1);
    assert.equal(finish.choices[0].finish_reason, 'tool_calls');
  });
}

test('HTTP stream strips a degenerate empty DSML loop without fake tool calls', async () => {
  const events = await replay(emptyDsml, ['Bash', 'Agent']);
  const content = events.map((event) => event.choices[0]?.delta?.content || '').join('');
  assert.match(content, /^Slide 8's column text runs into the dividers/);
  assert.doesNotMatch(content, /DSML/);
  assert.ok(content.length < 200);

  const toolCalls = events.flatMap((event) => event.choices[0]?.delta?.tool_calls || []);
  assert.equal(toolCalls.length, 0);

  const finish = events.filter((event) => event.choices[0]?.finish_reason).at(-1);
  assert.equal(finish.choices[0].finish_reason, 'stop');
});

test('HTTP non-stream strips a degenerate empty DSML loop without fake tool calls', async () => {
  const body = await replayRequest(emptyDsml, ['Bash', 'Agent'], false);
  const message = body.choices[0].message;
  assert.equal(body.choices[0].finish_reason, 'stop');
  assert.match(message.content, /^Slide 8's column text runs into the dividers/);
  assert.doesNotMatch(message.content, /DSML/);
  assert.ok(message.content.length < 200);
  assert.equal(message.tool_calls, undefined);
});

test('uses the direct runner when a terminal session exists', async () => {
  const res = new FakeResponse();
  let used = '';
  const agent = {
    async run() {
      used = 'extension';
      throw new Error('extension path should not be used');
    },
  };
  const direct = {
    reloadSession: () => ({ token: 'test-token' }),
    async run(_request, handlers) {
      used = 'direct';
      handlers.onReady({ sessionId: 'sess_direct', messageId: 'msg_direct' });
      handlers.onDelta({ kind: 'content', text: 'DIRECT_OK' });
      return {
        usage: { completion: 1 },
        finish: 'stop',
        sessionId: 'sess_direct',
        messageId: 'msg_direct',
      };
    },
  };
  const store = { getConversation: () => null, setConversation: () => {} };
  await handleChatCompletions(
    {},
    res,
    { model: 'deepseek-chat', messages: [{ role: 'user', content: 'hello' }], stream: false },
    { agent, direct, store, log: () => {}, config: { defaultModel: 'deepseek-chat', toolMode: 'auto' } },
  );
  const body = JSON.parse(res.chunks.join(''));
  assert.equal(used, 'direct');
  assert.equal(body.choices[0].message.content, 'DIRECT_OK');
  assert.equal(body.choices[0].finish_reason, 'stop');
});
