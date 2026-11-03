## 0.9.17

- **Fixed: `modelinfo.js` threw `ReferenceError: VERSION is not defined`.**
  `renderHeader` used `VERSION` in a default parameter but the module only
  imported `MODELS`, so `buildFrame()` died on its first call and the whole
  frame render (models + conversations + health + log) was dead.
- **Fixed: `modelinfo.js` threw `ReferenceError: PREVIEW_WIDTH is not
  defined`.** The identifier was referenced in the wide-terminal branch of
  `renderConversations` but never declared, so the conversation table threw
  for every normal-width terminal; only the `width < 60` path worked.
- **Fixed: a malformed WebSocket upgrade crashed the daemon.**
  `new URL(req.url, ...)` ran unguarded in the `upgrade` listener, before the
  key check. `GET // HTTP/1.1` with `Upgrade: websocket` threw out of the
  listener: the socket was neither answered nor destroyed (leaked fd) and the
  process exited without the `uncaughtException` guard. It now answers 400
  and destroys the socket.
- **Fixed: fragmented WebSocket messages had no size limit.** The 64 MB cap
  bounded a single frame only; continuation frames were appended to
  `fragments` with no running total, so one client could grow the buffer
  without bound and OOM the bridge. Reassembly is now capped at 8 MB and
  closes 1009 past it.
- **Fixed: unmasked client frames were accepted.** RFC 6455 5.1 requires
  every client frame to be masked; the mask bit was read but never enforced,
  so the mask bytes were reinterpreted as payload and a non-WebSocket peer
  was served as if it were one. Unmasked frames now close 1002.
- **Fixed: two dashboard buttons skipped the 401 recovery path.**
  `copySessionJson` and `clearLearned` used raw `fetch` with only
  `if (!res.ok) throw`, missing the `clearKey()` + unlock overlay that `api()`
  performs, so after a key rotation they showed `HTTP 401` while every other
  control self-healed. Both now route through `api()`.
- **Tests:** new `test/modelinfo-ws.test.js` (3 cases). The upgrade test
  hangs against the pre-fix code, which is the defect itself. Suite 231 to
  234.
- Version 0.9.17 (package.json and extension/manifest.json).
## 0.9.16

- **Security: two routes were registered ABOVE the API-key gate.**
  `/v1/bridge/log` and `DELETE /v1/conversations/:key` sat before the
  `if (!authorized)` check, and CORS is `*`, so any web page could run
  `fetch("http://127.0.0.1:8787/v1/bridge/log")` and read the bridge log —
  account ids, upstream error text, session ids — with no key at all. A
  cross-origin page could also delete stored conversations. Both routes now
  sit below the gate; `/health` stays public so clients can probe readiness.
- The three copy-pasted handler blocks in `server.js` had diverged: only the
  copies below the gate were protected. Duplicates above it are removed.
- **Removed a duplicated last-resort `jsonSpans` scan** in
  `extractToolCalls`. Two adjacent blocks tried the same thing; the first
  always decided, so the second was dead code.
- **The test script is now a glob** (`node --test test/*.test.js`) instead of
  a hardcoded 14-file chain. A new test file was silently never executed by
  `npm test`.
- **Tests:** new `test/auth-gate.test.js` (3 cases; 2 fail against pre-fix
  code). Suite 228 to 231.
- Version 0.9.16 (package.json and extension/manifest.json).
# Changelog

## 0.9.15

