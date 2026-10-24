import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { handleChatCompletions, PRESET_SYSTEM_PROMPTS, bridgeQueue } from '../src/openai.js';
import { upstreamThrottle } from '../src/direct.js';
import { normalizeMessages, splitMessages, transcriptDigest, conversationKey } from '../src/prompt.js';

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
      model: 'deepseek-reasoner',
      messages: [{ role: 'user', content: 'use a tool' }],
      tools: toolNames.map((name) => ({
        type: 'function',
        function: { name, description: `${name} tool`, parameters: { type: 'object', properties: {} } },
      })),
      stream,
    },
    { agent, store, log: () => {}, config: { defaultModel: 'deepseek-reasoner', toolMode: 'auto' } },
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
    { model: 'deepseek-reasoner', messages: [{ role: 'user', content: 'hello' }], stream: false },
    { agent, direct, store, log: () => {}, config: { defaultModel: 'deepseek-reasoner', toolMode: 'auto' } },
  );
  const body = JSON.parse(res.chunks.join(''));
  assert.equal(used, 'direct');
  assert.equal(body.choices[0].message.content, 'DIRECT_OK');
  assert.equal(body.choices[0].finish_reason, 'stop');
});

test('restarts from the full transcript when a saved parent message is invalid', async () => {
  const res = new FakeResponse();
  const messages = [
    { role: 'user', content: 'first question' },
    { role: 'assistant', content: 'first answer' },
    { role: 'user', content: 'second question' },
  ];
  const normalized = normalizeMessages(messages);
  const { rest } = splitMessages(normalized);
  const history = transcriptDigest(rest.slice(0, 2));
  let deleted = false;
  let calls = 0;
  const store = {
    getConversation: () => ({ sessionId: 'sess_old', parentId: 2, turns: 2, digest: history }),
    setConversation: () => {},
    deleteConversation: (key) => {
      deleted = key;
    },
  };
  const agent = {
    async run(request, handlers) {
      calls++;
      if (calls === 1) {
        assert.equal(request.continuation, true);
        const err = new Error('DeepSeek /chat/completion: invalid message id');
        err.code = 'invalid_parent';
        throw err;
      }
      assert.equal(request.continuation, false);
      assert.match(request.prompt, /USER:\nfirst question/);
      assert.match(request.prompt, /USER:\nsecond question/);
      handlers.onReady({ sessionId: 'sess_new', messageId: 3 });
      handlers.onDelta({ kind: 'content', text: 'AFTER_RESET' });
      return {
        usage: { completion: 1 },
        finish: 'stop',
        sessionId: 'sess_new',
        messageId: 3,
      };
    },
  };

  await handleChatCompletions(
    {},
    res,
    { model: 'deepseek-reasoner', messages, stream: false },
    { agent, store, log: () => {}, config: { defaultModel: 'deepseek-reasoner', toolMode: 'auto' } },
  );

  const body = JSON.parse(res.chunks.join(''));
  assert.equal(calls, 2);
  assert.ok(deleted);
  assert.equal(body.choices[0].message.content, 'AFTER_RESET');
  assert.equal(body.choices[0].finish_reason, 'stop');
});

test('resolves earlier-turn attachments when restarting from a fresh session', async () => {
  const res = new FakeResponse();
  const imageB64 = Buffer.from('early-turn-image-bytes').toString('base64');
  const dataUrl = `data:image/png;base64,${imageB64}`;
  const messages = [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'first question' },
        { type: 'image_url', image_url: { url: dataUrl } },
      ],
    },
    { role: 'assistant', content: 'first answer' },
    { role: 'user', content: 'second question' },
  ];
  const normalized = normalizeMessages(messages);
  const { rest } = splitMessages(normalized);
  const history = transcriptDigest(rest.slice(0, 2));
  const store = {
    getConversation: () => ({ sessionId: 'sess_old', parentId: 2, turns: 2, digest: history }),
    setConversation: () => {},
    deleteConversation: () => {},
  };
  const seenAttachments = [];
  let calls = 0;
  const agent = {
    async run(request, handlers) {
      calls++;
      seenAttachments.push(request.attachments);
      if (calls === 1) {
        assert.equal(request.continuation, true);
        assert.deepEqual(request.attachments, []);
        const err = new Error('DeepSeek /chat/completion: invalid message id');
        err.code = 'invalid_parent';
        throw err;
      }
      assert.equal(request.continuation, false);
      assert.match(request.prompt, /USER:\nfirst question/);
      assert.match(request.prompt, /USER:\nsecond question/);
      assert.deepEqual(request.attachments, [{ name: 'image-1.png', mime: 'image/png', dataBase64: imageB64 }]);
      handlers.onReady({ sessionId: 'sess_new', messageId: 3 });
      handlers.onDelta({ kind: 'content', text: 'AFTER_RESET' });
      return {
        usage: { completion: 1 },
        finish: 'stop',
        sessionId: 'sess_new',
        messageId: 3,
      };
    },
  };

  await handleChatCompletions(
    {},
    res,
    { model: 'deepseek-reasoner', messages, stream: false },
    { agent, store, log: () => {}, config: { defaultModel: 'deepseek-reasoner', toolMode: 'auto' } },
  );

  const body = JSON.parse(res.chunks.join(''));
  assert.equal(calls, 2);
  assert.equal(body.choices[0].message.content, 'AFTER_RESET');
  assert.equal(body.choices[0].finish_reason, 'stop');
});

