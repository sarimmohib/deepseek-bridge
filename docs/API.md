# API

Base URL: `http://127.0.0.1:8787/v1`

Authentication: `Authorization: Bearer <key>` or `x-api-key: <key>`. The key is
printed at startup and stored in the config file (`dsb key` prints it).

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/v1/chat/completions` | Chat, streaming or non-streaming |
| `GET` | `/v1/models` | Model list |
| `GET` | `/v1/bridge/status` | Mode, account summary, queue state |
| `GET` | `/v1/bridge/accounts` | Account pool summary (redacted; never includes tokens) |
| `POST` | `/v1/bridge/accounts` | Add and verify one account; `{replace: true}` resets the pool first |
| `DELETE` | `/v1/bridge/accounts/:id` | Remove one account |
| `DELETE` | `/v1/bridge/accounts` | Remove every account |
| `GET` | `/v1/bridge/session` | Stored account metadata (no credentials) |
| `GET` | `/v1/bridge/session/token` | Primary token + `accountId` for the dashboard (auth required) |
| `POST` | `/v1/bridge/session/verify` | Verify the primary account with a small authenticated call |
| `DELETE` | `/v1/bridge/session` | Delete every stored account (and legacy `session.json`) |
| `GET` | `/v1/bridge/conversations` | Cached conversations with token counts and previews |
| `GET` | `/v1/conversations` | Cached session map |
| `DELETE` | `/v1/conversations` | Forget cached sessions |
| `GET` | `/v1/bridge/rules` | Active preset, whether rules are on, and every rule |
| `POST` | `/v1/bridge/rules` | Add a user rule: `{text, category?}` |
| `DELETE` | `/v1/bridge/rules/:id` | Remove one rule (builtin included) |
| `DELETE` | `/v1/bridge/rules?learned=1` | Drop every learned rule |
| `GET` | `/health` | Liveness, version, and mode (no auth) |
| `GET` | `/` | HTML status page |

## curl

Linux/macOS:

```bash
KEY="$(dsb key)"

curl -s http://127.0.0.1:8787/v1/chat/completions \
  -H "authorization: Bearer $KEY" \
  -H 'content-type: application/json' \
  -d '{
    "model": "deepseek-reasoner",
    "stream": true,
    "messages": [{"role": "user", "content": "17*23?"}]
  }'
```

PowerShell:

```powershell
$key = dsb key
$body = @{
  model = "deepseek-reasoner"
  messages = @(@{ role = "user"; content = "17*23?" })
} | ConvertTo-Json -Depth 10

Invoke-RestMethod `
  -Uri http://127.0.0.1:8787/v1/chat/completions `
  -Method Post `
  -Headers @{ Authorization = "Bearer $key" } `
  -ContentType "application/json" `
  -Body $body
```

## OpenAI SDK

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:8787/v1",
    api_key="<the sk-ds-... key from `dsb key`>",
)

response = client.chat.completions.create(
    model="deepseek-reasoner",
    messages=[{"role": "user", "content": "Explain quicksort in one paragraph."}],
)
print(response.choices[0].message.content)
```

Works with DeepSeek Harness (dsh), the OpenAI SDKs, LiteLLM, or a local agent
loop.

## Models

The web app currently serves **DeepSeek-V4.1-Flash**, a multimodal MoE with a
552B backbone, a 1,048,576-token model context, and continuous reasoning effort.
The web session reports an **890,880-token** history/file budget. The bridge
caps uploads at **10 MB per file / 20 MB total** and budgets text files against
that context window (see [Images, files, and PDFs](#images-files-and-pdfs)).
The bridge exposes two stable IDs:

| Model | Site mode |
| --- | --- |
| `deepseek-reasoner` | Reasoning on; emits `reasoning_content` |
| `deepseek-search` | Reasoning on and web search enabled |

Both models always reason; the instant modes were removed. The `search` model
always sends `search_enabled: true`. For compatibility, legacy IDs
(`deepseek-chat`, `deepseek-expert`, or an unknown model) are normalized to
`deepseek-reasoner` instead of silently selecting an instant mode.
`/v1/models` reports `context_window: 890880` and
`max_output_tokens: 131072` for each entry.

> **Thinking effort is only partially controllable.** The web client sends only
> `thinking_enabled`; it has no 1–100 effort field. The bridge accepts
> `reasoning_effort` for OpenAI compatibility and adds a short prompt hint for
> low/max, but live tests showed the web gateway ignores numeric effort fields.
> `reasoning_effort: "none"` is accepted but does not disable reasoning in this
> reasoning-only build. Real numeric effort control requires the official
> DeepSeek API, not the web session.

### Model information

```bash
dsb models          # one line per model
dsb models --info   # details plus pasteable harness configuration
```

`--info` prints each model's description and limits, then ready-to-paste
configuration: the DeepSeek Harness profile patch and a generic
OpenAI-compatible env block for any other client.

```text
deepseek-bridge models  (default: deepseek-reasoner)
Base URL   http://127.0.0.1:8787/v1
API key    sk-ds-...

