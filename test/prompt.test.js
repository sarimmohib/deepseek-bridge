import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
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
  splitOversizedText,
  SPLIT_PART_BYTES,
  SPLIT_PART_TOKENS,
  TEXT_TOKENS_PER_BYTE,
  MAX_ATTACHMENT_TOKENS,
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

// Regression: a fenced call whose `arguments` is not a JSON *object* used to be
// passed through raw, so the bridge emitted native tool_calls with invalid or
// non-object JSON on the wire. opencode's openai-compatible parser fails those
// at finalize ("Invalid JSON input for tool call <name>") and the call bounces
// as a format error. They must be wrapped into { value: ... } like the DSML
// path already does, keeping `function.arguments` a valid JSON object string.
test('non-object fenced arguments are wrapped so tool_calls stay valid JSON', () => {
  const broken = extractToolCalls('```tool_call\n[{"name":"bash","arguments":"{command: ls}"}]\n```');
  assert.equal(broken.calls.length, 1);
  assert.deepEqual(broken.calls[0].arguments, { value: '{command: ls}' });

  const scalar = extractToolCalls('```tool_call\n[{"name":"bash","arguments":"ls -la"}]\n```');
  assert.deepEqual(scalar.calls[0].arguments, { value: 'ls -la' });

  const array = extractToolCalls('```tool_call\n[{"name":"bash","arguments":["ls","-la"]}]\n```');
  assert.deepEqual(array.calls[0].arguments, { value: ['ls', '-la'] });

  const literalArray = extractToolCalls('```tool_call\n[{"name":"bash","arguments":{"files":["a.txt","b.txt"]}}]\n```');
  assert.deepEqual(literalArray.calls[0].arguments, { files: ['a.txt', 'b.txt'] });

  const nulled = extractToolCalls('```tool_call\n[{"name":"bash","arguments":"null"}]\n```');
  assert.deepEqual(nulled.calls[0].arguments, { value: null });

  for (const { calls } of [broken, scalar, array, nulled]) {
    const wire = JSON.stringify(calls[0].arguments ?? {});
    assert.doesNotThrow(() => JSON.parse(wire), `arguments must stay parseable: ${wire}`);
    assert.equal(typeof JSON.parse(wire), 'object');
  }

  const object = extractToolCalls('```tool_call\n[{"name":"bash","arguments":{"command":"ls"}}]\n```');
  assert.deepEqual(object.calls[0].arguments, { command: 'ls' });
});

/* --- oversized attachment splitting and the context budget ---------------- */

const PART_LIMIT = 10 * 1024 * 1024; // MAX_ATTACHMENT_BYTES: text above this is split
const dataUrlOf = (buf, mime) => `data:${mime};base64,${buf.toString('base64')}`;
const textBuffer = (targetBytes, line = 'The quick brown fox jumps over the lazy dog. 0123456789\n') =>
  Buffer.from(line.repeat(Math.ceil(targetBytes / line.length)), 'utf8');

test('oversized text is split into context-budgeted parts that round-trip', () => {
  const big = textBuffer(11 * 1024 * 1024);
  const parts = splitOversizedText('big.log', 'text/plain', big);
  assert.equal(parts.length, Math.ceil(big.length / SPLIT_PART_BYTES));
  for (const part of parts) {
    assert.equal(part.mime, 'text/plain');
    assert.ok(part.data.length <= SPLIT_PART_BYTES, `part must stay within the context-budgeted window: ${part.data.length}`);
    assert.match(part.name, /^big\.part\d\dof\d\d\.log$/);
  }
  // Zero-padded names sort in upload order.
  const names = parts.map((p) => p.name);
  assert.deepEqual(names, [...names].sort());
  // Concatenating the part bytes restores the original file exactly.
  assert.ok(Buffer.concat(parts.map((p) => p.data)).equals(big), 'parts must round-trip to the original bytes');
});

test('split parts are trimmed to the leading parts that fit the context budget', async () => {
  const big = textBuffer(11 * 1024 * 1024); // ~6.3M estimated tokens in total
  const logs = [];
  const list = await resolveAttachments([{ kind: 'file', url: dataUrlOf(big, 'text/plain'), name: 'big.log' }], {
    log: (m) => logs.push(m),
  });
  // Each part carries ~SPLIT_PART_TOKENS tokens, so two parts together bust
  // the 500k budget: exactly the leading part survives.
  assert.ok(SPLIT_PART_TOKENS * 2 > MAX_ATTACHMENT_TOKENS);
  assert.equal(list.length, 1);
  assert.match(list[0].name, /^big\.part01of\d\d\.log$/);
  assert.ok(list[0].bytes <= SPLIT_PART_BYTES);
  const head = Buffer.from(list[0].dataBase64, 'base64');
  assert.ok(head.equals(big.subarray(0, head.length)), 'the kept part must be the head of the file');
  assert.ok(
    logs.some((m) =>
      /attachment split \(big\.log\): \d+ bytes > 10485760; splitting into \d+ context-budgeted parts/.test(m),
    ),
  );
  assert.ok(
    logs.some((m) =>
      /attachment skipped \(big\.part02of\d\d\.log\): ~\d+ tokens exceeds the model context budget; remainder of big\.log dropped \(context budget\)/.test(
        m,
      ),
    ),
  );
});