test('starts a fresh session when accumulated tokens exceed the context threshold', async () => {
  const res = new FakeResponse();
  const messages = [
    { role: 'user', content: 'first question' },
    { role: 'assistant', content: 'first answer' },
    { role: 'user', content: 'second question' },
  ];
  const normalized = normalizeMessages(messages);
  const { rest } = splitMessages(normalized);
  const key = conversationKey(normalized, 'deepseek-reasoner');
  // Digest matches the stored prefix, so without the context switch this
  // request would have continued the saved session.
  const history = transcriptDigest(rest.slice(0, 1));
  const events = [];
  let saved = null;
  const store = {
    getConversation: () => ({
      sessionId: 'sess_old',
      parentId: 2,
      turns: 1,
      digest: history,
      model: 'deepseek-reasoner',
      tokensOut: 900000,
    }),
    setConversation: (_key, value) => {
      saved = value;
    },
    deleteConversation: (k) => events.push(['delete', k]),
  };
  let sawContinuation = null;
  const agent = {
    async run(request, handlers) {
      sawContinuation = request.continuation;
      assert.equal(request.continuation, false);
      assert.match(request.prompt, /USER:\nfirst question/);
      assert.match(request.prompt, /USER:\nsecond question/);
      handlers.onReady({ sessionId: 'sess_new', messageId: 3 });
      handlers.onDelta({ kind: 'content', text: 'FRESH' });
      return { usage: { completion: 10 }, finish: 'stop', sessionId: 'sess_new', messageId: 3 };
    },
  };

  await handleChatCompletions(
    {},
    res,
    { model: 'deepseek-reasoner', messages, stream: false },
    {
      agent,
      store,
      log: (m) => events.push(['log', m]),
      config: { defaultModel: 'deepseek-reasoner', toolMode: 'auto', contextSwitchAt: 0.8 },
    },
  );

  const body = JSON.parse(res.chunks.join(''));
  assert.equal(sawContinuation, false);
  assert.ok(events.some(([kind, k]) => kind === 'delete' && k === key), 'stored conversation was deleted');
  assert.ok(
    events.some(([kind, m]) => kind === 'log' && /context limit reached \(\d+\/712704 tokens\); starting a fresh session/.test(m)),
    `context-limit log line missing: ${JSON.stringify(events)}`,
  );
  assert.equal(body.choices[0].message.content, 'FRESH');
  assert.equal(saved.sessionId, 'sess_new');
  assert.equal(saved.turns, 3);
});