- **Fixed: a bare-array tool call executed AND streamed to the client as
  prose.** The model emits calls as `<[{"name":…,"arguments":{…}}]
  </|DSML|>` — a bare JSON array inside stray DSML closers. The streaming guard
  recognized ```tool_call fences, `<tool_calls>` and DSML `invoke`, but never a
  bare array, so the markup was flushed to the client as content.
  `extractToolCalls` then found the same calls in `fullContent` and executed
  them: the GUI showed both a "Ran commands" chip and the raw JSON.
- The guard now matches a bare array opener (including the leading `<` that made
  it render as `<[{"name":…`), holds it until the array is balanced, and
  releases it only when `looksLikeToolCallPayload` rejects it. Ordinary JSON in
  prose still streams.
- **Fixed: stray DSML markers streamed as prose.** `</|DSML|>` arriving ahead of
  the call was emitted before the array was recognized. Every guard emit now
  passes through `stripDsmlResidue`, so no DSML marker reaches the client
  regardless of which branch produced it.
- **Tests:** five guard cases (bare, `<[`, DSML-wrapped, with prose, and an
  ordinary JSON array that must still stream). Suite 222 to 228.
- Version 0.9.15 (package.json and extension/manifest.json).

## 0.9.14

- **Added the regression test that 0.9.13 claimed but did not contain.** The
  0.9.13 changelog said a test for issue #3 was added and the suite went to
  223; the commit (`d06f704`) actually touched four files and left
  `test/prompt.test.js` unchanged, so the count stayed at 222. The test now
  exists: it builds a here-string wrapping a fenced block with raw newlines
  inside the JSON string and asserts the call still parses.
- The parser fix itself shipped correctly in 0.9.13 and is unchanged here:
  raw control characters inside a JSON string are escaped by
  `repairRawControlChars`, chained as `repairJsonText` at both recovery
  sites.
- **Tests:** suite 222 to 223; `test/prompt.test.js` 67 to 68.
- Version 0.9.14 (package.json and extension/manifest.json).

## 0.9.13

- **Fixed: raw newlines inside a tool-call argument dropped the call.**
  Issue #3: a here-string (`@' ... '@`) wrapping Python with triple-quoted
  strings and a fenced block was emitted as markdown. The payload was not
  valid JSON for a second reason beyond the inner fence - the model wrote
  real newlines and tabs inside the JSON string instead of `\n` and `\t`.
  `JSON.parse` rejected it, and no existing recovery path escaped control
  characters inside a string literal.
- `repairRawControlChars` now escapes raw newlines, carriage returns and tabs
  that appear inside a JSON string, leaving structure between values intact.
  It is chained with the backslash repair as `repairJsonText` and applied at
  both recovery call sites, so a Windows path and a multi-line script are
  repaired in one pass.
- **Tests:** one regression test for the raw-newline shape. Suite 222 to 223.
- Version 0.9.13 (package.json and extension/manifest.json).

## 0.9.12

- **Fixed: a fenced block inside a tool-call argument truncated the call.**
  `FENCED_TOOL` used a non-greedy body and closed at the first ``` at the
  start of a line. A JSON string argument may legitimately contain a fenced
  block - issue #3 reports a here-string (`@' ... '@`) wrapping Python with
  both triple-quoted strings and a ``` block. The match stopped at that inner
  fence, the payload was truncated, parsing failed, and the call was dropped
  as markdown.
- Fenced blocks are now located by parsing: for each opening fence, every
  later line-start fence is a candidate closer, and the block ends at the
  first candidate whose interior yields a call. Removal uses those same spans
  and still only deletes blocks that produced a call.
- **Tests:** one regression test for the heredoc + triple-quote + fence shape.
  Suite goes 221 to 222, all passing.
- Version 0.9.12 (package.json and extension/manifest.json).

## 0.9.11

- **Fixed: a stray `</tool_call>` closer discarded a valid call.** The residue
  set listed `tool_calls` and `call` but not `tool_call` (singular), so the
  closer survived stripping and the payload never looked like JSON. The call
  was rendered as assistant text instead of executing.
- **Fixed: Windows paths written with single backslashes were rejected.**
  `C:\Users\Sarim` inside a JSON string is not a legal escape; JSON.parse
  rejected the whole payload and a readable call was lost. Lone backslashes
  inside strings are now doubled before parsing, applied to both the raw
  payload and the residue-stripped variant.
- **Tests:** one regression test for the closer + Windows-path shape. Suite
  221 to 222, all passing.
- Version 0.9.11 (package.json and extension/manifest.json).

## 0.9.10

- **Fixed: a `tool_call` fence that yielded no call was still deleted from the
  reply.** 0.9.6 stopped such a fence from reporting `hadBlock`, but the removal
  step `cleaned.replace(FENCED_TOOL, '')` kept stripping it unconditionally, so
  the model's text vanished while `hadBlock` claimed nothing had happened — the
  worst combination, because the turn looks like an empty reply. A fence is now
  removed only when its payload parses into a call, the same rule already applied
  to `<call>` wrappers. This is the case asserted by
  `a tool_call fence that yields no call is not stripped as tool markup`, which
  failed in 0.9.9.
- **Tests:** all 14 files exit 0, 220 assertions, 0 failures, 0 unreadable.
- Version 0.9.10 (package.json and extension/manifest.json).

## 0.9.9

- **Fixed: the 0.9.8 release did not actually contain the test fix.** The edit
  that was meant to repair the 0.9.7 regression test silently failed to match,
  so the release commit touched only the changelog and the two version files.
  `test/prompt.test.js` stayed broken: unescaped quotes on the `prose` line,
  a corrupted `assert.equal(||)` call, and a file truncated mid-token. The
  suite therefore still exited 1 with no summary in 0.8.7 and 0.9.8.
- The corrupt tail is removed entirely and the test is rewritten cleanly. The
  file now parses, `node test/prompt.test.js` exits 0 with 65 tests, and every
  one of the 14 test files exits 0 (229 assertions, 0 failures).
- Version 0.9.9 (package.json and extension/manifest.json).

## 0.9.8

- **Fixed: a syntax error in the 0.9.7 regression test broke the whole test
  file.** The appended test wrote `'a = Get-Content 'x.xml' -Raw; …'` — single
  quotes nested inside a single-quoted string — plus references to undefined
  `text` and a corrupted identifier. `test/prompt.test.js` therefore failed to
  parse and exited 1 with no summary, so the suite silently stopped covering
  the parser. The test now builds the prose with double quotes, defines `text`,
  and passes a valid tool-name set. `node test/prompt.test.js` exits 0 with
  65 tests, and the full suite is 221/221 across 15 files.
- Version 0.9.8 (package.json and extension/manifest.json).

## 0.9.7

- **Fixed: a call array was lost when the prose before it contained brackets.**
  Recovery scanned for the first `[` and parsed the balanced span from there.
  A command string legitimately contains `[regex]::Match(…)` and `[^>]*`, so
  the scan landed inside the prose and never reached the payload — the turn was
  emitted verbatim as markdown with no call. Recovery now enumerates **every**
  balanced `[…]` / `{…}` span and keeps the first one that parses into a real
  call. The span scanner also restarts its string state at each candidate
  opener: carrying it in from surrounding prose left the scanner stuck inside a
  string after a stray quote in `text="([^"]*)"`.
- **Tests:** one regression test added (array after bracket-heavy prose). Suite
  goes 219 → 220, all passing.
- Version 0.9.7 (package.json and extension/manifest.json).

## 0.9.6

- **Fixed: a `tool_call` fence that yielded no call was stripped as tool
  markup.** The fence loop set `sawBlock = true` before parsing, so a fence
  whose payload did not parse reported `hadBlock` with zero calls. The caller
  treats that as "tool markup without a call" — it deletes the text and fires
  the learned `tool-markup` rule on a turn that never contained a call. The
  flag is now set only when a fence actually produces a call, so an
  unparseable fence stays in the reply as ordinary text.
- **Fixed: a bare call array preceded by prose was not recovered.** When the
  reply opened with a sentence and then emitted the array —
  `Running this now.` followed by `[{"name":"pwsh",…}] </pre>"}` — the
  bare-JSON fallback skipped it because the text did not start with `[` or `{`.
  With tool names known, the first balanced JSON span is now inspected too.
- **Tests:** two regression tests added (fence-with-no-call is not stripped;
  prose-prefixed bare array is recovered). Suite goes 217 → 219, all passing.
- Version 0.9.6 (package.json and extension/manifest.json).

## 0.9.5

- **Fixed: a valid `tool_call` fence was discarded when its payload carried
  wrapper residue.** A complete array surrounded by the tail of an HTML or
  markdown envelope — `[{"name":"pwsh",…}]\n</pre>"}` — failed
  `JSON.parse`, and `parseCallPayload` returned `[]` on any parse error, so the
  whole turn was reported as containing no complete call and the model had to
  re-emit it. The payload is now parsed in four passes: as-is, after stripping
  `</pre>`, `<pre>`, `</invoke>`, `</calls>` and similar wrapper tags, then over
  the first bracket-balanced JSON span (string-aware), and finally entry by
  entry. Issue #1.
- **Fixed: one malformed entry discarded its valid siblings.** Because the
  array was parsed as a unit, a truncated or corrupt second call zeroed out a
  perfectly good first one. Each top-level object is now parsed independently,
  so the calls that do parse still run.
- **Fixed: a literal `<call>…</call>` block passed through as assistant text
  instead of executing.** DeepSeek sometimes degrades a real invocation into
  that wrapper; the XML path only knew `tool_call`/`tool_calls`, so the call
  arrived as markdown and never ran. `<call>` is now parsed with the same
  payload path. It is consumed only when its body really yields a call — a
  prose mention of the tag stays in the reply byte for byte. Issue #2.
- **Tests:** four regression tests added to `test/prompt.test.js` covering
  both issues, including the prose-preservation case. Suite goes 213 → 217,
  all passing.
- Version 0.9.5 (package.json and extension/manifest.json).

## 0.9.4

- **Fixed: an unescaped quote inside a DSML attribute truncated the value.**
  When the model puts a JSON document straight into the attribute —
  `<parameter name="arguments" string="{"nested":{"a":1}}">` — the
  quoted-value parser used to stop at the first inner quote, so the argument
  arrived as `{`. A quoted value now extends to the last quote of the tag when
  what follows it is not another `key=` attribute, and it never extends across a
  stray `="value"` tail, so a duplicated attribute cannot swallow the parameter
  name.
- **Fixed: attribute punctuation look-alikes.** Full-width `＝` (U+FF1D) and
  typographic quotes (U+201C/U+201D/U+2018/U+2019) in attribute syntax are
  normalized before matching. Previously the attribute regex found no `name`,
  dropped the parameter, and the caller saw `missing required property` on a
  call that visibly contained the property.
- **Recovered: calls whose `invoke` wrapper was lost.** DeepSeek degrades long
  tool calls under load by dropping the `invoke name=` tag. A block of bare
  `<parameter>` elements now opens an implicit call and the tool is inferred
  from the parameter-name set, scored by required-property coverage.
- **Tests:** the 10 000-case stress harness went from 96.50 % to 97.38 %, the
  round-trip matrix from 318/336 to 336/336, and the full suite stays at
  213/213.
- Version 0.9.4 (package.json and extension/manifest.json).

## 0.9.3

- **Diagnostics:** a call that still arrives with no readable arguments is now
  logged as `tool call repaired (N): <tool>: invoke carried no readable
  arguments` when the tool requires at least one. Before, it only surfaced as a
  harness `missing required property` error with no trace in `bridge.log`.
  Combine with `DS_BRIDGE_DUMP_DIR` to capture the exact raw reply next time.
- Version 0.9.3 (package.json and extension/manifest.json).

## 0.9.2

- **Fixed: `skill` (and any tool with a `name` argument) arrived with `{}`.**
  `finishParam` treated a parameter literally named `name`/`tool`/`tool_name`
  as the *tool* name and discarded it, so `skill` lost its required `name` and
  the harness rejected it with `missing required property "name"`. Every named
  parameter now stays an argument; an invoke that lost its own name can still
  consume a `name` argument, but only when that value is a real tool and no
  tool would accept it as an argument instead.
- **Fixed: the short `<|parameter>` marker was invisible.** Under load DeepSeek
  drops the `DSML` word and writes `<|parameter name="command" ...>` /
  `<|invoke name="read">`. Those tags were not tokenized, so the body flowed
  into the previous parameter (a bash `description` ended up appended to the
  end of `command`) or into the invoke body, which was discarded (bash arrived
  with only `description`, or `skill` with no arguments). The tokenizer now
  accepts the short marker as well as `<｜｜DSML｜｜ …>`.
- **Fixed: literal DSML markers inside a value were eaten.** A bash heredoc that
  documented the marker token lost everything from the token to the next tag,
  with exit code 0. Inside a parameter, only real structural tags are treated
  as markup; anything else is kept as literal text.
- **Fixed: nameless parallel calls were retargeted.** A call whose invoke tag
  lost its `name` and carried only `file_path` was inferred as `edit` (both
  `read` and `edit` have `file_path`, and `edit` is declared first), so it was
  rejected for missing `old_string`/`new_string`. Inference now requires every
  *required* argument to be present, scores by required-argument coverage,
  prefers repeating the previous call's tool (the parallel-batch intent), and
  never selects a tool that would still be missing a required argument.
- **Also recovered:** unquoted attribute values (`name=read`), JSON bodies and
  `arguments="…"` on an invoke tag, which used to yield `{}`.
- **Tests:** regression coverage for all of the above, including an end-to-end
  `handleChatCompletions` replay of a composite real-world corrupted reply.
- Version 0.9.2 (package.json and extension/manifest.json).

## 0.9.1

- **Fixed: tool calls arrived with parameters the model had emitted.**
  `missing required property "command"` (and `file_path`, `content`,
  `old_string`, `description`) was reported for calls whose parameters were
  present in the raw reply. Root cause: DeepSeek writes the DSML parameter name
  with full-width or typographic punctuation under load (`name＝"command"`,
  `name=“command”`), drops the `name=` key (`parameter="command" string="true"`),
  or puts the value in the attribute list (`name="description" string="Screenshot
  it"`). The attribute reader only accepted `name="ascii"`, so every other shape
  dropped the parameter silently. Confirmed against the session transcript where
  the model itself notes *"my parameter attribute uses a full-width bracket,
  causing the field name to be wrong"*.
  - Attribute punctuation is normalized (`＝`, full-width/smart quotes, single
    quotes, spaced `=`).
  - A leading bare quoted value on a parameter/invoke tag is read as its name.
  - A `string=` attribute that is neither `true` nor `false` is used as the
    value when the element body is empty.
  - A parameter whose name stays unreadable is mapped to the tool's first
    unused schema property that can hold the value (type checked), instead of
    being dropped.
  - Repairs are logged (`tool call repaired (N): ...`) and a call that still
    lacks required arguments is logged with the names of the missing ones.
- **Fixed: mid-stream snapshot replay duplicated the reply.** DeepSeek replays
  the whole message object during a stream (`{v:{response:{fragments:...}}}`).
  The accumulator tracked "already emitted" on the fragment object, so the
  replayed objects looked new and the entire text was emitted again — the
  duplicated-argument / spliced-JSON corruption seen on long replies. Emission
  bookkeeping is now keyed by fragment position and resets only when the
  response message id changes.
- **New: opt-in raw capture.** `DS_BRIDGE_DUMP_DIR=<dir>` writes the raw SSE
  frames and the exact assistant text the tool-call parser received, per
  request. Off by default.
- **Tests:** regression coverage for every corrupted-attribute shape, the
  positional schema repair, and the snapshot-replay accumulator; the autosave
  resilience test no longer depends on the suite not running as root.
- Version 0.9.1 (package.json and extension/manifest.json).

## 0.9.0

- **DeepSeek Harness only.** OpenCode support surfaces are gone: the
  `opencodeProviderSnippet` export, the README OpenCode section and
  `opencode.key` hints, and the dashboard "Copy OpenCode config" button. The
  OpenAI-compatible Chat Completions API and the Chrome-extension fallback
  stay. Docs now describe dsh as the supported harness (Hermes/ZCode doc
  sections removed).
- **System prompt focus.** `systemPreset` now defaults to `dsh-agent` and the
  presets are dsh-tuned: `dsh-agent`, `dsh-plan`, `dsh-tool`, and `none`.
  `systemPrompt` still wins when set.
- **Rules with automatic learning.** New `src/rules.js` stores builtin, user,
  and learned rules in `rules.json` (`0600`, `DS_BRIDGE_RULES_FILE` override)
  and appends them to the bridge system message as a `# Rules` section
  (`systemRules`, on by default, 2,400-char budget). Six builtin rules ship
  (tool-call format, parallel calls, no invented results, no partial/empty
  markup, complete edits, verify before claiming success). When the bridge
  recovers from a repeatable failure — malformed tool markup with no call, a
  degenerate DSML wall, or an empty reply — it records a learned rule (deduped
  with a seen count) so the next turn is told not to repeat it.
  - CLI: `deepseek rules`, `--json`, `add "<text>"`, `remove <id>`,
    `clear-learned`.
  - API: `GET/POST/DELETE /v1/bridge/rules`,
    `DELETE /v1/bridge/rules/:id`, `DELETE /v1/bridge/rules?learned=1`.
  - Dashboard: a "System prompt & rules" panel (source badges, seen counts,
    add/remove, clear learned).
- **Prompt edits no longer reset conversations.** The conversation key is
  computed from the harness messages before the bridge system message is
  prepended, so editing `systemPrompt`, switching `systemPreset`, or changing
  a rule continues the stored DeepSeek session instead of orphaning it.
- **`deepseek models --info`** prints the dsh profile patch
  (`~/.dsh/profiles/web/cordis.patch.yml`) plus the generic
  OpenAI-compatible env JSON; the dashboard model cards copy the dsh patch.
- **Fixed: the bridge could terminate with exit 1 and no log line.**
  `Store.flush()` runs from `setInterval`; a failed write (read-only config
  dir, full disk, Windows `EPERM`/`EBUSY` on rename) threw inside the timer,
  which is an uncaught exception and killed the process. Writes now retry
  renames and fall back to an in-place write, `flush()` records
  `lastFlushError` and stays dirty for the next tick instead of throwing,
  account-pool flush failures are swallowed and retried, and the daemon
  installs `uncaughtException`/`unhandledRejection` handlers that log to
  `bridge.log` and keep serving.
- **Fixed: startup crash from a bad port.** `--port abc` persisted
  `Number('abc')` (= NaN, serialized as `null`) and the next start called
  `server.listen(NaN)` -> `ERR_SOCKET_BAD_PORT`. `--port` is validated
  (integer 1-65535, exit 2 with a clear message) and a stored invalid port
  falls back to 8787 instead of throwing.
- Version 0.9.0 (package.json and extension/manifest.json).
## 0.8.0

- **Multiple DeepSeek accounts with automatic rotation.** The single
  `session.json` is replaced by an unbounded pool in `accounts.json`
  (`0600`, atomic writes, per-account cookie/user-agent state). Add as many
  `userToken`s as you have accounts; each one is verified with DeepSeek before
  it is kept, duplicates dedupe by token hash, and nothing has a pool-size cap.
  - When an account hits DeepSeek's per-account rate window (clean empty
    reply, upload rate limit, 429/server-busy) it cools down for
    15s/45s/120s/300s/600s — escalating while it keeps hitting the window and
    decaying on success — and the request transparently restarts on another
    ready account (session create, attachment re-upload, fresh PoW). A token
    DeepSeek rejects (`not_signed_in`) is parked until it is re-added.
  - Conversations are account-scoped. A continuation is pinned to the account
    that created its `chat_session_id`; if that account is unavailable the
    request replays into a fresh session on a healthy account instead of
    leaking a session id across accounts. Uploaded file ids are cached per
    account (`accountId|sha256`), so rotation re-uploads correctly.
  - The process-global empty-reply valve no longer stalls healthy accounts when
    more than one is stored; per-account cool-downs do the pacing.
- **REST API:** `GET/POST /v1/bridge/accounts`, `DELETE /v1/bridge/accounts/:id`,
  `DELETE /v1/bridge/accounts`; `/health` and `/v1/bridge/status` report
  `{count, ready, cooling}`; `/v1/bridge/session/token` returns the primary
  account plus its `accountId`; `/v1/bridge/session/export` now upserts an
  account instead of replacing the pool; `/v1/bridge/session` DELETE clears all
  accounts and the legacy file. Account payloads are redacted — tokens never
  appear in a list/summary response.
- **Security:** `GET /v1/bridge/session/token` is now behind the bridge API-key
  gate like every other credential-bearing route. In 0.7.8 it sat before the
  auth check, so a local process could read the stored DeepSeek token without
  the key. The dashboard already sends the key; other clients must too.
- **CLI:** `deepseek accounts` (list / `--json` / `remove <id|index>` /
  `clear --yes`) reads from the running bridge or `accounts.json` directly.
  `deepseek --login --manual --token ...` appends an account (with `--replace`
  to reset the pool, `--label` to name it); the extension login upserts too.
  `deepseek --logout` now clears the whole pool and reports how many accounts
  were removed. `status`, `session`, help text and the startup banner show
  account counts and cooling state.
- **Dashboard:** new Accounts panel listing id, label, cookies, ready/cooling
  state, throttle hits and last use, with per-row delete, an add-token form
  (verified by the bridge) and a double-confirm "Clear all accounts". Token
  values are never rendered.
- **Migration:** an existing `session.json` is imported once into the pool on
  first load and left on disk until `--logout`/`accounts clear`. Older
  single-session bridges keep working; the CLI warns to restart when a running
  bridge predates the accounts API.
- Version bumped to 0.8.0. New tests: `test/accounts.test.js`,
  `test/rotation.test.js`, `test/accounts-api.test.js`.

## 0.7.8

- Completion gate INVERTED to a whitelist: a stream is complete only if its
  observed message status is explicitly FINISHED — ANY other status
  (STOPPED, PAUSED, or whatever DeepSeek introduces later) now routes into
  the resume/recovery machinery instead of being delivered as a complete
  reply. Found on the Gummy build: DeepSeek stopped a generation mid-THINKING
  with a status outside the previous blacklist, the cut reply passed as
  complete, and the harness turn ended mid-sentence — while DeepSeek's own
  Continue button resumed it perfectly. Statuses never seen before are
  logged so new ones are visible in the bridge log.

## 0.7.7

- DEGENERATE DSML LOOP detection: under rate pressure DeepSeek can fall
  into emitting a wall of empty DSML tags (hundreds of <｜｜DSML｜｜>
  pairs — observed on the Gummy Bears build with the Continue button
  offered after each wall). The wall is not a usable reply, it poisons the
  session's context (the model conditions on its own garbage and keeps
  looping), and auto-Continue only feeds it. The bridge now detects the
  wall (>30 empty-name DSML tags with no salvaged tool call and no usable
  text), drops the poisoned session, notes the throttle valve, and
  surfaces a retriable degenerate_reply error — so the client's retry
  replays into a fresh, clean session. Walls that contain real text or a
  real tool call keep the old strip/salvage behavior.

