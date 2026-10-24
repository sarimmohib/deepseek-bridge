/*
 * Zero-dependency ANSI dashboard: `deepseek ui`.
 *
 * Everything on screen is built by pure functions (renderModels,
 * renderConversations, renderHealthPanel, renderLogPanel, buildFrame) so the
 * layout is unit-testable; runTui() only wires stdin/stdout, timers and
 * fetches around them. No npm packages — raw ANSI escape sequences only.
 *
 * Alternate screen: enter with \x1b[?1049h, leave with \x1b[?1049l. Cleanup is
 * idempotent and runs in a finally block plus on SIGINT so the terminal is
 * always restored. Non-TTY stdin (CI, pipes) prints one static frame and
 * exits 0 — it never hangs and never enters raw mode.
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, paths } from './config.js';
import { MODELS } from './openai.js';
import { VERSION } from './version.js';

const ENTER_ALT = '\x1b[?1049h';
const EXIT_ALT = '\x1b[?1049l';
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';
const CLEAR = '\x1b[H\x1b[2J';

const PREVIEW_WIDTH = 48;
const PANEL_COUNT = 4; // 1 models · 2 conversations · 3 health · 4 log

/** Display names used by the OpenCode provider snippet (mirrors opencode.jsonc). */
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

async function fetchJson(url, timeout = 1500, headers = undefined) {
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeout) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Fetch health + status + conversations with short timeouts. Each part fails
 * soft (null) so a half-updated bridge (no /v1/bridge/conversations route, no
 * upstream in /health) still renders.
 */
export async function fetchBridgeState(cfg, { timeout = 1500 } = {}) {
  const base = `http://127.0.0.1:${cfg?.port ?? 8787}`;
  const headers = { authorization: `Bearer ${cfg?.key ?? ''}` };
  const [health, status, convRes] = await Promise.all([
    fetchJson(`${base}/health`, timeout),
    fetchJson(`${base}/v1/bridge/status`, timeout, headers),
    fetchJson(`${base}/v1/bridge/conversations`, timeout, headers),
  ]);
  return {
    health,
    status,
    conversations: Array.isArray(convRes?.conversations) ? convRes.conversations : null,
    upstream: convRes?.upstream ?? status?.upstream ?? health?.upstream ?? null,
  };
}

/** Fallback when the bridge is down: read state.json straight from disk. */
export function conversationsFromStateFile(stateFile = paths.STATE_FILE) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch {
    return null;
  }
  const convs = data?.conversations;
  if (!convs || typeof convs !== 'object') return [];
  return Object.entries(convs)
    .map(([key, v]) => {
      const item = {
        key,
        model: v?.model,
        turns: v?.turns,
        tokensIn: v?.tokensIn,
        tokensOut: v?.tokensOut,
        updatedAt: v?.updatedAt,
      };
      if (Number.isFinite(v?.sessionTokens)) item.sessionTokens = v.sessionTokens;
      if (typeof v?.preview === 'string') item.preview = v.preview;
      return item;
    })
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .slice(0, 100);
}

/** Last `count` lines of the bridge log, or [] when there is none yet. */
export function readLogTail(count = 8, logFile = path.join(paths.CONFIG_DIR, 'bridge.log')) {
  try {
    const text = fs.readFileSync(logFile, 'utf8');
    return text.replace(/\n+$/, '').split('\n').slice(-count);
  } catch {
    return [];
  }
}

/** Everything one frame needs; never throws. */
async function collectState(cfg, { timeout = 1200 } = {}) {
  const remote = await fetchBridgeState(cfg, { timeout });
  let conversations = remote.conversations;
  let convSource = null;
  if (conversations) {
    convSource = 'api';
  } else {
    conversations = conversationsFromStateFile();
    convSource = conversations ? 'file' : null;
    if (!conversations) conversations = [];
  }
  return {
    health: remote.health,
    status: remote.status,
    conversations,
    convSource,
    upstream: remote.upstream,
    logLines: readLogTail(),
  };
}

