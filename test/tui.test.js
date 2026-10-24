import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFrame,
  formatAge,
  modelSummaryLines,
  openaiEnvSnippet,
  opencodeProviderSnippet,
  renderConversations,
  renderModels,
  shortKey,
  stripAnsi,
  truncate,
} from '../src/tui.js';

const MODELS_FIXTURE = [
  {
    id: 'model-a',
    description: 'Model A (web Reasoner), reasoning enabled',
    context_window: 890880,
    max_output_tokens: 131072,
  },
  {
    id: 'model-b',
    description: 'Model B (web Search), reasoning and web search enabled',
    context_window: 890880,
    max_output_tokens: 131072,
  },
];

test('stripAnsi removes escape sequences but keeps plain text', () => {
  assert.equal(stripAnsi('\x1b[?1049h\x1b[?25lhello\x1b[0m world\x1b[H\x1b[2J!'), 'hello world!');
  assert.equal(stripAnsi('plain'), 'plain');
  assert.equal(stripAnsi(undefined), '');
  assert.equal(stripAnsi(null), '');
});

test('truncate cuts with an ellipsis and handles tiny limits', () => {
  assert.equal(truncate('abcdefgh', 8), 'abcdefgh');
  assert.equal(truncate('abcdefgh', 5), 'abcd…');
  assert.equal(truncate('abcdefgh', 1), 'a');
  assert.equal(truncate('abcdefgh', 0), '');
  assert.equal(truncate(null, 5), '');
});

test('formatAge buckets elapsed time and rejects junk', () => {
  const now = Date.now();
  assert.equal(formatAge(now - 30_000, now), '30s');
  assert.equal(formatAge(now - 5 * 60_000, now), '5m');
  assert.equal(formatAge(now - 3 * 3_600_000, now), '3h');
  assert.equal(formatAge(now - 50 * 3_600_000, now), '2d');
  assert.equal(formatAge(new Date(now - 60_000).toISOString(), now), '1m');
  assert.equal(formatAge(undefined, now), '-');
  assert.equal(formatAge('not-a-date', now), '-');
  assert.equal(formatAge(0, now), '-');
});

test('shortKey keeps 8 characters', () => {
  assert.equal(shortKey('abcdefghijklmnop'), 'abcdefgh');
  assert.equal(shortKey('ab'), 'ab');
  assert.equal(shortKey(undefined), '-');
  assert.equal(shortKey(''), '-');
});

test('modelSummaryLines marks the default model with *', () => {
  const lines = modelSummaryLines({ models: MODELS_FIXTURE, defaultModel: 'model-b' }).map(stripAnsi);
  assert.ok(lines.some((line) => line.startsWith('* ') && line.includes('model-b')));
  assert.ok(lines.some((line) => line.startsWith('  ') && line.includes('model-a')));
});

test('modelSummaryLines includes context/output metadata and description', () => {
  const lines = modelSummaryLines({ models: MODELS_FIXTURE, defaultModel: 'model-a' }).map(stripAnsi);
  assert.ok(lines.every((line) => line.includes('890,880') && line.includes('131,072')));
  assert.ok(lines[0].includes('Model A (web Reasoner)'));
});

test('modelSummaryLines narrow width drops the description', () => {
  const lines = modelSummaryLines({ models: MODELS_FIXTURE, defaultModel: 'model-a', width: 50 }).map(stripAnsi);
  assert.ok(!lines.some((line) => line.includes('Reasoner')));
  assert.ok(lines[0].includes('ctx'));
});

test('renderModels marks the default and renders a legend', () => {
  const out = stripAnsi(renderModels({ models: MODELS_FIXTURE, defaultModel: 'model-b', width: 100 }));
  assert.match(out, /MODELS/);
  assert.match(out, /\(\* = default\)/);
  assert.match(out, /model-b/);
  assert.match(out, /890,880/);
  const defaultLine = out.split('\n').find((line) => line.includes('model-b'));
  assert.ok(defaultLine.trim().startsWith('*'));
});

test('renderModels survives junk input', () => {
  const out = stripAnsi(renderModels({ models: [null, {}], defaultModel: null, width: 100 }));
  assert.match(out, /-/);
});

test('renderConversations shows an empty-state line for empty and missing lists', () => {
  assert.match(stripAnsi(renderConversations({ conversations: [] })), /no conversations yet/);
  assert.match(stripAnsi(renderConversations({ conversations: null })), /no conversations yet/);
  assert.match(stripAnsi(renderConversations({ conversations: undefined })), /no conversations yet/);
});

test('renderConversations renders dashes for missing fields', () => {
  const out = stripAnsi(renderConversations({
    conversations: [{ key: 'aabbccddeeff00' }], // legacy entry: no model/tokens/preview
    now: Date.now(),
  }));
  assert.match(out, /aabbccdd/); // short key
  assert.match(out, /-\s+-\s+-\s+-\s+-/); // turns, in, out, session all dashed
  assert.match(out, /MODEL/);
});

test('renderConversations renders numbers, age and preview', () => {
  const now = Date.now();
  const out = stripAnsi(renderConversations({
    conversations: [{
      key: 'k1234567890',
      model: 'deepseek-chat',
      turns: 3,
      tokensIn: 1200,
      tokensOut: 450,
      sessionTokens: 1650,
      updatedAt: now - 90_000,
      preview: 'hello world',
    }],
    now,
  }));
  assert.match(out, /deepseek-chat/);
  assert.match(out, /1,200/);
  assert.match(out, /450/);
  assert.match(out, /1,650/);
  assert.match(out, /1m/);
  assert.match(out, /hello world/);
});

