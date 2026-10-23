#!/usr/bin/env node
/*
 * End-to-end test against a real Chrome instance.
 *
 *   scripts/chrome-test.sh                       # launch throwaway Chrome
 *   node scripts/live-test.mjs --token <token>   # load extension, sign in, chat
 *
 * Options: --prompt "..." --model deepseek-reasoner --devtools 9333
 */
import { browserCommand, connect, evaluate, listTargets, waitFor } from './cdp.mjs';
import { loadConfig } from '../src/config.js';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const take = (name, fallback) => {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};

const DEVTOOLS = Number(take('--devtools', 9333));
const EXTENSION_PATH = take('--extension', fileURLToPath(new URL('../extension', import.meta.url)));
const config = loadConfig();
const token = take('--token', process.env.DS_TOKEN || '');
const prompt = take('--prompt', 'Reply with exactly: BRIDGE OK');
const model = take('--model', 'deepseek-reasoner');
const imagePath = take('--image', '');
const debug = args.includes('--debug') ? (args.splice(args.indexOf('--debug'), 1), true) : false;
const timeoutMs = Number(take('--timeout', 180000));

const IMAGE_MIME = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  avif: 'image/avif',
  bmp: 'image/bmp',
};

const log = (s) => console.log(`\x1b[2m•\x1b[0m ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findSw() {
  return (await listTargets(DEVTOOLS)).find((t) => t.type === 'service_worker' && t.url.endsWith('/sw.js'));
}

async function ensureExtension() {
  let sw = await findSw();
  if (!sw) {
    const { id } = await browserCommand(DEVTOOLS, 'Extensions.loadUnpacked', { path: EXTENSION_PATH });
    log(`loaded unpacked extension ${id}`);
    sw = await waitFor(findSw, { label: 'extension service worker', timeout: 15000 });
  }
  return sw;
}

async function configure(sw) {
  const conn = await connect(sw.webSocketDebuggerUrl);
  const payload = JSON.stringify({
    port: config.port,
    key: config.key,
    bridgeHost: '127.0.0.1',
    autoOpenTab: true,
  });
  // The service worker may still be booting right after load; retry until the
  // write is observable.
  await waitFor(
    async () => {
      const res = await conn.send('Runtime.evaluate', {
        expression: `chrome.storage.local.set(${payload}).then(() => chrome.storage.local.get('key')).then(v => v.key)`,
        awaitPromise: true,
        returnByValue: true,
      });
      if (res.exceptionDetails) return false;
      return res.result.value === config.key;
    },
    { label: 'extension storage', timeout: 15000 },
  );
  log('storage configured');
  // Wake the socket (sendMessage does not loop back to the sender, so poke the
  // reconnect path through storage.onChanged instead).
  await conn.send('Runtime.evaluate', {
    expression: `chrome.storage.local.set({ reconfiguredAt: Date.now() }).then(() => 'ok')`,
    awaitPromise: true,
    returnByValue: true,
  });
  conn.close();
  await waitFor(
    async () => {
      const r = await fetch(`http://127.0.0.1:${config.port}/health`).then((x) => x.json()).catch(() => null);
      return r?.extension ? r : null;
    },
    { label: 'bridge to see the extension', timeout: 20000 },
  );
  log('bridge sees the extension');
}

