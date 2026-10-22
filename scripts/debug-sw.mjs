#!/usr/bin/env node
/* Attach to the extension service worker, trigger one chat request and print
 * everything the worker logs or throws. */
import { connect, listTargets, loadConfig } from './cdp-debug-imports.mjs';

const config = loadConfig();
const targets = await listTargets(9333);
const sw = targets.find((t) => t.type === 'service_worker' && t.url.endsWith('/sw.js'));
if (!sw) {
  console.error('no service worker target');
  process.exit(1);
}

const conn = await connect(sw.webSocketDebuggerUrl);
conn.onEvent((msg) => {
  if (msg.method === 'Runtime.consoleAPICalled') {
    const args = (msg.params.args || []).map((a) => a.value ?? a.description ?? a.type).join(' ');
    console.log(`[console.${msg.params.type}]`, args);
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    console.log('[exception]', msg.params.exceptionDetails?.exception?.description || msg.params.exceptionDetails?.text);
  }
  if (msg.method === 'Log.entryAdded') {
    console.log(`[log.${msg.params.entry.level}]`, msg.params.entry.text);
  }
});
await conn.send('Runtime.enable');
await conn.send('Log.enable');
console.log('attached to', sw.url);

console.log('firing request…');
const res = await fetch(`http://127.0.0.1:${config.port}/v1/chat/completions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${config.key}` },
  body: JSON.stringify({ model: 'deepseek-chat', stream: true, messages: [{ role: 'user', content: 'Reply with exactly: PROBE' }] }),
});
console.log('HTTP', res.status);
const text = await res.text();
console.log(text.slice(0, 1200));
await new Promise((r) => setTimeout(r, 2000));
conn.close();
