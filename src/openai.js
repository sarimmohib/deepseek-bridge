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
  formatTurn,
} from './prompt.js';
import { BridgeError } from './agent.js';
import { buildParamToolIndex } from './prompt.js';
import { noteUpstreamThrottleEvent, upstreamCooldownMs } from './direct.js';
import { learnRule, renderRulesSection } from './rules.js';

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

/** Bridge-provided system presets, applied when config.systemPreset names one. */
export const PRESET_SYSTEM_PROMPTS = {
  'dsh-agent':
    'You are the model behind DeepSeek Harness (dsh), an autonomous coding agent running on the user\'s machine. Be decisive: pick the most reasonable approach and act on it, then verify the result. Use the provided tools for file, shell, and search work instead of guessing. State an assumption only when it changes the outcome; no filler and no restating the question. Never emit partial or hypothetical tool calls — only complete, executable ones.',
  'dsh-plan':
    'You are the planning model behind DeepSeek Harness (dsh). Think through the problem first, then return a short ordered plan: goal, steps, files or commands each step touches, and how to verify. Do not call tools unless the plan needs a fact you cannot infer; when you do, make one complete call and continue planning afterwards. No filler.',
  'dsh-tool':
    'You are the tool-calling model behind DeepSeek Harness (dsh). Your job is precise tool use: call exactly the tools needed, with complete arguments, and report results faithfully. One fenced tool_call block per turn, containing a JSON array of every parallel call. Never echo a result you did not receive, and never invent one.',
  none: '',
};

/**
 * Process-global upstream concurrency limiter: at most `maxUpstream` runner
 * executions against DeepSeek at once. Extra requests queue FIFO and take the
 * first freed slot. Release hands the slot straight to the next waiter (so the
 * active count can never overshoot max even across microtask scheduling), and
 * try/finally guarantees a slot is freed on both errors and aborts.
 */
export const bridgeQueue = { active: 0, queued: 0, max: 2 };
const slotWaiters = [];

export function clampMaxUpstream(v) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return 2;
  return Math.min(16, Math.max(1, n));
}

async function withUpstreamSlot(cfg, direct, fn) {
  bridgeQueue.max = clampMaxUpstream(cfg?.maxUpstream);
  // A raised limit must benefit queued waiters first: hand out the freed
  // capacity here (synchronously, so no new arrival can jump the FIFO).
  while (bridgeQueue.active < bridgeQueue.max && slotWaiters.length > 0) {
    const waiter = slotWaiters.shift();
    bridgeQueue.active++;
    waiter();
  }
  // Ride out a global throttle window while holding this slot: one account is
  // rate-limited, so pacing every client beats letting each one hammer. With
  // multiple accounts the throttled account cools down on its own and the
  // DirectClient rotates away, so a process-global stall would only slow down
  // healthy accounts.
  if (!direct?.hasMultipleAccounts) {
    const cooldown = upstreamCooldownMs();
    if (cooldown > 0) {
      await new Promise((resolve) => setTimeout(resolve, cooldown));
    }
  }
  if (bridgeQueue.active < bridgeQueue.max) {
    bridgeQueue.active++;
  } else {
    bridgeQueue.queued++;
    try {
      await new Promise((resolve) => slotWaiters.push(resolve));
    } finally {
      bridgeQueue.queued--;
    }
  }
  try {
    return await fn();
  } finally {
    const next = slotWaiters.shift();
    if (next) next();
    else bridgeQueue.active = Math.max(0, bridgeQueue.active - 1);
  }
}

function numOr(v, dflt) {
  return Number.isFinite(v) ? v : dflt;
}

function clampFraction(v, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return dflt;
  return Math.min(1, n);
}

function clampPositiveInt(v, dflt) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n <= 0) return dflt;
  return n;
}

/**
 * Best-effort numeric extraction from a runner usage value. The direct runner
 * surfaces DeepSeek's accumulated_token_usage (a session-cumulative count) as
 * { completion: N }; tolerate both a bare number and an object carrying token
 * fields.
 */
function numericTokens(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (v && typeof v === 'object') {
    for (const k of ['total_tokens', 'completion_tokens', 'prompt_tokens']) {
      const n = v[k];
      if (typeof n === 'number' && Number.isFinite(n)) return n;
    }
  }
  return null;
}

/**
 * Cap a fresh-start transcript to the most recent window that fits maxChars,
 * never dropping the latest user message. Returns the prompt text with a
 * one-line elision marker prepended when older messages were dropped.
 */
