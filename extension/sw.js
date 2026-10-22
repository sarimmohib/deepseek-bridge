/*
 * DeepSeek Bridge — service worker.
 *
 * Holds a WebSocket to the local bridge, dispatches jobs to the content script
 * running on chat.deepseek.com, and solves proof-of-work challenges inline.
 */

import { solveChallenge } from './pow.js';

const DEFAULTS = { port: 8787, key: '', autoOpenTab: true, bridgeHost: '127.0.0.1' };

let ws = null;
let reconnectTimer = null;
let backoff = 500;
let config = { ...DEFAULTS };
let lastError = null;
let connectedAt = null;

const state = {
  get connected() {
    return ws && ws.readyState === WebSocket.OPEN;
  },
};

async function readConfig() {
  const stored = await chrome.storage.local.get(DEFAULTS);
  config = { ...DEFAULTS, ...stored };
  return config;
}

function send(obj) {
  if (!state.connected) return false;
  try {
    ws.send(JSON.stringify(obj));
    return true;
  } catch {
    return false;
  }
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  const delay = Math.min(backoff, 15000);
  backoff = Math.min(backoff * 2, 15000);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

async function connect() {
  await readConfig();
  if (!config.key) {
    lastError = 'no-key';
    return;
  }
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  const url = `ws://${config.bridgeHost}:${config.port}/agent?key=${encodeURIComponent(config.key)}`;
  let socket;
  try {
    socket = new WebSocket(url);
  } catch (err) {
    lastError = String(err?.message || err);
    scheduleReconnect();
    return;
  }
  ws = socket;

  // Generations matter: a storage change or manual reconnect can replace `ws`
  // while the previous socket is still closing. Stale handlers must never
  // clobber the live connection, or the bridge ends up holding a socket the
  // worker no longer references.
  const isCurrent = () => ws === socket;

  socket.onopen = async () => {
    if (!isCurrent()) return;
    backoff = 500;
    connectedAt = Date.now();
    lastError = null;
    const info = await chrome.storage.local.get(['lastUser']);
    if (!isCurrent()) return;
    send({
      type: 'hello',
      version: chrome.runtime.getManifest().version,
      user: info.lastUser || null,
      capabilities: { vision: true, files: true, usage: true, batch: true },
    });
  };

  socket.onmessage = (event) => {
    if (!isCurrent()) return;
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    if (msg.type === 'ping') {
      send({ type: 'pong', at: Date.now() });
      return;
    }
    if (msg.type === 'job') handleJob(msg);
    if (msg.type === 'job.cancel') cancelJob(msg.id);
    if (msg.type === 'reload-extension') reloadExtension();
  };

  socket.onclose = (event) => {
    if (!isCurrent()) return;
    console.log('[bridge] ws closed', event.code, event.reason || '');
    connectedAt = null;
    ws = null;
    scheduleReconnect();
  };

  socket.onerror = () => {
    if (isCurrent()) lastError = 'socket-error';
  };
}

/* ---------------------------------------------------------------- jobs --- */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pingTab(tabId) {
  try {
    const pong = await chrome.tabs.sendMessage(tabId, { type: 'ds.ping' });
    return Boolean(pong?.ok);
  } catch {
    return false;
  }
}

async function waitForContentScript(tabId, attempts = 60) {
  for (let i = 0; i < attempts; i++) {
    if (await pingTab(tabId)) return true;
    await sleep(250);
  }
  return false;
}

async function ensureTab() {
  const tabs = await chrome.tabs.query({ url: 'https://chat.deepseek.com/*' });

  // Prefer a tab that already has a live content script.
  for (const tab of tabs) {
    if (tab.discarded) continue;
    if (await pingTab(tab.id)) return tab.id;
  }

  // A tab may be mid-navigation. Give it a moment, then reload it once.
  for (const tab of tabs) {
    if (await waitForContentScript(tab.id, 40)) return tab.id;
    await chrome.tabs.reload(tab.id).catch(() => {});
    if (await waitForContentScript(tab.id, 80)) return tab.id;
  }

  if (!config.autoOpenTab) throw new Error('No usable chat.deepseek.com tab is open.');

  const tab = await chrome.tabs.create({ url: 'https://chat.deepseek.com/', active: false, pinned: true });
  if (await waitForContentScript(tab.id, 120)) return tab.id;
  throw new Error('Opened chat.deepseek.com but the content script never loaded.');
}

async function dispatch(tabId, job) {
  console.log('[bridge] dispatch', job.id, 'to tab', tabId);
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await chrome.tabs.sendMessage(tabId, { type: 'ds.job', job });
      console.log('[bridge] dispatched', job.id);
      return;
    } catch (err) {
      lastError = err;
      await sleep(400);
      if (await pingTab(tabId)) continue;
      await chrome.tabs.reload(tabId).catch(() => {});
      await waitForContentScript(tabId, 80);
    }
  }
  throw lastError || new Error('could not reach the content script');
}

