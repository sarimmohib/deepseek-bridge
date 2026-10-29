import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-bridge-accounts-'));
process.env.DS_BRIDGE_HOME = home;
const accounts = await import('../src/accounts.js');
const { paths } = await import('../src/config.js');

const tokenA = 'account-a-token-that-is-long-enough-0001';
const tokenB = 'account-b-token-that-is-long-enough-0002';
const fakeToken = (i) => `pool-token-${String(i).padStart(3, '0')}-${'x'.repeat(24)}`;

function readPoolFile() {
  return JSON.parse(fs.readFileSync(paths.ACCOUNTS_FILE, 'utf8'));
}

// Windows ignores POSIX mode bits (Node reports 0o666/0o777); POSIX systems
// must stay private.
function assertPrivateMode(file, expected) {
  const mode = fs.statSync(file).mode & 0o777;
  if (process.platform === 'win32') assert.ok(mode & 0o200, `${file} is writable by owner`);
  else assert.equal(mode, expected);
}

test.after(() => {
  accounts.clearAccounts();
  fs.rmSync(home, { recursive: true, force: true });
});

// Run first: this is the only test that exercises the one-time legacy import
// (the module remembers that it already looked for session.json).
test('migrates a legacy session.json into the pool once', () => {
  fs.writeFileSync(
    paths.SESSION_FILE,
    JSON.stringify({
      version: 1,
      token: tokenA,
      cookies: [
        { name: 'sid', value: 'abc', domain: '.deepseek.com', path: '/' },
        { name: 'foreign', value: 'no', domain: '.example.com', path: '/' },
      ],
      userAgent: 'legacy-agent',
      user: { id: 'u1' },
      savedAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    }),
  );

  const pool = accounts.loadAccounts();
  assert.equal(pool.length, 1);
  assert.equal(pool[0].token, tokenA);
  assert.equal(pool[0].userAgent, 'legacy-agent');
  assert.deepEqual(pool[0].cookies.map((cookie) => cookie.name), ['sid']);
  assert.equal(pool[0].addedAt, '2026-01-01T00:00:00.000Z');
  assert.ok(fs.existsSync(paths.SESSION_FILE), 'legacy file is kept, not deleted');
  assertPrivateMode(paths.ACCOUNTS_FILE, 0o600);
  assertPrivateMode(home, 0o700);
});

test('accepts an unbounded number of tokens and dedupes by token', () => {
  accounts.clearAccounts();
  for (let i = 0; i < 30; i++) {
    const result = accounts.addAccount({ token: fakeToken(i), label: `acct-${i}` });
    assert.equal(result.created, true);
    assert.equal(result.count, i + 1);
  }
  assert.equal(accounts.accountCount(), 30);
  const file = readPoolFile();
  assert.equal(file.version, 1);
  assert.equal(file.accounts.length, 30);

  const duplicate = accounts.addAccount({ token: fakeToken(7), label: 'renamed' });
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.duplicate, true);
  assert.equal(accounts.accountCount(), 30);
  assert.equal(accounts.getAccount(accounts.tokenId(fakeToken(7))).label, 'renamed');
});

test('redacted views never contain tokens or cookie values', () => {
  accounts.clearAccounts();
  accounts.addAccount({ token: tokenA, cookies: [{ name: 'sid', value: 'secret-cookie-value', domain: '.deepseek.com', path: '/' }] });

  const list = accounts.listAccounts();
  const summary = accounts.accountsSummary();
  assert.equal(summary.count, 1);
  assert.deepEqual(summary.accounts.map((account) => account.id), list.map((account) => account.id));
  for (const payload of [JSON.stringify(list), JSON.stringify(summary)]) {
    assert.ok(!payload.includes(tokenA), 'token leaked into redacted view');
    assert.ok(!payload.includes('secret-cookie-value'), 'cookie value leaked into redacted view');
    assert.ok(!payload.includes('cookies,"'), 'cookie array leaked into redacted view');
  }
  assert.equal(list[0].cookies, 1);
  assert.equal(list[0].state, 'ready');
});

test('cookies and users are tracked per account', () => {
  accounts.clearAccounts();
  const a = accounts.addAccount({ token: tokenA }).account;
  const b = accounts.addAccount({ token: tokenB }).account;
  accounts.updateAccountCookies(a.id, [{ name: 'sid', value: 'a-cookie', domain: '.deepseek.com', path: '/' }]);
  accounts.setAccountUser(b.id, { id: 'user-b' });

  assert.deepEqual(accounts.getAccount(a.id).cookies.map((cookie) => cookie.name), ['sid']);
  assert.equal(accounts.getAccount(a.id).user, null);
  assert.deepEqual(accounts.getAccount(b.id).cookies, []);
  assert.deepEqual(accounts.getAccount(b.id).user, { id: 'user-b' });
  // Session shape carries the credential for direct requests.
  assert.equal(accounts.accountSession(accounts.getAccount(a.id)).token, tokenA);
});

