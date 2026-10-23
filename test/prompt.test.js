import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  contentToText,
  normalizeMessages,
  flattenTurns,
  conversationKey,
  transcriptDigest,
  splitMessages,
  extractToolCalls,
  toolPreamble,
  resolveAttachments,
} from '../src/prompt.js';

const msgs = (...items) => normalizeMessages(items);

test('multimodal content is flattened to text and keeps attachments separate', () => {
  assert.equal(contentToText('hi'), 'hi');
  assert.equal(
    contentToText([
      { type: 'text', text: 'what is this' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,xxx' } },
    ]),
    'what is this',
  );

  const [msg] = normalizeMessages([
    {
      role: 'user',
      content: [
        { type: 'text', text: 'what is this' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,xxx' } },
        { type: 'file', file: { filename: 'notes.txt', file_data: 'data:text/plain;base64,aGk=' } },
      ],
    },
  ]);
  assert.equal(msg.content, 'what is this');
  assert.equal(msg.attachments.length, 2);
  assert.equal(msg.attachments[0].kind, 'image');
  assert.equal(msg.attachments[1].name, 'notes.txt');
});

test('tool results are labelled for the model', () => {
  const out = flattenTurns(
    msgs(
      { role: 'user', content: 'list files' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'bash', arguments: '{"cmd":"ls"}' } }],
      },
      { role: 'tool', content: 'a.txt\nb.txt', tool_call_id: 'call_1', name: 'bash' },
    ),
  );
  assert.match(out, /ASSISTANT:\n```tool_call/);
  assert.match(out, /"name":"bash"/);
  assert.match(out, /TOOL RESULT \(bash\) \[call_1\]:\na\.txt/);
});

test('conversation key is stable across turns but not across conversations', () => {
  const a = msgs({ role: 'system', content: 's' }, { role: 'user', content: 'first' });
  const b = msgs({ role: 'system', content: 's' }, { role: 'user', content: 'first' }, { role: 'assistant', content: 'x' }, { role: 'user', content: 'second' });
  assert.equal(conversationKey(a, 'deepseek-reasoner'), conversationKey(b, 'deepseek-reasoner'));

  const c = msgs({ role: 'system', content: 's' }, { role: 'user', content: 'other' });
  assert.notEqual(conversationKey(a, 'deepseek-reasoner'), conversationKey(c, 'deepseek-reasoner'));
});

test('transcript digest detects edited history', () => {
  const rest = splitMessages(msgs({ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' })).rest;
  const edited = splitMessages(msgs({ role: 'user', content: 'a' }, { role: 'assistant', content: 'B' })).rest;
  assert.notEqual(transcriptDigest(rest), transcriptDigest(edited));
  assert.equal(transcriptDigest(rest), transcriptDigest(rest));
});

test('tool call blocks are parsed out of the reply', () => {
  const text = 'Let me check.\n```tool_call\n{"name":"read","arguments":{"path":"/etc/hosts"}}\n```';
  const { calls, cleaned } = extractToolCalls(text);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'read');
  assert.deepEqual(calls[0].arguments, { path: '/etc/hosts' });
  assert.equal(cleaned, 'Let me check.');
});

test('flattened tool call parameters become arguments', () => {
  const text = '```tool_call\n{"name":"Bash","command":"ls -la","description":"list files"}\n```';
  const { calls, cleaned } = extractToolCalls(text);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'Bash');
  assert.deepEqual(calls[0].arguments, { command: 'ls -la', description: 'list files' });
  assert.equal(cleaned, '');
});

test('plain text with no tool block is untouched', () => {
  const { calls, cleaned } = extractToolCalls('just an answer');
  assert.equal(calls.length, 0);
  assert.equal(cleaned, 'just an answer');
});

test('tool preamble lists names and schemas', () => {
  const p = toolPreamble(
    [{ type: 'function', function: { name: 'bash', description: 'run a command', parameters: { type: 'object', properties: { cmd: { type: 'string' } } } } }],
    'auto',
  );
  assert.match(p, /- bash: run a command/);
  assert.match(p, /"cmd":\{"type":"string"\}/);
});

test('parallel tool calls are parsed from one fenced array', () => {
  const text =
    '```tool_call\n[{"name":"bash","arguments":{"command":"ls"}},{"name":"read_file","arguments":{"path":"/tmp/a"}}]\n```';
  const { calls, cleaned } = extractToolCalls(text);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].name, 'bash');
  assert.deepEqual(calls[0].arguments, { command: 'ls' });
  assert.equal(calls[1].name, 'read_file');
  assert.equal(cleaned, '');
});

test('bare JSON tool calls and XML wrappers are accepted', () => {
  const bare = extractToolCalls('{"name":"bash","arguments":{"command":"pwd"}}');
  assert.equal(bare.calls.length, 1);
  assert.equal(bare.cleaned, '');

  const xml = extractToolCalls('<tool_call>{"name":"bash","arguments":{"command":"ls"}}</tool_call>');
  assert.equal(xml.calls.length, 1);
  assert.equal(xml.cleaned, '');
});

test('assistant tool calls are rendered as one fenced array', () => {
  const out = flattenTurns(
    msgs(
      { role: 'user', content: 'do two things' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'a', type: 'function', function: { name: 'bash', arguments: '{"command":"ls"}' } },
          { id: 'b', type: 'function', function: { name: 'read_file', arguments: '{"path":"/tmp/a"}' } },
        ],
      },
    ),
  );
  assert.match(out, /```tool_call\n\[/);
  assert.match(out, /"name":"bash"/);
  assert.match(out, /"name":"read_file"/);
});

