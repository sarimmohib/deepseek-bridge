import test from 'node:test';
import assert from 'node:assert/strict';
import {
  collectNetworkInfo,
  createStyle,
  formatTokens,
  groupAccounts,
  renderStartup,
  stripAnsi,
  tokenState,
  truncate,
  visibleLength,
} from '../src/tui.js';

const NOW = 1_700_000_000_000;

function fixture() {
  return {
    version: '0.9.20',
    cfg: { host: '127.0.0.1', port: 8787, key: 'sk-ds-29444b45c7771a81efa70a67afb6ed2d3fbc5d91c7fa0f2d' },
    health: { ok: true },
    accounts: {
      count: 2,
      ready: 1,
      cooling: 1,
      accounts: [
        {
          id: 'aaaa1111bbbbcccc',
          label: 'work',
          cooling: false,
          successCount: 3,
          failureCount: 0,
          lastUsedAt: NOW - 60_000,
        },
        {
          id: 'cccc2222dddd3333',
          label: '',
          cooling: true,
          lastError: { code: 'not_signed_in' },
          successCount: 0,
          failureCount: 2,
        },
      ],
    },
    models: [
      { id: 'deepseek-reasoner', context_window: 890880, description: 'Reasoner, reasoning enabled' },
      { id: 'deepseek-search', context_window: 890880, description: 'Search, reasoning + web search' },
    ],
    tools: [
      { id: 'git', found: true, version: '2.56.0' },
      { id: 'tailscale', found: false, version: null },
    ],
    autostart: { enabled: true, kind: 'schtasks' },
    network: {
      lan: ['192.168.1.5'],
      tailscale: { installed: true, dnsName: 'box.tail.ts.net', online: true },
    },
  };
}

test('start screen shows endpoints, models, key and every token state', () => {
  const text = renderStartup(fixture(), { style: createStyle({ color: false }), width: 100 });
  assert.match(text, /DEEPSEEK BRIDGE/);
  assert.match(text, /v0\.9\.20/);
  assert.match(text, /ONLINE/);
  assert.match(text, /http:\/\/127\.0\.0\.1:8787\/v1/);
  assert.match(text, /http:\/\/127\.0\.0\.1:8787\//);
  assert.match(text, /http:\/\/192\.168\.1\.5:8787\/v1/);
  assert.match(text, /http:\/\/box\.tail\.ts\.net:8787\/v1/);
  assert.match(text, /deepseek-reasoner/);
  assert.match(text, /deepseek-search/);
  assert.match(text, /890,880 ctx/);
  assert.match(text, /sk-ds-29444b45c7771a81efa70a67afb6ed2d3fbc5d91c7fa0f2d/);
  assert.match(text, /1 WORKING · 0 COOLING · 1 EXPIRED/);
  assert.match(text, /aaaa1111/);
  assert.match(text, /cccc2222/);
  assert.match(text, /need a fresh login/);
  assert.match(text, /autostart schtasks/);
});

test('colourless output has no escape sequences and fits the requested width', () => {
  const text = renderStartup(fixture(), { style: createStyle({ color: false }), width: 60 });
  assert.equal(stripAnsi(text), text);
  for (const line of text.split('\n')) {
    assert.ok(visibleLength(line) <= 60, `line too wide (${visibleLength(line)}): ${line}`);
  }
});

test('ascii mode replaces box drawing and is still aligned', () => {
  const text = renderStartup(fixture(), { style: createStyle({ color: false, ascii: true }), width: 80 });
  assert.ok(!text.includes('╭'));
  assert.ok(!text.includes('●'));
  assert.match(text, /^\+-+\+$/m);
  for (const line of text.split('\n')) {
    assert.ok(visibleLength(line) <= 80, `line too wide (${visibleLength(line)}): ${line}`);
  }
});

test('empty pool gets an actionable message instead of an empty table', () => {
  const data = { ...fixture(), accounts: { count: 0, ready: 0, cooling: 0, accounts: [] } };
  const text = renderStartup(data, { style: createStyle({ color: false }), width: 92 });
  assert.match(text, /no tokens yet/);
  assert.match(text, /deepseek --login/);
});

test('offline bridge and missing tailscale degrade gracefully', () => {
  const data = {
    ...fixture(),
    health: null,
    network: { lan: [], tailscale: { installed: true, dnsName: null, online: false } },
  };
  const text = renderStartup(data, { style: createStyle({ color: false }), width: 92 });
  assert.match(text, /OFFLINE/);
  assert.match(text, /installed, not connected/);
  assert.match(text, /loopback only/);
});

test('tokenState separates working, cooling and expired logins', () => {
  assert.equal(tokenState({ cooling: false }), 'working');
  assert.equal(tokenState({ cooling: true, lastError: { code: 'empty_reply' } }), 'cooling');
  assert.equal(tokenState({ cooling: true, lastError: { code: 'not_signed_in' } }), 'expired');
  assert.equal(tokenState(null), 'expired');
  const groups = groupAccounts([
    { cooling: false },
    { cooling: true, lastError: { code: 'empty_reply' } },
    { cooling: true, lastError: { code: 'not_signed_in' } },
  ]);
  assert.equal(groups.working.length, 1);
  assert.equal(groups.cooling.length, 1);
  assert.equal(groups.expired.length, 1);
});

test('network collection skips loopback and Tailscale from the LAN list', () => {
  const info = collectNetworkInfo({
    interfaces: {
      'Wi-Fi': [
        { family: 'IPv4', internal: false, address: '192.168.1.5' },
        { family: 'IPv6', internal: false, address: 'fe80::1' },
      ],
      Loopback: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }],
      tailscale0: [{ family: 'IPv4', internal: false, address: '100.101.102.103' }],
    },
    tailscale: { dnsName: 'box.tail.ts.net' },
  });
  assert.deepEqual(info.lan, ['192.168.1.5']);
  assert.equal(info.tailscale.dnsName, 'box.tail.ts.net');
});

test('narrow coloured output never leaks a half escape sequence', () => {
  const text = renderStartup(fixture(), { style: createStyle({ color: true }), width: 60 });
  for (const line of text.split('\n')) {
    const plain = stripAnsi(line);
    assert.ok(!plain.includes('\u001b'), 'raw escape left behind');
    assert.ok(!/\[\d+(?:;\d+)*m/.test(plain), `broken sequence: ${plain}`);
    assert.ok(plain.length <= 60, `line too wide (${plain.length}): ${plain}`);
  }
});

test('formatting helpers keep columns predictable', () => {
  assert.equal(formatTokens(890880), '890,880');
  assert.equal(truncate('abcdef', 4), 'abc…');
  assert.equal(truncate('abc', 4), 'abc');
  assert.equal(visibleLength('\u001b[32mok\u001b[0m'), 2);
  const cut = truncate('\u001b[32mabcdef\u001b[0m', 4);
  assert.equal(visibleLength(cut), 4);
  assert.match(cut, /\u001b\[32m/);
  assert.match(cut, /\u001b\[0m$/);
});
