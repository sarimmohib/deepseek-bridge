/*
 * Terminal presentation for the bridge.
 *
 * Everything here is pure string building so the start screen can be tested
 * without a TTY: `renderStartup()` returns the exact text, `printStartup()`
 * writes it. Colour is decided by the caller (`supportsColor`), and every
 * width-sensitive line is clamped to the requested width so a narrow terminal
 * degrades to truncation instead of wrapping into noise.
 */
import os from 'node:os';

const ESC = '\u001b[';
const ANSI = {
  reset: `${ESC}0m`,
  bold: `${ESC}1m`,
  dim: `${ESC}2m`,
  red: `${ESC}31m`,
  green: `${ESC}32m`,
  yellow: `${ESC}33m`,
  blue: `${ESC}34m`,
  magenta: `${ESC}35m`,
  cyan: `${ESC}36m`,
  gray: `${ESC}90m`,
  brightGreen: `${ESC}92m`,
  brightCyan: `${ESC}96m`,
};

const ANSI_RE = /\u001b\[[0-9;]*m/g;

export function stripAnsi(text) {
  return String(text).replace(ANSI_RE, '');
}

export function visibleLength(text) {
  return stripAnsi(text).length;
}

/** True when stdout can render colour and the user has not opted out. */
export function supportsColor(stream = process.stdout, env = process.env) {
  if (env.NO_COLOR || env.TERM === 'dumb') return false;
  if (env.FORCE_COLOR && env.FORCE_COLOR !== '0') return true;
  return Boolean(stream && stream.isTTY);
}

export function createStyle({ color = supportsColor(), ascii = false } = {}) {
  const paint = (text, ...names) => {
    const value = String(text);
    if (!color) return value;
    const codes = names.map((name) => ANSI[name]).filter(Boolean).join('');
    return codes ? `${codes}${value}${ANSI.reset}` : value;
  };
  return {
    color,
    ascii,
    paint,
    bold: (text) => paint(text, 'bold'),
    dim: (text) => paint(text, 'dim'),
    red: (text) => paint(text, 'red'),
    green: (text) => paint(text, 'green'),
    yellow: (text) => paint(text, 'yellow'),
    cyan: (text) => paint(text, 'cyan'),
    gray: (text) => paint(text, 'gray'),
    brightGreen: (text) => paint(text, 'brightGreen'),
    brightCyan: (text) => paint(text, 'brightCyan'),
  };
}

const ASCII_BOX = {
  tl: '+', tr: '+', bl: '+', br: '+', h: '-', v: '|',
  dot: '*', ring: 'o', cross: 'x', arrow: '->',
};
const UNICODE_BOX = {
  tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│',
  dot: '●', ring: '◐', cross: '✕', arrow: '→',
};

export function boxChars(ascii = false) {
  return ascii ? ASCII_BOX : UNICODE_BOX;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/** Truncate to `max` visible characters, adding an ellipsis when cut. */
export function truncate(text, max) {
  const value = String(text);
  if (max <= 0) return '';
  if (visibleLength(value) <= max) return value;

  // Walk visible characters but copy escape sequences whole: slicing a raw
  // ANSI string at a fixed offset can cut `\x1b[32m` in half and leak a broken
  // colour sequence into the terminal.
  const budget = max <= 1 ? max : max - 1;
  let out = '';
  let visible = 0;
  let index = 0;
  let sawAnsi = false;
  while (index < value.length && visible < budget) {
    if (value[index] === '\u001b') {
      const match = /^\u001b\[[0-9;]*m/.exec(value.slice(index));
      if (match) {
        out += match[0];
        index += match[0].length;
        sawAnsi = true;
        continue;
      }
    }
    out += value[index];
    index++;
    visible++;
  }
  return `${out}${max <= 1 ? '' : '…'}${sawAnsi ? ANSI.reset : ''}`;
}

function padVisible(text, width) {
  const length = visibleLength(text);
  return length >= width ? text : text + ' '.repeat(width - length);
}

export function formatTokens(n) {
  const value = Number(n) || 0;
  return value.toLocaleString('en-US');
}

export function shortId(id) {
  const text = String(id || '');
  return text.length <= 8 ? text : text.slice(0, 8);
}

export function fmtAge(timestamp, now = Date.now()) {
  const at = Number(timestamp) || 0;
  if (!at) return 'never';
  const ms = Math.max(0, now - at);
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/**
 * The bridge has three useful token states for a human looking at the start
 * screen: working (ready), cooling (temporary upstream throttle) and expired
 * (the login itself is dead — `not_signed_in`). Anything else is treated as
 * working because it can still be tried.
 */
export function tokenState(account) {
  if (!account) return 'expired';
  if (account.lastError?.code === 'not_signed_in') return 'expired';
  if (account.cooling) return 'cooling';
  return 'working';
}

export function groupAccounts(accounts = []) {
  const groups = { working: [], cooling: [], expired: [] };
  for (const account of accounts) groups[tokenState(account)].push(account);
  return groups;
}

function accountLine(account, style, box, width) {
  const state = tokenState(account);
  const mark = state === 'working'
    ? style.green(box.dot)
    : state === 'cooling'
      ? style.yellow(box.ring)
      : style.red(box.cross);
  const id = shortId(account.id);
  const labelText = account.label || account.user || '';
  const label = labelText && labelText !== id && labelText !== account.id ? labelText : '(no label)';
  const ok = Number(account.successCount) || 0;
  const fail = Number(account.failureCount) || 0;
  const last = account.lastUsedAt ? fmtAge(account.lastUsedAt) : 'never used';
  const body = `${mark} ${style.bold(id.padEnd(8))} ${label.padEnd(14)} ${state.padEnd(8)} ${String(ok).padStart(3)} ok · ${String(fail).padStart(2)} fail · ${last}`;
  return `    ${truncate(body, width - 4)}`;
}

function section(title, style) {
  return `  ${style.bold(style.cyan(title.toUpperCase()))}`;
}

function row(label, value, style, width, indent = 4) {
  const labelWidth = 13;
  const text = `${' '.repeat(indent)}${style.dim(label.padEnd(labelWidth))}${value}`;
  return truncate(text, width);
}

function headerBlock({ version, health, cfg, started }, style, box, width) {
  const inner = width - 4;
  const title = `${style.bold('DEEPSEEK BRIDGE')} ${style.dim(`v${version}`)}`;
  const online = Boolean(health?.ok);
  const badge = online
    ? style.brightGreen(`${box.dot} ONLINE`)
    : style.red(`${box.cross} OFFLINE`);
  const badgeWidth = visibleLength(badge);
  const titleWidth = visibleLength(title);
  const hostRoom = inner - titleWidth - badgeWidth - 2;
  const hostText = hostRoom < `${cfg.host}:${cfg.port}`.length
    ? truncate(`${cfg.host}:${cfg.port}`, Math.max(4, hostRoom))
    : `${cfg.host}:${cfg.port}`;
  const right = `${badge} ${style.dim(hostText)}`;
  const gap = Math.max(0, inner - titleWidth - visibleLength(right));
  const content = `${title}${' '.repeat(gap)}${right}`;
  const top = `${box.tl}${box.h.repeat(width - 2)}${box.tr}`;
  const mid = `${box.v} ${padVisible(content, inner)} ${box.v}`;
  const bottom = `${box.bl}${box.h.repeat(width - 2)}${box.br}`;
  const sub = started ? `  ${style.dim('started in the background')}` : '';
  return [top, mid, bottom, ...(sub ? [sub] : [])];
}

function endpointLines(data, style, box, width) {
  const { cfg, network = {} } = data;
  const lines = [];
  const base = `http://127.0.0.1:${cfg.port}/v1`;
  lines.push(row('OpenAI', base, style, width));
  lines.push(row('Dashboard', `http://127.0.0.1:${cfg.port}/`, style, width));
  const lan = (network.lan || [])[0];
  lines.push(row('LAN', lan ? `http://${lan}:${cfg.port}/v1` : style.dim('loopback only'), style, width));
  const tail = network.tailscale || {};
  if (tail.dnsName) {
    const online = tail.online === false ? style.dim(' (offline)') : '';
    lines.push(row('Tailscale', `http://${tail.dnsName}:${cfg.port}/v1${online}`, style, width));
  } else if (tail.installed) {
    lines.push(row('Tailscale', style.dim('installed, not connected — run `tailscale up`'), style, width));
  } else {
    lines.push(row('Tailscale', style.dim('not installed — `deepseek install`'), style, width));
  }
  return lines;
}

function modelLines(data, style, width) {
  const models = data.models || [];
  if (!models.length) return [`    ${style.dim('no models advertised')}`];
  return models.map((model) => {
    const ctx = `${formatTokens(model.context_window)} ctx`;
    const text = `    ${style.bold(model.id.padEnd(20))}${style.dim(ctx.padEnd(14))}${truncate(model.description || '', width - 40)}`;
    return truncate(text, width);
  });
}

function toolLine(data, style, width) {
  const parts = (data.tools || []).map((tool) => {
    if (!tool.found) return style.dim(`${tool.id} missing`);
    return `${tool.id} ${tool.version || 'installed'}`;
  });
  const autostart = data.autostart?.enabled
    ? style.green(`autostart ${data.autostart.kind || 'on'}`)
    : style.dim('autostart off');
  parts.push(autostart);
  return truncate(`    ${parts.join(style.dim(' · '))}`, width);
}

/**
 * Build the whole start/status screen. Returns a string with a trailing
 * newline so callers can `process.stdout.write()` it directly.
 */
export function renderStartup(data, options = {}) {
  const style = options.style || createStyle(options);
  const box = boxChars(style.ascii);
  const width = clamp(Number(options.width || process.stdout.columns || 92), 60, 100);
  const cfg = data.cfg || { host: '127.0.0.1', port: 8787, key: '' };
  const accounts = data.accounts || { count: 0, ready: 0, cooling: 0, accounts: [] };
  const groups = groupAccounts(accounts.accounts || []);
  const out = [];

  out.push('');
  out.push(...headerBlock({ ...data, cfg }, style, box, width));
  out.push('');

  out.push(section('Endpoints', style));
  out.push(...endpointLines(data, style, box, width));
  out.push('');

  out.push(section('Models', style));
  out.push(...modelLines(data, style, width));
  out.push('');

  out.push(section('API key', style));
  out.push(`    ${style.bold(truncate(cfg.key || '(no key yet)', width - 4))}`);
  out.push(truncate(`    ${style.dim('copy it with `deepseek key` · clients send it as Authorization: Bearer <key>')}`, width));
  out.push('');

  out.push(section(`Tokens — ${groups.working.length} working · ${groups.cooling.length} cooling · ${groups.expired.length} expired`, style));
  if (!accounts.count) {
    out.push(`    ${style.dim('no tokens yet — add one with `deepseek --login`')}`);
  } else {
    const visible = [...groups.working, ...groups.cooling, ...groups.expired];
    const limit = 8;
    for (const account of visible.slice(0, limit)) {
      out.push(accountLine(account, style, box, width));
    }
    if (visible.length > limit) {
      out.push(truncate(`    ${style.dim(`+ ${visible.length - limit} more — run \`deepseek accounts\``)}`, width));
    }
    const dead = groups.expired.length;
    if (dead) {
      out.push(truncate(`    ${style.yellow(`${dead} token${dead === 1 ? '' : 's'} need a fresh login — open the pool in the app or run \`deepseek --login\``)}`, width));
    }
  }
  out.push('');

  out.push(section('Tools', style));
  out.push(toolLine(data, style, width));
  out.push('');

  out.push(section('Next', style));
  const next = [
    'deepseek accounts',
    'deepseek install',
    'deepseek ui',
    'deepseek logs',
    'deepseek stop',
  ].map((cmd) => style.cyan(cmd)).join(style.dim(' · '));
  out.push(truncate(`    ${next}`, width));
  out.push('');

  return `${out.join('\n')}\n`;
}

export function printStartup(data, options = {}) {
  process.stdout.write(renderStartup(data, options));
}

/** Collect the URLs the start screen and the installer both advertise. */
export function collectNetworkInfo({ interfaces = os.networkInterfaces(), tailscale = null } = {}) {
  const lan = [];
  for (const [name, addresses] of Object.entries(interfaces || {})) {
    for (const address of addresses || []) {
      if (address.family !== 'IPv4' && address.family !== 4) continue;
      if (address.internal) continue;
      if (name.toLowerCase().includes('tailscale')) continue;
      if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(address.address)) continue;
      lan.push(address.address);
    }
  }
  return { lan: [...new Set(lan)], tailscale };
}