* deepseek-reasoner  (default)
    description        DeepSeek V4.1 Flash (web Reasoner), reasoning enabled, ...
    context_window     890,880
    max_output_tokens  131,072

DeepSeek Harness (dsh) profile patch (paste into ~/.dsh/profiles/web/cordis.patch.yml):
- id: llm-pi-ai
  config:
    providers:
      bridge:
        apiKeyEnv: DEEPSEEK_BRIDGE_KEY
        baseURL: http://127.0.0.1:8787/v1
        api: openai-completions
        models:
          - id: deepseek-reasoner
            ...
- id: agent-default-model
  config:
    provider: bridge
    model: deepseek-reasoner
    reasoningEffort: high

Generic OpenAI-compatible env (JSON):
{
  "OPENAI_BASE_URL": "http://127.0.0.1:8787/v1",
  "OPENAI_API_KEY": "sk-ds-...",
  "OPENAI_MODEL": "deepseek-reasoner"
}
```

### DeepSeek Harness (dsh)

Install dsh with `npm install -g @deepseek-ai/dsh` (allow its native-build
scripts), start the bridge, and point a dsh provider at it:

```bash
dsb
export DEEPSEEK_BRIDGE_KEY="$(dsb key)"
```

Add this block to `~/.dsh/profiles/web/cordis.patch.yml` (or let
`dsb models --info` print it):

```yaml
- id: llm-pi-ai
  config:
    providers:
      bridge:
        apiKeyEnv: DEEPSEEK_BRIDGE_KEY
        baseURL: http://127.0.0.1:8787/v1
        api: openai-completions
        models:
          - id: deepseek-reasoner
            name: DeepSeek V4.1 Flash Reasoner (web)
            contextWindow: 890880
            maxTokens: 131072
            reasoningEfforts:
              off:
              low: low
              high: high
              max: max
          - id: deepseek-search
            name: DeepSeek V4.1 Flash Search (web)
            contextWindow: 890880
            maxTokens: 131072
            reasoningEfforts:
              off:
              low: low
              high: high
              max: max
- id: agent-default-model
  config:
    provider: bridge
    model: deepseek-reasoner
    reasoningEffort: high
