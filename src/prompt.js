import crypto from 'node:crypto';

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

const MAX_ATTACHMENTS = 12;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 20000;

const MIME_EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg',
  'application/pdf': 'pdf',
  'text/plain': 'txt',
  'text/markdown': 'md',
  'application/json': 'json',
  'application/zip': 'zip',
};

function mimeFromName(name = '') {
  const ext = String(name).toLowerCase().match(/\.([a-z0-9]{1,8})$/)?.[1];
  if (!ext) return null;
  for (const [mime, e] of Object.entries(MIME_EXT)) if (e === ext) return mime;
  if (ext === 'jpeg') return 'image/jpeg';
  return null;
}

function sniffMime(buf) {
  if (!buf?.length) return null;
  const b = buf;
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 6 && b.subarray(0, 3).toString('latin1') === 'GIF') return 'image/gif';
  if (b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP')
    return 'image/webp';
  if (b.length >= 5 && b.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04) return 'application/zip';
  return null;
}

function sanitizeName(name, mime, index) {
  let out = String(name || '').split(/[\\/]/).pop() || '';
  out = out.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 120);
  if (!out) {
    const ext = MIME_EXT[mime] || 'bin';
    return `${mime?.startsWith('image/') ? 'image' : 'file'}-${index + 1}.${ext}`;
  }
  if (!/\.[a-z0-9]{1,8}$/i.test(out)) {
    const ext = MIME_EXT[mime];
    if (ext) out += `.${ext}`;
  }
  return out;
}

function parseDataUrl(url) {
  const m = /^data:([^;,]*)(;base64)?,([\s\S]*)$/.exec(url || '');
  if (!m) throw new Error('invalid data URL');
  const mime = (m[1] || 'text/plain').trim().toLowerCase();
  let buf;
  if (m[2]) buf = Buffer.from(m[3], 'base64');
  else buf = Buffer.from(decodeURIComponent(m[3]), 'utf8');
  return { mime, buf };
}

function imageUrlOf(part) {
  const u = part?.image_url ?? part?.url ?? part?.image;
  if (typeof u === 'string') return u;
  if (u && typeof u === 'object') return u.url || u.data || null;
  return null;
}

function contentParts(content) {
  if (content == null) return { text: '', attachments: [] };
  if (typeof content === 'string') return { text: content, attachments: [] };
  if (typeof content === 'object' && !Array.isArray(content)) {
    return contentParts([content]);
  }
  if (!Array.isArray(content)) return { text: String(content), attachments: [] };

  const texts = [];
  const attachments = [];
  for (const part of content) {
    if (typeof part === 'string') {
      texts.push(part);
      continue;
    }
    if (!part || typeof part !== 'object') continue;
    if (part.type === 'text' || part.type === 'input_text') {
      texts.push(part.text || '');
      continue;
    }
    if (part.type === 'image_url' || part.type === 'input_image' || part.type === 'image') {
      const url = imageUrlOf(part);
      if (url) {
        attachments.push({
          kind: 'image',
          url,
          name: part.name || part.filename || null,
          mime: part.mime_type || part.mime || null,
        });
      }
      continue;
    }
    if (part.type === 'file' || part.type === 'input_file') {
      const file = part.file && typeof part.file === 'object' ? part.file : part;
      const name = file.filename || file.name || part.filename || null;
      const mime = file.mime_type || file.mime || part.mime_type || null;
      const data = file.file_data ?? file.data;
      const url = file.file_url || file.url || null;
      if (typeof data === 'string' && data) {
        const urlValue = data.startsWith('data:') ? data : `data:${mime || 'application/octet-stream'};base64,${data}`;
        attachments.push({ kind: 'file', url: urlValue, name, mime });
      } else if (typeof url === 'string' && url) {
        attachments.push({ kind: 'file', url, name, mime });
      } else if (file.file_id) {
        // OpenAI file ids refer to the provider's storage, which the web chat
        // does not have. Keep a visible note instead of silently dropping it.
        texts.push(`[file omitted: unsupported file_id ${file.file_id}]`);
      }
      continue;
    }
    if (part.type === 'input_audio' || part.type === 'audio') {
      texts.push('[audio omitted: the bridge is text/image/file only]');
      continue;
    }
    if (typeof part.text === 'string') texts.push(part.text);
  }
  return { text: texts.join('\n'), attachments };
}

