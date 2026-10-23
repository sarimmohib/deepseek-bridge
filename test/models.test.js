import test from 'node:test';
import assert from 'node:assert/strict';
import { MODELS, normalizeModelId, resolveModel } from '../src/openai.js';
import { normalizeDefaultModel } from '../src/config.js';

test('only the reasoning models are advertised', () => {
  assert.deepEqual(
    MODELS.map((model) => model.id),
    ['deepseek-reasoner', 'deepseek-search'],
  );
});

test('legacy instant model IDs are normalized to the reasoner', () => {
  assert.equal(normalizeModelId('deepseek-chat'), 'deepseek-reasoner');
  assert.equal(normalizeModelId('deepseek-expert'), 'deepseek-reasoner');
  assert.equal(normalizeModelId('deepseek-reasoner'), 'deepseek-reasoner');
  assert.equal(normalizeModelId('deepseek-search'), 'deepseek-search');
  assert.equal(normalizeModelId('some-unknown-model'), 'deepseek-reasoner');
  assert.equal(normalizeDefaultModel('deepseek-chat'), 'deepseek-reasoner');
  assert.equal(normalizeDefaultModel('deepseek-expert'), 'deepseek-reasoner');
  assert.equal(normalizeDefaultModel('deepseek-search'), 'deepseek-search');
  assert.equal(normalizeDefaultModel(''), 'deepseek-reasoner');
});

test('reasoner always reasons and never searches', () => {
  for (const body of [
    {},
    { thinking_enabled: false, thinking: false, search_enabled: true },
    { reasoning_effort: 'none' },
  ]) {
    const opts = resolveModel('deepseek-reasoner', body);
    assert.equal(opts.thinking, true);
    assert.equal(opts.search, false);
  }
});

test('search always reasons and always searches', () => {
  for (const body of [
    {},
    { thinking_enabled: false, thinking: false, search_enabled: false },
    { reasoning_effort: 'none' },
  ]) {
    const opts = resolveModel('deepseek-search', body);
    assert.equal(opts.thinking, true);
    assert.equal(opts.search, true);
  }
});

test('effort is still passed as a hint for the reasoning models', () => {
  assert.equal(resolveModel('deepseek-reasoner', { reasoning_effort: 'max' }).effort, 100);
  assert.equal(resolveModel('deepseek-search', { reasoning_effort: 'low' }).effort, 50);
  assert.equal(resolveModel('deepseek-reasoner', { reasoning_effort: 'none' }).effort, null);
});