function capTranscript(rest, maxChars) {
  if (!rest.length) return { text: '', omitted: 0 };
  let lastUser = -1;
  for (let i = rest.length - 1; i >= 0; i--) {
    if (rest[i].role === 'user') {
      lastUser = i;
      break;
    }
  }
  if (lastUser < 0) return { text: flattenTurns(rest), omitted: 0 };
  const lens = rest.map((m) => formatTurn(m).length);
  const suffix = new Array(rest.length + 1).fill(0);
  for (let i = rest.length - 1; i >= 0; i--) {
    suffix[i] = lens[i] + (i < rest.length - 1 ? 2 + suffix[i + 1] : 0);
  }
  let start = 0;
  while (start < lastUser && suffix[start] > maxChars) start++;
  if (start === 0) return { text: flattenTurns(rest), omitted: 0 };
  const text = `[earlier conversation omitted: ${start} messages]\n\n${flattenTurns(rest.slice(start))}`;
  return { text, omitted: start };
}

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
export function createToolGuard({ enabled, emit, toolNames = null, paramToolIndex = null }) {
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
  const cfg = ctx.config || {};

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return sendError(res, 400, 'messages must be a non-empty array', 'invalid_request');
  }

  const requestedModel = body.model || cfg.defaultModel;
  const model = normalizeModelId(requestedModel);
  const messages = normalizeMessages(body.messages);

  // The conversation key is computed from the HARNESS's own messages, before
  // the bridge system message is prepended. Editing systemPrompt, systemPreset
  // or the rules therefore changes what the model is told without orphaning
  // the stored DeepSeek session (keyed on model + harness system + first user
  // turn): the next request continues the same session with the new guidance.
  const key = conversationKey(messages, model);

  // Bridge-provided system prompt: prepended as an extra system message so the
  // harness's own system message is kept verbatim (ours comes first; nothing
  // is deduped or rewritten). An explicit systemPrompt beats a preset; the
  // rules section (builtin + user + learned) is appended when enabled.
  let bridgeSystem = '';
  const explicitSystem = typeof cfg.systemPrompt === 'string' ? cfg.systemPrompt.trim() : '';
  const presetName = typeof cfg.systemPreset === 'string' ? cfg.systemPreset.trim() : '';
  if (explicitSystem) {
    bridgeSystem = explicitSystem;
  } else if (presetName && presetName !== 'none') {
    if (Object.hasOwn(PRESET_SYSTEM_PROMPTS, presetName)) bridgeSystem = PRESET_SYSTEM_PROMPTS[presetName];
    else log(`unknown systemPreset '${presetName}' ignored; valid presets: ${Object.keys(PRESET_SYSTEM_PROMPTS).join(', ')}`);
  }
  let rulesSection = '';
  if (cfg.systemRules !== false) {
    try {
      rulesSection = renderRulesSection();
    } catch {
      rulesSection = '';
    }
  }
  if (rulesSection) bridgeSystem = bridgeSystem ? `${bridgeSystem}\n\n${rulesSection}` : rulesSection;
  const chatMessages = bridgeSystem
    ? [{ role: 'system', content: bridgeSystem, attachments: [] }, ...messages]
    : messages;

  const { system, rest } = splitMessages(chatMessages);
  const opts = resolveModel(model, body);

  const tools = Array.isArray(body.tools) ? body.tools : null;
  const toolChoice = body.tool_choice ?? 'auto';
  const toolsActive = Boolean(tools?.length) && toolChoice !== 'none' && ctx.config.toolMode !== 'off';
  const toolNames = toolsActive ? new Set(tools.map((tool) => tool?.function?.name).filter(Boolean)) : null;
  const paramToolIndex = toolsActive ? buildParamToolIndex(tools) : null;
  const preamble = toolsActive ? toolPreamble(tools, toolChoice) : '';
  const hint = opts.thinking && opts.effortExplicit ? effortHint(opts.effort) : '';

  let prev = store.getConversation(key);
  const digest = transcriptDigest(rest);

  // Context-limit switching: once a stored session has consumed roughly its
  // share of the model's context window, abandon it and replay from scratch.
  // `sessionTokens` is the runner-reported cumulative count when available;
  // otherwise fall back to completion tokens sent so far plus a rough estimate
  // of the upcoming prompt (~4 chars per token — heuristic, not exact).
  const contextWindow = MODELS.find((m) => m.id === model)?.context_window || 890880;
  const contextSwitchAt = clampFraction(cfg.contextSwitchAt, 0.8);
  if (prev) {
    const threshold = contextSwitchAt * contextWindow;
    const estPromptTokens = Math.ceil(
      (system.map((m) => m.content).join('\n\n').length + flattenTurns(rest).length) / 4,
    ); // rough estimate
    const used = Number.isFinite(prev.sessionTokens)
      ? prev.sessionTokens
      : Number.isFinite(prev.tokensOut)
        ? prev.tokensOut + estPromptTokens
        : null;
    if (used != null && used >= threshold) {
      store.deleteConversation?.(key);
      log(`context limit reached (${used}/${Math.round(threshold)} tokens); starting a fresh session`);
      prev = null;
    }
  }

  const maxFreshTranscriptChars = clampPositiveInt(cfg.maxFreshTranscriptChars, 200_000);
  const fullPlan = () => {
    const head = [system.map((m) => m.content).join('\n\n'), preamble, hint].filter(Boolean).join('\n\n');
    // Fresh starts replay the entire transcript; cap it to the most recent
    // window that fits so the prompt stays bounded. Bookkeeping (digest, turns)
    // still covers the full transcript, so later continuations keep working.
    const transcript = capTranscript(rest, maxFreshTranscriptChars);
    return {
      continuation: false,
      sessionId: null,
      parentMessageId: null,
      accountId: null,
      prompt: head ? `${head}\n\n${transcript.text}` : transcript.text,
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
        // A DeepSeek chat session belongs to the account that created it. Pin
        // the continuation to that account; if it is cooling, the runner
        // raises account_switched and this request replays fresh instead of
        // sending another account's session id.
        accountId: prev.accountId ?? null,
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
  const guard = createToolGuard({ enabled: toolsActive, emit: writeContent, toolNames, paramToolIndex });
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
      // Hold one of the process-global upstream slots for the whole runner
      // execution; excess concurrent requests queue FIFO until a slot frees.
      withUpstreamSlot(cfg, ctx.direct, () =>
        runner.run(
          {
            prompt: currentPlan.prompt,
            continuation: currentPlan.continuation,
            sessionId: currentPlan.sessionId,
            parentMessageId: currentPlan.parentMessageId,
            accountId: currentPlan.accountId ?? null,
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
        ));

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
      // Persistent empty replies on a long-lived DeepSeek session (rate
      // throttling that outlives the cool-down valve) recover the same way:
      // abandon the bloated session and replay into a fresh one.
      const emptyReply = err?.code === 'empty_reply';
      // A degenerate DSML wall poisons the DeepSeek session: restart from a
      // fresh one even though the wall technically streamed (it was garbage,
      // and the fresh replay carries the real transcript).
      const degenerate = err?.code === 'degenerate_reply';
      // The pinned account became unavailable (cooling/expired) before any
      // network call, so the stored chat_session_id cannot be continued on
      // another account. Replay the whole transcript into a fresh session.
      const accountSwitched = err?.code === 'account_switched';
      if (
        activePlan.continuation &&
        (invalidParent || emptyReply || degenerate || accountSwitched) &&
        (!content && !reasoning || degenerate)
      ) {
        log(
          degenerate
            ? 'degenerate DSML loop; retrying from a fresh session'
            : accountSwitched
              ? 'conversation account is cooling down; retrying from a fresh session'
              : emptyReply
                ? 'persistent empty replies from DeepSeek; retrying from a fresh session'
                : 'saved DeepSeek parent was rejected; retrying from a fresh session',
        );
        store.deleteConversation?.(key);
        // The fresh prompt replays the whole transcript, but `attachments` was
        // collected from the continuation tail only. Resolve what earlier turns
        // contributed, skipping bytes the tail already covered.
        const headAttachments = collectAttachments(rest.slice(0, rest.length - sourceMessages.length));
        if (headAttachments.length) {
          const attKey = (a) => crypto.createHash('sha256').update(a.dataBase64).digest('hex');
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
      ? extractToolCalls(fullContent, { toolNames, paramToolIndex })
      : { calls: [], cleaned: fullContent, hadBlock: false };

    // Degenerate DSML loop: under rate pressure the model can fall into
    // emitting a wall of empty DSML tags (<｜｜DSML｜｜>). The wall is not a
    // usable reply — it poisons the session's context (the model conditions
    // on its own garbage and keeps looping), and auto-Continue would only
    // feed it. Drop the stored session so the client's retry replays into a
    // fresh one, and surface a retriable error.
    const emptyTagWall = (fullContent.match(/<\s*\/?\s*[｜|]+\s*DSML\s*[｜|]+\s*>/gi) || []).length;
    const usableAfterStrip = toolsActive ? toolCalls.cleaned.trim() : '';
    if (emptyTagWall > 30 && toolCalls.calls.length === 0 && !usableAfterStrip) {
      noteUpstreamThrottleEvent();
      // Learned rules: this is a repeatable failure mode, so record it for
      // the next turn's bridge system prompt before failing the request.
      learnRule('degenerate-dsml');
      log(`degenerate DSML loop detected (${emptyTagWall} empty tags); dropping the session`);
      store.deleteConversation?.(key);
      throw new BridgeError(
        'DeepSeek fell into a degenerate loop and produced no usable output.',
        'degenerate_reply',
        502,
      );
    }

    if (toolCalls.calls.length === 0) {
      if (unemitted) {
        const held = toolsActive
          ? extractToolCalls(unemitted, { toolNames, paramToolIndex })
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
        learnRule('tool-markup');
        log(`tool markup without a call stripped (${Math.max(0, fullContent.length - toolCalls.cleaned.length)} chars)`);
      }
    } else {
      content = toolCalls.cleaned;
    }

    if (!content && !reasoning && toolCalls.calls.length === 0) {
      // Conversion can strip everything: a degenerate DSML loop or tool
      // markup without an executable call leaves no content, no reasoning,
      // and no calls. Delivering an empty completion makes harnesses stall
      // silently — surface a retriable error instead (stream clients get an
      // in-stream error event, others a 502 they can retry).
      log(`empty completion after conversion (raw ${fullContent.length}c); failing the request`);
      noteUpstreamThrottleEvent();
      learnRule('empty-reply');
      throw new BridgeError('The model returned no usable output.', 'empty_reply', 502);
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

    const promptTokens = estimateTokens(plan.prompt);
    const runnerCompletion = numericTokens(usage?.completion);
    const completionTokens =
      runnerCompletion ?? Math.max(1, Math.round((content.length + reasoning.length) / 3.6));
    const usageOut = {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    };

    if (sessionId && messageId) {
      // Token accounting is cumulative per conversation and only advances when
      // the runner reported usage for the turn; a turn without usage carries
      // the previous counters forward. Counter carry-over only happens on a
      // true continuation — a fresh session starts from zero.
      const carried = plan.continuation ? prev : null;
      const entry = {
        sessionId,
        parentId: messageId,
        turns: rest.length,
        digest,
        model,
      };
      // DeepSeek chat sessions are account-scoped: remember who owns this one
      // so continuation is pinned to it (or replayed fresh after a rotation).
      if (result.accountId) entry.accountId = result.accountId;
      const firstUser = rest.find((m) => m.role === 'user');
      if (firstUser) entry.preview = String(firstUser.content || '').slice(0, 80);
      if (usage) {
        const runnerCumulative = numericTokens(usage.completion);
        const prevSession = numOr(carried?.sessionTokens, 0);
        entry.tokensIn = numOr(carried?.tokensIn, 0) + promptTokens;
        if (runnerCumulative != null) {
          // Session-true cumulative count reported by the runner: store it
          // directly and grow tokensOut by the per-turn delta so a cumulative
          // counter is never double-counted as per-turn output.
          entry.sessionTokens = runnerCumulative;
          entry.tokensOut = numOr(carried?.tokensOut, 0) + Math.max(0, runnerCumulative - prevSession);
        } else {
          // No cumulative count available: estimate the session total.
          entry.sessionTokens = prevSession + usageOut.total_tokens;
          entry.tokensOut = numOr(carried?.tokensOut, 0) + completionTokens;
        }
      } else {
        // No usage this turn (recovered or extension-mode turn): carry the
        // previous counters forward instead of resetting them.
        entry.tokensIn = numOr(carried?.tokensIn, 0);
        entry.tokensOut = numOr(carried?.tokensOut, 0);
        if (carried?.sessionTokens != null) entry.sessionTokens = carried.sessionTokens;
      }
      store.setConversation(key, entry);
    }

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
        `cont=${plan.continuation} att=${attachments.length} account=${result.accountId ? String(result.accountId).slice(0, 8) : '-'} ` +
        `session=${sessionId || '?'} msg=${messageId || '?'} ` +
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