test('renderConversations truncates previews to 48 characters', () => {
  const long = 'x'.repeat(200);
  // Wide terminal: the preview column gets its full ~48 characters.
  const out = stripAnsi(renderConversations({ conversations: [{ key: 'k1', preview: long }], width: 130 }));
  const row = out.split('PREVIEW')[1].split('\n')[1];
  const preview = row.slice(-48); // preview is the last column
  assert.equal(preview.length, 48);
  assert.match(preview, /…$/);
  // Narrow terminal: every rendered line still fits the width.
  const narrow = stripAnsi(renderConversations({ conversations: [{ key: 'k1', preview: long }], width: 100 }));
  for (const line of narrow.split('\n')) {
    assert.ok(line.length <= 100, `line too long (${line.length}): ${line}`);
  }
});

test('renderConversations narrow layout drops the preview column', () => {
  const out = stripAnsi(renderConversations({ conversations: [{ key: 'k1', preview: 'hi' }], width: 50 }));
  assert.ok(!out.includes('PREVIEW'));
});

test('opencode snippet parses as JSON and mirrors the opencode.jsonc shape', () => {
  const parsed = JSON.parse(opencodeProviderSnippet({
    models: [{ id: 'deepseek-reasoner', context_window: 890880, max_output_tokens: 131072 }],
    port: 8787,
  }));
  const provider = parsed['deepseek-bridge'];
  assert.equal(provider.name, 'DeepSeek Bridge');
  assert.equal(provider.package, '@opencode/ai/providers/openai-compatible');
  assert.equal(provider.settings.baseURL, 'http://127.0.0.1:8787/v1');
  assert.match(provider.settings.apiKey, /^\{file:~\/\.config\/deepseek-bridge\/opencode\.key\}$/);
  assert.equal(provider.compatibility.reasoningField, 'reasoning_content');
  const model = provider.models['deepseek-reasoner'];
  assert.equal(model.name, 'DeepSeek V4.1 Flash Reasoner (web)');
  assert.equal(model.family, 'deepseek');
  assert.equal(model.capabilities.tools, true);
  assert.deepEqual(model.capabilities.input, ['text', 'image']);
  assert.deepEqual(model.capabilities.output, ['text']);
  assert.deepEqual(model.capabilities.reasoning.effort, ['low', 'high', 'max']);
  assert.deepEqual(model.limit, { context: 890880, output: 131072 });
});

test('opencode snippet inlines an explicit API key', () => {
  const parsed = JSON.parse(opencodeProviderSnippet({ models: [], port: 9000, apiKey: 'sk-ds-test' }));
  assert.equal(parsed['deepseek-bridge'].settings.apiKey, 'sk-ds-test');
  assert.equal(parsed['deepseek-bridge'].settings.baseURL, 'http://127.0.0.1:9000/v1');
});

test('env snippet parses as JSON with base URL, key and model', () => {
  const parsed = JSON.parse(openaiEnvSnippet({ apiKey: 'sk-ds-abc', port: 8787, model: 'deepseek-search' }));
  assert.equal(parsed.OPENAI_BASE_URL, 'http://127.0.0.1:8787/v1');
  assert.equal(parsed.OPENAI_API_KEY, 'sk-ds-abc');
  assert.equal(parsed.OPENAI_MODEL, 'deepseek-search');
});

test('buildFrame composes every panel and strips to plain text', () => {
  const frame = buildFrame(
    {
      cfg: { port: 8787, defaultModel: 'deepseek-reasoner' },
      health: { ok: true, mode: 'direct', upstream: { active: 1, queued: 2, max: 3 } },
      status: null,
      conversations: [{
        key: 'k1234567890',
        model: 'deepseek-chat',
        turns: 2,
        tokensIn: 10,
        tokensOut: 20,
        updatedAt: Date.now() - 60_000,
        preview: 'hi there',
      }],
      convSource: 'file',
      logLines: ['2026-10-24 log line one'],
      focus: 1,
    },
    100,
  );
  const plain = stripAnsi(frame);
  for (const expected of [
    /deepseek-bridge v/,
    /MODELS/,
    /CONVERSATIONS \(from state\.json\)/,
    /HEALTH/,
    /bridge\s+up/,
    /upstream  active 1 · queued 2 · max 3/,
    /LOG/,
    /log line one/,
    /k1234567 /,
    /hi there/,
    /q\/Ctrl\+C quit/,
  ]) {
    assert.match(plain, expected);
  }
});

test('buildFrame narrow layout stays single column', () => {
  const frame = buildFrame(
    {
      cfg: { port: 8787, defaultModel: 'deepseek-reasoner' },
      health: { ok: true, mode: 'direct', upstream: { active: 0, queued: 0, max: 3 } },
      conversations: [{ key: 'k1', preview: 'secret preview text' }],
      convSource: 'api',
      logLines: [],
      focus: -1,
    },
    50,
  );
  const plain = stripAnsi(frame);
  assert.ok(!plain.includes('PREVIEW'));
  assert.match(plain, /bridge up · port 8787/);
  assert.match(plain, /1-4\/Tab focus · r refresh · q quit/);
});

test('buildFrame with no bridge data renders DOWN and dashes, never throws', () => {
  const frame = buildFrame({ cfg: { port: 8787, defaultModel: 'deepseek-reasoner' } }, 100);
  const plain = stripAnsi(frame);
  assert.match(plain, /down/);
  assert.match(plain, /DOWN/);
  assert.match(plain, /no conversations yet/);
  assert.match(plain, /no log yet/);
});
