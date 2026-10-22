/*
 * Terminal-owned DeepSeek web session.
 *
 * Only chat.deepseek.com cookies and the site's `userToken` are stored. Both
 * are credentials, so the file is written 0600 and never logged. The extension
 * is used once to copy them out of Chrome; after `deepseek --login` the bridge
 * talks to DeepSeek directly and Chrome is not needed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { paths } from './config.js';

const FILE = paths.SESSION_FILE;
const SESSION_VERSION = 1;

function isDeepSeekDomain(domain) {
  const d = String(domain || '').toLowerCase().replace(/^\./, '');
  return d === 'deepseek.com' || d.endsWith('.deepseek.com');
}

function normalizeCookie(cookie) {
  if (!cookie || typeof cookie.name !== 'string' || typeof cookie.value !== 'string') return null;
  if (!isDeepSeekDomain(cookie.domain)) return null;
  return {
    name: cookie.name,
    value: cookie.value,
    domain: String(cookie.domain || '').toLowerCase(),
    path: cookie.path || '/',
    secure: cookie.secure !== false,
    httpOnly: Boolean(cookie.httpOnly),
    hostOnly: Boolean(cookie.hostOnly),
    sameSite: cookie.sameSite || null,
    expirationDate: Number(cookie.expirationDate) > 0 ? Number(cookie.expirationDate) : null,
  };
}

function mergeCookies(existing, updates) {
  const map = new Map();
  for (const cookie of [...(existing || []), ...(updates || [])]) {
    const normalized = normalizeCookie(cookie);
    if (!normalized) continue;
    if (normalized.expirationDate && normalized.expirationDate <= Date.now() / 1000) continue;
    map.set(`${normalized.domain}|${normalized.path}|${normalized.name}`, normalized);
  }
  return [...map.values()];
}

function writeSession(session) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(path.dirname(FILE), 0o700);
  } catch {
    /* Windows and some filesystems do not support POSIX modes. */
  }
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(session, null, 2) + '\n', { mode: 0o600 });
  try {
    fs.chmodSync(tmp, 0o600);
  } catch {
    /* Windows and some filesystems do not support POSIX modes. */
  }
  fs.renameSync(tmp, FILE);
}

export function loadSession() {
  try {
    const session = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (
      !session ||
      session.version !== SESSION_VERSION ||
      typeof session.token !== 'string' ||
      session.token.length < 20 ||
      !Array.isArray(session.cookies)
    ) {
      return null;
    }
    session.cookies = mergeCookies([], session.cookies);
    return session;
  } catch {
    return null;
  }
}

export function saveSession({ token, cookies, userAgent, user } = {}) {
  const previous = loadSession();
  const value = typeof token === 'string' ? token.trim() : previous?.token;
  if (!value || value.length < 20) throw new Error('DeepSeek did not return a usable user token');
  const now = new Date().toISOString();
  // A browser export or manual token replaces the cookie set; a Set-Cookie
  // update is merged explicitly by updateSessionCookies below.
  const cookieList = Array.isArray(cookies) ? cookies : previous?.cookies;
  const session = {
    version: SESSION_VERSION,
    token: value,
    cookies: mergeCookies([], cookieList),
    userAgent: userAgent || previous?.userAgent || '',
    user: user || previous?.user || null,
    savedAt: previous?.savedAt || now,
    updatedAt: now,
  };
  writeSession(session);
  return session;
}

export function updateSessionCookies(cookies) {
  if (!Array.isArray(cookies) || cookies.length === 0) return null;
  const previous = loadSession();
  if (!previous) return null;
  return saveSession({ ...previous, cookies: mergeCookies(previous.cookies, cookies) });
}

export function setSessionUser(user) {
  const previous = loadSession();
  if (!previous || !user) return previous;
  return saveSession({ ...previous, user });
}

export function clearSession() {
  try {
    fs.unlinkSync(FILE);
    return true;
  } catch {
    return false;
  }
}

function cookieMatchesUrl(cookie, url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  const domain = String(cookie.domain || '').toLowerCase().replace(/^\./, '');
  if (!domain || !isDeepSeekDomain(domain)) return false;
  if (cookie.hostOnly ? host !== domain : host !== domain && !host.endsWith(`.${domain}`)) return false;
  if (cookie.expirationDate && Date.now() / 1000 >= cookie.expirationDate) return false;
  const cookiePath = cookie.path || '/';
  return parsed.pathname.startsWith(cookiePath);
}

export function cookieHeader(session, url = 'https://chat.deepseek.com/api/v0') {
  if (!session?.cookies?.length) return '';
  return session.cookies
    .filter((cookie) => cookieMatchesUrl(cookie, url))
    .sort((a, b) => (b.path?.length || 0) - (a.path?.length || 0))
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join('; ');
}

export function sessionSummary(session = loadSession()) {
  if (!session) return { available: false };
  const expiries = session.cookies
    .map((cookie) => cookie.expirationDate)
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((a, b) => a - b);
  return {
    available: true,
    user: session.user || null,
    cookies: session.cookies.length,
    savedAt: session.savedAt || null,
    updatedAt: session.updatedAt || null,
    expiresAt: expiries.length ? new Date(expiries[0] * 1000).toISOString() : null,
    file: FILE,
  };
}
