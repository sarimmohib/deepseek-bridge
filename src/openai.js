import crypto from 'node:crypto';
import {
  extractToolCalls,
  looksLikeToolCallPayload,
  flattenTurns,
  normalizeMessages,
  conversationKey,
  transcriptDigest,
  splitMessages,
  toolPreamble,
  estimateTokens,
  collectAttachments,
  resolveAttachments,
} from './prompt.js';

export const MODELS = [
  {
    id: 'deepseek-reasoner',
    object: 'model',
    owned_by: 'deepseek',
    description: 'DeepSeek V4.1 Flash (web Reasoner), reasoning enabled, reasoning_content populated',
    context_window: 890880,
    max_output_tokens: 131072,
  },
  {
    id: 'deepseek-search',
    object: 'model',
    owned_by: 'deepseek',
    description: 'DeepSeek V4.1 Flash (web Search), reasoning and web search enabled',
    context_window: 890880,
    max_output_tokens: 131072,
  },
];

function normalizeEffort(value) {
  if (value == null) return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value <= 0) return 0;
    return Math.max(1, Math.min(100, Math.round(value)));
  }
  const s = String(value).trim().toLowerCase();
  if (['none', 'off', 'disabled'].includes(s)) return 0;
  if (['minimal', 'min'].includes(s)) return 1;
  if (s === 'low') return 50;
  if (['medium', 'med', 'high'].includes(s)) return 75;
  if (['xhigh', 'ultra', 'max', 'maximum'].includes(s)) return 100;
  const n = Number(s);
  if (Number.isFinite(n)) return normalizeEffort(n);
  return null;
}

function effortHint(effort) {
  if (effort == null) return '';
  if (effort <= 25) return 'Reasoning effort hint: keep internal reasoning brief and answer directly.';
  if (effort >= 90) return 'Reasoning effort hint: think thoroughly and verify each step before answering.';
  return '';
}

export function normalizeModelId(name) {
  const n = String(name || '').toLowerCase();
  return n.includes('search') ? 'deepseek-search' : 'deepseek-reasoner';
}

export function resolveModel(name = 'deepseek-reasoner', body = {}) {
  const model = normalizeModelId(name);
  const modelType = 'default';
  // Both advertised models always reason. The search model always searches.
  // Body flags cannot turn either capability off, so a legacy client cannot
  // silently fall back to an instant chat mode.
  const thinking = true;
  const search = model === 'deepseek-search';
  let effort = null;
  let effortExplicit = false;

  if (body.thinking && typeof body.thinking === 'object' && body.thinking.effort != null) {
    effort = normalizeEffort(body.thinking.effort);
    effortExplicit = true;
  }
  if (body.reasoning_effort != null) {
    effort = normalizeEffort(body.reasoning_effort);
    effortExplicit = true;
  }
  if (effort === 0) {
    effort = null;
    effortExplicit = false;
  }

  return { modelType, thinking, search, effort, effortExplicit };
}

const TOOL_FENCE_MARKERS = ['```tool_call', '```json:tool_call', '```json'];
const TOOL_START_PATTERNS = [
  { re: /```(?:tool_call|json:tool_call)/i, kind: 'tool' },
  { re: /```json\b/i, kind: 'json' },
  { re: /<(?:tool_calls?|function_calls?)>/i, kind: 'xml' },
  { re: /<[\uFF5C|]+\s*DSML\s*[\uFF5C|]+\s*(?:calls|tool_calls|invoke)\b/i, kind: 'dsml' },
];

/**
 * Hold back a tool-call fence without holding back ordinary prose. The old
 * implementation buffered the whole answer whenever tools were advertised,
 * which made prose-only replies arrive in one late burst. This filters at the
 * fence boundary instead, and also survives a fence split across deltas.
 *
 * Plain ```json fences are held only until their payload can be inspected. If
 * the payload is an ordinary JSON answer it is released immediately; if it has
 * the shape of a tool call it stays held so the client never sees it as text.
 */