test('a text file just under the token cap passes untouched', async () => {
  const buf = textBuffer(900_000); // ~495k estimated tokens, under the 500k cap
  assert.ok(buf.length <= PART_LIMIT, 'precondition: the byte caps alone would let this through');
  assert.ok(buf.length * TEXT_TOKENS_PER_BYTE <= MAX_ATTACHMENT_TOKENS);
  const logs = [];
  const list = await resolveAttachments([{ kind: 'file', url: dataUrlOf(buf, 'text/plain'), name: 'ok.txt' }], {
    log: (m) => logs.push(m),
  });
  assert.equal(list.length, 1);
  assert.equal(list[0].name, 'ok.txt');
  assert.equal(list[0].bytes, buf.length);
  assert.equal(logs.filter((m) => m.includes('context budget')).length, 0);
});

test('a ~2MB text file over the token cap is split and keeps only its leading part', async () => {
  const big = textBuffer(2 * 1024 * 1024); // ~1.15M estimated tokens, under the byte caps
  assert.ok(big.length <= PART_LIMIT, 'precondition: the byte cap alone would not trigger the split');
  assert.ok(big.length * TEXT_TOKENS_PER_BYTE > MAX_ATTACHMENT_TOKENS);
  assert.ok(SPLIT_PART_TOKENS * 2 > MAX_ATTACHMENT_TOKENS, 'precondition: two parts cannot both fit');
  const logs = [];
  const list = await resolveAttachments([{ kind: 'file', url: dataUrlOf(big, 'text/plain'), name: 'huge.txt' }], {
    log: (m) => logs.push(m),
  });
  assert.equal(list.length, 1);
  assert.match(list[0].name, /^huge\.part01of\d\d\.txt$/);
  const head = Buffer.from(list[0].dataBase64, 'base64');
  assert.ok(head.length <= SPLIT_PART_BYTES, 'the kept part stays within the context-budgeted window');
  assert.ok(head.length > 600_000, `the kept part is the ~636 KB head, got ${head.length} bytes`);
  assert.ok(head.equals(big.subarray(0, head.length)), 'the kept part must be the head of the file');
  assert.ok(
    logs.some((m) =>
      /attachment split \(huge\.txt\): ~\d+ tokens exceeds the model context budget; splitting into \d+ context-budgeted parts/.test(
        m,
      ),
    ),
  );
  assert.ok(
    logs.some((m) =>
      /attachment skipped \(huge\.part02of\d\d\.txt\): ~\d+ tokens exceeds the model context budget; remainder of huge\.txt dropped \(context budget\)/.test(
        m,
      ),
    ),
  );
});

test('a ~950KB text file just over the token cap is split instead of skipped', async () => {
  const buf = textBuffer(950_000); // ~523k estimated tokens: over the cap, far under 10 MB
  assert.ok(buf.length <= PART_LIMIT, 'precondition: the byte cap alone would not trigger the split');
  assert.ok(buf.length * TEXT_TOKENS_PER_BYTE > MAX_ATTACHMENT_TOKENS, 'precondition: the whole file busts the token budget');
  const logs = [];
  const list = await resolveAttachments([{ kind: 'file', url: dataUrlOf(buf, 'text/plain'), name: 'med.txt' }], {
    log: (m) => logs.push(m),
  });
  assert.equal(list.length, 1);
  assert.match(list[0].name, /^med\.part01of\d\d\.txt$/);
  const head = Buffer.from(list[0].dataBase64, 'base64');
  assert.ok(head.length <= SPLIT_PART_BYTES, 'the kept part stays within the context-budgeted window');
  assert.ok(head.length > 600_000, `the kept part is the ~636 KB head, got ${head.length} bytes`);
  assert.ok(head.equals(buf.subarray(0, head.length)), 'the kept part must be the head of the file');
  assert.ok(
    logs.some((m) =>
      /attachment split \(med\.txt\): ~\d+ tokens exceeds the model context budget; splitting into \d+ context-budgeted parts/.test(
        m,
      ),
    ),
  );
});