async function handleJob(job) {
  const { id, payload } = job;
  send({ type: 'job.accepted', id });
  try {
    const tabId = await ensureTab();
    await dispatch(tabId, job);
  } catch (err) {
    send({ type: 'job.error', id, message: String(err?.message || err), code: 'dispatch_failed' });
  }
}

function cancelJob(id) {
  chrome.tabs.query({ url: 'https://chat.deepseek.com/*' }).then((tabs) => {
    for (const t of tabs) chrome.tabs.sendMessage(t.id, { type: 'ds.cancel', id }).catch(() => {});
  });
}

/* ---------------------------------------------------------- dev reload --- */

async function reloadExtension() {
  try {
    await chrome.storage.local.set({ reloadTabsOnStart: true });
  } catch {
    /* ignore */
  }
  setTimeout(() => chrome.runtime.reload(), 150);
}

async function reloadTabsIfRequested() {
  try {
    const { reloadTabsOnStart } = await chrome.storage.local.get('reloadTabsOnStart');
    if (!reloadTabsOnStart) return;
    await chrome.storage.local.remove('reloadTabsOnStart');
    const tabs = await chrome.tabs.query({ url: 'https://chat.deepseek.com/*' });
    for (const tab of tabs) chrome.tabs.reload(tab.id).catch(() => {});
  } catch {
    /* ignore */
  }
}

reloadTabsIfRequested();

/* ----------------------------------------------------------------- pow --- */

/**
 * Solve a PoW challenge inline. The site's hash is a slow JS port, so this
 * blocks the event loop for roughly a second; that is still far cheaper than
 * spawning an offscreen document, which Chrome tears down mid-job whenever the
 * debugger is not attached.
 */
function solvePow(challenge) {
  const started = Date.now();
  try {
    const answer = solveChallenge(challenge);
    return Promise.resolve({ answer, ms: Date.now() - started });
  } catch (err) {
    return Promise.reject(new Error(String(err?.message || err)));
  }
}

/* --------------------------------------------------------------- wiring --- */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'ds.event') {
    send(msg.event);
    sendResponse({ ok: true });
    return false;
  }
  if (msg?.type === 'ds.pow') {
    solvePow(msg.challenge)
      .then((res) => sendResponse({ ok: true, answer: res.answer, ms: res.ms }))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
  }
  if (msg?.type === 'ds.user') {
    chrome.storage.local.set({ lastUser: msg.user || null });
    return false;
  }
  if (msg?.type === 'ds.reconnect') {
    backoff = 500;
    if (ws) ws.close();
    ws = null;
    connect();
    sendResponse({ ok: true });
    return false;
  }
  if (msg?.type === 'ds.status') {
    sendResponse({
      connected: !!state.connected,
      connectedAt,
      lastError,
      config: { port: config.port, host: config.bridgeHost, hasKey: !!config.key },
    });
    return false;
  }
  return false;
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.port || changes.key || changes.bridgeHost) {
    if (ws) ws.close();
    ws = null;
    backoff = 500;
    connect();
  }
});

chrome.runtime.onInstalled.addListener(() => connect());
chrome.runtime.onStartup.addListener(() => connect());

chrome.alarms.create('ds-bridge-keepalive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'ds-bridge-keepalive') connect();
});

connect();