## 0.7.6

- FILE-UPLOAD rate limits handled properly: uploads draw from their own
  stricter DeepSeek quota (observed: "rate limit reached" on image uploads
  during a dsh agent run, with the harness's own 5×5 retries unable to
  outlast the window). Upload rate-limit failures now use the long
  throttle-aware retry schedule, raise the global cool-down valve so chat
  requests pace too, and surface a clean error only after the window.
- Uploaded file ids are cached by content hash (account-scoped on DeepSeek,
  LRU-capped at 60): harness retries that re-send the same attachment
  upload once per bridge lifetime instead of hammering the upload quota.

## 0.7.5

- DSML SALVAGE for degraded tool calls: under sustained rate pressure
  DeepSeek emits tool calls with malformed markup — doubled bars
  (<｜｜DSML｜｜calls>), a lost invoke/name tag, bare parameter tags. The
  extractor previously stripped those blocks silently, so the agent's
  intended tool call (e.g. a diagnostic command) was lost and the turn
  ended text-only. The extractor now starts an implicit call on
  parameter-open inside a calls wrapper and infers the tool from a
  parameter-name index built from the request's tool schemas (a block is
  salvaged only when its parameter names uniquely match one registered
  tool). Found on the Gummy Bears build: the model's diagnostic
  chrome --dump-dom tool call was being discarded verbatim.

