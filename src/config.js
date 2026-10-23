import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const CONFIG_DIR =
  process.env.DS_BRIDGE_HOME || path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'deepseek-bridge');

const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const STATE_FILE = path.join(CONFIG_DIR, 'state.json');
const PID_FILE = path.join(CONFIG_DIR, 'bridge.pid');
const SESSION_FILE = path.join(CONFIG_DIR, 'session.json');

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

function writeJSON(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function loadConfig() {
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
  };
  if (!saved.key || saved.defaultModel !== cfg.defaultModel) {
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

  flush() {
    if (!this.dirty) return;
    writeJSON(this.file, this.data);
    this.dirty = false;
  }

  startAutosave(intervalMs = 2000) {
    const timer = setInterval(() => this.flush(), intervalMs);
    timer.unref?.();
    const flushNow = () => this.flush();
    process.on('exit', flushNow);
    process.on('SIGINT', () => {
      flushNow();
      process.exit(0);
    });
    return timer;
  }
}

export const paths = { CONFIG_DIR, CONFIG_FILE, STATE_FILE, PID_FILE, SESSION_FILE };