test('picks the least-recently-used ready account and skips cooling ones', () => {
  accounts.clearAccounts();
  const a = accounts.addAccount({ token: tokenA }).account;
  const b = accounts.addAccount({ token: tokenB }).account;

  const first = accounts.pickAccount({ now: 1_000 });
  const second = accounts.pickAccount({ now: 2_000 });
  const third = accounts.pickAccount({ now: 3_000 });
  assert.deepEqual([first.id, second.id, third.id], [a.id, b.id, a.id]);

  // Simulate a throttle on the account that was used most recently.
  accounts.markAccountThrottle(second.id, { code: 'empty_reply' });
  const cooling = accounts.getAccount(second.id);
  assert.ok(cooling.cooldownUntil > Date.now());
  assert.equal(cooling.state ?? 'cooling', 'cooling');
  assert.equal(cooling.throttleHits, 1);
  assert.equal(cooling.throttleLevel, 1);
  assert.equal(accounts.pickAccount({ preferId: second.id }), null, 'pinned cooling account is not handed out');
  const next = accounts.pickAccount();
  assert.equal(next.id, a.id);

  assert.ok(accounts.nextAvailableAt({ excludeIds: [a.id] }) > Date.now());
  accounts.markAccountSuccess(second.id);
  const recovered = accounts.getAccount(second.id);
  assert.equal(recovered.cooldownUntil, 0);
  assert.equal(recovered.throttleLevel, 0);
  assert.ok(accounts.nextAvailableAt() - Date.now() < 1000);
});

test('throttle cooldown escalates once per window and decays on success', () => {
  accounts.clearAccounts();
  const a = accounts.addAccount({ token: tokenA }).account;
  const t0 = 1_700_000_000_000;

  accounts.markAccountThrottle(a.id, { code: 'empty_reply', now: t0 });
  let current = accounts.getAccount(a.id);
  assert.equal(current.throttleLevel, 1);
  assert.equal(current.cooldownUntil, t0 + accounts.cooldownStepMs(1));

  // A concurrent failure inside the same window must not escalate the level.
  accounts.markAccountThrottle(a.id, { code: 'empty_reply', now: t0 + 1_000 });
  current = accounts.getAccount(a.id);
  assert.equal(current.throttleLevel, 1);
  assert.equal(current.throttleHits, 2);
  assert.equal(current.cooldownUntil, t0 + accounts.cooldownStepMs(1));

  // Once the window expired, the next throttle escalates to step two.
  accounts.markAccountThrottle(a.id, { code: 'empty_reply', now: t0 + accounts.cooldownStepMs(1) + 1 });
  current = accounts.getAccount(a.id);
  assert.equal(current.throttleLevel, 2);
  assert.equal(current.cooldownUntil, t0 + accounts.cooldownStepMs(1) + 1 + accounts.cooldownStepMs(2));

  // A new-window throttle with Retry-After keeps at least that long.
  const t2 = current.cooldownUntil + 1;
  accounts.markAccountThrottle(a.id, { code: 'upload_rate_limited', retryAfterMs: 90_000, now: t2 });
  current = accounts.getAccount(a.id);
  assert.ok(current.cooldownUntil >= t2 + 90_000);
  assert.equal(current.lastError.code, 'upload_rate_limited');

  for (let i = 0; i < 6; i++) accounts.markAccountSuccess(a.id);
  assert.equal(accounts.getAccount(a.id).throttleLevel, 0);
  assert.equal(accounts.getAccount(a.id).lastError, null);
});

test('expired accounts are parked and explicit re-add heals them', () => {
  accounts.clearAccounts();
  const a = accounts.addAccount({ token: tokenA }).account;
  accounts.markAccountExpired(a.id, 'session expired');
  const expired = accounts.getAccount(a.id);
  assert.equal(expired.lastError.code, 'not_signed_in');
  assert.ok(expired.cooldownUntil > Date.now() + 4 * 60_000);
  assert.equal(accounts.pickAccount(), null);

  const readded = accounts.addAccount({ token: tokenA });
  assert.equal(readded.created, false);
  assert.equal(accounts.getAccount(a.id).cooldownUntil, 0);
  assert.equal(accounts.getAccount(a.id).lastError, null);
  assert.equal(accounts.pickAccount().id, a.id);
});

test('stats are debounced but flushing makes them durable', () => {
  accounts.clearAccounts();
  const a = accounts.addAccount({ token: tokenA }).account;
  accounts.markAccountUsed(a.id);
  accounts.markAccountSuccess(a.id);
  accounts.flushAccountsNow();
  const file = readPoolFile();
  const stored = file.accounts.find((account) => account.id === a.id);
  assert.ok(stored.lastUsedAt > 0);
  assert.equal(stored.successCount, 1);
  assert.equal(typeof file.accounts[0].token, 'string', 'file itself keeps the credential');
});

test('removing and clearing accounts updates the pool file', () => {
  accounts.clearAccounts();
  const a = accounts.addAccount({ token: tokenA }).account;
  accounts.addAccount({ token: tokenB });
  assert.equal(accounts.removeAccount(a.id), true);
  assert.equal(accounts.removeAccount(a.id), false);
  assert.equal(accounts.accountCount(), 1);
  const cleared = accounts.clearAccounts();
  assert.equal(cleared.removed, 1);
  assert.equal(accounts.hasAccounts(), false);
  assert.equal(fs.existsSync(paths.ACCOUNTS_FILE), false);
});

test('primary account prefers a ready account over a cooling one', () => {
  accounts.clearAccounts();
  const a = accounts.addAccount({ token: tokenA }).account;
  const b = accounts.addAccount({ token: tokenB }).account;
  accounts.markAccountThrottle(a.id, { code: 'empty_reply' });
  assert.equal(accounts.getPrimaryAccount().id, b.id);
  accounts.markAccountSuccess(a.id);
  assert.equal(accounts.getPrimaryAccount().id, a.id);
});