export function createToolGuard({ enabled, emit, toolNames = null }) {
  let pending = '';
  let holding = false;
  let held = '';
  let holdKind = '';
  let jsonDecided = false;

  function partialSuffix(text) {
    const lower = text.toLowerCase();
    let best = 0;
    for (const marker of TOOL_FENCE_MARKERS) {
      const m = marker.toLowerCase();
      const max = Math.min(m.length - 1, lower.length);
      for (let k = max; k > best; k--) {
        if (lower.endsWith(m.slice(0, k))) {
          best = k;
          break;
        }
      }
    }
    // Hold an unterminated tag prefix so a DSML start split across deltas is
    // never streamed before it can be recognized.
    const lt = text.lastIndexOf('<');
    if (lt >= 0) {
      const tail = text.slice(lt);
      if (tail.length <= 96 && !tail.includes('>')) best = Math.max(best, tail.length);
    }
    return best;
  }

  function takeHeld() {
    const out = held;
    held = '';
    holding = false;
    holdKind = '';
    jsonDecided = false;
    return out;
  }

  function decideJson() {
    if (holdKind !== 'json' || jsonDecided) return;
    // Only decide on a fence that is followed by a newline. End-of-buffer is
    // not a reliable closing fence while the response is still streaming: a
    // literal ``` inside a JSON string would look like the end of the block.
    const block = held.match(/```json[ \t]*(?:\r?\n)?([\s\S]*?)\r?\n```[ \t]*\r?\n/i);
    if (!block) return;
    jsonDecided = true;
    if (!looksLikeToolCallPayload(block[1], { toolNames })) {
      const out = takeHeld();
      if (out) emit(out);
    }
  }

  function push(text) {
    if (!text) return;
    if (!enabled) {
      emit(text);
      return;
    }
    if (holding) {
      held += text;
      decideJson();
      return;
    }
    pending += text;
    let cut = -1;
    let kind = '';
    for (const pattern of TOOL_START_PATTERNS) {
      const i = pending.search(pattern.re);
      if (i >= 0 && (cut < 0 || i < cut)) {
        cut = i;
        kind = pattern.kind;
      }
    }
    if (cut >= 0) {
      if (cut > 0) emit(pending.slice(0, cut));
      held = pending.slice(cut);
      pending = '';
      holding = true;
      holdKind = kind;
      jsonDecided = false;
      decideJson();
      return;
    }
    const keep = partialSuffix(pending);
    if (keep < pending.length) {
      const flush = pending.slice(0, pending.length - keep);
      if (flush) emit(flush);
      pending = pending.slice(pending.length - keep);
    }
  }

  function finish() {
    if (holding) return takeHeld();
    const out = pending;
    pending = '';
    return out;
  }

  return { push, finish };
}


function sse(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

function chunk({ id, created, model, delta, finish = null }) {
  return {
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta, logprobs: null, finish_reason: finish }],
  };
}

