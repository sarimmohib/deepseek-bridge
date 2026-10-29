/*
 * DeepSeek cookie helpers shared by the session layer and the account pool.
 *
 * Only cookies for deepseek.com ever pass through these functions; every other
 * domain is dropped at the door. Kept in its own module so session.js and
 * accounts.js can both use it without a circular import.
 */

export function isDeepSeekDomain(domain) {
  const d = String(domain || '').toLowerCase().replace(/^\./, '');
  return d === 'deepseek.com' || d.endsWith('.deepseek.com');
}

export function normalizeCookie(cookie) {
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

export function mergeCookies(existing, updates) {
  const map = new Map();
  for (const cookie of [...(existing || []), ...(updates || [])]) {
    const normalized = normalizeCookie(cookie);
    if (!normalized) continue;
    if (normalized.expirationDate && normalized.expirationDate <= Date.now() / 1000) continue;
    map.set(`${normalized.domain}|${normalized.path}|${normalized.name}`, normalized);
  }
  return [...map.values()];
}

export function cookieMatchesUrl(cookie, url) {
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
