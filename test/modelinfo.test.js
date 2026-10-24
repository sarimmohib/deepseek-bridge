import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatAge,
  modelSummaryLines,
  openaiEnvSnippet,
  opencodeProviderSnippet,
  shortKey,
  stripAnsi,
  truncate,
} from '../src/modelinfo.js';

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