export async function handleChatCompletions(req, res, body, ctx) {
  const { agent, store, log } = ctx;

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return sendError(res, 400, 'messages must be a non-empty array', 'invalid_request');
  }

  const requestedModel = body.model || ctx.config.defaultModel;
  const model = normalizeModelId(requestedModel);
  const messages = normalizeMessages(body.messages);
  const { system, rest } = splitMessages(messages);
  const opts = resolveModel(model, body);

  const tools = Array.isArray(body.tools) ? body.tools : null;
  const toolChoice = body.tool_choice ?? 'auto';
  const toolsActive = Boolean(tools?.length) && toolChoice !== 'none' && ctx.config.toolMode !== 'off';
  const toolNames = toolsActive ? new Set(tools.map((tool) => tool?.function?.name).filter(Boolean)) : null;
  const preamble = toolsActive ? toolPreamble(tools, toolChoice) : '';
  const hint = opts.thinking && opts.effortExplicit ? effortHint(opts.effort) : '';

  const key = conversationKey(messages, model);
  const prev = store.getConversation(key);
  const digest = transcriptDigest(rest);

  const fullPlan = () => {
    const head = [system.map((m) => m.content).join('\n\n'), preamble, hint].filter(Boolean).join('\n\n');
    const transcript = flattenTurns(rest);
    return {
      continuation: false,
      sessionId: null,
      parentMessageId: null,
      prompt: head ? `${head}\n\n${transcript}` : transcript,
      baseTurns: 0,
    };
  };

  let plan;
  let sourceMessages;
  if (prev && prev.digest && prev.turns > 0 && rest.length > prev.turns) {
    const previousDigest = transcriptDigest(rest.slice(0, prev.turns));
    if (previousDigest === prev.digest) {
      // Drop the assistant turn we produced last time: the DeepSeek session
      // already holds it, and resending it makes the model answer its own echo.
      const tail = rest.slice(prev.turns);
      while (tail.length > 0 && tail[0].role === 'assistant') tail.shift();
      sourceMessages = tail;
      plan = {
        continuation: true,
        sessionId: prev.sessionId,
        parentMessageId: prev.parentId,
        prompt: [hint, flattenTurns(tail)].filter(Boolean).join('\n\n'),
        baseTurns: prev.turns,
      };
    }
  }
  if (!plan) {
    sourceMessages = rest;
    plan = fullPlan();
  }

  // Images and files travel separately from the text prompt: the content
  // script uploads the bytes and passes the resulting ids as ref_file_ids.
  const rawAttachments = collectAttachments(sourceMessages);
  // `let` so the invalid-parent fallback below can add attachments from the
  // earlier turns that the continuation tail never covered.
  let attachments = rawAttachments.length ? await resolveAttachments(rawAttachments, { log }) : [];
  if (!plan.prompt.trim() && attachments.length) plan.prompt = 'Please analyze the attached file(s).';

  const stream = body.stream === true;
  const includeUsage = body.stream_options?.include_usage === true;
  const id = `chatcmpl-${crypto.randomBytes(12).toString('hex')}`;
  const created = Math.floor(Date.now() / 1000);

  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });

  let keepalive = null;
  if (stream) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      'x-bridge-model': model,
    });
    res.write(': connected\n\n');
    sse(res, chunk({ id, created, model, delta: { role: 'assistant', content: '' } }));

    // DeepSeek can pause for a while between a tool call and the next token.
    // Keep intermediaries from treating the silent SSE connection as dead.
    keepalive = setInterval(() => {
      if (!res.writableEnded) {
        try {
          res.write(': keepalive\n\n');
        } catch {
          /* client disconnected */
        }
      }
    }, 15_000);
    keepalive.unref?.();
    res.on?.('finish', () => clearInterval(keepalive));
    res.on?.('close', () => clearInterval(keepalive));
  }

  const directSession = ctx.direct?.reloadSession?.();
  const runner = directSession ? ctx.direct : agent;
  const mode = directSession ? 'direct' : 'extension';

  const started = Date.now();
  let content = '';
  let reasoning = '';
  let usage = null;
  let finish = 'stop';
  let sessionId = plan.sessionId;
  let messageId = null;

  // With tools advertised, hold back only the tool_call fence. Ordinary prose
  // is streamed immediately so a text-only answer does not arrive in one burst.
  let fullContent = '';
  const writeContent = (text) => {
    if (!text) return;
    content += text;
    if (stream) sse(res, chunk({ id, created, model, delta: { content: text } }));
  };
  const guard = createToolGuard({ enabled: toolsActive, emit: writeContent, toolNames });
  const emitContent = (text) => {
    if (!text) return;
    fullContent += text;
    guard.push(text);
  };
  const emitReasoning = (text) => {
    if (!text) return;
    reasoning += text;
    if (stream) sse(res, chunk({ id, created, model, delta: { reasoning_content: text } }));
  };

  try {
    let activePlan = plan;
    const runPlan = (currentPlan) =>
      runner.run(
        {
          prompt: currentPlan.prompt,
          continuation: currentPlan.continuation,
          sessionId: currentPlan.sessionId,
          parentMessageId: currentPlan.parentMessageId,
          modelType: opts.modelType,
          thinking: opts.thinking,
          search: opts.search,
          attachments: attachments.map(({ name, mime, dataBase64 }) => ({ name, mime, dataBase64 })),
          debug: body.debug === true,
          requestId: id,
        },
        {
          onReady: (msg) => {
            if (msg.sessionId) sessionId = msg.sessionId;
            if (msg.messageId) messageId = msg.messageId;
          },
          onDelta: (msg) => {
            if (msg.kind === 'reasoning') emitReasoning(msg.text);
            else emitContent(msg.text);
          },
        },
        { signal: controller.signal },
      );

    let result;
    try {
      result = await runPlan(activePlan);
    } catch (err) {
      // A failed request can leave a dangling user message in the saved
      // DeepSeek session. The next continuation then fails with
      // "invalid message id"; recover by starting a fresh session with the
      // full transcript. Only safe before any answer text was streamed.
      const invalidParent =
        err?.code === 'invalid_parent' ||
        /invalid message id|message not found|invalid parent|not a leaf/i.test(String(err?.message || ''));
      if (activePlan.continuation && invalidParent && !content && !reasoning) {
        log('saved DeepSeek parent was rejected; retrying from a fresh session');
        store.deleteConversation?.(key);
        // The fresh prompt replays the whole transcript, but `attachments` was
        // collected from the continuation tail only. Resolve what earlier turns
        // contributed, skipping bytes the tail already covered.
        const headAttachments = collectAttachments(rest.slice(0, rest.length - sourceMessages.length));
        if (headAttachments.length) {
          const attKey = (a) => `${a.dataBase64.length}:${a.dataBase64.slice(0, 128)}`;
          const known = new Set(attachments.map(attKey));
          for (const att of await resolveAttachments(headAttachments, { log })) {
            if (!known.has(attKey(att))) {
              known.add(attKey(att));
              attachments.push(att);
            }
          }
        }
        activePlan = fullPlan();
        plan = activePlan;
        sessionId = null;
        messageId = null;
        result = await runPlan(activePlan);
      } else {
        throw err;
      }
    }
    plan = activePlan;

    usage = result.usage;
    finish = result.finish || 'stop';
    if (result.sessionId) sessionId = result.sessionId;
    if (result.messageId) messageId = result.messageId;

    const unemitted = guard.finish();
    const toolCalls = toolsActive
      ? extractToolCalls(fullContent, { toolNames })
      : { calls: [], cleaned: fullContent, hadBlock: false };

    if (toolCalls.calls.length === 0) {
      if (unemitted) {
        const held = toolsActive
          ? extractToolCalls(unemitted, { toolNames })
          : { calls: [], cleaned: unemitted, hadBlock: false };
        if (held.hadBlock) {
          // Malformed DSML/tool markup with no executable call: drop the
          // markup instead of streaming it back as assistant prose. This is
          // the degenerate "<｜｜DSML｜｜ calls>" + empty-tag loop some web
          // responses fall into after a tool-result turn.
          if (held.cleaned) writeContent(held.cleaned);
        } else {
          // A fence that did not parse as a tool call is ordinary text after all.
          writeContent(unemitted);
        }
      }
      if (!toolCalls.hadBlock) content = fullContent;
      if (toolCalls.hadBlock) {
        log(`tool markup without a call stripped (${Math.max(0, fullContent.length - toolCalls.cleaned.length)} chars)`);
      }
    } else {
      content = toolCalls.cleaned;
    }

    if (toolCalls.calls.length > 0) {
      finish = 'tool_calls';
      if (stream) {
        // Content was already streamed; announce calls as one delta at the end.
        const calls = toolCalls.calls.map((c, i) => ({
          index: i,
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: typeof c.arguments === 'string' ? c.arguments : JSON.stringify(c.arguments ?? {}) },
        }));
        sse(res, chunk({ id, created, model, delta: { tool_calls: calls }, finish: null }));
      }
    }

    if (sessionId && messageId) {
      store.setConversation(key, {
        sessionId,
        parentId: messageId,
        turns: rest.length,
        digest,
        model,
      });
    }

    const promptTokens = estimateTokens(plan.prompt);
    const completionTokens = usage?.completion || Math.max(1, Math.round((content.length + reasoning.length) / 3.6));
    const usageOut = {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    };

    if (stream) {
      sse(res, chunk({ id, created, model, delta: {}, finish }));
      if (includeUsage) {
        sse(res, {
          id,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [],
          usage: usageOut,
        });
      }
      res.write('data: [DONE]\n\n');
      res.end();
    } else {
      const message = { role: 'assistant', content };
      if (reasoning) message.reasoning_content = reasoning;
      if (finish === 'tool_calls') {
        message.content = content || null;
        message.tool_calls = toolCalls.calls.map((c) => ({
          id: c.id,
          type: 'function',
          function: {
            name: c.name,
            arguments: typeof c.arguments === 'string' ? c.arguments : JSON.stringify(c.arguments ?? {}),
          },
        }));
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(
        JSON.stringify({
          id,
          object: 'chat.completion',
          created,
          model,
          choices: [{ index: 0, message, logprobs: null, finish_reason: finish }],
          usage: usageOut,
          system_fingerprint: `dsb_${sessionId ? String(sessionId).slice(0, 8) : 'new'}`,
        }),
      );
    }

    if (result.debugLines) {
      log(`sse debug: ${result.debugLines.length} events`);
      for (const line of result.debugLines) log(`sse ${line}`);
    } else {
      log(`sse debug: none (${mode} runner did not return debugLines)`);
    }

    log(
      `chat ok mode=${mode} model=${model} thinking=${opts.thinking} effort=${opts.effort ?? '-'} search=${opts.search} ` +
        `cont=${plan.continuation} att=${attachments.length} session=${sessionId || '?'} msg=${messageId || '?'} ` +
        `out=${content.length}c/${reasoning.length}c ${Date.now() - started}ms`,
    );
  } catch (err) {
    const message = err?.message || String(err);
    log(`chat failed: ${message}`);
    if (stream) {
      if (!res.headersSent) {
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
      }
      sse(res, { error: { message, type: err?.code || 'bridge_error', code: err?.code || 'bridge_error' } });
      res.write('data: [DONE]\n\n');
      res.end();
    } else if (!res.headersSent) {
      sendError(res, err?.status || 502, message, err?.code || 'bridge_error');
    } else {
      res.end();
    }
  }
}

export function sendError(res, status, message, code = 'error') {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ error: { message, type: code, code } }));
}
