/*
 * src/dashboard.js — self-contained dashboard served at GET /.
 *
 * One exported string: a complete HTML page with inline CSS + vanilla JS.
 * Zero dependencies, zero external requests (no CDNs, fonts, or images).
 * The API key lives in localStorage only and is sent as a Bearer header.
 *
 * The page JS deliberately avoids template literals, backticks and
 * backslashes so this whole file can be one safe backtick template.
 */

export const dashboardHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>deepseek-bridge dashboard</title>
<style>
  :root {
    --bg: #0d0f14;
    --card: #141821;
    --card2: #10141c;
    --border: #232733;
    --text: #e8ebf2;
    --muted: #8b93a7;
    --accent: #4d6bfe;
    --accent-soft: rgba(77, 107, 254, 0.14);
    --amber: #e3b341;
    --green: #3fb950;
    --red: #f16a6a;
    --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    background: var(--bg);
    color: var(--text);
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .mono { font-family: var(--mono); }
  .hidden { display: none !important; }
  .muted { color: var(--muted); font-weight: 400; font-size: 11.5px; }

  /* ---------- header ---------- */
  header {
    position: sticky;
    top: 0;
    z-index: 40;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    padding: 10px 20px;
    background: rgba(13, 15, 20, 0.9);
    backdrop-filter: blur(10px);
    border-bottom: 1px solid var(--border);
  }
  .brand { font-weight: 700; font-size: 15px; letter-spacing: 0.2px; }
  .chip {
    font-size: 11px;
    padding: 2px 9px;
    border-radius: 999px;
    border: 1px solid var(--border);
    color: var(--muted);
    background: var(--card);
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }
  .chip.accent {
    color: #9db1ff;
    border-color: rgba(77, 107, 254, 0.5);
    background: var(--accent-soft);
  }
  .chip.amber {
    color: var(--amber);
    border-color: rgba(227, 179, 65, 0.45);
    background: rgba(227, 179, 65, 0.12);
  }
  .dot { width: 9px; height: 9px; border-radius: 50%; background: #4a5163; flex: none; }
  .dot.up { background: var(--green); box-shadow: 0 0 6px rgba(63, 185, 80, 0.7); }
  .dot.down { background: var(--red); box-shadow: 0 0 6px rgba(241, 106, 106, 0.6); }
  .spacer { flex: 1 1 auto; }

  /* ---------- layout ---------- */
  main { max-width: 1080px; margin: 0 auto; padding: 20px; display: flex; flex-direction: column; gap: 22px; }
  section h2 {
    margin: 0 0 10px;
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 1.2px;
    color: var(--muted);
  }
  .card {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 14px 16px;
  }
  .empty { color: var(--muted); font-size: 13px; padding: 6px 2px; }

  /* ---------- buttons & inputs ---------- */
  .btn {
    background: var(--card2);
    border: 1px solid var(--border);
    color: var(--text);
    border-radius: 8px;
    padding: 7px 12px;
    font-size: 12.5px;
    font-family: inherit;
    cursor: pointer;
    transition: border-color 0.15s, background 0.15s, color 0.15s;
  }
  .btn:hover { border-color: var(--accent); color: #cdd7ff; }
  .btn:focus-visible { outline: 2px solid rgba(77, 107, 254, 0.55); outline-offset: 1px; }
  .btn.ok { border-color: var(--green); color: var(--green); }
  .btn.armed { border-color: var(--red); color: var(--red); background: rgba(241, 106, 106, 0.12); }
  .btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  .btn.primary:hover { background: #3d59e0; color: #fff; }
  input, select {
    background: var(--card2);
    border: 1px solid var(--border);
    color: var(--text);
    border-radius: 8px;
    padding: 7px 10px;
    font-size: 13px;
    font-family: inherit;
    outline: none;
  }
  input:focus, select:focus { border-color: var(--accent); }

  /* ---------- models ---------- */
  .models-row {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
    gap: 12px;
  }
  .model-card { display: flex; flex-direction: column; gap: 8px; }
  .model-card.def {
    border-color: rgba(77, 107, 254, 0.55);
    box-shadow: inset 0 0 0 1px rgba(77, 107, 254, 0.2);
  }
  .model-head { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .model-id { font-weight: 700; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .star { color: var(--amber); font-size: 11px; white-space: nowrap; }
  .model-desc {
    color: var(--muted);
    font-size: 12px;
    line-height: 1.45;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .model-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 14px;
    font-size: 11px;
    color: var(--muted);
    font-variant-numeric: tabular-nums;
  }
  .model-card .btn { align-self: flex-start; margin-top: 2px; }

  /* ---------- conversations ---------- */
  .toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 12px; }
  #search { flex: 1 1 170px; min-width: 150px; }
  .count { margin-left: auto; font-size: 12px; color: var(--muted); white-space: nowrap; font-variant-numeric: tabular-nums; }
  .table-wrap {
    border: 1px solid var(--border);
    border-radius: 12px;
    background: var(--card);
    overflow: auto;
    max-height: 560px;
  }
  table { width: 100%; border-collapse: collapse; font-size: 13px; min-width: 700px; }
  thead th {
    position: sticky;
    top: 0;
    z-index: 2;
    background: var(--card2);
    text-align: left;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.8px;
    color: var(--muted);
    padding: 9px 12px;
    border-bottom: 1px solid var(--border);
    white-space: nowrap;
  }
  tbody td { padding: 8px 12px; border-bottom: 1px solid rgba(35, 39, 51, 0.6); vertical-align: middle; }
  tbody tr:hover { background: rgba(77, 107, 254, 0.06); }
  tbody tr:last-child td { border-bottom: none; }
  th.num, td.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .pv { max-width: 340px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .mdl { font-size: 12px; color: #b9c2d8; }
  .act { width: 40px; }
  tr.fading { opacity: 0.25; transition: opacity 0.3s; }
  tr.empty-row td { text-align: center; color: var(--muted); padding: 28px 12px; }
  .del {
    background: transparent;
    border: none;
    color: var(--muted);
    font-size: 13px;
    line-height: 1;
    padding: 3px 7px;
    border-radius: 6px;
    cursor: pointer;
  }
  .del:hover { color: var(--red); background: rgba(241, 106, 106, 0.12); }
  .more-row { display: flex; justify-content: center; margin-top: 10px; }

  /* ---------- log ---------- */
  details#log-panel { padding: 10px 16px 14px; }
  details#log-panel summary { cursor: pointer; user-select: none; font-size: 13px; font-weight: 600; }
  #log-pre {
    margin: 10px 0 0;
    background: #0a0c10;
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 12px;
    font-family: var(--mono);
    font-size: 12px;
    line-height: 1.55;
    color: #b6bfd4;
    max-height: 280px;
    overflow: auto;
    white-space: pre;
  }
  #log-pre::-webkit-scrollbar, .table-wrap::-webkit-scrollbar { width: 9px; height: 9px; }
  #log-pre::-webkit-scrollbar-thumb, .table-wrap::-webkit-scrollbar-thumb { background: #232733; border-radius: 5px; }

  footer { text-align: center; color: var(--muted); font-size: 11.5px; padding: 16px 12px 28px; opacity: 0.85; }

  /* ---------- unlock overlay ---------- */
  #unlock {
    position: fixed;
    inset: 0;
    z-index: 200;
    background: rgba(8, 10, 15, 0.82);
    backdrop-filter: blur(6px);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 16px;
  }
  .unlock-card { width: min(360px, 100%); display: flex; flex-direction: column; gap: 10px; }
  .unlock-card h2 { margin: 0; font-size: 16px; }
  .unlock-card p { margin: 0; font-size: 12px; color: var(--muted); }
  .unlock-card code {
    font-family: var(--mono);
    font-size: 11.5px;
    background: var(--card2);
    border: 1px solid var(--border);
    border-radius: 5px;
    padding: 1px 5px;
  }
  .unlock-card input { width: 100%; }
  .unlock-card .btn { width: 100%; }

  /* ---------- toasts ---------- */
  #toasts {
    position: fixed;
    right: 16px;
    bottom: 16px;
    z-index: 300;
    display: flex;
    flex-direction: column;
    gap: 8px;
    max-width: min(90vw, 340px);
  }
  .toast {
    background: #1a1f2b;
    border: 1px solid var(--border);
    border-left: 3px solid var(--accent);
    color: var(--text);
    border-radius: 10px;
    padding: 9px 13px;
    font-size: 12.5px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
    word-break: break-word;
    opacity: 1;
    transform: none;
    transition: opacity 0.3s, transform 0.3s;
  }
  .toast.ok { border-left-color: var(--green); }
  .toast.error { border-left-color: var(--red); }
  .toast.gone { opacity: 0; transform: translateY(6px); }

  @media (max-width: 640px) {
    header { padding: 10px 12px; gap: 6px; }
    .brand { font-size: 14px; }
    main { padding: 14px 12px; gap: 18px; }
    .pv { max-width: 200px; }
    .count { flex-basis: 100%; order: 9; margin-left: 0; }
  }
</style>
</head>
<body>
<header>
  <span class="dot" id="dot" title="checking"></span>
  <span class="brand">deepseek-bridge</span>
  <span class="chip" id="chip-version" title="bridge version">–</span>
  <span class="chip" id="chip-mode" title="bridge mode">–</span>
  <span class="chip mono" id="base-url" title="bridge base URL">–</span>
  <span class="chip" id="chip-upstream" title="upstream active/queued/max">upstream –/0/–</span>
  <span class="spacer"></span>
  <button class="btn" id="btn-refresh" type="button" title="refresh now">Refresh</button>
</header>
<main>
  <section>
    <h2>Models</h2>
    <div class="models-row" id="models-row"><div class="empty">Loading…</div></div>
  </section>
  <section>
    <h2>Conversations</h2>
    <div class="toolbar">
      <input id="search" type="search" placeholder="Search preview or model…" autocomplete="off">
      <select id="model-filter" title="filter by model"><option value="">All models</option></select>
      <select id="sort" title="sort conversations">
        <option value="recent">Recently updated</option>
        <option value="tokens">Most tokens</option>
        <option value="turns">Most turns</option>
      </select>
      <span class="count" id="count">showing 0 of 0</span>
      <button class="btn" id="btn-clear" type="button" title="delete every conversation">Clear all</button>
    </div>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th class="pv">Preview</th>
            <th>Model</th>
            <th class="num">Turns</th>
            <th class="num">In</th>
            <th class="num">Out</th>
            <th class="num">Session</th>
            <th class="num">Age</th>
            <th class="num act" aria-label="delete"></th>
          </tr>
        </thead>
        <tbody id="conv-body">
          <tr class="empty-row"><td colspan="8">No conversations yet.</td></tr>
        </tbody>
      </table>
    </div>
    <div class="more-row"><button class="btn hidden" id="btn-more" type="button">show 100 more</button></div>
  </section>
  <section>
    <details id="log-panel" open>
      <summary>Bridge log <span class="muted">(last 40 lines, newest last)</span></summary>
      <pre id="log-pre"> </pre>
    </details>
  </section>
</main>
<footer>loopback-only · API key stays in your browser</footer>
<div id="toasts"></div>
<div id="unlock" class="hidden">
  <div class="unlock-card card">
    <h2>Unlock dashboard</h2>
    <p>Paste the bridge API key — run <code>deepseek key</code> to show it.
    It is stored in this browser only and sent as a Bearer header.</p>
    <input id="key-input" type="password" placeholder="API key" autocomplete="off">
    <button class="btn primary" id="btn-save" type="button">Save</button>
  </div>
</div>
<script>
(function () {
  'use strict';
  var NL = String.fromCharCode(10);
  var MODEL_NAMES = {
    'deepseek-reasoner': 'DeepSeek V4.1 Flash Reasoner (web)',
    'deepseek-search': 'DeepSeek V4.1 Flash Search (web)'
  };
  var state = {
    key: '',
    health: null,
    status: null,
    convos: [],
    models: [],
    log: [],
    search: '',
    model: '',
    sort: 'recent',
    limit: 100,
    armed: false,
    armTimer: null,
    filterSig: null,
    modelsSig: null,
    lastPollErr: 0
  };
  try { state.key = localStorage.getItem('dsb.key') || ''; } catch (e) {}

  function $(id) { return document.getElementById(id); }

  function esc(s) {
    if (s === null || s === undefined) return '';
    return String(s)
      .split('&').join('&amp;')
      .split('<').join('&lt;')
      .split('>').join('&gt;')
      .split('"').join('&quot;')
      .split("'").join('&#39;');
  }
  function num(v) { return typeof v === 'number' && isFinite(v) ? v : 0; }
  function fmtNum(v) { return typeof v === 'number' && isFinite(v) ? v.toLocaleString('en-US') : '–'; }
  function dash(v) { return v === null || v === undefined || v === '' ? '–' : v; }
  function fmtAge(ms) {
    if (typeof ms !== 'number' || !isFinite(ms)) return '–';
    var s = Math.max(0, (Date.now() - ms) / 1000);
    if (s < 60) return Math.floor(s) + 's';
    if (s < 3600) return Math.floor(s / 60) + 'm';
    if (s < 86400) return Math.floor(s / 3600) + 'h';
    return Math.floor(s / 86400) + 'd';
  }

  /* ---------------- toasts ---------------- */
  function toast(msg, kind) {
    var box = $('toasts');
    var t = document.createElement('div');
    t.className = 'toast' + (kind ? ' ' + kind : '');
    t.textContent = msg;
    box.appendChild(t);
    while (box.children.length > 5) box.removeChild(box.firstChild);
    setTimeout(function () {
      t.classList.add('gone');
      setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 350);
    }, 2500);
  }

  /* ---------------- api ---------------- */
  function clearKey() {
    state.key = '';
    try { localStorage.removeItem('dsb.key'); } catch (e) {}
    showUnlock();
  }
  function api(path, opts) {
    opts = opts || {};
    var headers = {};
    if (state.key) headers['Authorization'] = 'Bearer ' + state.key;
    return fetch(path, { method: opts.method || 'GET', headers: headers }).then(function (res) {
      if (res.status === 401) {
        var had = !!state.key;
        clearKey();
        if (had) toast('Unauthorized — key cleared', 'error');
        throw new Error('unauthorized');
      }
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json().catch(function () { return {}; });
    });
  }
  function pollError(label, err) {
    if (!err || err.message === 'unauthorized') return;
    var now = Date.now();
    if (now - state.lastPollErr > 20000) {
      state.lastPollErr = now;
      toast(label + ': ' + err.message, 'error');
    }
  }

  /* ---------------- unlock ---------------- */
  function showUnlock() { $('unlock').classList.remove('hidden'); }
  function hideUnlock() { $('unlock').classList.add('hidden'); }
  function saveKey() {
    var v = $('key-input').value.trim();
    if (!v) { toast('Enter an API key first', 'error'); return; }
    state.key = v;
    try { localStorage.setItem('dsb.key', v); } catch (e) {}
    $('key-input').value = '';
    hideUnlock();
    toast('Key saved', 'ok');
    refreshAll();
  }

  /* ---------------- header ---------------- */
  function renderHeader() {
    var h = state.health;
    $('chip-version').textContent = h && h.version ? 'v' + h.version : '–';
    var mode = (h && h.mode) || (state.status && state.status.mode) || '';
    var cm = $('chip-mode');
    cm.textContent = mode || '–';
    cm.classList.toggle('accent', mode === 'direct');
    $('base-url').textContent = location.host || '–';
    var up = (h && h.upstream) || {};
    var q = num(up.queued);
    var badge = $('chip-upstream');
    badge.textContent = 'upstream ' + dash(up.active) + '/' + q + '/' + dash(up.max);
    badge.classList.toggle('amber', q > 0);
    var dot = $('dot');
    dot.className = 'dot ' + (h ? (h.ok ? 'up' : 'down') : '');
    dot.title = h && h.ok ? 'bridge is up' : 'bridge not responding';
  }

  /* ---------------- models ---------------- */
  function buildSnippet(m) {
    var id = m && m.id ? String(m.id) : '';
    var entry = {
      name: MODEL_NAMES[id] || id,
      family: 'deepseek',
      capabilities: {
        tools: true,
        input: ['text', 'image'],
        output: ['text'],
        reasoning: { supported: true, effort: ['low', 'high', 'max'] }
      },
      limit: {
        context: isFinite(Number(m && m.context_window)) ? Number(m.context_window) : 890880,
        output: isFinite(Number(m && m.max_output_tokens)) ? Number(m.max_output_tokens) : 131072
      }
    };
    var models = {};
    if (id) models[id] = entry;
    var c = state.status && state.status.config;
    var port = c && Number(c.port) ? Number(c.port) : (location.port ? Number(location.port) : 8787);
    return JSON.stringify({
      'deepseek-bridge': {
        name: 'DeepSeek Bridge',
        package: '@opencode/ai/providers/openai-compatible',
        settings: {
          baseURL: 'http://127.0.0.1:' + port + '/v1',
          apiKey: '{file:~/.config/deepseek-bridge/opencode.key}'
        },
        compatibility: { reasoningField: 'reasoning_content' },
        models: models
      }
    }, null, 2);
  }
  function copyText(text, btn) {
    function done() {
      toast('Copied to clipboard', 'ok');
      if (!btn) return;
      var old = btn.textContent;
      btn.textContent = 'Copied';
      btn.classList.add('ok');
      setTimeout(function () { btn.textContent = old; btn.classList.remove('ok'); }, 1500);
    }
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) {}
      document.body.removeChild(ta);
      if (ok) done();
      else toast('Copy failed', 'error');
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, fallback);
    } else {
      fallback();
    }
  }
  function renderModels() {
    var host = $('models-row');
    var def = state.status && state.status.config ? state.status.config.model : null;
    var sig = (def || '') + '#';
    var i, m;
    for (i = 0; i < state.models.length; i++) {
      m = state.models[i];
      sig += (m && m.id ? m.id : '') + '|' + num(m && m.context_window) + '|' +
        num(m && m.max_output_tokens) + '|' + (m && m.description ? m.description : '') + ';';
    }
    if (sig === state.modelsSig) return;
    state.modelsSig = sig;
    if (!state.models.length) {
      host.innerHTML = '<div class="empty">No models reported.</div>';
      return;
    }
    var html = '';
    for (i = 0; i < state.models.length; i++) {
      m = state.models[i];
      var isDef = def && m.id === def;
      html += '<div class="model-card' + (isDef ? ' def' : '') + '">'
        + '<div class="model-head"><span class="model-id mono">' + esc(m.id) + '</span>'
        + (isDef ? '<span class="star" title="default model (status.config.model)">★ default</span>' : '')
        + '</div>'
        + '<div class="model-desc">' + esc(dash(m.description)) + '</div>'
        + '<div class="model-meta"><span>ctx ' + fmtNum(m.context_window) + '</span>'
        + '<span>out ' + fmtNum(m.max_output_tokens) + '</span>'
        + '<span>' + esc(dash(m.owned_by)) + '</span></div>'
        + '<button class="btn" type="button" data-idx="' + i + '">Copy OpenCode config</button>'
        + '</div>';
    }
    host.innerHTML = html;
  }

  /* ---------------- conversations ---------------- */
  function filteredConvos() {
    var q = state.search.toLowerCase();
    var out = [];
    var i, c, hay;
    for (i = 0; i < state.convos.length; i++) {
      c = state.convos[i];
      if (state.model && c.model !== state.model) continue;
      if (q) {
        hay = ((c.preview || '') + ' ' + (c.model || '')).toLowerCase();
        if (hay.indexOf(q) < 0) continue;
      }
      out.push(c);
    }
    out.sort(function (a, b) {
      if (state.sort === 'tokens') return num(b.tokensIn) + num(b.tokensOut) - num(a.tokensIn) - num(a.tokensOut);
      if (state.sort === 'turns') return num(b.turns) - num(a.turns);
      return num(b.updatedAt) - num(a.updatedAt);
    });
    return out;
  }
  function renderModelFilter() {
    var seen = {};
    var names = [];
    var i, m;
    for (i = 0; i < state.convos.length; i++) {
      m = state.convos[i].model;
      if (m && !seen[m]) { seen[m] = true; names.push(m); }
    }
    names.sort();
    var sig = names.join('|');
    if (sig === state.filterSig) return;
    state.filterSig = sig;
    var sel = $('model-filter');
    while (sel.options.length) sel.remove(0);
    sel.add(new Option('All models', ''));
    for (i = 0; i < names.length; i++) sel.add(new Option(names[i], names[i]));
    if (state.model && !seen[state.model]) state.model = '';
    sel.value = state.model;
  }
  function renderConvos() {
    var list = filteredConvos();
    var shown = list.slice(0, state.limit);
    $('count').textContent = 'showing ' + shown.length + ' of ' + state.convos.length;
    $('btn-more').classList.toggle('hidden', list.length <= state.limit);
    if (!shown.length) {
      var msg = state.convos.length ? 'No conversations match the current filters.' : 'No conversations yet.';
      $('conv-body').innerHTML = '<tr class="empty-row"><td colspan="8">' + msg + '</td></tr>';
      return;
    }
    var rows = '';
    for (var i = 0; i < shown.length; i++) {
      var c = shown[i];
      var pv = c.preview === null || c.preview === undefined || c.preview === '' ? '(no preview)' : String(c.preview);
      var when = typeof c.updatedAt === 'number' && isFinite(c.updatedAt) ? new Date(c.updatedAt).toISOString() : '';
      rows += '<tr data-key="' + esc(c.key) + '">'
        + '<td class="pv" title="' + esc(pv) + '">' + esc(pv) + '</td>'
        + '<td class="mono mdl">' + esc(dash(c.model)) + '</td>'
        + '<td class="num">' + fmtNum(c.turns) + '</td>'
        + '<td class="num">' + fmtNum(c.tokensIn) + '</td>'
        + '<td class="num">' + fmtNum(c.tokensOut) + '</td>'
        + '<td class="num">' + fmtNum(c.sessionTokens) + '</td>'
        + '<td class="num" title="' + esc(when) + '">' + fmtAge(c.updatedAt) + '</td>'
        + '<td class="num act"><button class="del" type="button" title="delete conversation" aria-label="delete">✕</button></td>'
        + '</tr>';
    }
    $('conv-body').innerHTML = rows;
  }

  /* ---------------- log ---------------- */
  function renderLog() {
    var pre = $('log-pre');
    var pinned = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 24;
    pre.textContent = state.log.join(NL);
    if (pinned) pre.scrollTop = pre.scrollHeight;
  }

  /* ---------------- refresh loop ---------------- */
  function refreshFast() {
    api('/health').then(function (h) {
      state.health = h;
      renderHeader();
    }).catch(function (err) {
      state.health = null;
      renderHeader();
      pollError('health', err);
    });
    if (!state.key) return;
    api('/v1/bridge/status').then(function (s) {
      state.status = s;
      renderHeader();
      renderModels();
    }).catch(function (err) { pollError('status', err); });
    api('/v1/bridge/conversations').then(function (d) {
      state.convos = (d && d.conversations) || [];
      renderModelFilter();
      renderConvos();
    }).catch(function (err) { pollError('conversations', err); });
    api('/v1/models').then(function (d) {
      state.models = (d && d.data) || [];
      renderModels();
    }).catch(function (err) { pollError('models', err); });
  }
  function refreshLog() {
    if (!state.key) return;
    api('/v1/bridge/log?lines=40').then(function (d) {
      state.log = ((d && d.lines) || []).slice(-40);
      renderLog();
    }).catch(function (err) { pollError('log', err); });
  }
  function refreshAll() { refreshFast(); refreshLog(); }

  /* ---------------- events ---------------- */
  function disarm() {
    state.armed = false;
    var b = $('btn-clear');
    b.classList.remove('armed');
    b.textContent = 'Clear all';
    if (state.armTimer) { clearTimeout(state.armTimer); state.armTimer = null; }
  }
  function wire() {
    $('btn-refresh').addEventListener('click', refreshAll);
    $('btn-save').addEventListener('click', saveKey);
    $('key-input').addEventListener('keydown', function (e) { if (e.key === 'Enter') saveKey(); });
    $('search').addEventListener('input', function (e) { state.search = e.target.value; renderConvos(); });
    $('model-filter').addEventListener('change', function (e) { state.model = e.target.value; renderConvos(); });
    $('sort').addEventListener('change', function (e) { state.sort = e.target.value; renderConvos(); });
    $('btn-more').addEventListener('click', function () { state.limit += 100; renderConvos(); });
    $('models-row').addEventListener('click', function (ev) {
      var btn = ev.target && ev.target.closest ? ev.target.closest('button[data-idx]') : null;
      if (!btn) return;
      var m = state.models[parseInt(btn.getAttribute('data-idx'), 10)];
      if (m) copyText(buildSnippet(m), btn);
    });
    $('conv-body').addEventListener('click', function (ev) {
      var btn = ev.target && ev.target.closest ? ev.target.closest('button.del') : null;
      if (!btn) return;
      var tr = btn.closest('tr');
      var key = tr ? tr.getAttribute('data-key') : '';
      if (!key) return;
      tr.classList.add('fading');
      api('/v1/conversations/' + encodeURIComponent(key), { method: 'DELETE' }).then(function () {
        state.convos = state.convos.filter(function (c) { return c.key !== key; });
        toast('deleted', 'ok');
        renderConvos();
      }).catch(function (err) {
        tr.classList.remove('fading');
        if (err && err.message !== 'unauthorized') toast('Delete failed: ' + err.message, 'error');
      });
    });
    $('btn-clear').addEventListener('click', function () {
      if (!state.armed) {
        state.armed = true;
        var b = $('btn-clear');
        b.classList.add('armed');
        b.textContent = 'Confirm clear?';
        state.armTimer = setTimeout(disarm, 3000);
        return;
      }
      disarm();
      api('/v1/conversations', { method: 'DELETE' }).then(function () {
        state.convos = [];
        renderConvos();
        toast('All conversations cleared', 'ok');
      }).catch(function (err) {
        if (err && err.message !== 'unauthorized') toast('Clear failed: ' + err.message, 'error');
      });
    });
  }

  var tick = 0;
  setInterval(function () {
    if (document.hidden) return;
    tick++;
    refreshFast();
    if (tick % 3 === 0) refreshLog();
  }, 5000);
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) refreshAll();
  });

  wire();
  if (state.key) hideUnlock();
  else showUnlock();
  refreshAll();
})();
</script>
</body>
</html>
`;
