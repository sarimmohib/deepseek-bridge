/*
 * src/rules.js — durable, model-facing rules injected into the bridge system
 * prompt on every request.
 *
 * Three sources, one store:
 *   builtin — shipped defaults, seeded into the store the first time it is read
 *   user    — added with `deepseek rules add` or the dashboard
 *   learned — recorded automatically when the bridge detects a repeatable
 *             failure (malformed tool markup, a degenerate DSML wall, an empty
 *             reply) so later turns can avoid repeating it
 *
 * The whole rendered section is prepended to the bridge system message, so
 * every rule is short and the section has a hard character budget. Nothing
 * here touches conversation state; edits apply on the next request because the
 * config and this file are re-read per request.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { paths } from './config.js';

const MAX_RULES = 24;
const MAX_LEARNED = 12;
const MAX_TEXT = 320;
const MIN_TEXT = 3;
const MAX_SECTION_CHARS = 2400;

/**
 * Shipped rules. They document the bridge's own repeatable failure modes — the
 * tool-call protocol is an adapter convention, so a model that drifts from it
 * produces markup the bridge has to strip (or a poisoned session). Seeded into
 * the store so users can see, edit, or delete them.
 */
export const BUILTIN_RULES = [
  {
    category: 'tool-format',
    text:
      'A tool call is exactly one fenced block: a line with three backticks and the word tool_call, then a JSON array of {"name", "arguments"} objects, then a closing fence. No prose inside the block.',
  },
  {
    category: 'tool-format',
    text:
      'Put every parallel call in the same JSON array. Do not emit one fenced block per call, and do not wrap the array in extra markup.',
  },
  {
    category: 'tool-result',
    text:
      'After a tool result, either call the next tool or answer. Never echo, summarize, or invent a tool result as if you produced it.',
  },
  {
    category: 'tool-format',
    text:
      'Never emit partial or empty markup: no bare DSML/XML tags, no calls wrapper without an invoke, no truncated JSON. Every call must carry a name and complete arguments.',
  },
  {
    category: 'edits',
    text:
      'When you edit a file, produce the complete new content. Do not abbreviate with ellipses or "unchanged" placeholders unless the tool itself takes a patch.',
  },
  {
    category: 'verify',
    text:
      'Verify a change with the project\'s own tests, build, or a direct check before claiming it works. Do not state that a command passed unless it ran.',
  },
];

/** Learned-rule text for each repeatable bridge-detected failure. */
export const LEARNED_RULES = {
  'tool-markup': {
    category: 'tool-format',
    text:
      'A previous turn emitted tool markup that contained no complete call, so it was stripped. Emit only complete tool_call blocks with a name and full arguments.',
  },
  'degenerate-dsml': {
    category: 'tool-format',
    text:
      'A previous turn fell into a loop of empty DSML tags. Never emit empty DSML/XML tags; answer in prose or make one complete tool call.',
  },
  'empty-reply': {
    category: 'output',
    text:
      'A previous turn produced no usable output. Always return either a short answer or one complete tool call — never an empty turn.',
  },
};

function rulesFile() {
  return process.env.DS_BRIDGE_RULES_FILE || paths.RULES_FILE;
}

function now() {
  return Date.now();
}

function normalizeText(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

function ruleId(category, text) {
  return crypto.createHash('sha256').update(`${category}\n${normalizeText(text).toLowerCase()}`).digest('hex').slice(0, 10);
}

function makeRule({ category, text, source, count = 1, firstSeen = null, lastSeen = null }) {
  const clean = normalizeText(text).slice(0, MAX_TEXT);
  const cat = normalizeText(category || source || 'general').slice(0, 40) || 'general';
  const stamp = now();
  return {
    id: ruleId(cat, clean),
    category: cat,
    text: clean,
    source,
    count,
    firstSeen: firstSeen || stamp,
    lastSeen: lastSeen || stamp,
  };
}

function emptyStore() {
  const seededAt = now();
  const rules = BUILTIN_RULES.map((rule) => makeRule({ ...rule, source: 'builtin', firstSeen: seededAt, lastSeen: seededAt }));
  return { version: 1, seededAt, rules };
}

function readDisk() {
  const file = rulesFile();
  let parsed = null;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    parsed = null;
  }
  if (!parsed || !Array.isArray(parsed.rules)) {
    // Missing or corrupt: seed builtins. A deleted builtin is not re-seeded,
    // because then the file exists with a valid (possibly empty) array.
    const seeded = emptyStore();
    try {
      writeDisk(seeded);
    } catch {
      /* read-only config dir: use the in-memory seed for this request */
    }
    return seeded;
  }
  return { version: 1, seededAt: parsed.seededAt || null, rules: parsed.rules.filter(isValidRule).map(coerceRule) };
}

function isValidRule(rule) {
  return rule && typeof rule === 'object' && typeof rule.text === 'string' && normalizeText(rule.text).length >= MIN_TEXT;
}