test('caps a fresh transcript with an elision marker when it exceeds maxFreshTranscriptChars', async () => {
  const res = new FakeResponse();
  const filler = 'x'.repeat(400);
  const messages = [
    { role: 'user', content: `OLD1 ${filler}` },
    { role: 'assistant', content: `OLD2 ${filler}` },
    { role: 'user', content: `OLD3 ${filler}` },
    { role: 'assistant', content: `OLD4 ${filler}` },
    { role: 'user', content: 'LATEST_QUESTION' },
  ];
  let prompt = '';
  const agent = {
    async run(request, handlers) {
      prompt = request.prompt;
      assert.equal(request.continuation, false);
      handlers.onReady({ sessionId: 'sess_cap', messageId: 1 });
      handlers.onDelta({ kind: 'content', text: 'ok' });
      return { usage: null, finish: 'stop', sessionId: 'sess_cap', messageId: 1 };
    },
  };
  const store = { getConversation: () => null, setConversation: () => {} };

  await handleChatCompletions(
    {},
    res,
    { model: 'deepseek-reasoner', messages, stream: false },
    {
      agent,
      store,
      log: () => {},
      config: { defaultModel: 'deepseek-reasoner', toolMode: 'auto', maxFreshTranscriptChars: 700 },
    },
  );

  // 700 chars fit the last three turns (439 chars) but not four (852), so the
  // three oldest messages are dropped and the recent window is kept.
  assert.equal(
    prompt,
    `[earlier conversation omitted: 3 messages]\n\nASSISTANT:\nOLD4 ${filler}\n\nUSER:\nLATEST_QUESTION`,
  );
  assert.ok(!prompt.includes('OLD1'));
  const body = JSON.parse(res.chunks.join(''));
  assert.equal(body.choices[0].message.content, 'ok');
});

test('leaves short transcripts uncapped on a fresh start', async () => {
  const res = new FakeResponse();
  let prompt = '';
  const agent = {
    async run(request, handlers) {
      prompt = request.prompt;
      handlers.onReady({ sessionId: 'sess_small', messageId: 1 });
      handlers.onDelta({ kind: 'content', text: 'ok' });
      return { usage: null, finish: 'stop', sessionId: 'sess_small', messageId: 1 };
    },
  };
  const store = { getConversation: () => null, setConversation: () => {} };
  await handleChatCompletions(
    {},
    res,
    { model: 'deepseek-reasoner', messages: [{ role: 'user', content: 'tiny' }], stream: false },
    { agent, store, log: () => {}, config: { defaultModel: 'deepseek-reasoner', toolMode: 'auto', maxFreshTranscriptChars: 10 } },
  );
  assert.equal(prompt, 'USER:\ntiny');
});

test('prepends the preset bridge system prompt before the harness system message', async () => {
  const res = new FakeResponse();
  let prompt = '';
  const agent = {
    async run(request, handlers) {
      prompt = request.prompt;
      handlers.onReady({ sessionId: 'sess_sys', messageId: 1 });
      handlers.onDelta({ kind: 'content', text: 'ok' });
      return { usage: null, finish: 'stop', sessionId: 'sess_sys', messageId: 1 };
    },
  };
  const store = { getConversation: () => null, setConversation: () => {} };
  await handleChatCompletions(
    {},
    res,
    {
      model: 'deepseek-reasoner',
      messages: [
        { role: 'system', content: 'HARNESS_SYS' },
        { role: 'user', content: 'hi' },
      ],
      stream: false,
    },
    { agent, store, log: () => {}, config: { defaultModel: 'deepseek-reasoner', toolMode: 'auto', systemPreset: 'coding' } },
  );
  assert.equal(prompt, `${PRESET_SYSTEM_PROMPTS.coding}\n\nHARNESS_SYS\n\nUSER:\nhi`);
});

test('explicit systemPrompt wins over systemPreset', async () => {
  const res = new FakeResponse();
  let prompt = '';
  const agent = {
    async run(request, handlers) {
      prompt = request.prompt;
      handlers.onReady({ sessionId: 'sess_sys', messageId: 1 });
      handlers.onDelta({ kind: 'content', text: 'ok' });
      return { usage: null, finish: 'stop', sessionId: 'sess_sys', messageId: 1 };
    },
  };
  const store = { getConversation: () => null, setConversation: () => {} };
  await handleChatCompletions(
    {},
    res,
    {
      model: 'deepseek-reasoner',
      messages: [
        { role: 'system', content: 'HARNESS_SYS' },
        { role: 'user', content: 'hi' },
      ],
      stream: false,
    },
    {
      agent,
      store,
      log: () => {},
      config: { defaultModel: 'deepseek-reasoner', toolMode: 'auto', systemPrompt: 'BRIDGE_EXPLICIT', systemPreset: 'concise' },
    },
  );
  assert.ok(prompt.startsWith('BRIDGE_EXPLICIT\n\nHARNESS_SYS\n\nUSER:\nhi'));
  assert.ok(!prompt.includes(PRESET_SYSTEM_PROMPTS.concise));
});

