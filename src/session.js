/*
 * Terminal-owned DeepSeek web session(s).
 *
 * Historically this module owned one session.json. It is now a compatibility
 * layer over src/accounts.js: saveSession() upserts an account, loadSession()
 * returns the primary account in the old session shape, and clearSession()
 * removes the whole stored pool (plus any legacy session.json). Callers that
 * need per-account behavior (rotation, per-account cookies) use accounts.js
 * directly.
 */
import { paths } from './config.js';
import * as accounts from './accounts.js';
import { cookieHeader, mergeCookies, normalizeCookie } from './cookies.js';

export { cookieHeader, mergeCookies, normalizeCookie };

export const SESSION_VERSION = 1;

export function loadSession() {
  const account = accounts.getPrimaryAccount();
  return account ? accounts.accountSession(account) : null;
}

export function saveSession({ token, cookies, userAgent, user } = {}) {
  const { account } = accounts.addAccount({
    token,
    cookies: Array.isArray(cookies) ? cookies : undefined,
    userAgent,
    user,
    replaceCookies: Array.isArray(cookies),
  });
  return accounts.accountSession(account);
}

// A Set-Cookie update from a response belongs to the account that made the
// request; direct.js uses updateAccountCookies(accountId, ...) for that. This
// legacy helper updates the primary account.
export function updateSessionCookies(cookies) {
  const primary = accounts.getPrimaryAccount();
  if (!primary) return null;
  const updated = accounts.updateAccountCookies(primary.id, cookies);
  return updated ? accounts.accountSession(updated) : null;
}

export function setSessionUser(user) {
  const primary = accounts.getPrimaryAccount();
  if (!primary) return null;
  const updated = accounts.setAccountUser(primary.id, user);
  return updated ? accounts.accountSession(updated) : null;
}

export function clearSession() {
  const { removed } = accounts.clearAccounts();
  return removed > 0;
}

export function sessionSummary(session = loadSession()) {
  const summary = accounts.accountsSummary();
  if (!session) return { available: false, accounts: summary.count };
  const expiries = (session.cookies || [])
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
    file: paths.ACCOUNTS_FILE,
    accounts: summary.count,
  };
}
