/*
 * Unbounded pool of DeepSeek web accounts (userToken + cookies).
 *
 * The bridge used to store exactly one web session in session.json. That made
 * every request ride one account, so DeepSeek's per-account throttle surfaced
 * as empty replies under load. This module keeps a list of accounts instead and
 * tracks per-account health: when an account hits the throttle it cools down and
 * requests rotate to another one, while the pool itself has no size limit.
 *
 * Tokens are credentials. They never leave the accountSession()/legacy
 * session-token path and are never included in listAccounts()/accountsSummary().
 *
 * Storage: <config dir>/accounts.json, mode 0600, atomic rename. A legacy
 * session.json is migrated once and then ignored (clearAccounts() removes it).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { paths } from './config.js';
import { mergeCookies } from './cookies.js';

const FILE = paths.ACCOUNTS_FILE;
const ACCOUNTS_VERSION = 1;

// Per-account cool-down after a throttle signal. DeepSeek's empty-reply window
// is measured at ~10-15 s to recover, but under sustained bursts it can last
// minutes; the level escalates while an account keeps hitting it and decays on
// success.
export const ACCOUNT_COOLDOWN_STEPS = [15_000, 45_000, 120_000, 300_000, 600_000];
// An expired token does not recover by waiting, so exclude it until the user
// re-adds/refreshes it and requests rotate to healthy accounts. Kept short
// enough that a transient false positive (a WAF/auth-looking failure) cannot
// park a still-valid account for long; a genuinely dead token simply gets one
// extra failed probe per window before rotating away again.
const EXPIRED_COOLDOWN_MS = 5 * 60_000;
const FLUSH_DELAY_MS = 2_000;
const MAX_LAST_ERROR_CHARS = 200;

let cache = { stamp: null, accounts: [] };
let pending = new Map(); // id -> stats patch not yet persisted
let flushTimer = null;
let exitHandlerInstalled = false;
let legacyChecked = false;

export function tokenId(token) {
  return crypto.createHash('sha256').update(String(token || ''), 'utf8').digest('hex').slice(0, 16);
}

function asTimestamp(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function isoOr(value, fallback) {
  if (typeof value === 'string' && value) return value;
  return fallback;
}

function normalizeLastError(value) {
  if (!value || typeof value !== 'object') return null;
  const code = typeof value.code === 'string' ? value.code : 'error';
  return {
    code,
    at: asTimestamp(value.at) || Date.now(),
    ...(typeof value.message === 'string'
      ? { message: value.message.slice(0, MAX_LAST_ERROR_CHARS) }
      : {}),
  };
}

function normalizeRecord(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const token = typeof raw.token === 'string' ? raw.token.trim() : '';
  if (token.length < 20) return null;
  const now = new Date().toISOString();
  return {
    id: tokenId(token),
    token,
    cookies: mergeCookies([], Array.isArray(raw.cookies) ? raw.cookies : []),
    userAgent: typeof raw.userAgent === 'string' ? raw.userAgent : '',
    user: raw.user && typeof raw.user === 'object' ? raw.user : null,
    label: typeof raw.label === 'string' ? raw.label.slice(0, 80) : '',
    addedAt: isoOr(raw.addedAt, now),
    updatedAt: isoOr(raw.updatedAt, now),
    lastUsedAt: asTimestamp(raw.lastUsedAt),
    lastSuccessAt: asTimestamp(raw.lastSuccessAt),
    cooldownUntil: asTimestamp(raw.cooldownUntil),
    throttleLevel: Math.min(ACCOUNT_COOLDOWN_STEPS.length, Math.max(0, Math.floor(Number(raw.throttleLevel) || 0))),
    throttleHits: Math.max(0, Math.floor(Number(raw.throttleHits) || 0)),
    successCount: Math.max(0, Math.floor(Number(raw.successCount) || 0)),
    failureCount: Math.max(0, Math.floor(Number(raw.failureCount) || 0)),
    lastError: normalizeLastError(raw.lastError),
  };
}

function dedupe(records) {
  const map = new Map();
  for (const record of records) {
    if (!record) continue;
    const previous = map.get(record.id);
    if (!previous) {
      map.set(record.id, record);
      continue;
    }
    // A token can be written twice by racing processes; keep the freshest
    // stats and the earliest addedAt (stable pool ordering).
    map.set(record.id, {
      ...previous,
      ...record,
      addedAt: previous.addedAt || record.addedAt,
      cookies: mergeCookies(previous.cookies, record.cookies),
    });
  }
  return [...map.values()];
}

function stampOf(stat) {
  return `${stat.mtimeMs}:${stat.size}`;
}

function writeDisk(accounts) {
  const payload = { version: ACCOUNTS_VERSION, accounts: dedupe(accounts) };
  fs.mkdirSync(path.dirname(FILE), { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(path.dirname(FILE), 0o700);
  } catch {
    /* Windows and some filesystems do not support POSIX modes. */
  }
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', { mode: 0o600 });
  try {
    fs.chmodSync(tmp, 0o600);
  } catch {
    /* Windows and some filesystems do not support POSIX modes. */
  }
  fs.renameSync(tmp, FILE);
  try {
    cache = { stamp: stampOf(fs.statSync(FILE)), accounts: payload.accounts };
  } catch {
    cache = { stamp: null, accounts: payload.accounts };
  }
  return payload.accounts;
}

