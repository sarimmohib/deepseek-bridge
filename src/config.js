import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const CONFIG_DIR =
  process.env.DS_BRIDGE_HOME || path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'deepseek-bridge');

const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const STATE_FILE = path.join(CONFIG_DIR, 'state.json');
const PID_FILE = path.join(CONFIG_DIR, 'bridge.pid');
// Legacy single-session file. New code stores an unbounded pool in
// accounts.json and only reads session.json once, to migrate it.
const SESSION_FILE = path.join(CONFIG_DIR, 'session.json');
const ACCOUNTS_FILE = path.join(CONFIG_DIR, 'accounts.json');
// Model-facing rules (builtin/user/learned) injected into the bridge system
// prompt. Kept beside the config so a backup of the directory carries them.
const RULES_FILE = path.join(CONFIG_DIR, 'rules.json');

function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function normalizeDefaultModel(value) {
  const v = String(value || '').toLowerCase();
  return v === 'deepseek-search' ? 'deepseek-search' : 'deepseek-reasoner';
}

function clampFraction(v, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return dflt;
  return Math.min(1, n);
}

function clampInt(v, dflt, min, max = Number.MAX_SAFE_INTEGER) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

// Windows can reject a rename while another process (antivirus, a reader,
// the previous bridge instance) still holds the target open, and a full or
// read-only volume can fail the write outright. Retry a few times and fall
// back to an in-place write; callers decide whether a hard failure is fatal.
const RENAME_RETRIES = 5;
const RENAME_BACKOFF_MS = 20;

function writeFileAtomic(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, body, { mode: 0o600 });
  let lastErr = null;
  for (let attempt = 0; attempt < RENAME_RETRIES; attempt++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (err) {
      lastErr = err;
      if (!['EPERM', 'EBUSY', 'EACCES', 'EEXIST'].includes(err?.code)) break;
      // Synchronous sleep: this runs inside a timer/request, and the write
      // is tiny, so a short block beats dropping the update.
      const until = Date.now() + RENAME_BACKOFF_MS * (attempt + 1);
      while (Date.now() < until) { /* spin briefly */ }
    }
  }
  // Last resort: write straight to the target. A torn file is recoverable
  // (readJSON falls back to defaults); a killed bridge is not.
  try {
    fs.writeFileSync(file, body, { mode: 0o600 });
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* already gone */
    }
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* already gone */
    }
    throw lastErr || err;
  }
}

function writeJSON(file, value) {
  writeFileAtomic(file, JSON.stringify(value, null, 2) + '\n');
}

export function loadConfig({ persist = true } = {}) {
  const saved = readJSON(CONFIG_FILE, {});
  const cfg = {
    ...saved,
    host: saved.host || '127.0.0.1',
    port: Number(saved.port) || 8787,
    key: saved.key || `sk-ds-${crypto.randomBytes(24).toString('hex')}`,
    defaultModel: normalizeDefaultModel(saved.defaultModel),
    toolMode: saved.toolMode || 'auto', // auto | off
    autoUpdate: saved.autoUpdate !== false,
    lastUpdateCheck: Number(saved.lastUpdateCheck) || 0,
    lastUpdateVersion: saved.lastUpdateVersion || null,
    // Conversation-intelligence knobs.
    contextSwitchAt: clampFraction(saved.contextSwitchAt, 0.8), // fraction of the context window; 0 < v <= 1
    maxFreshTranscriptChars: clampInt(saved.maxFreshTranscriptChars, 200000, 1),
    maxUpstream: clampInt(saved.maxUpstream, 2, 1, 16),
    systemPrompt: typeof saved.systemPrompt === 'string' ? saved.systemPrompt : '',
    // dsh-agent is the default because DeepSeek Harness is the supported
    // harness; an explicit systemPrompt still wins over any preset.
    // Empty means unset so an existing config picks up the dsh-agent default
    // after upgrading; an explicit 'none' still disables the preset.
    systemPreset:
      typeof saved.systemPreset === 'string' && saved.systemPreset.trim()
        ? saved.systemPreset.trim()
        : 'dsh-agent',
    systemRules: saved.systemRules !== false,
  };
  if (persist && (!saved.key || saved.defaultModel !== cfg.defaultModel)) {
    try {
      writeJSON(CONFIG_FILE, cfg);
    } catch {
      // Read-only config dir must not crash every CLI invocation.
      if (!saved.key) {
        console.error(`Warning: config directory ${CONFIG_DIR} is not writable; the generated API key is temporary and will change between runs.`);
      }
    }
  }
  return cfg;
}

export function saveConfig(patch) {
  const cfg = { ...loadConfig(), ...patch };
  writeJSON(CONFIG_FILE, cfg);
  return cfg;
}

export class Store {
  constructor(file = STATE_FILE) {
    this.file = file;
    this.data = readJSON(file, { conversations: {} });
    if (!this.data.conversations) this.data.conversations = {};
    this.dirty = false;
  }

  getConversation(key) {
    return this.data.conversations[key] || null;
  }

  setConversation(key, value) {
    this.data.conversations[key] = { ...value, updatedAt: Date.now() };
    this.dirty = true;
    this.#trim();
  }

  deleteConversation(key) {
    delete this.data.conversations[key];
    this.dirty = true;
  }

  #trim() {
    const entries = Object.entries(this.data.conversations);
    const MAX = 200;
    if (entries.length <= MAX) return;
    entries.sort((a, b) => (a[1].updatedAt || 0) - (b[1].updatedAt || 0));
    for (const [key] of entries.slice(0, entries.length - MAX)) delete this.data.conversations[key];
  }

  // Returns true when the flush landed. A failed write keeps the store
  // dirty so the next autosave retries it, and never throws: this runs from
  // a timer, where an exception would terminate the whole bridge.
  flush() {
    if (!this.dirty) return true;
    try {
      writeJSON(this.file, this.data);
      this.dirty = false;
      this.lastFlushError = null;
      return true;
    } catch (err) {
      this.lastFlushError = err?.message || String(err);
      try {
        this.onFlushError?.(err);
      } catch {
        // A broken observer must not escalate a handled failure into a crash.
      }
      return false;
    }
  }

  startAutosave(intervalMs = 2000) {
    // flush() never throws, but keep the timer callback guarded anyway: an
    // exception escaping a timer callback is an uncaught exception and kills
    // the process (ERR_SOCKET_BAD_PORT-style crashes are not the only way a
    // long-running daemon dies).
    const timer = setInterval(() => {
      try {
        this.flush();
      } catch {
        /* flush already records lastFlushError */
      }
    }, intervalMs);
    timer.unref?.();
    // Exit and signal handlers run in a fragile state: the process is going
    // down and a file may be locked. They must never throw.
    const flushNow = () => {
      try {
        return this.flush();
      } catch {
        return false;
      }
    };
    process.on('exit', flushNow);
    process.on('SIGINT', () => {
      flushNow();
      process.exit(0);
    });
    return timer;
  }
}

export const paths = { CONFIG_DIR, CONFIG_FILE, STATE_FILE, PID_FILE, SESSION_FILE, ACCOUNTS_FILE, RULES_FILE };