test('unknown systemPreset is ignored with a one-line log', async () => {
  const res = new FakeResponse();
  const logs = [];
  let prompt = '';
  const agent = {
    async run(request, handlers) {
      prompt = request.prompt;
      handlers.onReady({ sessionId: 'sess_sys', messageId: 1 });
      handlers.onDelta({ kind: 'content', text: 'ok' });
      return { usage: null, finish: 'stop', sessionId: 'sess_sys', messageId: 1 };
    },
  };
  const store = { getConversation: () => null, setConversation: () => {} };
  await handleChatCompletions(
    {},
    res,
    {
      model: 'deepseek-reasoner',
      messages: [
        { role: 'system', content: 'HARNESS_SYS' },
        { role: 'user', content: 'hi' },
      ],
      stream: false,
    },
    { agent, store, log: (m) => logs.push(m), config: { defaultModel: 'deepseek-reasoner', toolMode: 'auto', systemPreset: 'bogus' } },
  );
  assert.equal(prompt, 'HARNESS_SYS\n\nUSER:\nhi');
  assert.equal(logs.filter((m) => /unknown systemPreset/.test(m)).length, 1);
});

test('queues upstream execution beyond maxUpstream and never exceeds it', async () => {
  let activeNow = 0;
  let maxSeen = 0;
  let completed = 0;
  const agent = {
    async run(_request, handlers) {
      activeNow++;
      maxSeen = Math.max(maxSeen, activeNow);
      handlers.onReady({ sessionId: 'sess_cc', messageId: 1 });
      await new Promise((resolve) => setTimeout(resolve, 25));
      handlers.onDelta({ kind: 'content', text: 'ok' });
      activeNow--;
      completed++;
      return { usage: null, finish: 'stop', sessionId: 'sess_cc', messageId: 1 };
    },
  };
  const store = { getConversation: () => null, setConversation: () => {} };
  const requests = [];
  for (let i = 0; i < 6; i++) {
    const res = new FakeResponse();
    requests.push(
      handleChatCompletions(
        {},
        res,
        { model: 'deepseek-reasoner', messages: [{ role: 'user', content: `q${i}` }], stream: false },
        { agent, store, log: () => {}, config: { defaultModel: 'deepseek-reasoner', toolMode: 'auto', maxUpstream: 2 } },
      ).then(() => res),
    );
  }
  const responses = await Promise.all(requests);

  assert.equal(completed, 6);
  assert.ok(maxSeen <= 2, `overlapping executions reached ${maxSeen}`);
  assert.equal(maxSeen, 2, 'expected the limiter to actually admit 2 at once');
  assert.equal(bridgeQueue.active, 0);
  assert.equal(bridgeQueue.queued, 0);
  for (const res of responses) {
    const body = JSON.parse(res.chunks.join(''));
    assert.equal(body.choices[0].message.content, 'ok');
    assert.equal(body.choices[0].finish_reason, 'stop');
  }
});

test('accumulates usage into the store after a successful turn', async () => {
  const res = new FakeResponse();
  let saved = null;
  const store = {
    getConversation: () => null,
    setConversation: (_key, value) => {
      saved = value;
    },
  };
  const agent = {
    async run(request, handlers) {
      assert.equal(request.continuation, false);
      handlers.onReady({ sessionId: 'sess_tok', messageId: 9 });
      handlers.onDelta({ kind: 'content', text: 'reply' });
      return { usage: { completion: 42 }, finish: 'stop', sessionId: 'sess_tok', messageId: 9 };
    },
  };
  await handleChatCompletions(
    {},
    res,
    { model: 'deepseek-reasoner', messages: [{ role: 'user', content: 'count me' }], stream: false },
    { agent, store, log: () => {}, config: { defaultModel: 'deepseek-reasoner', toolMode: 'auto' } },
  );
  const body = JSON.parse(res.chunks.join(''));
  assert.ok(saved, 'conversation entry was stored');
  assert.equal(saved.tokensOut, 42);
  assert.equal(saved.tokensIn, body.usage.prompt_tokens);
  assert.ok(saved.tokensIn > 0);
  assert.equal(saved.sessionTokens, 42);
  assert.equal(saved.preview, 'count me');
});

