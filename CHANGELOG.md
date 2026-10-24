# Changelog

## 0.7.0

- Replaced the terminal dashboard with a web dashboard served by the bridge
  itself at `http://127.0.0.1:8787/`: unlock with the API key (stored in the
  browser, sent only to the bridge), then live models with copyable OpenCode
  config, a searchable/filterable/sortable conversations table with per-row
  delete and a double-confirm clear-all, the upstream queue, and the log tail.
  One self-contained HTML file, no external requests.
- Removed `deepseek ui` and the ANSI dashboard module; the model-table and
  harness-snippet helpers moved to `src/modelinfo.js` (`deepseek models` and
  `deepseek models --info` are unchanged).
- New auth-gated endpoints: `GET /v1/bridge/log?lines=N` and
  `DELETE /v1/conversations/:key`.

## 0.6.3

- Empty replies are DeepSeek's per-account rate throttle, not a parallelism
  limit (measured: 13 rapid-fire sequential requests trigger it; a slow
  trickle never does). Empty-reply retries now back off on a dedicated
  schedule (3s/9s/20s/35s ≈ 67s worst case) instead of the transient
  schedule, so bursts ride out the throttle window transparently: the same
  15-request rapid-fire run that surfaced 2 failures now passes 15/15.
- `maxUpstream` stays a parallelism cap (default 2, from 0.6.2).

## 0.6.2

- Lowered the default `maxUpstream` from 3 to 2. Measured under load:
  DeepSeek reliably serves ~2 parallel generations per account, while 3+
  concurrent generations increasingly return empty replies (a 10-way burst
  produced empty completions for 20% of requests even after retries; a
  sequential trickle produced none in 33 requests). Set `maxUpstream` higher
  in the config if your account tolerates it — the queue still caps
  everything FIFO and surfaced failures are clean retriable 502s.

## 0.6.1

- Hardened reply integrity end to end: a `/chat/resume_stream` replay that
  still ends WIP keeps resuming instead of returning a partial reply, a
  recovery that confirms an empty reply falls through to the fresh-start
  retry, and a response whose converted output is empty (degenerate DSML
  loop with no content, reasoning, or calls) now surfaces a retriable
  `empty_reply` error instead of a silent empty completion.
- Attachment polish: mid-size text files over the per-attachment token
  budget are split instead of skipped whole, and the in-prompt split note
  names the one delivered part and states the remainder is omitted.
- The per-request config reload no longer rotates the API key when the
  config file goes missing or corrupt (startup config stays authoritative;
  reloads never write).
- Token counters survive no-usage turns, and non-numeric runner usage no
  longer leaks into the OpenAI usage fields.

## 0.6.0

- Added `deepseek ui`, a zero-dependency terminal dashboard: live panels for
  models, conversations (turns, token counts, preview), bridge health
  (upstream active/queued/max), and the bridge log tail. Keyboard-driven
  (1-4/Tab move focus, `r` refresh, `q` quit); when stdin is not a TTY it
  renders one static frame and exits.
- Added `deepseek models` and `deepseek models --info`: the model table plus
  pasteable harness configuration — an OpenCode provider JSON block mirroring
  the working `opencode.jsonc` entry, and a generic `OPENAI_BASE_URL` /
  `OPENAI_API_KEY` env block with a shell export form.