test('attachments are decoded, deduplicated and sized', async () => {
  const list = await resolveAttachments([
    { kind: 'image', url: 'data:image/png;base64,aGVsbG8=', name: 'a.png' },
    { kind: 'image', url: 'data:image/png;base64,aGVsbG8=', name: 'b.png' },
  ]);
  assert.equal(list.length, 1);
  assert.equal(list[0].name, 'a.png');
  assert.equal(list[0].mime, 'image/png');
  assert.equal(Buffer.from(list[0].dataBase64, 'base64').toString(), 'hello');
});

test('native DSML tool calls are parsed and stripped', () => {
  const bar = '\uFF5C';
  const open = `<${bar}${bar}DSML${bar}${bar}`;
  const close = `</${bar}${bar}DSML${bar}${bar}`;
  const text =
    `${open} calls>\n` +
    `${open} invoke name="bash">\n` +
    `${open} parameter name="arguments" string="false">{"command":"pwd"}</${bar}${bar}DSML${bar}${bar} parameter>\n` +
    `${close} invoke>\n` +
    `${close} calls>`;
  const { calls, cleaned } = extractToolCalls(text);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'bash');
  assert.deepEqual(calls[0].arguments, { command: 'pwd' });
  assert.equal(cleaned, '');
});

test('DSML direct parameters become arguments', () => {
  const text =
    '<|DSML| calls><|DSML| invoke name="read_file">' +
    '<|DSML| parameter name="path" string="true">/tmp/a.txt</|DSML| parameter>' +
    '<|DSML| parameter name="limit" string="false">5</|DSML| parameter>' +
    '</|DSML| invoke></|DSML| calls>';
  const { calls, cleaned } = extractToolCalls(text);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'read_file');
  assert.deepEqual(calls[0].arguments, { path: '/tmp/a.txt', limit: 5 });
  assert.equal(cleaned, '');
});

const emptyDsml = fs.readFileSync(new URL('./fixtures/empty-dsml.txt', import.meta.url), 'utf8');

test('empty DSML call wrappers are stripped without inventing tool calls', () => {
  const { calls, cleaned, hadBlock } = extractToolCalls(emptyDsml, {
    toolNames: new Set(['Bash', 'Agent', 'Read']),
  });
  assert.equal(calls.length, 0);
  assert.equal(hadBlock, true);
  assert.match(cleaned, /^Slide 8's column text runs into the dividers/);
  assert.doesNotMatch(cleaned, /DSML/);
  assert.ok(cleaned.length < 200);
});

// Exact assistant payloads from the failing ZCode rollout. DeepSeek dropped
// the names from closing tags, omitted the calls closer, wrapped a JSON array
// in DSML, and used a plain ```json fence. All of them must execute natively.
const failingRollout = JSON.parse(
  fs.readFileSync(new URL('./fixtures/failing-rollout.json', import.meta.url), 'utf8'),
);
const failingCases = {
  turn2: { names: ['Bash'], prose: '' },
  turn8: { names: ['Bash', 'Agent'], prose: '' },
  turn10: { names: ['Bash'], prose: 'LibreOffice finished installing.' },
  turn11: { names: ['Bash'], prose: '' },
  turn12: { names: ['Bash'], prose: '' },
  turn13: { names: ['Bash'], prose: '' },
};

for (const [turn, expected] of Object.entries(failingCases)) {
  test(`failing rollout ${turn} produces executable tool calls`, () => {
    const { calls, cleaned } = extractToolCalls(failingRollout[turn], {
      toolNames: new Set(['Bash', 'Agent']),
    });
    assert.deepEqual(
      calls.map((call) => call.name),
      expected.names,
    );
    for (const call of calls) {
      assert.equal(typeof call.arguments, 'object');
      assert.ok(call.arguments.command || call.arguments.prompt);
    }
    if (expected.prose) assert.ok(cleaned.startsWith(expected.prose));
    assert.doesNotMatch(cleaned, /DSML|```/);
  });
}

test('ordinary JSON code fences are left as content', () => {
  const text = 'Schema:\n```json\n{"name":"demo","value":1}\n```';
  const { calls, cleaned } = extractToolCalls(text, { toolNames: new Set(['Bash']) });
  assert.equal(calls.length, 0);
  assert.match(cleaned, /```json\n\{"name":"demo","value":1\}\n```/);
});

test('backticks inside JSON arguments do not close the fence early', () => {
  const text = '```json\n[{"name":"Bash","arguments":{"command":"printf \\"```\\""}}]\n```';
  const { calls, cleaned } = extractToolCalls(text, { toolNames: new Set(['Bash']) });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].arguments.command, 'printf "```"');
  assert.equal(cleaned, '');
});

test('plain json fences accept flattened calls only for advertised tools', () => {
  const text = '```json\n{"name":"Bash","command":"ls -la"}\n```';
  const withNames = extractToolCalls(text, { toolNames: new Set(['Bash']) });
  assert.equal(withNames.calls.length, 1);
  assert.deepEqual(withNames.calls[0].arguments, { command: 'ls -la' });

  const withoutNames = extractToolCalls(text);
  assert.equal(withoutNames.calls.length, 0);
  assert.match(withoutNames.cleaned, /```json/);
});
