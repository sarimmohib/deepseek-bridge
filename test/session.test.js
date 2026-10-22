import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-bridge-session-'));
process.env.DS_BRIDGE_HOME = home;
const session = await import('../src/session.js');
const { paths } = await import('../src/config.js');

const token = 'test-token-that-is-definitely-long-enough';

test.after(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

test('stores only DeepSeek cookies and writes the file 0600', () => {
  session.clearSession();
  session.saveSession({
    token,
    userAgent: 'test-agent',
    cookies: [
      { name: 'root', value: '1', domain: '.deepseek.com', path: '/', secure: true },
      { name: 'sid', value: 'abc', domain: 'chat.deepseek.com', path: '/', secure: true, httpOnly: true },
      { name: 'foreign', value: 'no', domain: '.example.com', path: '/' },
    ],
  });

  const saved = session.loadSession();
  assert.equal(saved.token, token);
  assert.equal(saved.userAgent, 'test-agent');
  assert.deepEqual(saved.cookies.map((c) => c.name).sort(), ['root', 'sid']);
  assert.equal(fs.statSync(paths.SESSION_FILE).mode & 0o777, 0o600);
});

test('cookieHeader sends matching DeepSeek cookies and skips expired ones', () => {
  session.clearSession();
  session.saveSession({
    token,
    cookies: [
      { name: 'root', value: '1', domain: '.deepseek.com', path: '/' },
      { name: 'sid', value: 'abc', domain: 'chat.deepseek.com', path: '/', hostOnly: true },
      { name: 'old', value: 'gone', domain: '.deepseek.com', path: '/', expirationDate: 1 },
      { name: 'api', value: 'v', domain: '.deepseek.com', path: '/api' },
      { name: 'other', value: 'no', domain: '.example.com', path: '/' },
    ],
  });

  const header = session.cookieHeader(session.loadSession());
  assert.match(header, /root=1/);
  assert.match(header, /sid=abc/);
  assert.match(header, /api=v/);
  assert.doesNotMatch(header, /old=gone/);
  assert.doesNotMatch(header, /other=no/);
  assert.doesNotMatch(session.cookieHeader(session.loadSession(), 'https://deepseek.com/'), /sid=abc/);
});

test('a new login replaces old cookies; Set-Cookie updates merge', () => {
  session.clearSession();
  session.saveSession({ token, cookies: [{ name: 'old', value: '1', domain: '.deepseek.com', path: '/' }] });
  session.saveSession({ token, cookies: [{ name: 'new', value: '2', domain: '.deepseek.com', path: '/' }] });
  assert.deepEqual(session.loadSession().cookies.map((c) => c.name), ['new']);

  session.updateSessionCookies([{ name: 'extra', value: '3', domain: '.deepseek.com', path: '/' }]);
  assert.deepEqual(session.loadSession().cookies.map((c) => c.name).sort(), ['extra', 'new']);
});

test('summary omits credentials and clearSession removes the file', () => {
  session.clearSession();
  session.saveSession({ token, cookies: [{ name: 'sid', value: 'abc', domain: '.deepseek.com', path: '/' }] });
  const summary = session.sessionSummary();
  assert.equal(summary.available, true);
  assert.equal(summary.cookies, 1);
  assert.equal(JSON.stringify(summary).includes(token), false);
  assert.equal(session.clearSession(), true);
  assert.equal(session.loadSession(), null);
  assert.equal(session.sessionSummary().available, false);
});