```

`apiKeyEnv` keeps the key out of the file. The patch ids are the profile short
slugs (`llm-pi-ai`), not package names, and `reasoningEfforts` maps each level
to the wire spelling. Boot `dsh web` and the model picker shows the bridge
models.

## Images, files, and PDFs

Send ordinary OpenAI content parts. The bridge fetches remote URLs (http/https,
20 s timeout), decodes data URLs, caps at **10 MB per file / 20 MB total / 12
files**, uploads each file through the same upload endpoint, and passes the
returned ids as `ref_file_ids`:

```json
{
  "role": "user",
  "content": [
    {"type": "text", "text": "What is wrong in this screenshot?"},
    {"type": "image_url", "image_url": {"url": "data:image/png;base64,..."}}
  ]
}
```

Also accepted: `input_image`, and `file` / `input_file` parts with `file_data`
(data URL or base64) or `file_url`. PDFs, text, code, and office documents use
the same upload path. Images can be added on a later turn; the file ids are
attached to that turn of the reused DeepSeek session. A failed image fetch is
logged and skipped rather than failing the whole request.

**Text files are context-budgeted.** DeepSeek ingests attached text into the
model context at roughly 0.55 tokens per byte (measured: 1.55 MB ≈ 695k tokens
ingested fully; ~2.7 MB ≈ 1.2M tokens overflows the 890,880-token window and
breaks the turn). A text file whose estimate exceeds 500k tokens is therefore
not uploaded as-is: files above the per-file byte cap are split into ~636 KB
parts (≈350k tokens each, named `name.part01ofNN.ext`), and only the leading
parts that fit the 500k-token per-attachment budget are sent — the remainder is
dropped with an explicit note in the prompt instead of failing the request.
Text files that fit the byte cap but not the token budget are skipped with the
same kind of note. Images and binary files are exempt; they keep the plain
10 MB per file / 20 MB total caps.

## Multi-turn conversations

The bridge keys a session on `(model, system prompt, first user message)`,
stores the DeepSeek `chat_session_id` and last assistant message id in
`state.json`, and, when the next request repeats the transcript and appends new
turns, continues that session with only the new tail as `parent_message_id`.
Keep sending the full transcript, like any OpenAI client does.
`DELETE /v1/conversations` starts fresh everywhere.

Continuation is digest-verified: the bridge hashes the turns it believes the
DeepSeek session already holds and only reuses the session when the hash
matches, so an edited or divergent transcript starts fresh instead of making
the model answer its own echo.

**Context-limit switching.** Each conversation tracks session tokens from
DeepSeek's accumulated usage (with a rough fallback estimate). When the count
passes `contextSwitchAt` — a fraction of the model's context window, default
`0.8` (≈712k of the 890,880 tokens) — the bridge abandons the stored session
and the next request starts a fresh one automatically instead of failing
mid-window. Fresh starts replay the transcript capped at
`maxFreshTranscriptChars` (default `200000`), keeping the most recent turns and
prepending an `[earlier conversation omitted: N messages]` marker for the rest,
so huge histories elide instead of failing.

`GET /v1/bridge/conversations` lists the cached conversations with model,
turns, input/output/session token counts, a preview, and the upstream queue
state (same auth as the other bridge endpoints).

## System prompts and rules

The bridge prepends its own system message to every request. It is sent as a
separate system message before the harness's own, so dsh's prompt is kept
verbatim — nothing is deduped or rewritten. Three keys in
`~/.config/deepseek-bridge/config.json` control it:

- `"systemPrompt": "..."` — exact text, sent verbatim. Always wins.
- `"systemPreset"` — used when `systemPrompt` is empty. Defaults to
  `dsh-agent`; also `dsh-plan` (plan first, then act), `dsh-tool` (precise
  tool use), or `none` (no preset).
- `"systemRules": true` — append the Rules section described below. Defaults
  to `true`.

An unknown preset name is ignored with a one-line log. The config file is
re-read per request, so edits apply on the next request without restarting the
bridge.

**Editing the prompt does not reset conversations.** The stored-conversation
key is computed from the harness's own messages (model, harness system
message, first user turn) *before* the bridge system message is prepended. So
changing `systemPrompt`, switching presets, or editing a rule changes what the
model is told on the next turn while the existing DeepSeek session continues.

## Rules

Rules are short, model-facing instructions kept in
`~/.config/deepseek-bridge/rules.json` (`0600`; override the path with
`DS_BRIDGE_RULES_FILE`). When `systemRules` is on, they are appended to the
bridge system message under a `# Rules` heading, capped at 2,400 characters.
The full rule text, triggers, and design constraints live in
[RULES.md](../RULES.md); `src/rules.js` holds the shipped defaults.
Three sources share the store:

- **builtin** — six shipped rules covering the bridge's repeatable failure
  modes: the fenced `tool_call` block format, one JSON array for parallel
  calls, never inventing a tool result, never emitting partial or empty
  DSML/markup, complete file edits, and verifying before claiming success.
  Seeded on first read; deleting one is respected (it is not re-seeded).
- **user** — added by hand (320 characters max, 24 rules total).
- **learned** — recorded automatically when the bridge detects a repeatable
  failure it already has to recover from: tool markup that contained no
  complete call (stripped), a degenerate DSML wall (session dropped), or an
  empty reply. Identical failures are deduped and counted, and the least-seen
  learned rule is evicted past 12.

The point of learning is that the same mistake is not repeated on the next
turn: the rule is injected into the prompt before the model answers again.