test('oversized binary files are still skipped instead of split', async () => {
  const rnd = crypto.randomBytes(11 * 1024 * 1024);
  const logs = [];
  const list = await resolveAttachments(
    [
      { kind: 'file', url: dataUrlOf(rnd, 'application/octet-stream'), name: 'blob.bin' },
      { kind: 'file', url: dataUrlOf(rnd, 'image/png'), name: 'big.png' },
      { kind: 'image', url: dataUrlOf(rnd, 'image/png'), name: 'big.png' },
    ],
    { log: (m) => logs.push(m) },
  );
  assert.equal(list.length, 0);
  const skips = logs.filter((m) => m.startsWith('attachment skipped ('));
  assert.equal(skips.length, 3);
  for (const line of skips) assert.match(line, /bytes > 10485760/);
});

test('splitting respects the attachment count and total byte budgets', async () => {
  const huge = textBuffer(11 * 1024 * 1024);
  const huge2 = textBuffer(11 * 1024 * 1024, 'a second oversized file with different content\n');

  // Attachment-count budget: the input itself is capped at 12 attachments, so
  // with 11 small siblings only the first oversized file is even considered,
  // and its single context-budgeted part fills slot 12. (The per-part count
  // check further down cannot fire while the set guard caps every oversized
  // file at one part: two parts are ~700k tokens > the 500k budget.)
  const siblings = Array.from({ length: 11 }, (_, i) => ({
    kind: 'file',
    url: dataUrlOf(Buffer.from(`sibling ${i}\n`), 'text/plain'),
    name: `s${i}.txt`,
  }));
  const limitLogs = [];
  const limited = await resolveAttachments(
    [
      ...siblings,
      { kind: 'file', url: dataUrlOf(huge, 'text/plain'), name: 'big.log' },
      { kind: 'file', url: dataUrlOf(huge2, 'text/plain'), name: 'other.log' },
    ],
    { log: (m) => limitLogs.push(m) },
  );
  assert.equal(limited.length, 12);
  assert.match(limited[11].name, /^big\.part01of\d\d\.log$/);
  assert.ok(limited.every((p) => !p.name.startsWith('other.')));
  assert.ok(
    limitLogs.some((m) =>
      /attachment skipped \(big\.part02of\d\d\.log\): ~\d+ tokens exceeds the model context budget; remainder of big\.log dropped \(context budget\)/.test(
        m,
      ),
    ),
  );

  // Total byte budget: two ~9.9 MB images (exempt from the token guard) crowd
  // the 20 MB pool so even the single surviving part of big.log no longer fits.
  const fat1 = crypto.randomBytes(Math.floor(9.9 * 1024 * 1024));
  const fat2 = crypto.randomBytes(Math.floor(9.9 * 1024 * 1024));
  const totalLogs = [];
  const budgeted = await resolveAttachments(
    [
      { kind: 'image', url: dataUrlOf(fat1, 'image/png'), name: 'a.png' },
      { kind: 'image', url: dataUrlOf(fat2, 'image/png'), name: 'b.png' },
      { kind: 'file', url: dataUrlOf(huge, 'text/plain'), name: 'big.log' },
    ],
    { log: (m) => totalLogs.push(m) },
  );
  assert.equal(budgeted.length, 2);
  assert.ok(totalLogs.some((m) => /total attachment budget exceeded; remainder of big\.log dropped/.test(m)));
});

test('images are exempt from the token guard and keep legacy size behavior', async () => {
  // A 4 MB png dwarfs the 500k-token text budget, but images ride the vision
  // pipeline, not text ingestion — they must upload untouched.
  const png = crypto.randomBytes(4 * 1024 * 1024);
  assert.ok(png.length * TEXT_TOKENS_PER_BYTE > MAX_ATTACHMENT_TOKENS);
  const logs = [];
  const list = await resolveAttachments([{ kind: 'image', url: dataUrlOf(png, 'image/png'), name: 'big.png' }], {
    log: (m) => logs.push(m),
  });
  assert.equal(list.length, 1);
  assert.equal(list[0].kind, 'image');
  assert.equal(list[0].bytes, png.length);
  assert.equal(logs.filter((m) => m.includes('context budget')).length, 0);

  // The same bytes offered as a generic file part are exempt too (binary mime).
  const asFile = await resolveAttachments([{ kind: 'file', url: dataUrlOf(png, 'image/png'), name: 'big.png' }]);
  assert.equal(asFile.length, 1);
  assert.equal(asFile[0].bytes, png.length);
});