- Conversation management: per-conversation token accounting (session tokens
  from DeepSeek's accumulated usage) exposed via a new auth-gated
  `GET /v1/bridge/conversations`. When a conversation crosses `contextSwitchAt`
  (default 0.8 of the model context window) the bridge starts a fresh session
  automatically. Fresh-session transcripts are capped at
  `maxFreshTranscriptChars` (default 200000) with an elision marker instead of
  failing on huge histories.
- Upstream concurrency limiting for agent swarms: `maxUpstream` (default 3)
  caps simultaneous DeepSeek requests; extras queue FIFO.
  `upstream: {active, queued, max}` now appears in `/health` and
  `/v1/bridge/status`.
- Bridge-provided system prompts: `systemPrompt` (exact text) or `systemPreset`
  (one of `coding`/`concise`/`tutor`/`agent`) is prepended to each request's
  system messages. The config is re-read per request, so edits apply on the
  next request without restarting the bridge.
- Attachment overhaul: DeepSeek ingests text files into the model context
  (~0.55 tokens/byte measured; 1.55 MB ≈ 695k tokens ingested fully; ~2.7 MB ≈
  1.2M tokens overflows the 890,880-token window and breaks the turn).
  Oversized text files are now split into ~636 KB context-budgeted parts
  (350k tokens each) instead of dropped; a per-attachment context ceiling of
  500k tokens keeps totals sane and drops the remainder with clear notes.
  Binary/image handling is unchanged (10 MB per file, 20 MB total caps).
- Reply-integrity hardening: a stream that ends while the message status is
  still WIP is treated as interrupted and resumed via `/chat/resume_stream`;
  a clean stream that carries zero content and reasoning is retried as a
  transient failure (`empty_reply`) instead of returning a silent empty
  completion. Uploads referenced while DeepSeek still shows them PENDING
  trigger one transparent fresh retry (or a clean 504 `file_not_ready` if text
  was already streamed), and consecutive uploads get a 750 ms settle gap.

## 0.5.1

- Retry transient DeepSeek failures instead of ending a reply midway: network
  errors, WAF/202 challenges, HTTP 408/425/429/5xx, server-busy responses, and
  invalid PoW responses.
- Detect truncated SSE streams that end without a `close`/`finish` marker and
  resume them with DeepSeek's `/chat/continue` endpoint. Replayed content is
  de-duplicated before it reaches the client.
- Send SSE keepalive comments while a long reasoning/tool turn is silent.
- If a saved DeepSeek parent message is rejected (`invalid message id`), retry
  the request once from a fresh session using the full transcript.
- `deepseek --login --manual` now accepts `--token`, `--token-file`, and
  `DEEPSEEK_TOKEN`/`DEEPSEEK_USER_TOKEN`, reads piped stdin without requiring a
  trailing newline, and falls back to canonical terminal input when raw mode is
  unavailable.
- When the fresh-session fallback replays the full transcript, attachments from
  earlier turns are re-uploaded instead of being dropped.
- Manual login now also honors structured `not_signed_in` rejections, so a
  rejected token no longer replaces a working session.
- A read-only config directory no longer crashes CLI startup during the
  model-default migration; when the initial API key cannot be saved, a warning
  says the generated key is temporary.
- File uploads get a 10-minute per-attempt window instead of the 60-second
  setup cap, so large files survive slow uplinks.
- Definitive server error events (e.g. moderation) surface immediately instead
  of being retried as transient failures.
- Retry bookkeeping releases each attempt's timers before backing off.
- Recover interrupted replies by re-attaching to the live generation with
  DeepSeek's `resume_stream` endpoint first (works while the message is still
  generating), falling back to `/chat/continue` for refused or stale resumes.
- Always send valid JSON object `arguments` in converted tool calls: malformed
  or non-object fenced arguments are wrapped instead of passed through, fixing
  intermittent "wrong format for a tool call" rejections in OpenCode.

## 0.5.0

- Removed the instant models (`deepseek-chat` and `deepseek-expert`) from the catalog.
- The only advertised models are now `deepseek-reasoner` and `deepseek-search`.
- Both models always reason; `deepseek-search` always enables web search.
- Legacy model IDs and the old config default are normalized to `deepseek-reasoner`.
- Updated the OpenCode provider, CLI defaults, dev scripts, tests, and docs.

## 0.4.0

- Added `deepseek version` with local, git, and GitHub version reporting.
- Added `deepseek update` (`--check`, `--no-restart`) and safe fast-forward updates.
- Added an automatic update check on start/chat/serve (every 6 hours, git checkout only).
- Added `deepseek key --file PATH` for secret-file based clients.
- Added the OpenCode provider integration documented in the README.
- Exposed the bridge version in `/health`, `/v1/bridge/status`, the HTML status page, and startup logs.
- The extension manifest now matches the package version.

## 0.3.0

- Direct mode with one-time browser session export.
- Manual `userToken` login without the extension.
- Direct PoW, uploads, SSE, cookie refresh, and session storage.
- Extension fallback remains available.