```bash
dsb rules                        # table: id, source, seen count, text
dsb rules --json                 # machine-readable, includes the preset
dsb rules add "Always run the tests" --category verify
dsb rules remove <id>
dsb rules clear-learned          # drop learned, keep builtin/user
```

## Tool calling

When `tools` are present the bridge injects a short instruction block and parses
tool calls out of the answer into real OpenAI `tool_calls`:

```json
[{"name": "get_weather", "arguments": {"city": "Paris"}}]
```

- **Parallel calls:** one fenced array can contain several calls; the bridge
  returns all of them in one `tool_calls` delta.
- **Formats accepted:** fenced `tool_call` arrays/objects, plain `json` code
  fences that contain a call, XML `<tool_call>` wrappers, bare JSON, and the
  model's native DSML tags.
- **Malformed DSML:** the parser tolerates the closers DeepSeek emits
  (`</DSML>` instead of `</DSML invoke>`), a missing `calls` closer, and a JSON
  array wrapped inside `calls` instead of `invoke` tags. If the model emits a
  degenerate `calls` wrapper with no executable `invoke`, the markup is stripped
  instead of being streamed as assistant prose. The request finishes normally
  with no fake tool call, and the bridge logs how many markup characters were
  removed.
- **Corrupted argument names:** DeepSeek sometimes writes a parameter tag with
  full-width or typographic punctuation (`name="command"`, `name=“command”`),
  drops the `name=` key (`parameter="command" string="true"`), or puts the value
  in the attribute list (`name="description" string="Screenshot it"`). Each of
  those used to drop the parameter silently, so the harness rejected the call
  with `missing required property "command"` even though the model had emitted
  it, and the model kept retrying the identical call. All of those shapes are
  now read correctly. A parameter whose name is unreadable is mapped onto the
  tool's first unused schema slot that can hold the value (schema type checked),
  and every repair is logged as `tool call repaired (N): ...` so it is visible
  in `bridge.log` instead of surfacing as a confusing harness error.
- **Corrupted tags and names:** the short marker `<|parameter name="x">` (no
  `DSML` word) is read like the full tag; unquoted attribute values
  (`name=read`) are accepted; a JSON body or `arguments="..."` on an `invoke` is
  used as the arguments. A parameter literally named `name` is kept as an
  argument (`skill` has one), and a nameless call in a parallel batch is inferred
  from its arguments with required-argument checks — it repeats the previous
  call's tool rather than being retargeted to a different schema. Literal DSML
  markers inside a value (a heredoc that documents the marker) are preserved.
- **Debug capture:** set `DS_BRIDGE_DUMP_DIR=/some/dir` to write the raw SSE
  frames and the exact assistant text the parser saw, per request. Nothing is
  written when the variable is unset.
- **Continuation:** send results as normal
  `{"role": "tool", "tool_call_id": ...}` messages; the bridge renders them back
  into the DeepSeek transcript.
- Set `"toolMode": "off"` in the config to disable emulation.

Finish reason becomes `tool_calls`. `tool_choice: "none"` skips the preamble;
`"required"` or a specific function adds a must-call instruction.

## Agent swarms

Multiple harness agents can share one bridge. Each conversation key
(model + system prompt + first user message) is distinct, so concurrent agents
get independent DeepSeek conversations automatically — no per-agent setup.

Set `"maxUpstream"` in the config (default `2`, clamped to 1-16) to cap how
many requests hit DeepSeek at the same time; extras queue FIFO and take the
first freed slot. This protects the single web session from parallel-swarm
rate limits without serializing every request. The queue is observable:
`/health` and `/v1/bridge/status` report `upstream: {active, queued, max}`,
and the web dashboard shows the same counts in its header.

Mind the account-level rate throttle on top of the parallelism cap: rapid
bursts (measured trigger: ~13+ back-to-back requests, or a sustained heavy
wave) trip a throttle window that can outlast the burst by a few minutes.
Empty replies inside that window are retried on a dedicated 3s/9s/20s/35s
backoff, so short windows are absorbed invisibly; a deep window surfaces a
clean retriable `empty_reply` 502. After a heavy burst, give the account a
few quiet minutes (or pace the swarm) before the next sustained load.