/** Text view of an OpenAI content value. Images/files are represented by ids
 * separately, so this only flattens the visible text. */
export function contentToText(content) {
  return contentParts(content).text;
}

export function normalizeMessages(messages) {
  return (messages || []).map((m) => {
    const { text, attachments } = contentParts(m.content);
    return {
      role: m.role || 'user',
      content: text,
      attachments,
      name: m.name,
      tool_call_id: m.tool_call_id,
      tool_calls: m.tool_calls || null,
    };
  });
}

export function splitMessages(messages) {
  const system = messages.filter((m) => m.role === 'system' || m.role === 'developer');
  const rest = messages.filter((m) => m.role !== 'system' && m.role !== 'developer');
  return { system, rest };
}

/** Stable key for one conversation: model + system prompt + first user turn. */
export function conversationKey(messages, model) {
  const { system, rest } = splitMessages(messages);
  const firstUser = rest.find((m) => m.role === 'user');
  return sha256(
    JSON.stringify({
      model,
      system: system.map((m) => m.content).join('\n'),
      firstUser: firstUser ? firstUser.content : rest[0]?.content || '',
    }),
  ).slice(0, 32);
}

/** Digest of the non-system transcript produced so far. */
export function transcriptDigest(rest) {
  return sha256(
    JSON.stringify(
      rest.map((m) => ({
        role: m.role,
        content: m.content,
        attachments: m.attachments?.map((a) => ({ kind: a.kind, name: a.name || '', urlLength: (a.url || '').length })),
        tool_calls: m.tool_calls
          ? m.tool_calls.map((c) => [c.id || c.function?.name, c.function?.name, c.function?.arguments])
          : undefined,
        tool_call_id: m.tool_call_id,
      })),
    ),
  );
}

export function formatTurn(m) {
  switch (m.role) {
    case 'assistant': {
      let text = m.content || '';
      if (Array.isArray(m.tool_calls) && m.tool_calls.length) {
        const calls = m.tool_calls.map((c) => ({
          name: c.function?.name || c.name,
          arguments: safeParse(c.function?.arguments ?? c.arguments ?? {}),
        }));
        text = [text, `\`\`\`tool_call\n${JSON.stringify(calls)}\n\`\`\``].filter(Boolean).join('\n\n');
      }
      return `ASSISTANT:\n${text}`;
    }
    case 'tool':
      return `TOOL RESULT${m.name ? ` (${m.name})` : ''}${m.tool_call_id ? ` [${m.tool_call_id}]` : ''}:\n${m.content}`;
    case 'user':
      return `USER:\n${m.content}`;
    default:
      return `${String(m.role).toUpperCase()}:\n${m.content}`;
  }
}

