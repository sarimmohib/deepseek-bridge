import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createToolGuard } from '../src/openai.js';
import { extractToolCalls } from '../src/prompt.js';

const failingRollout = JSON.parse(
  fs.readFileSync(new URL('./fixtures/failing-rollout.json', import.meta.url), 'utf8'),
);
const emptyDsml = fs.readFileSync(new URL('./fixtures/empty-dsml.txt', import.meta.url), 'utf8');
const toolNames = new Set(['Bash', 'Agent']);

function runGuard(text, chunkSize = 1) {
  let emitted = '';
  const guard = createToolGuard({
    enabled: true,
    toolNames,
    emit: (chunk) => {
      emitted += chunk;
    },
  });
  for (let i = 0; i < text.length; i += chunkSize) guard.push(text.slice(i, i + chunkSize));
  const tail = guard.finish();
  return { emitted, tail, all: emitted + tail };
}

for (const [turn, expected] of Object.entries({
  turn2: ['Bash'],
  turn8: ['Bash', 'Agent'],
  turn10: ['Bash'],
  turn11: ['Bash'],
  turn12: ['Bash'],
  turn13: ['Bash'],
})) {
  test(`streaming guard never leaks failing rollout ${turn}`, () => {
    const text = failingRollout[turn];
    const { emitted, all } = runGuard(text);
    assert.doesNotMatch(emitted, /DSML|```json/);
    const { calls } = extractToolCalls(all, { toolNames });
    assert.deepEqual(
      calls.map((call) => call.name),
      expected,
    );
  });
}

test('streaming guard releases an ordinary JSON code fence immediately', () => {
  const text = 'Schema:\n```json\n{"name":"demo","value":1}\n```\nDone.';
  const { emitted, tail, all } = runGuard(text);
  assert.equal(all, text);
  assert.equal(tail, '');
  assert.match(emitted, /```json\n\{"name":"demo","value":1\}\n```/);
  const { calls, cleaned } = extractToolCalls(all, { toolNames });
  assert.equal(calls.length, 0);
  assert.equal(cleaned, text);
});

test('streaming guard keeps prose before a malformed DSML call', () => {
  const text = failingRollout.turn10;
  const { emitted, tail } = runGuard(text);
  assert.ok(emitted.startsWith('LibreOffice finished installing.'));
  assert.doesNotMatch(emitted, /DSML/);
  assert.match(tail, /^<｜｜DSML｜｜ calls>/);
});

test('streaming guard never streams a degenerate empty DSML loop', () => {
  const { emitted, tail } = runGuard(emptyDsml);
  assert.match(emitted, /^Slide 8's column text runs into the dividers/);
  assert.doesNotMatch(emitted, /DSML/);
  assert.match(tail, /^<｜｜DSML｜｜ calls>/);
  assert.ok(tail.length > 40000);
});

test('streaming guard holds a JSON call containing literal backticks', () => {
  const text = '```json\n[{"name":"Bash","arguments":{"command":"printf \\"```\\""}}]\n```';
  const { emitted, all } = runGuard(text);
  assert.doesNotMatch(emitted, /```json/);
  const { calls } = extractToolCalls(all, { toolNames });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].arguments.command, 'printf "```"');
});

test('streaming guard holds a flattened JSON call for an advertised tool', () => {
  const text = '```json\n{"name":"Bash","command":"ls -la"}\n```';
  const { emitted, all } = runGuard(text);
  assert.doesNotMatch(emitted, /```json/);
  const { calls } = extractToolCalls(all, { toolNames });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].arguments, { command: 'ls -la' });
});


// A call emitted as a bare array (optionally wrapped in stray DSML markers)
// used to execute while ALSO streaming to the client as prose: the guard
// matched fences, <tool_calls> and DSML invoke, but never a bare `[{…}]`.
for (const [label, text] of Object.entries({
  bare: '[{\"name\":\"Bash\",\"arguments\":{\"command\":\"ls\"}}]',
  angle: '<[{\"name\":\"Bash\",\"arguments\":{\"command\":\"ls\"}}]',
  dsml_wrapped: '</|DSML|>[{\"name\":\"Bash\",\"arguments\":{\"command\":\"ls\"}}] </|DSML|>',
  with_prose: 'Running it now.\n[{\"name\":\"Bash\",\"arguments\":{\"command\":\"ls\"}}]',
})) {
  test(`guard holds a bare-array call (${label})`, () => {
    const { emitted, all } = runGuard(text, 3);
    assert.doesNotMatch(emitted, /"name"\s*:\s*"Bash"/);
    assert.doesNotMatch(emitted, /DSML/);
    const { calls } = extractToolCalls(all, { toolNames });
    assert.deepEqual(calls.map((c) => c.name), ['Bash']);
  });
}

test('guard still streams an ordinary JSON array in prose', () => {
  const text = 'The config is [{"name": "x","value":1}] and done.';
  const { all } = runGuard(text, 4);
  assert.match(all, /The config is \[\{"name": "x","value":1\}\] and done\./);
});
