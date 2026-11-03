import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { buildFrame, renderConversations } from '../src/modelinfo.js';
import { attachWebSocket } from '../src/ws.js';

// modelinfo.js referenced VERSION and PREVIEW_WIDTH without importing or
// declaring them, so both entry points threw on the first call.
test('buildFrame renders instead of throwing ReferenceError', () => {
  const out = buildFrame({ cfg: { port: 8787 } }, 100);
  assert.equal(typeof out, 'string');
  assert.ok(out.length > 0);
});

test('renderConversations renders a wide-terminal row', () => {
  const out = renderConversations({
    conversations: [
      { key: 'abc', model: 'deepseek-reasoner', turns: 2, updatedAt: Date.now(), preview: 'hi' },
    ],
    width: 100,
  });
  assert.match(out, /KEY/);
  assert.match(out, /hi/);
});

// The upgrade handler parsed req.url with new URL() before any auth check. A
// malformed request-target threw out of the listener: the socket was neither
// answered nor destroyed, and the daemon died without the uncaughtException
// guard. It must answer 400 and destroy.
test('a malformed upgrade request-target gets 400 instead of throwing', async () => {
  const server = http.createServer();
  attachWebSocket(server, { path: '/agent', onConnection: () => {} });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  const status = await new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: '//',
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
      },
    });
    req.on('upgrade', (_res, socket) => {
      socket.destroy();
      resolve('upgraded');
    });
    req.on('response', (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', (err) => resolve(`err:${err.code}`));
    req.end();
  });

  server.close();
  assert.equal(status, 400);
});
