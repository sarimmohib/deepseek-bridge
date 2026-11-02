import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// The bridge re-reads config.json on every request, so the probe needs a real
// config file in an isolated home before the module is imported.
const KEY = `sk-ds-${'a'.repeat(32)}`;
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsb-auth-'));
fs.writeFileSync(
  path.join(home, 'config.json'),
  JSON.stringify({ key: KEY, defaultModel: 'deepseek-reasoner', toolMode: 'auto', maxUpstream: 1 }),
);
process.env.DS_BRIDGE_HOME = home;

const { createServer } = await import('../src/server.js');

const config = { key: KEY, defaultModel: 'deepseek-reasoner', toolMode: 'auto', maxUpstream: 1 };
const store = {
  data: { conversations: {} },
  getConversation: () => null,
  setConversation: () => {},
  deleteConversation: () => {},
  flush: () => {},
};
const { server } = createServer({ config, store, log: () => {} });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

test.after(() => {
  server.close();
  fs.rmSync(home, { recursive: true, force: true });
});

function request(pathname, headers = {}, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method, headers }, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

// `/v1/bridge/log` and `DELETE /v1/conversations/:key` were registered ABOVE the
// `if (!authorized)` gate, and CORS is '*'. Any web page could therefore read
// the bridge log (account ids, upstream errors) with a plain fetch. These two
// assert the routes are gated, and that the legitimate key still works.
test('the bridge log requires the API key', async () => {
  const anon = await request('/v1/bridge/log');
  assert.equal(anon.status, 401);
  assert.doesNotMatch(anon.body, /"lines"/);

  const authorized = await request('/v1/bridge/log', { authorization: `Bearer ${KEY}` });
  assert.equal(authorized.status, 200);
  assert.match(authorized.body, /"lines"/);
});

test('deleting a conversation requires the API key', async () => {
  const anon = await request('/v1/conversations/abc', {}, 'DELETE');
  assert.equal(anon.status, 401);
});

test('/health stays public so a client can probe readiness', async () => {
  const res = await request('/health');
  assert.equal(res.status, 200);
});
