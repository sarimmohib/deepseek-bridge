/*
 * Model catalog helpers: `deepseek models` / `deepseek models --info`.
 *
 * modelSummaryLines/modelDetailLines render the CLI table; the snippet
 * builders produce pasteable harness config that mirrors the working
 * ~/.config/opencode/opencode.jsonc entry (same key order and shape).
 * No npm packages.
 */
import { MODELS } from './openai.js';

const OPENCODE_MODEL_NAMES = {
  'deepseek-reasoner': 'DeepSeek V4.1 Flash Reasoner (web)',
  'deepseek-search': 'DeepSeek V4.1 Flash Search (web)',
};

// ---------------------------------------------------------------- helpers

function dim(text) {
  return `\x1b[2m${text}\x1b[0m`;
}

function strong(text) {
  return `\x1b[1m${text}\x1b[0m`;
}

function panelTitle(text, focused) {
  return focused ? `\x1b[7m ${text} \x1b[0m` : strong(text);
}

/** Remove ANSI escape sequences (CSI, OSC, and lone ESC bytes). */
export function stripAnsi(value) {
  return String(value ?? '').replace(
    // eslint-disable-next-line no-control-regex
    /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-PRZcf-nqry><~]/g,
    '',
  );
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/** Truncate to n characters with a trailing ellipsis (empty for empty input). */
export function truncate(value, n) {
  const text = String(value ?? '');
  const limit = Number(n);
  if (!Number.isFinite(limit) || limit < 1) return '';
  if (text.length <= limit) return text;
  return limit === 1 ? text.slice(0, 1) : `${text.slice(0, limit - 1)}…`;
}

/** Format a number with thousands separators, or '-' when absent/invalid. */
export function formatNumber(value) {
  if (value === null || value === undefined || value === '') return '-';
  const n = Number(value);
  if (!Number.isFinite(n)) return '-';
  return n.toLocaleString('en-US');
}

