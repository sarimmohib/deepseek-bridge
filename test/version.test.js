import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  VERSION,
  compareVersions,
  fetchLatestVersion,
  isNewer,
  readLocalVersion,
} from '../src/version.js';

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('local version comes from package.json', () => {
  assert.equal(VERSION, pkg.version);
  assert.equal(readLocalVersion(), pkg.version);
});

test('semver comparison orders releases and prereleases', () => {
  assert.equal(compareVersions('0.4.0', '0.3.9'), 1);
  assert.equal(compareVersions('0.4.0', '0.4.0'), 0);
  assert.equal(compareVersions('v0.4.0', '0.4.0'), 0);
  assert.equal(compareVersions('0.4.0-beta.1', '0.4.0'), -1);
  assert.equal(compareVersions('0.4.0-beta.2', '0.4.0-beta.1'), 1);
  assert.equal(compareVersions('0.4.0-rc.1', '0.4.0-beta.9'), 1);
  assert.equal(isNewer('0.4.0', '0.3.0'), true);
  assert.equal(isNewer('0.3.0', '0.4.0'), false);
});

test('invalid versions fail instead of silently comparing equal', () => {
  assert.throws(() => compareVersions('not-a-version', '0.4.0'), /Invalid version/);
});

test('fetchLatestVersion reads the package version without an API token', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    assert.match(String(url), /raw\.githubusercontent\.com\/sarimmohib\/deepseek-bridge\/main\/package\.json/);
    assert.equal(options.cache, 'no-store');
    return new Response(JSON.stringify({ version: '9.8.7' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  try {
    const latest = await fetchLatestVersion();
    assert.equal(latest.version, '9.8.7');
  } finally {
    globalThis.fetch = original;
  }
});

test('fetchLatestVersion reports GitHub failures clearly', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('nope', { status: 503 });
  try {
    await assert.rejects(fetchLatestVersion(), /HTTP 503/);
  } finally {
    globalThis.fetch = original;
  }
});
