const $ = (id) => document.getElementById(id);

const dot = $('dot');
const statusBox = $('status');

// Track which inputs the user has touched so the periodic refresh below never
// overwrites a value that is still being typed or pasted.
const FIELDS = ['host', 'port', 'key'];
const touched = new Set();
for (const id of FIELDS) {
  $(id).addEventListener('input', () => touched.add(id));
  $(id).addEventListener('paste', () => touched.add(id));
}

function fillFromStorage(stored) {
  if (!touched.has('host')) $('host').value = stored.bridgeHost;
  if (!touched.has('port')) $('port').value = stored.port;
  if (!touched.has('key')) $('key').value = stored.key;
}

function setDot(kind) {
  dot.className = kind === 'ok' ? 'ok' : kind === 'wait' ? 'wait' : '';
}

async function refresh() {
  const stored = await chrome.storage.local.get({ port: 8787, key: '', bridgeHost: '127.0.0.1' });
  fillFromStorage(stored);

  const status = await chrome.runtime.sendMessage({ type: 'ds.status' }).catch(() => null);
  if (!status) {
    setDot('bad');
    statusBox.textContent = 'service worker unavailable';
    return;
  }
  if (!status.config?.hasKey) {
    setDot('wait');
    statusBox.textContent = 'No API key yet.\nRun: node bin/ds-bridge.js\nThen paste the key above and press Save & connect.';
    return;
  }
  if (status.connected) {
    setDot('ok');
    statusBox.textContent = `connected to ws://${status.config.host}:${status.config.port}/agent`;
  } else {
    setDot('bad');
    statusBox.textContent = `not connected to ws://${status.config.host}:${status.config.port}/agent\n${
      status.lastError ? `last error: ${status.lastError}\n` : ''
    }Is ds-bridge running?`;
  }

  // Is the DeepSeek tab signed in?
  const tabs = await chrome.tabs.query({ url: 'https://chat.deepseek.com/*' });
  if (tabs.length) {
    const ping = await chrome.tabs.sendMessage(tabs[0].id, { type: 'ds.ping' }).catch(() => null);
    if (ping) statusBox.textContent += `\ntab: ${ping.signedIn ? 'signed in' : 'NOT signed in'}`;
  } else {
    statusBox.textContent += '\ntab: none open (one will open on first request)';
  }
}

$('save').addEventListener('click', async () => {
  const port = Number($('port').value) || 8787;
  const key = $('key').value.trim();
  const bridgeHost = $('host').value.trim() || '127.0.0.1';
  await chrome.storage.local.set({ port, key, bridgeHost });
  touched.clear();
  await chrome.runtime.sendMessage({ type: 'ds.reconnect' }).catch(() => {});
  setTimeout(refresh, 600);
});

$('open').addEventListener('click', async () => {
  const tabs = await chrome.tabs.query({ url: 'https://chat.deepseek.com/*' });
  if (tabs.length) {
    await chrome.tabs.update(tabs[0].id, { active: true });
    await chrome.windows.update(tabs[0].windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: 'https://chat.deepseek.com/' });
  }
});

refresh();
setInterval(refresh, 1500);