async function ensureTab() {
  const pages = (await listTargets(DEVTOOLS)).filter((t) => t.type === 'page');
  let page = pages.find((t) => t.url.includes('chat.deepseek.com'));

  if (!page) {
    const { targetId } = await browserCommand(DEVTOOLS, 'Target.createTarget', { url: 'https://chat.deepseek.com/' });
    await waitFor(
      async () => (await listTargets(DEVTOOLS)).find((t) => t.id === targetId && t.type === 'page' && t.url.includes('deepseek')),
      { label: 'deepseek tab', timeout: 20000 },
    );
    page = (await listTargets(DEVTOOLS)).find((t) => t.id === targetId);
    log('opened chat.deepseek.com');
  }

  if (token) {
    // The target can exist before its document does; wait for a real origin.
    await waitFor(
      async () => {
        try {
          return await evaluate(page, `location.origin === 'https://chat.deepseek.com'`);
        } catch {
          return false;
        }
      },
      { label: 'deepseek origin', timeout: 30000 },
    );
    const current = await evaluate(page, `(() => { try { return JSON.parse(localStorage.getItem('userToken')||'{}').value || ''; } catch { return ''; } })()`);
    if (current !== token) {
      await evaluate(page, `localStorage.setItem('userToken', ${JSON.stringify(JSON.stringify({ value: token, __version: '0' }))}); 'ok'`);
      log('token injected, reloading');
      const conn = await connect(page.webSocketDebuggerUrl);
      await conn.send('Page.reload');
      conn.close();
      await sleep(3000);
    }
  }

  // Wait until the content script answers from the SW side.
  const sw = await findSw();
  const conn = await connect(sw.webSocketDebuggerUrl);
  const ok = await waitFor(
    async () => {
      const r = await conn.send('Runtime.evaluate', {
        expression: `(async () => {
          const tabs = await chrome.tabs.query({url:'https://chat.deepseek.com/*'});
          for (const t of tabs) { try { const p = await chrome.tabs.sendMessage(t.id,{type:'ds.ping'}); if (p?.ok) return p; } catch {} }
          return null;
        })()`,
        awaitPromise: true,
        returnByValue: true,
      });
      return r.result.value;
    },
    { label: 'content script', timeout: 30000 },
  );
  conn.close();
  log(`content script ready (signedIn=${ok.signedIn})`);
  if (!ok.signedIn) throw new Error('content script is not signed in');
}

async function chat() {
  const t0 = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let contentValue = prompt;
  if (imagePath) {
    const ext = imagePath.split('.').pop()?.toLowerCase() || 'png';
    const mime = IMAGE_MIME[ext];
    if (!mime) throw new Error(`unsupported image extension: ${ext}`);
    const b64 = fs.readFileSync(imagePath).toString('base64');
    contentValue = [
      { type: 'text', text: prompt },
      { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } },
    ];
    log(`image ${imagePath} (${Math.round(b64.length * 0.75 / 1024)}k)`);
  }

  const res = await fetch(`http://127.0.0.1:${config.port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${config.key}` },
    body: JSON.stringify({
      model,
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: 'user', content: contentValue }],
      debug,
    }),
    signal: controller.signal,
  });
  log(`HTTP ${res.status} (${Date.now() - t0}ms)`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let reasoning = '';
  let usage = null;
  let firstDeltaAt = null;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let i;
    while ((i = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, i);
      buffer = buffer.slice(i + 2);
      for (const line of block.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        let evt;
        try {
          evt = JSON.parse(data);
        } catch {
          continue;
        }
        if (evt.error) throw new Error(evt.error.message);
        if (evt.usage) usage = evt.usage;
        const d = evt.choices?.[0]?.delta;
        if (d?.reasoning_content) {
          if (!firstDeltaAt) firstDeltaAt = Date.now() - t0;
          reasoning += d.reasoning_content;
          process.stdout.write(`\x1b[2m${d.reasoning_content}\x1b[0m`);
        }
        if (d?.content) {
          if (!firstDeltaAt) firstDeltaAt = Date.now() - t0;
          if (reasoning && !content) process.stdout.write('\n\n');
          content += d.content;
          process.stdout.write(d.content);
        }
        if (d?.tool_calls) process.stdout.write(`\n[tool_calls] ${JSON.stringify(d.tool_calls)}\n`);
      }
    }
  }
  clearTimeout(timer);

  console.log('\n');
  log(`first token ${firstDeltaAt}ms, total ${Date.now() - t0}ms`);
  log(`usage ${JSON.stringify(usage)}`);
  if (!content.trim()) throw new Error('empty completion');
  console.log(`\x1b[32mPASS\x1b[0m`);
  return { content, reasoning, usage };
}

async function main() {
  const sw = await ensureExtension();
  log(`extension ${new URL(sw.url).host}`);
  await configure(sw);
  await ensureTab();
  await chat();
}

main().catch((err) => {
  console.error(`\n\x1b[31mFAIL\x1b[0m ${err.stack || err}`);
  process.exit(1);
});