// ---------------------------------------------------------------- loop

function attachEpipeGuard(stream) {
  if (!stream || typeof stream.once !== 'function') return;
  stream.once('error', (err) => {
    if (err?.code === 'EPIPE') process.exit(0); // `deepseek ui | head` closed the pipe
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * TUI main entry (`deepseek ui`). Non-TTY stdin or stdout prints one static
 * frame and returns; a real terminal gets the alternate-screen dashboard.
 */
export async function runTui({ stdin = process.stdin, stdout = process.stdout } = {}) {
  const cfg = loadConfig();
  const width = Number(stdout?.columns) > 0 ? stdout.columns : 100;

  if (!stdin.isTTY || !stdout?.isTTY) {
    attachEpipeGuard(stdout);
    const data = await collectState(cfg, { timeout: 1200 });
    const frame = buildFrame({ ...data, cfg, focus: -1 }, width);
    stdout.write(`${frame}\n`);
    return;
  }

  const state = {
    focus: 0,
    health: null,
    status: null,
    conversations: null,
    convSource: null,
    upstream: null,
    logLines: readLogTail(),
    quit: false,
  };

  const draw = () => {
    try {
      stdout.write(CLEAR + buildFrame({ ...state, cfg }, width));
    } catch {
      /* stdout closed — the next keypress or timer cleans up */
    }
  };

  const refreshState = async () => {
    const remote = await fetchBridgeState(cfg, { timeout: 1500 });
    state.status = remote.status;
    if (remote.upstream) state.upstream = remote.upstream;
    state.convSource = remote.conversations ? 'api' : 'file';
    state.conversations = remote.conversations ?? conversationsFromStateFile() ?? [];
    state.logLines = readLogTail();
  };

  const refreshHealth = async () => {
    const health = await fetchJson(`http://127.0.0.1:${cfg.port}/health`, 1500);
    if (health) state.health = health;
    if (health?.upstream) state.upstream = health.upstream;
  };

  const onKey = (chunk) => {
    const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    if (text.includes('\x1b')) return; // arrow keys and other escape sequences
    for (const char of text) {
      if (char === 'q' || char === 'Q' || char === '\u0003' || char === '\u0004') {
        state.quit = true;
        return;
      }
      if (char >= '1' && char <= String(PANEL_COUNT)) {
        state.focus = Number(char) - 1;
        draw();
      } else if (char === '\t') {
        state.focus = (state.focus + 1) % PANEL_COUNT;
        draw();
      } else if (char === 'r' || char === 'R') {
        void refreshState().then(draw).catch(() => {});
        void refreshHealth().then(draw).catch(() => {});
      }
    }
  };

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    try {
      stdout.write(SHOW_CURSOR + EXIT_ALT);
    } catch {
      /* stdout is gone */
    }
    try {
      stdin.setRawMode(false);
    } catch {
      /* not a TTY anymore */
    }
    try {
      stdin.removeListener('data', onKey);
      stdin.pause();
    } catch {
      /* ignore */
    }
    try {
      process.removeListener('SIGINT', onSigint);
    } catch {
      /* ignore */
    }
  };

  const onSigint = () => {
    cleanup();
    process.exit(130);
  };

  attachEpipeGuard(stdout);

  try {
    stdout.write(ENTER_ALT + HIDE_CURSOR);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onKey);
    process.on('SIGINT', onSigint);
    draw(); // show the skeleton immediately, then fill it in
    await Promise.all([refreshState(), refreshHealth()]);
    draw();

    const stateTimer = setInterval(() => {
      void refreshState().then(draw).catch(() => {});
    }, 2000); // conversations/state
    const healthTimer = setInterval(() => {
      void refreshHealth().then(draw).catch(() => {});
    }, 5000); // health
    stateTimer.unref?.();
    healthTimer.unref?.();

    while (!state.quit) await sleep(100);
  } finally {
    cleanup();
  }
}