function legacySessionRecord() {
  let session;
  try {
    session = JSON.parse(fs.readFileSync(paths.SESSION_FILE, 'utf8'));
  } catch {
    return null;
  }
  if (!session || typeof session.token !== 'string' || session.token.trim().length < 20) return null;
  if (!Array.isArray(session.cookies)) return null;
  const record = normalizeRecord({
    token: session.token,
    cookies: session.cookies,
    userAgent: session.userAgent,
    user: session.user,
    addedAt: session.savedAt,
    updatedAt: session.updatedAt,
  });
  return record;
}

function readDisk() {
  let stat;
  try {
    stat = fs.statSync(FILE);
  } catch (err) {
    if (err?.code !== 'ENOENT') return cache.accounts;
    // No pool file yet: migrate a legacy single session exactly once.
    if (legacyChecked) return [];
    legacyChecked = true;
    const record = legacySessionRecord();
    if (!record) return [];
    return writeDisk([record]);
  }
  const stamp = stampOf(stat);
  if (stamp === cache.stamp) return cache.accounts;

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    // A corrupt pool must not brick the bridge: keep a copy for inspection and
    // fall back to migration/empty so the user can re-add tokens.
    try {
      fs.renameSync(FILE, `${FILE}.corrupt-${Date.now()}`);
    } catch {
      /* best effort */
    }
    cache = { stamp: null, accounts: [] };
    return [];
  }
  const records = Array.isArray(parsed?.accounts) ? parsed.accounts.map(normalizeRecord) : [];
  const accounts = dedupe(records);
  cache = { stamp, accounts };
  return accounts;
}

function effectiveAccount(account) {
  const patch = pending.get(account.id);
  const copy = { ...account, cookies: account.cookies.map((cookie) => ({ ...cookie })) };
  if (!patch) return copy;
  for (const [key, value] of Object.entries(patch)) {
    copy[key] = key === 'lastError' && value ? { ...value } : value;
  }
  return copy;
}

export function loadAccounts() {
  return readDisk().map(effectiveAccount);
}

export function accountCount() {
  return readDisk().length;
}

export function hasAccounts() {
  return readDisk().length > 0;
}

export function getAccount(id) {
  const found = readDisk().find((account) => account.id === id);
  return found ? effectiveAccount(found) : null;
}

function isReady(account, now = Date.now()) {
  return Boolean(account?.token) && !(asTimestamp(account.cooldownUntil) > now);
}

export function isCooling(account, now = Date.now()) {
  return asTimestamp(account?.cooldownUntil) > now;
}

// Primary account = the first usable one (or the first stored one when every
// account is cooling). Used by the legacy single-session API and the dashboard
// token export; scheduling uses pickAccount() instead.
export function getPrimaryAccount() {
  const accounts = readDisk().map(effectiveAccount);
  if (!accounts.length) return null;
  const now = Date.now();
  const ready = accounts.find((account) => isReady(account, now));
  return ready || accounts[0];
}

export function accountSession(account) {
  if (!account?.token) return null;
  return {
    version: 1,
    token: account.token,
    cookies: (account.cookies || []).map((cookie) => ({ ...cookie })),
    userAgent: account.userAgent || '',
    user: account.user || null,
    savedAt: account.addedAt || null,
    updatedAt: account.updatedAt || null,
  };
}

function redact(account, now = Date.now()) {
  const coolingFor = Math.max(0, asTimestamp(account.cooldownUntil) - now);
  return {
    id: account.id,
    label: account.label || '',
    user: account.user || null,
    cookies: Array.isArray(account.cookies) ? account.cookies.length : 0,
    addedAt: account.addedAt || null,
    updatedAt: account.updatedAt || null,
    lastUsedAt: asTimestamp(account.lastUsedAt) || null,
    lastSuccessAt: asTimestamp(account.lastSuccessAt) || null,
    cooldownUntil: asTimestamp(account.cooldownUntil) || null,
    cooldownMs: coolingFor,
    cooling: coolingFor > 0,
    state: coolingFor > 0 ? 'cooling' : 'ready',
    throttleLevel: account.throttleLevel || 0,
    throttleHits: account.throttleHits || 0,
    successCount: account.successCount || 0,
    failureCount: account.failureCount || 0,
    lastError: account.lastError ? { ...account.lastError } : null,
  };
}