## 0.7.4

- ROOT-CAUSE FIX for long builds halting: DeepSeek rate-stops long
  generations and marks the message STOPPED (chat.deepseek.com shows a
  "Continue" button) — the bridge mapped that status to null and delivered
  the truncated fragment as a complete reply, so harness agents ended their
  turns mid-build. STOPPED is now a first-class status: the bridge presses
  Continue automatically (resume_stream first, then /chat/continue) and
  rides the generation to a real FINISHED, deduplicating every replay
  boundary — including nested stops inside the recovery itself.

## 0.7.3

- Persistent empty replies on a long-lived DeepSeek session (a rate window
  that outlives the cool-down valve, observed when three concurrent dsh
  agent loops pushed one 22-turn session past its tolerance) now abandon
  the session and replay the conversation into a fresh one — the same
  recovery path as invalid-parent failures, bounded to one retry.
- The dashboard/upstream tests reset the throttle valve between cases.

## 0.7.2

- Global adaptive throttle valve: when DeepSeek's rate window produces empty
  replies, every upstream request now pauses behind an escalating cool-down
  (10s/20s/40s/80s, decaying on success) instead of each client hammering
  independently. Found under a 3-way concurrent dsh agent-loop stress run,
  where one 22-turn task's LLM call surfaced an empty-reply failure after the
  per-request backoff was exhausted; with the valve the same load rides the
  window out.

## 0.7.1

- Dashboard theme: richer ZCode-style dark palette (charcoal + warm orange
  accent) and a creamy-white light theme, with a header toggle persisted in
  the browser (first visit follows the system preference, no flash).
- Session-token card: view (masked, Show to reveal), copy, and export the
  DeepSeek login token plus cookies for connecting another device without
  re-logging in — including a one-click `deepseek --login --manual --token …`
  setup command. Served by the auth-gated `GET /v1/bridge/session/token`
  (`?full=1` adds cookies and user agent).
- `deepseek ui` is back, now simply opening the web dashboard in a browser
  (starts the bridge if needed). The page is a static string server-side, so
  it costs nothing when nobody is viewing it; polling pauses on hidden tabs.
- The dashboard log panel no longer exposes the API key that the bridge's
  startup banner prints (`sk-ds-…` values are redacted server-side).

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