test('accumulates usage deltas across continuation turns', async () => {
  const res = new FakeResponse();
  const messages = [
    { role: 'user', content: 'q1' },
    { role: 'assistant', content: 'a1' },
    { role: 'user', content: 'q2' },
  ];
  const normalized = normalizeMessages(messages);
  const { rest } = splitMessages(normalized);
  const history = transcriptDigest(rest.slice(0, 2));
  let saved = null;
  const store = {
    getConversation: () => ({
      sessionId: 'sess_cont',
      parentId: 2,
      turns: 2,
      digest: history,
      model: 'deepseek-reasoner',
      tokensIn: 10,
      tokensOut: 42,
      sessionTokens: 42,
    }),
    setConversation: (_key, value) => {
      saved = value;
    },
  };
  const agent = {
    async run(request, handlers) {
      assert.equal(request.continuation, true);
      handlers.onReady({ sessionId: 'sess_cont', messageId: 3 });
      handlers.onDelta({ kind: 'content', text: 'second reply' });
      // 60 is the runner-reported session-cumulative count: the turn delta is 18.
      return { usage: { completion: 60 }, finish: 'stop', sessionId: 'sess_cont', messageId: 3 };
    },
  };
  await handleChatCompletions(
    {},
    res,
    { model: 'deepseek-reasoner', messages, stream: false },
    { agent, store, log: () => {}, config: { defaultModel: 'deepseek-reasoner', toolMode: 'auto' } },
  );
  const body = JSON.parse(res.chunks.join(''));
  assert.ok(saved, 'conversation entry was stored');
  assert.equal(saved.tokensIn, 10 + body.usage.prompt_tokens);
  assert.equal(saved.tokensOut, 60);
  assert.equal(saved.sessionTokens, 60);
});

test('pure degenerate DSML stream ends with an in-stream error instead of silence', async () => {
  const loop = '<｜｜DSML｜｜ calls>\n' + '<｜｜DSML｜｜>\n'.repeat(6);
  const events = await replayRequest(loop, ['Bash'], true);
  const errorFrame = events.find((event) => event.error);
  assert.ok(errorFrame, 'expected an error frame in the stream');
  assert.equal(errorFrame.error.code, 'empty_reply');
  assert.equal(events.filter((event) => event.choices?.[0]?.finish_reason).length, 0);
});

test('pure degenerate DSML non-stream returns a 502 empty_reply', async () => {
  const loop = '<｜｜DSML｜｜ calls>\n' + '<｜｜DSML｜｜>\n'.repeat(6);
  const body = await replayRequest(loop, ['Bash'], false);
  assert.equal(body.error.code, 'empty_reply');
  assert.match(body.error.message, /no usable output/);
});

test.after(() => {
  // the empty_reply tests raise the global upstream throttle; drop it so
  // later suites in this process are not paced by a leftover cooldown
  upstreamThrottle.level = 0;
  upstreamThrottle.until = 0;
});

test('raising maxUpstream mid-queue wakes FIFO waiters instead of a new arrival', async () => {
  upstreamThrottle.level = 0;
  upstreamThrottle.until = 0;
  const startOrder = [];
  const agent = {
    async run(_request, handlers) {
      handlers.onReady({ sessionId: 'sess_cc', messageId: 1 });
      await new Promise((resolve) => setTimeout(resolve, 20));
      handlers.onDelta({ kind: 'content', text: 'ok' });
      return { usage: null, finish: 'stop', sessionId: 'sess_cc', messageId: 1 };
    },
  };
  const tracked = {
    async run(request, handlers) {
      startOrder.push(request.prompt);
      return agent.run(request, handlers);
    },
  };
  const store = { getConversation: () => null, setConversation: () => {} };
  const fire = (label, maxUpstream) => {
    const res = new FakeResponse();
    const done = handleChatCompletions(
      {},
      res,
      { model: 'deepseek-reasoner', messages: [{ role: 'user', content: label }], stream: false },
      { agent: tracked, store, log: () => {}, config: { defaultModel: 'deepseek-reasoner', toolMode: 'auto', maxUpstream } },
    ).then(() => label);
    return { done, res };
  };

  fire('a', 1);
  await new Promise((resolve) => setTimeout(resolve, 5)); // a is active
  fire('b', 1); // queued behind a
  fire('c', 1); // queued behind b
  await new Promise((resolve) => setTimeout(resolve, 5));
  fire('d', 2); // arrives with a raised limit while b and c are waiting

  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.deepEqual(
    startOrder.map((p) => p.trim().split('\n').at(-1)),
    ['a', 'b', 'c', 'd'],
    `start order was ${startOrder}`,
  );
  assert.equal(bridgeQueue.active, 0);
  assert.equal(bridgeQueue.queued, 0);
});
