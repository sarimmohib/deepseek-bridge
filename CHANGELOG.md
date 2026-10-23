# Changelog

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