test('splitting never cuts through a multibyte character', async () => {
  // The first ~636 KB split window ends inside the 3-byte あ
  // (offsets SPLIT_PART_BYTES-2 .. SPLIT_PART_BYTES).
  const big = Buffer.concat([
    Buffer.alloc(SPLIT_PART_BYTES - 2, 0x78),
    Buffer.from('あ', 'utf8'),
    Buffer.alloc(10 * 1024 * 1024, 0x79),
  ]);
  assert.ok(big.length > PART_LIMIT);

  const parts = splitOversizedText('unicode.txt', 'text/plain', big);
  assert.ok(parts.length > 1);
  const joined = Buffer.concat(parts.map((p) => p.data));
  assert.ok(joined.equals(big));
  for (const part of parts) {
    assert.ok(part.data.length <= SPLIT_PART_BYTES);
    assert.ok(!part.data.toString('utf8').includes('\uFFFD'), 'no replacement chars introduced');
  }
  assert.match(parts[0].name, /^unicode\.part01of\d+\.txt$/);

  // resolveAttachments keeps only the leading context-budgeted part, intact.
  const list = await resolveAttachments([{ kind: 'file', url: dataUrlOf(big, 'text/plain'), name: 'unicode.txt' }]);
  assert.equal(list.length, 1);
  const resolved = Buffer.from(list[0].dataBase64, 'base64');
  assert.ok(resolved.equals(big.subarray(0, resolved.length)));
  assert.ok(!resolved.toString('utf8').includes('\uFFFD'));
});

test('oversized text data URLs announce the honest split in the flattened text', () => {
  const payload = 'A'.repeat(14_500_000); // ~10.9 MB decoded
  const decodedBytes = Math.floor((14_500_000 * 3) / 4);
  const approxParts = Math.ceil(decodedBytes / SPLIT_PART_BYTES);
  const nn = String(approxParts).padStart(Math.max(2, String(approxParts).length), '0');
  const kb = Math.round(SPLIT_PART_BYTES / 1000);
  const text = contentToText([
    { type: 'text', text: 'see attached' },
    { type: 'file', file: { filename: 'notes.txt', file_data: `data:text/plain;base64,${payload}` } },
  ]);
  assert.match(text, /see attached/);
  assert.match(
    text,
    new RegExp(
      `\\[file notes\\.txt exceeds the model context budget: only the first part \\(notes\\.part01of${nn}\\.txt, ~${kb} KB\\) can be attached; the rest of the file is omitted\\]`,
    ),
  );
  // The old overpromise ("will be uploaded as N parts") is gone.
  assert.doesNotMatch(text, /will be uploaded as/);
  assert.doesNotMatch(text, /uploaded split into parts/);

  // Small and binary files stay unannotated.
  const quiet = contentToText([
    { type: 'file', file: { filename: 'notes.txt', file_data: 'data:text/plain;base64,aGk=' } },
    { type: 'file', file: { filename: 'blob.bin', file_data: `data:application/octet-stream;base64,${payload}` } },
  ]);
  assert.equal(quiet, '');
});

test('text data URLs over the token cap announce the honest split in the flattened text', () => {
  const buf = textBuffer(950_000); // under the byte caps, over the token cap
  assert.ok(buf.length * TEXT_TOKENS_PER_BYTE > MAX_ATTACHMENT_TOKENS);
  const parts = Math.ceil(buf.length / SPLIT_PART_BYTES);
  const nn = String(parts).padStart(Math.max(2, String(parts).length), '0');
  const kb = Math.round(SPLIT_PART_BYTES / 1000);
  const text = contentToText([
    { type: 'file', file: { filename: 'med.txt', file_data: `data:text/plain;base64,${buf.toString('base64')}` } },
  ]);
  assert.match(
    text,
    new RegExp(
      `\\[file med\\.txt exceeds the model context budget: only the first part \\(med\\.part01of${nn}\\.txt, ~${kb} KB\\) can be attached; the rest of the file is omitted\\]`,
    ),
  );
  // The old whole-file omission wording is gone: the file is not skipped, its
  // leading part is delivered.
  assert.doesNotMatch(text, /omitted: ~\d+ tokens exceeds/);

  // Unnamed files get the same honesty without a part name.
  const unnamed = contentToText([
    { type: 'file', file: { mime_type: 'text/plain', file_data: `data:text/plain;base64,${buf.toString('base64')}` } },
  ]);
  assert.equal(
    unnamed,
    `[a file exceeds the model context budget: only the first part (~${kb} KB) can be attached; the rest of the file is omitted]`,
  );

  // Small text files stay unannotated.
  const quiet = contentToText([
    { type: 'file', file: { filename: 'ok.txt', file_data: 'data:text/plain;base64,aGk=' } },
  ]);
  assert.equal(quiet, '');
});