export function listAccounts() {
  const now = Date.now();
  return readDisk().map((account) => redact(effectiveAccount(account), now));
}

export function accountsSummary() {
  const now = Date.now();
  const accounts = readDisk().map((account) => redact(effectiveAccount(account), now));
  const ready = accounts.filter((account) => !account.cooling).length;
  return {
    count: accounts.length,
    ready,
    cooling: accounts.length - ready,
    accounts,
  };
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushAccounts();
  }, FLUSH_DELAY_MS);
  flushTimer.unref?.();
  if (!exitHandlerInstalled) {
    exitHandlerInstalled = true;
    process.on('exit', () => {
      try {
        flushAccounts();
      } catch {
        /* nothing left to save */
      }
    });
  }
}

function commit(accounts) {
  return writeDisk(accounts);
}

export function flushAccounts() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (!pending.size) return;
  commit(readDisk().map(effectiveAccount));
  pending.clear();
}

function withPendingWrite(mutate) {
  const base = readDisk().map(effectiveAccount);
  const result = mutate(base);
  writeDisk(base);
  pending.clear();
  return result;
}

export function addAccount({
  token,
  cookies,
  userAgent,
  user,
  label,
  replaceCookies = true,
  makePrimary = false,
} = {}) {
  const value = typeof token === 'string' ? token.trim() : '';
  if (!value || value.length < 20) throw new Error('DeepSeek did not return a usable user token');
  const id = tokenId(value);
  const now = new Date().toISOString();
  let created = false;
  let duplicate = false;

  const accounts = withPendingWrite((base) => {
    const existing = base.find((account) => account.id === id);
    if (existing) {
      duplicate = true;
      if (Array.isArray(cookies)) {
        existing.cookies = replaceCookies ? mergeCookies([], cookies) : mergeCookies(existing.cookies, cookies);
      }
      if (userAgent) existing.userAgent = userAgent;
      if (user) existing.user = user;
      if (label) existing.label = String(label).slice(0, 80);
      existing.updatedAt = now;
      // An explicit re-add/login is a health reset: the token was just proven
      // or refreshed, so clear any cooldown inherited from an old failure.
      existing.cooldownUntil = 0;
      existing.throttleLevel = 0;
      existing.lastError = null;
      if (makePrimary) {
        const index = base.indexOf(existing);
        if (index > 0) {
          base.splice(index, 1);
          base.unshift(existing);
        }
      }
      return existing;
    }
    created = true;
    const record = normalizeRecord({
      token: value,
      cookies: Array.isArray(cookies) ? cookies : [],
      userAgent,
      user,
      label,
      addedAt: now,
      updatedAt: now,
    });
    if (makePrimary) base.unshift(record);
    else base.push(record);
    return record;
  });

  return { account: effectiveAccount(accounts), created, duplicate, count: readDisk().length };
}

export function removeAccount(id) {
  const accounts = readDisk().map(effectiveAccount);
  const next = accounts.filter((account) => account.id !== id);
  if (next.length === accounts.length) return false;
  pending.delete(id);
  writeDisk(next);
  return true;
}

export function clearAccounts() {
  const removed = readDisk().length;
  pending.clear();
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  try {
    fs.unlinkSync(FILE);
  } catch {
    /* already gone */
  }
  try {
    fs.unlinkSync(paths.SESSION_FILE);
  } catch {
    /* legacy file absent */
  }
  cache = { stamp: null, accounts: [] };
  legacyChecked = true;
  return { removed };
}

export function updateAccountCookies(id, cookies) {
  if (!Array.isArray(cookies) || cookies.length === 0) return null;
  let updated = null;
  withPendingWrite((base) => {
    const account = base.find((candidate) => candidate.id === id);
    if (!account) return;
    account.cookies = mergeCookies(account.cookies, cookies);
    account.updatedAt = new Date().toISOString();
    updated = account;
  });
  return updated ? effectiveAccount(updated) : null;
}

export function setAccountUser(id, user) {
  if (!user) return null;
  let updated = null;
  withPendingWrite((base) => {
    const account = base.find((candidate) => candidate.id === id);
    if (!account) return;
    account.user = user;
    account.updatedAt = new Date().toISOString();
    updated = account;
  });
  return updated ? effectiveAccount(updated) : null;
}

function effectiveById(id) {
  const stored = readDisk().find((account) => account.id === id);
  return stored ? effectiveAccount(stored) : null;
}

function patchAccount(id, patch) {
  if (!effectiveById(id)) return null;
  const previous = pending.get(id) || {};
  pending.set(id, { ...previous, ...patch });
  scheduleFlush();
  return effectiveById(id);
}