function coerceRule(rule) {
  const source = ['builtin', 'user', 'learned'].includes(rule.source) ? rule.source : 'user';
  const text = normalizeText(rule.text).slice(0, MAX_TEXT);
  const category = normalizeText(rule.category || 'general').slice(0, 40) || 'general';
  return {
    id: typeof rule.id === 'string' && rule.id ? rule.id : ruleId(category, text),
    category,
    text,
    source,
    count: Number.isFinite(rule.count) && rule.count > 0 ? Math.floor(rule.count) : 1,
    firstSeen: Number(rule.firstSeen) || null,
    lastSeen: Number(rule.lastSeen) || null,
  };
}

function writeDisk(store) {
  const file = rulesFile();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  const payload = { version: 1, seededAt: store.seededAt || null, rules: store.rules };
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function commit(store) {
  store.rules = sortRules(store.rules).slice(0, MAX_RULES);
  writeDisk(store);
  return store;
}

/** Builtins first, then user, then learned by how often they fired. */
function sortRules(rules) {
  const rank = { builtin: 0, user: 1, learned: 2 };
  return [...rules].sort((a, b) => {
    const bySource = (rank[a.source] ?? 3) - (rank[b.source] ?? 3);
    if (bySource) return bySource;
    if (a.source === 'learned' && b.source === 'learned' && a.count !== b.count) return b.count - a.count;
    return (a.firstSeen || 0) - (b.firstSeen || 0);
  });
}

/** Every stored rule, ordered the way the prompt renders them. */
export function listRules() {
  const store = readDisk();
  return sortRules(store.rules);
}

/** Counts per source for status/summary surfaces. */
export function rulesSummary() {
  const rules = listRules();
  return {
    count: rules.length,
    builtin: rules.filter((r) => r.source === 'builtin').length,
    user: rules.filter((r) => r.source === 'user').length,
    learned: rules.filter((r) => r.source === 'learned').length,
  };
}

/** Add a user rule. Returns { rule, duplicate, count }. */
export function addRule({ text, category = 'general' } = {}) {
  const clean = normalizeText(text);
  if (clean.length < MIN_TEXT) throw new Error('A rule needs at least 3 characters.');
  if (clean.length > MAX_TEXT) throw new Error(`A rule is capped at ${MAX_TEXT} characters.`);
  const store = readDisk();
  const needle = clean.toLowerCase();
  const existing = store.rules.find((rule) => normalizeText(rule.text).toLowerCase() === needle);
  if (existing) return { rule: existing, duplicate: true, count: rulesSummary().count };
  const rule = makeRule({ text: clean, category, source: 'user' });
  if (!rule.category) rule.category = 'general';
  store.rules.push(rule);
  commit(store);
  return { rule, duplicate: false, count: rulesSummary().count };
}

/** Remove one rule by id (builtin included: deletion is the user's call). */
export function removeRule(id) {
  const store = readDisk();
  const next = store.rules.filter((rule) => rule.id !== String(id || ''));
  if (next.length === store.rules.length) return { removed: false, count: store.rules.length };
  store.rules = next;
  commit(store);
  return { removed: true, count: next.length };
}

/** Drop every learned rule. Returns how many were removed. */
export function clearLearned() {
  const store = readDisk();
  const before = store.rules.length;
  store.rules = store.rules.filter((rule) => rule.source !== 'learned');
  const removed = before - store.rules.length;
  if (removed) commit(store);
  return { removed, count: store.rules.length };
}

/**
 * Record one occurrence of a repeatable failure. Identical learned rules are
 * deduped and their count grows, so the prompt stays bounded. Never throws:
 * learning must not fail a request.
 */
export function learnRule(kind) {
  const spec = LEARNED_RULES[kind];
  if (!spec) return null;
  try {
    const store = readDisk();
    const needle = normalizeText(spec.text).toLowerCase();
    const existing = store.rules.find(
      (rule) => rule.source === 'learned' && normalizeText(rule.text).toLowerCase() === needle,
    );
    if (existing) {
      existing.count = (existing.count || 1) + 1;
      existing.lastSeen = now();
      commit(store);
      return existing;
    }
    const learned = store.rules.filter((rule) => rule.source === 'learned');
    if (learned.length >= MAX_LEARNED) {
      // Replace the least-seen learned rule; user and builtin rules are never
      // evicted by automatic learning.
      learned.sort((a, b) => (a.count || 1) - (b.count || 1) || (a.lastSeen || 0) - (b.lastSeen || 0));
      const victim = learned[0];
      store.rules = store.rules.filter((rule) => rule !== victim);
    }
    const rule = makeRule({ ...spec, source: 'learned' });
    store.rules.push(rule);
    commit(store);
    return rule;
  } catch {
    return null;
  }
}

/**
 * Model-facing '# Rules' section, or '' when the store is empty. Rules beyond
 * the character budget are dropped, never truncated mid-sentence.
 */
export function renderRulesSection({ maxChars = MAX_SECTION_CHARS } = {}) {
  let rules;
  try {
    rules = listRules();
  } catch {
    return '';
  }
  if (!rules.length) return '';
  const lines = [
    '# Rules',
    'These rules are maintained by the bridge from earlier repeatable failures. Follow them on every turn.',
  ];
  let size = lines.join('\n').length;
  for (const rule of rules) {
    const line = `- [${rule.category}] ${rule.text}`;
    if (size + line.length + 1 > maxChars) break;
    lines.push(line);
    size += line.length + 1;
  }
  return lines.length > 2 ? lines.join('\n') : '';
}