function safeParse(value) {
  if (typeof value !== 'string') return value ?? {};
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export function flattenTurns(rest) {
  return rest.map(formatTurn).join('\n\n');
}

export function collectAttachments(messages) {
  return (messages || []).flatMap((m) => m.attachments || []);
}

/**
 * Turn the URLs/data URLs collected from OpenAI content parts into uploadable
 * bytes. Remote URLs are fetched by the bridge (http/https only) with a hard
 * byte cap; data URLs are decoded locally. Duplicate bytes are sent once.
 */
export async function resolveAttachments(attachments, { log = () => {} } = {}) {
  const out = [];
  const seen = new Set();
  let total = 0;

  for (const att of (attachments || []).slice(0, MAX_ATTACHMENTS)) {
    let buf;
    let mime = att.mime || null;
    try {
      if (!att.url || typeof att.url !== 'string') continue;
      if (att.url.startsWith('data:')) {
        const parsed = parseDataUrl(att.url);
        buf = parsed.buf;
        mime = mime || parsed.mime;
      } else if (/^https?:\/\//i.test(att.url)) {
        const res = await fetch(att.url, {
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
          redirect: 'follow',
          headers: { 'user-agent': 'deepseek-bridge/0.1' },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const declared = Number(res.headers.get('content-length') || 0);
        if (declared > MAX_ATTACHMENT_BYTES) throw new Error(`too large (${declared} bytes)`);
        mime = mime || (res.headers.get('content-type') || '').split(';')[0].trim() || null;
        buf = Buffer.from(await res.arrayBuffer());
      } else {
        continue;
      }
    } catch (err) {
      log(`attachment skipped (${att.name || att.kind || 'file'}): ${err?.message || err}`);
      continue;
    }

    if (!buf?.length) continue;
    if (buf.length > MAX_ATTACHMENT_BYTES) {
      log(`attachment skipped (${att.name || 'file'}): ${buf.length} bytes > ${MAX_ATTACHMENT_BYTES}`);
      continue;
    }
    if (total + buf.length > MAX_TOTAL_ATTACHMENT_BYTES) {
      log(`attachment skipped (${att.name || 'file'}): total attachment budget exceeded`);
      continue;
    }

    mime = (mime || mimeFromName(att.name) || sniffMime(buf) || 'application/octet-stream').toLowerCase();
    if (mime === 'application/octet-stream') {
      mime = (mimeFromName(att.name) || sniffMime(buf) || mime).toLowerCase();
    }
    if (att.kind === 'image' && !mime.startsWith('image/')) {
      log(`attachment skipped (${att.name || 'image'}): server returned ${mime}, not an image`);
      continue;
    }

    const hash = sha256(buf);
    if (seen.has(hash)) continue;
    seen.add(hash);
    total += buf.length;

    out.push({
      kind: att.kind || (mime.startsWith('image/') ? 'image' : 'file'),
      name: sanitizeName(att.name, mime, out.length),
      mime,
      bytes: buf.length,
      dataBase64: buf.toString('base64'),
    });
  }

  if (out.length) {
    log(
      `attachments resolved: ${out.length} (${out.map((a) => `${a.name}:${Math.round(a.bytes / 1024)}k`).join(', ')})`,
    );
  }
  return out;
}

function schemaLine(tool) {
  const fn = tool.function || tool;
  const name = fn.name || 'tool';
  const desc = fn.description ? String(fn.description).replace(/\s+/g, ' ').trim() : '';
  const params = fn.parameters ? JSON.stringify(fn.parameters) : '{"type":"object"}';
  return `- ${name}${desc ? `: ${desc}` : ''}\n  arguments schema: ${params}`;
}

export function toolPreamble(tools, toolChoice) {
  if (!tools?.length) return '';
  const list = tools.map(schemaLine).join('\n');
  let choiceRule = '';
  if (toolChoice === 'none') {
    choiceRule = 'Tool use is disabled for this turn. Answer directly without emitting a tool_call block.';
  } else if (toolChoice === 'required') {
    choiceRule = 'You MUST call at least one of the tools now.';
  } else if (toolChoice && typeof toolChoice === 'object') {
    const name = toolChoice.function?.name || toolChoice.name;
    if (name) choiceRule = `You MUST call the tool "${name}" now.`;
  }

  return [
    '# Tool access',
    'You can call tools to inspect or change the environment. A tool call is a fenced block containing a JSON array:',
    '```tool_call',
    '[{"name": "<tool name>", "arguments": { ... }}]',
    '```',
    'Rules:',
    '- Use exact tool names and JSON argument shapes from this list.',
    '- To call several tools at once, put all of them in the same JSON array (parallel calls are allowed).',
    '- If you call a tool, output only the fenced block for that turn; no prose inside the block.',
    '- Tool results arrive as messages starting with "TOOL RESULT". Never invent results.',
    '- After seeing the results, continue the task and answer the user.',
    choiceRule,
    'Available tools:',
    list,
  ]
    .filter(Boolean)
    .join('\n');
}

// A closing fence must be at the start of a line (or at the end of the text).
// Otherwise a literal ``` inside a JSON string would end the block early.
const FENCED_TOOL = /```(?:tool_call|json:tool_call)[ \t]*(?:\r?\n)?([\s\S]*?)(?:\r?\n```|```[ \t]*$)/gi;
const XML_TOOL = /<(?:tool_call|tool_calls)>([\s\S]*?)<\/(?:tool_call|tool_calls)>/gi;

// DeepSeek's native chat template can leak DSML tags as ordinary text after a
// tool-result turn. The emitted markup is not perfectly formed: closing tags
// often lose their name (</｜｜DSML｜｜> instead of </｜｜DSML｜｜ invoke>),
// the calls wrapper may be missing, and the calls block can contain a JSON
// array instead of invoke/parameter tags. Tokenize the tags instead of relying
// on one strict regex so every one of those shapes is recovered.
const DSML_BAR = String.raw`[\uFF5C|]+`;
const DSML_TAG_RE = new RegExp(
  String.raw`<\s*(\/?)\s*` + DSML_BAR + String.raw`\s*DSML\s*` + DSML_BAR + String.raw`\s*([^>]*)>`,
  'gi',
);

function parseAttrs(text) {
  const out = {};
  for (const m of String(text || '').matchAll(/([a-zA-Z_][\w:-]*)\s*=\s*"([^"]*)"/g)) out[m[1]] = m[2];
  return out;
}

function parseTagSpec(raw) {
  const text = String(raw || '').trim();
  if (!text) return { name: '', attrs: {} };
  const match = text.match(/^([A-Za-z_][\w-]*)\b([\s\S]*)$/);
  if (!match) return { name: '', attrs: parseAttrs(text) };
  return { name: match[1].toLowerCase(), attrs: parseAttrs(match[2]) };
}

function parameterValue(param) {
  const raw = param.value ?? '';
  if (String(param.string).toLowerCase() === 'true') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function extractDsml(text) {
  const source = String(text || '');
  const calls = [];
  let saw = false;
  let cleaned = '';
  let cursor = 0;
  let inCalls = false;
  let callsWrapper = false;
  let inInvoke = false;
  let inParam = false;
  let currentCall = null;
  let currentParam = null;
  let callsBody = '';
  let callsAtStart = 0;

  const finishParam = () => {
    if (!currentParam) return;
    const param = currentParam;
    currentParam = null;
    inParam = false;
    if (!currentCall || !param.name) return;
    const value = parameterValue(param);
    if (param.name === 'arguments' || param.name === 'args') currentCall.argPayload = value;
    else if (['name', 'tool', 'tool_name'].includes(param.name)) {
      if (!currentCall.name) currentCall.name = String(value ?? '').trim();
    } else currentCall.args[param.name] = value;
  };

  const finishCall = () => {
    if (inParam) finishParam();
    if (!currentCall) return;
    const call = currentCall;
    currentCall = null;
    let name = String(call.name || call.args.name || call.args.tool || call.args.tool_name || '').trim();
    delete call.args.name;
    delete call.args.tool;
    delete call.args.tool_name;
    if (!name) return;
    if (call.argPayload !== undefined) {
      let parsed = call.argPayload;
      if (typeof parsed === 'string') {
        try {
          parsed = JSON.parse(parsed);
        } catch {
          /* keep the string */
        }
      }
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        call.args = { ...parsed, ...call.args };
      } else {
        call.args = { ...call.args, value: parsed };
      }
    }
    calls.push({ id: `call_${crypto.randomBytes(6).toString('hex')}`, name, arguments: call.args });
  };

  const finishCalls = () => {
    if (inParam) finishParam();
    if (inInvoke) {
      finishCall();
      inInvoke = false;
    }
    const body = callsBody.trim();
    if (calls.length === callsAtStart && body) calls.push(...parseCallPayload(body, { allowDirect: true }));
    callsBody = '';
    inCalls = false;
    callsWrapper = false;
    callsAtStart = calls.length;
  };

  for (const match of source.matchAll(DSML_TAG_RE)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    const segment = source.slice(cursor, start);
    if (segment) {
      if (inParam && currentParam) currentParam.value += segment;
      else if (inCalls && !inInvoke) callsBody += segment;
      else if (!inCalls && !inInvoke && !inParam) cleaned += segment;
    }
    cursor = end;
    saw = true;

    const closing = Boolean(match[1]);
    const { name, attrs } = parseTagSpec(match[2]);

    if (!closing) {
      if (name === 'calls' || name === 'tool_calls') {
        if (inCalls) finishCalls();
        inCalls = true;
        callsWrapper = true;
        callsBody = '';
        callsAtStart = calls.length;
      } else if (name === 'invoke' || name === 'tool' || name === 'tool_call') {
        if (inInvoke) finishCall();
        if (inParam) finishParam();
        inCalls = true;
        inInvoke = true;
        currentCall = {
          name: attrs.name || attrs.tool || attrs.tool_name || '',
          args: {},
          argPayload: undefined,
        };
        callsBody = '';
      } else if (name === 'parameter' || name === 'param') {
        if (inParam) finishParam();
        if (inInvoke) {
          currentParam = { name: attrs.name || '', string: attrs.string, value: '' };
          inParam = true;
        }
      }
    } else if (name === 'parameter' || name === 'param') {
      finishParam();
    } else if (name === 'invoke' || name === 'tool' || name === 'tool_call') {
      if (inParam) finishParam();
      if (inInvoke) {
        finishCall();
        inInvoke = false;
        if (!callsWrapper) inCalls = false;
      }
    } else if (name === 'calls' || name === 'tool_calls') {
      finishCalls();
    } else if (!name) {
      // DeepSeek often omits the tag name on a closing tag. Close the
      // innermost construct, which is what the stream order implies.
      if (inParam) finishParam();
      else if (inInvoke) {
        finishCall();
        inInvoke = false;
        if (!callsWrapper) inCalls = false;
      } else if (inCalls) {
        finishCalls();
      }
    }
  }

  const tail = source.slice(cursor);
  if (tail) {
    if (inParam && currentParam) currentParam.value += tail;
    else if (inCalls && !inInvoke) callsBody += tail;
    else if (!inCalls && !inInvoke && !inParam) cleaned += tail;
  }

  if (inParam) finishParam();
  if (inInvoke) {
    finishCall();
    inInvoke = false;
  }
  if (inCalls) finishCalls();

  return { calls, cleaned: cleaned.replace(/\n{3,}/g, '\n\n').trim(), had: saw };
}


function callFromItem(item, { allowDirect = true, requireArgs = false, toolNames = null } = {}) {
  if (!item || typeof item !== 'object') return null;
  const fn = item.function && typeof item.function === 'object' ? item.function : item;
  const name = String(fn.name || item.name || item.tool || item.tool_name || '').trim();
  if (!name) return null;
  if (toolNames && !toolNames.has(name.toLowerCase())) return null;

  let args = fn.arguments ?? item.arguments ?? item.args ?? item.parameters;
  if (args === undefined) {
    if (!allowDirect || requireArgs) return null;
    // Some local models flatten the parameters into the call object:
    // {"name":"Bash","command":"ls"} instead of {"name":"Bash","arguments":{...}}.
    args = {};
    for (const [key, value] of Object.entries(fn)) {
      if (['id', 'type', 'name', 'tool', 'tool_name', 'function', 'index'].includes(key)) continue;
      args[key] = value;
    }
  }
  if (typeof args === 'string') {
    // The OpenAI protocol requires `arguments` to be the stringified JSON
    // *object* of the call. Passing through text that is not a JSON object
    // (unparseable model output, scalars, arrays) makes strict clients reject
    // the whole tool call — opencode's openai-compatible stream parser fails
    // the finalize step with "Invalid JSON input for tool call <name>" and the
    // user sees the call bounce as a format error. Mirror extractDsml and wrap
    // every non-object payload in { value: ... } so the wire stays valid JSON.
    let normalized = null;
    try {
      const parsed = JSON.parse(args);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) normalized = parsed;
      else normalized = { value: parsed ?? null };
    } catch {
      normalized = { value: args };
    }
    args = normalized;
  } else if (args !== null && (Array.isArray(args) || typeof args !== 'object')) {
    // Same protocol rule for arguments supplied as a literal array/scalar.
    args = { value: args };
  }
  return {
    id: item.id || `call_${crypto.randomBytes(6).toString('hex')}`,
    name,
    arguments: args,
  };
}

function parseCallPayload(raw, options = {}) {
  const text = String(raw || '')
    .trim()
    .replace(/^```[a-z_:]*\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();
  if (!text) return [];
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (Array.isArray(parsed)) return parsed.map((item) => callFromItem(item, options)).filter(Boolean);
  if (parsed?.tool_calls && Array.isArray(parsed.tool_calls)) {
    return parsed.tool_calls.map((item) => callFromItem(item, options)).filter(Boolean);
  }
  if (parsed?.calls && Array.isArray(parsed.calls)) {
    return parsed.calls.map((item) => callFromItem(item, options)).filter(Boolean);
  }
  const one = callFromItem(parsed, options);
  return one ? [one] : [];
}

/**
 * Check whether a fenced JSON payload really describes a tool call. Used by
 * the streaming guard to decide whether a ```json block must be held until the
 * response ends or can be streamed immediately as ordinary content.
 */
export function looksLikeToolCallPayload(raw, options = {}) {
  const toolNames = normalizeToolNames(options.toolNames);
  return (
    parseCallPayload(raw, {
      allowDirect: Boolean(toolNames),
      toolNames,
      requireArgs: !toolNames,
    }).length > 0
  );
}

const JSON_FENCE = /```json[ \t]*(?:\r?\n)?([\s\S]*?)(?:\r?\n```|```[ \t]*$)/gi;

function normalizeToolNames(toolNames) {
  if (!toolNames) return null;
  const names = [...toolNames].map((name) => String(name || '').toLowerCase()).filter(Boolean);
  return names.length ? new Set(names) : null;
}

/**
 * Extract tool calls from a model reply. Supported shapes (all emitted by
 * different local models): fenced JSON arrays, fenced single objects, plain
 * ```json fences that contain a call, XML <tool_call> wrappers, DSML markup
 * (including malformed closing tags), and a bare JSON object/array.
 */
export function extractToolCalls(text, { toolNames = null } = {}) {
  const source = text || '';
  const names = normalizeToolNames(toolNames);
  const calls = [];
  let sawBlock = false;
  let match;

  FENCED_TOOL.lastIndex = 0;
  while ((match = FENCED_TOOL.exec(source))) {
    sawBlock = true;
    calls.push(...parseCallPayload(match[1], { allowDirect: true }));
  }

  XML_TOOL.lastIndex = 0;
  while ((match = XML_TOOL.exec(source))) {
    sawBlock = true;
    calls.push(...parseCallPayload(match[1], { allowDirect: true }));
  }

  let cleaned = source.replace(FENCED_TOOL, '').replace(XML_TOOL, '');
  cleaned = cleaned.replace(JSON_FENCE, (block, payload) => {
    const parsed = parseCallPayload(payload, {
      allowDirect: Boolean(names),
      toolNames: names,
      requireArgs: !names,
    });
    if (!parsed.length) return block;
    sawBlock = true;
    calls.push(...parsed);
    return '';
  });

  const dsml = extractDsml(cleaned);
  if (dsml.had) {
    sawBlock = true;
    cleaned = dsml.cleaned;
    calls.push(...dsml.calls);
  }

  if (calls.length === 0 && !sawBlock) {
    const trimmed = source.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      const bare = parseCallPayload(trimmed, {
        allowDirect: Boolean(names),
        toolNames: names,
        requireArgs: !names,
      });
      if (bare.length) {
        calls.push(...bare);
        cleaned = '';
      }
    }
  }

  return {
    calls,
    cleaned: cleaned.replace(/\n{3,}/g, '\n\n').trim(),
    hadBlock: sawBlock || calls.length > 0,
  };
}

export const estimateTokens = (text) => Math.max(1, Math.round((text || '').length / 3.6));