function reserve(id, now) {
  if (!readDisk().some((account) => account.id === id)) return;
  const previous = pending.get(id) || {};
  pending.set(id, { ...previous, lastUsedAt: now });
  scheduleFlush();
}

export function markAccountUsed(id) {
  reserve(id, Date.now());
  return getAccount(id);
}

export function markAccountSuccess(id) {
  const account = getAccount(id);
  if (!account) return null;
  const level = Math.max(0, (account.throttleLevel || 0) - 1);
  return patchAccount(id, {
    successCount: (account.successCount || 0) + 1,
    lastSuccessAt: Date.now(),
    throttleLevel: level,
    cooldownUntil: 0,
    ...(level === 0 ? { lastError: null } : {}),
  });
}

export function markAccountThrottle(id, { retryAfterMs = 0, code = 'empty_reply', now = Date.now() } = {}) {
  const account = getAccount(id);
  if (!account) return null;
  // While the account is already inside a throttle window, a second in-flight
  // failure only extends the SAME cool-down; escalating on every concurrent
  // failure would park a small pool for minutes after one burst. Escalation
  // happens once per window: after the cool-down has expired, a new throttle
  // signal moves to the next step.
  const alreadyCooling = asTimestamp(account.cooldownUntil) > now;
  const level = alreadyCooling
    ? Math.max(1, account.throttleLevel || 1)
    : Math.min(ACCOUNT_COOLDOWN_STEPS.length, (account.throttleLevel || 0) + 1);
  // Already cooling: keep the existing window (an explicit Retry-After may
  // extend it); concurrent failures must not push the recovery time out
  // indefinitely while a burst keeps hammering.
  const cooldownUntil = alreadyCooling
    ? Math.max(asTimestamp(account.cooldownUntil), now + Math.max(0, Number(retryAfterMs) || 0))
    : Math.max(now + ACCOUNT_COOLDOWN_STEPS[level - 1], now + Math.max(0, Number(retryAfterMs) || 0));
  return patchAccount(id, {
    throttleLevel: level,
    throttleHits: (account.throttleHits || 0) + 1,
    cooldownUntil,
    lastError: { code: String(code), at: now },
  });
}

export function markAccountFailure(id, code = 'error') {
  const account = getAccount(id);
  if (!account) return null;
  return patchAccount(id, {
    failureCount: (account.failureCount || 0) + 1,
    lastError: { code: String(code), at: Date.now() },
  });
}

export function markAccountExpired(id, message = '') {
  const account = getAccount(id);
  if (!account) return null;
  const now = Date.now();
  return patchAccount(id, {
    cooldownUntil: now + EXPIRED_COOLDOWN_MS,
    lastError: {
      code: 'not_signed_in',
      at: now,
      ...(message ? { message: String(message).slice(0, MAX_LAST_ERROR_CHARS) } : {}),
    },
  });
}

export function pickAccount({ preferId = null, excludeIds = [], now = Date.now() } = {}) {
  const excluded = new Set(excludeIds || []);
  const accounts = readDisk()
    .map(effectiveAccount)
    .filter((account) => account.token && !excluded.has(account.id));
  if (!accounts.length) return null;

  if (preferId) {
    const preferred = accounts.find((account) => account.id === preferId);
    if (!preferred || !isReady(preferred, now)) return null;
    reserve(preferred.id, now);
    return effectiveById(preferId);
  }

  const ready = accounts.filter((account) => isReady(account, now));
  if (!ready.length) return null;
  ready.sort(
    (a, b) =>
      asTimestamp(a.lastUsedAt) - asTimestamp(b.lastUsedAt) ||
      (Date.parse(a.addedAt) || 0) - (Date.parse(b.addedAt) || 0),
  );
  const chosen = ready[0];
  reserve(chosen.id, now);
  return effectiveById(chosen.id);
}

export function nextAvailableAt({ excludeIds = [] } = {}) {
  const excluded = new Set(excludeIds || []);
  const accounts = readDisk().map(effectiveAccount).filter((account) => account.token && !excluded.has(account.id));
  if (!accounts.length) return Infinity;
  const now = Date.now();
  let next = Infinity;
  for (const account of accounts) {
    const until = asTimestamp(account.cooldownUntil);
    if (until <= now) return now;
    next = Math.min(next, until);
  }
  return next;
}

export function cooldownStepMs(level) {
  const index = Math.min(ACCOUNT_COOLDOWN_STEPS.length, Math.max(1, Math.floor(Number(level) || 1))) - 1;
  return ACCOUNT_COOLDOWN_STEPS[index];
}

// Test/CLI helper: apply any debounced stats now so the file is current.
export function flushAccountsNow() {
  flushAccounts();
}