/** '-'/0/1s/59s/1m/59m/1h/47h/2d — never throws on junk input. */
export function formatAge(updatedAt, now = Date.now()) {
  let t = Number(updatedAt);
  if ((!Number.isFinite(t) || t <= 0) && typeof updatedAt === 'string' && updatedAt) {
    const parsed = Date.parse(updatedAt);
    if (Number.isFinite(parsed)) t = parsed;
  }
  if (!Number.isFinite(t) || t <= 0) return '-';
  const seconds = Math.max(0, Math.floor((now - t) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** First 8 characters of a conversation key, or '-'. */
export function shortKey(key) {
  const text = String(key ?? '');
  return text ? text.slice(0, 8) : '-';
}

// ------------------------------------------------------- models (pure)

/**
 * One concise line per model. The default model gets a '*' marker.
 * Width < 60 drops the description so the line always fits.
 */
export function modelSummaryLines({ models = MODELS, defaultModel = null, width = 100 } = {}) {
  const list = Array.isArray(models) ? models : [];
  const narrow = width < 60;
  const idCol = clamp(Math.max(4, ...list.map((m) => String(m?.id ?? '').length)), 4, 28);
  return list.map((m) => {
    const marker = m?.id === defaultModel ? '*' : ' ';
    const id = truncate(String(m?.id ?? '-'), idCol).padEnd(idCol);
    const ctx = formatNumber(m?.context_window);
    const out = formatNumber(m?.max_output_tokens);
    if (narrow) return `${marker} ${id} ctx ${ctx} out ${out}`;
    const desc = truncate(String(m?.description ?? ''), Math.max(10, width - idCol - 30));
    return `${marker} ${id}  ctx ${String(ctx).padStart(8)}  out ${String(out).padStart(8)}  ${desc}`;
  });
}

/** Full detail block for `deepseek models --info` (indented, one model). */
export function modelDetailLines(model, { isDefault = false } = {}) {
  return [
    `${isDefault ? '*' : ' '} ${String(model?.id ?? '-')}${isDefault ? '  (default)' : ''}`,
    `    description        ${model?.description ?? '-'}`,
    `    context_window     ${formatNumber(model?.context_window)}`,
    `    max_output_tokens  ${formatNumber(model?.max_output_tokens)}`,
  ];
}

/** MODELS panel. */
export function renderModels({ models = MODELS, defaultModel = null, width = 100, focused = false } = {}) {
  const lines = [panelTitle('[1] MODELS', focused)];
  const inner = Math.max(20, width - 2);
  for (const line of modelSummaryLines({ models, defaultModel, width: inner })) {
    lines.push(`  ${line}`);
  }
  lines.push(dim('  (* = default)'));
  return lines.map((line) => truncate(line, width)).join('\n');
}

// ------------------------------------------------ conversations (pure)

function field(value) {
  if (value === null || value === undefined || value === '') return '-';
  return String(value);
}

/**
 * CONVERSATIONS panel. Rows are rendered defensively: any missing field
 * (legacy state.json entries, partial API payloads) becomes '-' and nothing
 * here can throw on odd shapes. `source` is 'api' | 'file' | null.
 */
export function renderConversations({ conversations, width = 100, now = Date.now(), focused = false, source = null } = {}) {
  const title = '[2] CONVERSATIONS' + (source === 'file' ? ' (from state.json)' : '');
  const lines = [panelTitle(title, focused)];
  const list = Array.isArray(conversations) ? conversations : [];
  if (!list.length) {
    lines.push(dim('  (no conversations yet)'));
    return lines.map((line) => truncate(line, width)).join('\n');
  }

    if (width < 60) {
      lines.push(dim('  KEY      TURNS  AGE'));
      for (const c of list) {
        const row =
          `  ${shortKey(c?.key).padEnd(8)} ` +
          `${field(c?.turns).padStart(5)}  ${formatAge(c?.updatedAt, now).padEnd(4)}`;
        lines.push(truncate(row, width).trimEnd());
      }
      return lines.join('\n');
    }

  const modelCol = clamp(Math.max(5, ...list.map((c) => String(c?.model ?? '').length)), 5, 22);
  // Fixed prefix: indent + key + model + turns + in + out + session + age + separators.
  const prefixLen = 2 + 8 + 2 + modelCol + 2 + 5 + 2 + 9 + 2 + 9 + 2 + 9 + 2 + 4 + 2;
  // The preview absorbs whatever width is left, capped at ~48 chars, so rows
  // never overflow the terminal even when token columns grow past their pads.
  const previewWidth = clamp(width - prefixLen, 8, PREVIEW_WIDTH);
  const header =
    `  ${'KEY'.padEnd(8)}  ${'MODEL'.padEnd(modelCol)}  ${'TURNS'.padStart(5)}  ` +
    `${'IN'.padStart(9)}  ${'OUT'.padStart(9)}  ${'SESSION'.padStart(9)}  ${'AGE'.padEnd(4)}  PREVIEW`;
  lines.push(dim(header));
  for (const c of list) {
    const row =
      `  ${shortKey(c?.key).padEnd(8)}  ` +
      `${truncate(String(c?.model ?? '-'), modelCol).padEnd(modelCol)}  ` +
      `${field(c?.turns).padStart(5)}  ` +
      `${formatNumber(c?.tokensIn).padStart(9)}  ` +
      `${formatNumber(c?.tokensOut).padStart(9)}  ` +
      `${formatNumber(c?.sessionTokens).padStart(9)}  ` +
      `${formatAge(c?.updatedAt, now).padEnd(4)}  ` +
      truncate(String(c?.preview ?? ''), previewWidth);
    lines.push(truncate(row, width).trimEnd());
  }
  return lines.join('\n');
}

// ----------------------------------------------------- health/log (pure)

/** Header strip: version, mode, base URL, upstream counts. */
export function renderHeader({ version = VERSION, cfg, health = null, status = null, upstream = null, width = 100 } = {}) {
  const mode = health?.mode ?? status?.mode ?? 'down';
  const up = upstream ?? health?.upstream ?? status?.upstream ?? null;
  const upText = up
    ? `${field(up.active)}/${field(up.max)} active · ${field(up.queued)} queued`
    : 'n/a (older bridge)';
  const base = `http://127.0.0.1:${cfg?.port ?? 8787}/v1`;
  return strong(truncate(`deepseek-bridge v${version} · ${mode} · ${base} · upstream ${upText}`, width));
}

/** HEALTH panel: bridge up/down, port, mode, upstream counts, session age. */
export function renderHealthPanel({ health = null, status = null, port = null, upstream = null, width = 100, focused = false } = {}) {
  const lines = [panelTitle('[3] HEALTH', focused)];
  const up = Boolean(health?.ok);
  const mode = health?.mode ?? status?.mode ?? null;
  const upCounts = upstream ?? health?.upstream ?? status?.upstream ?? null;

  if (width < 60) {
    const bits = [`bridge ${up ? 'up' : 'DOWN'}`, `port ${field(port)}`];
    if (mode) bits.push(`mode ${mode}`);
    if (upCounts) bits.push(`up ${field(upCounts.active)}/${field(upCounts.max)} q${field(upCounts.queued)}`);
    lines.push(`  ${bits.join(' · ')}`);
    return lines.map((line) => truncate(line, width)).join('\n');
  }

  lines.push(`  bridge    ${up ? 'up' : 'DOWN'}`);
  lines.push(`  port      ${field(port)}`);
  lines.push(`  mode      ${mode ?? '-'}`);
  lines.push(
    `  upstream  active ${field(upCounts?.active)} · queued ${field(upCounts?.queued)} · max ${field(upCounts?.max)}`,
  );
  const direct = status?.direct;
  if (direct && typeof direct === 'object') {
    const savedAt = direct.savedAt || direct.updatedAt;
    const who = direct.user ? `${direct.user} · ` : '';
    if (direct.available) lines.push(`  session   ${who}age ${formatAge(savedAt)}`);
    else lines.push('  session   not configured');
  }
  return lines.map((line) => truncate(line, width)).join('\n');
}

/** LOG panel: last `count` lines of bridge.log. */
export function renderLogPanel({ lines = null, width = 100, focused = false, count = 8 } = {}) {
  const out = [panelTitle('[4] LOG (bridge.log tail)', focused)];
  const list = Array.isArray(lines) && lines.length ? lines.slice(-count) : [];
  if (!list.length) out.push(dim('  (no log yet)'));
  for (const line of list) out.push(`  ${truncate(line, Math.max(10, width - 2))}`);
  return out.map((line) => truncate(line, width)).join('\n');
}

/**
 * Compose one full frame. `focus` is 0-3, or -1 for no highlight (static
 * frames). Width < 60 switches every panel to a single-column layout.
 */
export function buildFrame(data = {}, width = 100, now = Date.now()) {
  const { cfg, health, status, conversations, convSource, upstream, logLines, focus = -1 } = data;
  const narrow = width < 60;
  const parts = [
    renderHeader({ cfg, health, status, upstream, width }),
    renderModels({ models: MODELS, defaultModel: cfg?.defaultModel, width, focused: focus === 0 }),
    renderConversations({ conversations, width, now, focused: focus === 1, source: convSource }),
    renderHealthPanel({ health, status, port: cfg?.port, upstream, width, focused: focus === 2 }),
    renderLogPanel({ lines: logLines, width, focused: focus === 3, count: narrow ? 5 : 8 }),
  ];
  parts.push(
    dim(narrow ? '1-4/Tab focus · r refresh · q quit' : 'keys: 1-4/Tab switch focus · r refresh · q/Ctrl+C quit'),
  );
  return parts.join('\n');
}

// ------------------------------------------------------------ snippets

/**
 * OpenCode provider snippet mirroring the "deepseek-bridge" entry in
 * ~/.config/opencode/opencode.jsonc exactly (same key order and shape).
 * Returns a JSON string. `apiKey` defaults to the {file:...} reference the
 * existing entry uses; pass a key to inline it.
 */
export function opencodeProviderSnippet({ models = MODELS, port = 8787, apiKey = null } = {}) {
  const provider = {
    name: 'DeepSeek Bridge',
    package: '@opencode/ai/providers/openai-compatible',
    settings: {
      baseURL: `http://127.0.0.1:${port}/v1`,
      apiKey: apiKey || '{file:~/.config/deepseek-bridge/opencode.key}',
    },
    compatibility: {
      reasoningField: 'reasoning_content',
    },
    models: {},
  };
  for (const m of Array.isArray(models) ? models : []) {
    provider.models[String(m?.id ?? '')] = {
      name: OPENCODE_MODEL_NAMES[m?.id] || String(m?.id ?? ''),
      family: 'deepseek',
      capabilities: {
        tools: true,
        input: ['text', 'image'],
        output: ['text'],
        reasoning: {
          supported: true,
          effort: ['low', 'high', 'max'],
        },
      },
      limit: {
        context: Number.isFinite(Number(m?.context_window)) ? Number(m.context_window) : 890880,
        output: Number.isFinite(Number(m?.max_output_tokens)) ? Number(m.max_output_tokens) : 131072,
      },
    };
  }
  return JSON.stringify({ 'deepseek-bridge': provider }, null, 2);
}

/**
 * Generic OpenAI-compatible harness config as a JSON string — the three env
 * vars any OpenAI client needs against the bridge.
 */
export function openaiEnvSnippet({ apiKey = '', port = 8787, model = 'deepseek-reasoner' } = {}) {
  return JSON.stringify(
    {
      OPENAI_BASE_URL: `http://127.0.0.1:${port}/v1`,
      OPENAI_API_KEY: String(apiKey ?? ''),
      OPENAI_MODEL: String(model ?? 'deepseek-reasoner'),
    },
    null,
    2,
  );
}

// --------------------------------------------------------- data access
