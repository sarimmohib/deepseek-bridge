# Architecture

The bridge is a small Node service that turns a DeepSeek web session into an
OpenAI-compatible API. It does the same work the site's own client does:
authenticated fetches, proof-of-work, stream translation, uploads, and session
reuse.

## Request path

```text
terminal / agent / SDK
        │ OpenAI HTTP + SSE
        ▼
  deepseek-bridge (127.0.0.1:8787)
        │ HTTPS + cookies + PoW
        ▼
  chat.deepseek.com/api/v0
```

There is no browser hop. Once an account token is stored, all requests go
straight from Node to DeepSeek.

## Direct session

`dsb login` stores a `userToken` (plus cookies and a user agent when available)
as one entry in `accounts.json` (`0600` where POSIX modes apply). The Node
client sends those values as an ordinary `Cookie` header and
`Authorization: Bearer <userToken>`.

A stored account is verified with a small authenticated call before it is kept.
Re-adding the same token is a health reset, not a duplicate.

## Account pool

Every account keeps its own token, cookies, user agent, and health stats. A
scheduler picks the least-recently-used ready account per fresh request.
Cool-downs are per account:

```text
15s → 45s → 2m → 5m → 10m
```

A success decays the level one step. A rejected token (`not_signed_in`) is
parked (a short 5-minute re-probe window) until it is re-added; re-adding the
token resets its state immediately. There is no maximum pool size.

## Rotation

- A clean empty reply, an upload rate limit, or HTTP 429/server-busy on an
  account starts its cool-down.
- The same request is transparently restarted on another ready account — chat
  session create, PoW, and attachment uploads are redone on that account.
- The bridge log records which account served and when it rotated; account ids
  are truncated to 8 characters and tokens never appear in logs.
- A conversation is pinned to the account that created its DeepSeek
  `chat_session_id`. Continuations never send that session id under another
  account; if the pinned account is unavailable the turn is replayed into a
  fresh session on a healthy account (the client still sees a normal reply).
- Uploaded file ids are cached per account (`accountId|sha256`), because
  DeepSeek file ids are account-scoped, so rotation re-uploads correctly.
- With one account stored nothing rotates and the original single-session
  behavior (including the global empty-reply valve) is preserved.
- `maxUpstream` caps concurrent DeepSeek generations across the whole bridge
  (default `2`); raise it if you add many accounts and want more parallelism.
- If a *running* bridge predates 0.8.0, the CLI stores the account locally and
  asks you to restart it (`dsb stop && dsb`) so the new pool is loaded.

## Migration from session.json

On first start after upgrading, an existing `session.json` is imported once as
the first account and left in place. `dsb --logout` /
`dsb accounts clear --yes` removes both files.

## Proof of work

`create_pow_challenge` returns a hash challenge; the site hashes
`salt_expireAt_nonce` with a Keccak-f[1600] sponge that differs from stock
SHA3-256 (round constants 1..23, and a rho step that swaps lane halves for
offsets ≥ 32). `src/pow.js` is a byte-accurate port and solves in ~1.2 s at the
usual difficulty. A solved challenge is single-use, so a fresh challenge is
requested per completion.

## Stream translation

The site sends patch events (`{v}`, `{p,o,v}` with `SET`/`APPEND`/`BATCH`,
index `-1` = last element). The accumulator rebuilds the `response.fragments`
array and emits `THINK` fragments as `reasoning_content`, `RESPONSE` fragments
as `content`.

## Tool adapter

The bridge adds a compact tool schema to the prompt, watches the stream for
tool-call fences/DSML, holds them until the block is complete, and emits native
`tool_calls` deltas. Ordinary JSON fences are released as soon as their fence is
complete. See [API.md](API.md#tool-calling) for the accepted formats and the
repair rules.

## Sessions

The bridge reuses the DeepSeek `chat_session_id` for matching transcripts and
sends only the new tail with `parent_message_id`. A session belongs to the
account that created it, so cached conversations also record `accountId`; a
continuation stays pinned to that account (or replays fresh). This keeps context
and tool results consistent without resending the whole conversation to the
website on every turn.

The conversation key is `(model, system prompt, first user message)`. It is
computed before the bridge's own system message is prepended, so editing
`systemPrompt`, switching presets, or editing a rule does not reset existing
conversations.

## Security model

- The account pool is `~/.config/deepseek-bridge/accounts.json`, written with
  mode `0600` (atomic rename) on Linux/macOS, under your user profile on
  Windows. The config directory is `0700` where POSIX modes apply. A legacy
  `session.json` from pre-0.8.0 installs is migrated once and then ignored until
  it is removed.
- Only `chat.deepseek.com` credentials are stored. The bridge never reads
  cookies for other sites.
- The bridge prints only a truncated API key in the HTML status page and never
  prints the DeepSeek token or cookie values. Account list/summary responses
  (`/v1/bridge/accounts`, `/health`, `/v1/bridge/status`) are redacted, and log
  lines truncate account ids to 8 characters.
- The bridge listens on `127.0.0.1` only by default. The API key protects the
  loopback HTTP API; anyone with both local access and that key can use your
  accounts (and the auth-gated session token endpoint explicitly returns the
  primary token so the dashboard and another machine can bootstrap a login).
- `dsb --logout` (or `dsb accounts clear --yes`) deletes `accounts.json` and any
  legacy `session.json`. It does not log out your browser; use DeepSeek's own
  logout for that.
- Copied web sessions are personal credentials. Do not commit `accounts.json` or
  `session.json`, paste them in issues, or share them. The repository's
  `.gitignore` excludes both.

## Notes and limits

- Personal-use bridge: it rides your own web sessions. Bulk or commercial use
  will hit account rate limits and the site's terms.
- Unlimited accounts, one pool. Requests rotate across the stored accounts
  automatically; each account has its own web session and health state. Running
  the browser and the bridge with the same account is fine, but they are not
  isolated accounts.
- Image/file attachments are supported through the web upload endpoint, with a
  bridge cap of 10 MB per file and 20 MB total per request. Text files are
  additionally budgeted against the model context window.
- The tool-call protocol is an adapter convention, not a native web-chat
  feature. Native DSML output is parsed as a fallback, and parallel calls are
  returned in one turn.
- Both advertised models always reason. `reasoning_effort` is accepted but the
  web gateway ignores numeric effort; `low`/`max` add a small prompt hint.
- The bridge is not a security boundary. Keep it on loopback and protect the
  API key and `accounts.json`.

## Development

```bash
node --test test/*.test.js
```

The suite covers the PoW vector, account-pool storage and rotation (per-account
cool-downs, migration, redaction), the accounts REST API, session storage and
cookie filtering, prompt/tool parsing, the streaming guard, semantic version
comparison and the GitHub version fetch, and a full HTTP replay of every
accepted tool-call format, including the captured failing-rollout payloads and
the empty-DSML loop.

The live rotation harness spawns its own bridge against a throwaway config
directory and a high port, so it never touches the real config or port 8787:

```bash
node scripts/live-rotation.mjs baseline
node scripts/live-rotation.mjs rotation
node scripts/live-rotation.mjs all
```

Tokens are read from `%TEMP%\ds-bridge-test-tokens.txt` (or `--token-file
PATH`) and are never printed.

A live direct-mode smoke test against a running bridge:

```bash
curl -s http://127.0.0.1:8787/v1/chat/completions \
  -H "authorization: Bearer $(dsb key)" \
  -H 'content-type: application/json' \
  -d '{"model":"deepseek-reasoner","messages":[{"role":"user","content":"Reply with exactly DIRECT_OK"}]}'
```
