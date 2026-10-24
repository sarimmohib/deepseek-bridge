# deepseek-bridge

An OpenAI-compatible local API for **chat.deepseek.com**.

`deepseek --login` copies your logged-in web session out of Chrome **once**.
After that the bridge talks to DeepSeek directly from Node. Chrome and the
extension can be closed or removed, and there is no browser RAM cost for
normal requests.

```text
┌──────────────────┐   OpenAI HTTP + SSE   ┌──────────────────────┐
│ terminal / agent │ ────────────────────► │  deepseek-bridge     │
│ SDK / ZCode      │ ◄──────────────────── │  127.0.0.1:8787      │
└──────────────────┘                       └──────────┬───────────┘
                                                      │ HTTPS + cookies
                                                      │ + PoW
                                                      ▼
                                           chat.deepseek.com/api/v0
```

The extension mode is still available as a fallback. It does the same HTTP and
PoW work inside a `chat.deepseek.com` tab, which is useful when you do not want
to store a terminal session or when a new web build temporarily breaks direct
mode.

## Features

- **Direct mode:** no Chrome process, extension, or open tab needed at runtime.
- **One-command login:** `deepseek --login` copies only `chat.deepseek.com`
  cookies and the site's `userToken` into a `0600` session file.
- **Extension fallback:** the original same-origin extension path remains.
- **Transient-failure recovery:** network errors, server-busy replies, WAF
  challenges, and truncated SSE streams are retried; an interrupted reply is
  resumed with DeepSeek's continue endpoint and de-duplicated.
- **OpenCode provider:** a ready-to-use `deepseek-bridge/*` provider config.
- **Versioned self-update:** `deepseek version` checks GitHub, and
  `deepseek update` fast-forwards a clean git checkout.
- OpenAI-compatible `POST /v1/chat/completions`, streaming and non-streaming.
- Image, file, and PDF input through OpenAI content parts.
- Emulated tool calling, including parallel calls, in native OpenAI format.
- Reasoning-only models: `deepseek-reasoner` and `deepseek-search` (reasoning + web search).
- Multi-turn session reuse and no npm runtime dependencies.

## Requirements

| Component | Requirement |
| --- | --- |
| Node.js | 18 or newer (`node --version`) |
| Account | A DeepSeek account signed in at <https://chat.deepseek.com> |
| Browser | Chrome or Chromium 116+ **for `deepseek --login` only** (or for extension mode) |
| OS | Linux, macOS, or Windows 10/11 |

The bridge is pure JavaScript. It has no native modules, compilers, Python, or
system services to install. The only OS-specific part is how the `deepseek`
launcher is put on `PATH`, which npm handles.

## Install

### 1. Get the code

```bash
git clone https://github.com/sarimmohib/deepseek-bridge.git
cd deepseek-bridge
```

You can also download the ZIP from GitHub and extract it.

### 2. Install the `deepseek` command

From the repository directory:

```bash
npm install -g .
```

This creates a global `deepseek` command. The package has no dependencies, so
there is nothing else to download.

> **For automatic updates, keep a git checkout.** `npm install -g .` copies the
> package into npm's global directory, so `deepseek update` can only report that
> the install is not a git checkout. Link the checkout instead if you want
> `deepseek update` to fast-forward it automatically. A copied install is still
> fine; pull and reinstall to update it.
>
> Linux/macOS:
>
> ```bash
> mkdir -p "$HOME/.local/bin"
> ln -sf "$PWD/bin/deepseek.js" "$HOME/.local/bin/deepseek"
> ```
>
> Windows: `npm link` from the checkout works the same way (it creates the
> npm shim). Make sure the chosen `bin` directory is on `PATH`.

Verify:

```bash
deepseek --help
```

#### Linux and macOS

If npm reports `EACCES` for the global prefix, install into your user directory
instead of using `sudo`:

```bash
npm install -g . --prefix "$HOME/.local"
export PATH="$HOME/.local/bin:$PATH"
```

Add the `export PATH=...` line to `~/.bashrc`, `~/.zshrc`, or the equivalent
file for your shell. On macOS with Homebrew Node, the default prefix is usually
already writable.

If `deepseek` is not found after a normal global install, check:

```bash
npm prefix -g
# the command is in <prefix>/bin
```

#### Windows

Open PowerShell in the repository directory and run:

```powershell
npm install -g .
deepseek --help
```

The command is installed as `deepseek.cmd` in `%APPDATA%\npm`. That directory
is normally on `PATH`. If PowerShell blocks npm's script wrapper
(`npm.ps1 cannot be loaded`), use `npm.cmd install -g .` or run PowerShell as a
normal user with the execution policy adjusted for your account.

If you use Git Bash, the `deepseek` shim works there too. Native `cmd.exe` and
PowerShell are the best-tested Windows shells for this project.

#### Without a global install

You can run everything from the repository without changing `PATH`:

```bash
node bin/deepseek.js          # start in the background
node bin/deepseek.js serve    # run in the foreground
node bin/ds-chat.js "hello"   # one chat message
```

The old POSIX `bin/ds` wrapper is still present and forwards to the Node
launcher, but `deepseek` is the cross-platform command.

## One-time login (recommended)

The terminal cannot read Chrome's live cookie jar directly. The extension is
therefore used **once** as a narrow exporter: it asks `chat.deepseek.com` for
its own cookies and `localStorage.userToken`, then hands both to the local
bridge over the authenticated loopback connection. It does not copy other
sites' cookies.

1. Start the bridge:

   ```bash
   deepseek
   ```

2. Load the extension once (skip if it is already loaded):

   - Open `chrome://extensions`.
   - Enable **Developer mode**.
   - Click **Load unpacked** and select the `extension/` folder printed by
     `deepseek`.
   - Open the extension popup, enter the port (default `8787`) and the API key
     printed by `deepseek`.

3. Sign in at <https://chat.deepseek.com> in a normal Chrome tab.

4. Run:

   ```bash
   deepseek --login
   ```

   Expected output:

   ```text
   DeepSeek session copied to the terminal

     Mode        direct (Chrome not required)
     Cookies     1
     Session     ~/.config/deepseek-bridge/session.json

     Chrome and the extension are no longer needed for requests.
   ```

5. Test it with Chrome closed:

   ```bash
   deepseek chat "Reply with exactly: DIRECT_OK"
   ```

`deepseek --login` prints no token or cookie values. The session file is
created with mode `0600` on Linux/macOS and lives under your user profile on
Windows.

### No extension at all (manual token)

If you do not want to install the extension even once, use the manual flow:

1. Open <https://chat.deepseek.com> in Chrome and sign in.
2. Open DevTools (`F12`) → **Console**, paste this, and press Enter:

   ```js
   copy((()=>{const v=localStorage.getItem('userToken');try{const p=JSON.parse(v);return typeof p==='string'?p:p.value}catch{return v}})())
   ```

3. Run one of:

   ```bash
   deepseek --login --manual
   deepseek --login --manual --token-file token.txt
   deepseek --login --manual --token <userToken>
   DEEPSEEK_TOKEN=<userToken> deepseek --login --manual
   ```

4. At the hidden prompt, paste the token and press Enter. The prompt reads from
   a terminal, piped stdin, or the explicit options above; it does not require a
   trailing newline when input is piped.

`--token` can expose the value in your shell history, so prefer
`--token-file`, `DEEPSEEK_TOKEN`, or the hidden prompt. This stores only
`userToken`; the bridge acquires and updates the DeepSeek cookies it needs. It
is fully extension-independent, but the copy step is manual. The extension flow
above is automatic and can reuse the browser login you already have.

### Session lifetime

The web session can expire, be revoked, or require a new login. When that
happens, requests fail with `not_signed_in` and a message telling you to run:

```bash
deepseek --login
```

To delete the terminal session and go back to extension mode:

```bash
deepseek --logout
```

To inspect the stored session metadata without printing credentials:

```bash
deepseek session
```

### What gets copied

- Cookies returned by `chrome.cookies.getAll({ url: "https://chat.deepseek.com/" })`.
- The `userToken` value from `chat.deepseek.com` localStorage.
- The browser's user agent string, so the copied cookies have the same client
  identity they were issued to.

Nothing else. Cookies for Google, GitHub, banking, or any other site are never
read or stored.

## Extension mode (fallback)

If no `session.json` exists, the bridge uses the original extension path:

```text
terminal / agent / SDK
        │ OpenAI HTTP + SSE
        ▼
  deepseek-bridge (127.0.0.1:8787)
        │ WebSocket (authenticated)
        ▼
  extension service worker ──► content script on chat.deepseek.com
                                   │ same-origin fetch + cookies
                                   ▼
                           POST /api/v0/chat/completion
```

In this mode Chrome must stay open with a signed-in `chat.deepseek.com` tab.
The extension creates the chat session, solves the PoW challenge, and
translates the site's patch-based SSE stream into OpenAI chunks.

`deepseek --logout` switches back to this mode if the extension is connected.
Direct mode takes precedence whenever `session.json` exists.

## CLI reference

| Command | What it does |
| --- | --- |
| `deepseek` | Start the bridge in the background (or report that it is already running) and print status |
| `deepseek start` | Same as `deepseek` |
| `deepseek serve` | Run the bridge in the foreground; logs stream to the terminal |
| `deepseek stop` | Stop the background bridge using its PID file |
| `deepseek status` | Show base URL, mode, session/extension state, config, and log path |
| `deepseek --login` | Copy the Chrome web session into the terminal (once per login) |
| `deepseek --login --manual` | Paste `userToken` from DevTools (or use `--token`, `--token-file`, `DEEPSEEK_TOKEN`); no extension needed |
| `deepseek --logout` | Delete the terminal session and fall back to extension mode |
| `deepseek session` | Show stored session metadata, never the token |
| `deepseek version` | Show the local version, commit, and GitHub `main` version |
| `deepseek update --check` | Check GitHub without changing files |
| `deepseek update` | Fast-forward a clean `main` git checkout and optionally restart the bridge |
| `deepseek chat "hello"` | Send one chat message (starts the bridge if needed) |
| `deepseek "hello"` | Shorthand for `deepseek chat "hello"` |
| `deepseek --repl` | Interactive chat |
| `deepseek key` | Print the API key |
| `deepseek key --file PATH` | Write the API key to a `0600` file for another client |
| `deepseek extension` | Print the absolute extension folder |
| `deepseek logs` | Print the log path and the last 40 lines |
| `deepseek ui` | Full-screen terminal dashboard: models, conversations, health, log tail |
| `deepseek models` | One line per advertised model |
| `deepseek models --info` | Model details plus pasteable OpenCode/OpenAI harness config |
| `deepseek help` | Show help |

Start options are passed through:

```bash
deepseek start --port 9000
deepseek serve --port 9000
deepseek start --no-update   # skip the automatic GitHub version check
```

`deepseek`, `deepseek start`, `deepseek serve`, and `deepseek chat` check
GitHub before starting. The check is throttled to once every six hours and can
be disabled with `autoUpdate: false` in the config or
`DEEPSEEK_NO_UPDATE=1` in the environment.

The bridge listens on `127.0.0.1` only. If port 8787 is busy, it picks the next
free port and saves it in the config; update the extension popup if you use
extension mode.

## Terminal UI

```bash
deepseek ui
```

A zero-dependency, full-screen dashboard for the running bridge. Four live
panels:

- `[1] MODELS` — the advertised models with context/output limits, the default
  one marked.
- `[2] CONVERSATIONS` — cached conversations with model, turns, input/output
  and session token counts, age, and a preview of the latest turn.
- `[3] HEALTH` — bridge up/down, port, mode, direct-session age, and the
  upstream queue (`active/queued/max`).
- `[4] LOG` — the tail of `bridge.log`.

Keys: `1`-`4` or `Tab` move the focus ring, `r` refreshes immediately (the
panels also poll on their own), `q` or `Ctrl+C` quits. When stdin is not a TTY
(CI, pipes), the command renders one static frame with no focus highlight and
exits.

## Versioning and self-update

Versions follow [semantic versioning](https://semver.org/) and live in
`package.json`; the extension manifest uses the same version. The current
version is exposed in `/health`, `/v1/bridge/status`, the HTML status page, and
the startup log.

```bash
deepseek version          # local + GitHub main + update status
deepseek version --local  # no network
deepseek version --json   # machine-readable
deepseek update --check    # check without changing files
deepseek update            # fast-forward main, restart a running bridge
deepseek update --no-restart
```

The automatic check is intentionally conservative. It only updates an install
that is:

- a git checkout, not an npm copy;
- on `main`;
- clean (no modified or untracked files);
- behind GitHub `origin/main`;
- at least one semantic version behind `package.json` on `main`.

It uses `git fetch origin main` and `git merge --ff-only origin/main`, so it
never overwrites local work and never force-pushes. Failures are reported and
leave the checkout untouched. Disable the startup check with:

```bash
deepseek start --no-update
# or
DEEPSEEK_NO_UPDATE=1 deepseek
```

or edit `~/.config/deepseek-bridge/config.json`:

```json
{
  "autoUpdate": false
}
```

The config file holds the keys below. Every key is optional, and the bridge
re-reads the file per request, so edits apply on the next request without a
restart.

| Key | Default | What it does |
| --- | --- | --- |
| `autoUpdate` | `true` | Automatic GitHub version check on start/chat/serve |
| `defaultModel` | `deepseek-reasoner` | Model used when a request omits `model` |
| `toolMode` | `auto` | Set `"off"` to disable tool-call emulation |
| `contextSwitchAt` | `0.8` | Fraction of the model context window after which a conversation restarts fresh |
| `maxFreshTranscriptChars` | `200000` | Cap for transcripts replayed into a fresh session |
| `maxUpstream` | `3` | Maximum simultaneous DeepSeek requests; extras queue FIFO |
| `systemPrompt` | empty | Bridge-provided system prompt, prepended to every request |
| `systemPreset` | empty | Named preset instead of `systemPrompt`: `coding`, `concise`, `tutor`, `agent` |

A running bridge is restarted only after a successful update. The command itself
is still the old process for that invocation; the next invocation and the
restarted bridge use the new code.

## OpenCode

OpenCode V2 can use the bridge as a normal OpenAI-compatible custom provider.
Start the bridge first, then export its key to a private file:

```bash
deepseek
deepseek key --file ~/.config/deepseek-bridge/opencode.key
```

Add this to `~/.config/opencode/opencode.jsonc` (the file is normally mode
`0600`; never commit the key):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "providers": {
    "deepseek-bridge": {
      "name": "DeepSeek Bridge",
      "package": "@opencode/ai/providers/openai-compatible",
      "settings": {
        "baseURL": "http://127.0.0.1:8787/v1",
        "apiKey": "{file:~/.config/deepseek-bridge/opencode.key}"
      },
      "compatibility": {
        "reasoningField": "reasoning_content"
      },
      "models": {
        "deepseek-reasoner": {
          "name": "DeepSeek V4.1 Flash Reasoner (web)",
          "family": "deepseek",
          "capabilities": {
            "tools": true,
            "input": ["text", "image"],
            "output": ["text"],
            "reasoning": {
              "supported": true,
              "effort": ["low", "high", "max"]
            }
          },
          "limit": { "context": 890880, "output": 131072 }
        },
        "deepseek-search": {
          "name": "DeepSeek V4.1 Flash Search (web)",
          "family": "deepseek",
          "capabilities": {
            "tools": true,
            "input": ["text", "image"],
            "output": ["text"],
            "reasoning": {
              "supported": true,
              "effort": ["low", "high", "max"]
            }
          },
          "limit": { "context": 890880, "output": 131072 }
        }
      }
    }
  }
}
```

Both models use the same provider. Verify and use it:

```bash
opencode models | grep deepseek-bridge
opencode run --model deepseek-bridge/deepseek-reasoner "Reply with exactly: OK"
```

Select it for an interactive session with `/models`, or make it the default for
new sessions:

```jsonc
{
  "model": "deepseek-bridge/deepseek-reasoner"
}
```

If the bridge chose a different port because 8787 was busy, change
`settings.baseURL` to match the URL printed by `deepseek status`. The bridge
must be running; it is not started by OpenCode automatically.

## API

Base URL: `http://127.0.0.1:8787/v1`

Authentication: `Authorization: Bearer <key>` or `x-api-key: <key>`. The key is
printed at startup and stored in the config file.

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/v1/chat/completions` | Chat, streaming or non-streaming |
| `GET` | `/v1/models` | Model list |
| `GET` | `/v1/bridge/status` | Mode, direct session, extension state, queue |
| `GET` | `/v1/bridge/session` | Stored session metadata (no credentials) |
| `POST` | `/v1/bridge/session/export` | Ask Chrome for a fresh session (used by `--login`) |
| `POST` | `/v1/bridge/session/verify` | Verify the stored session with a small authenticated call |
| `DELETE` | `/v1/bridge/session` | Delete the stored terminal session |
| `GET` | `/v1/bridge/conversations` | Cached conversations with token counts and previews |
| `GET` | `/v1/conversations` | Cached session map |
| `DELETE` | `/v1/conversations` | Forget cached sessions |
| `GET` | `/health` | Liveness, version, mode, and extension flag (no auth) |
| `GET` | `/` | HTML status page |

### curl

Linux/macOS:

```bash
KEY="$(deepseek key)"

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
$key = deepseek key
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

### OpenAI SDK

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:8787/v1",
    api_key="<the sk-ds-... key from `deepseek key`>",
)

response = client.chat.completions.create(
    model="deepseek-reasoner",
    messages=[{"role": "user", "content": "Explain quicksort in one paragraph."}],
)
print(response.choices[0].message.content)
```

Works with the OpenAI SDKs, LiteLLM, Continue, Aider, ZCode, or a local agent
loop.

### Models

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

#### Model information

```bash
deepseek models          # one line per model
deepseek models --info   # details plus pasteable harness configuration
```

`--info` prints each model's description and limits, then ready-to-paste
configuration: an OpenCode provider JSON block that mirrors the working entry
from the [OpenCode](#opencode) section, and a generic OpenAI-compatible env
block for any other client. The output has this shape:

```text
deepseek-bridge models  (default: deepseek-reasoner)
Base URL   http://127.0.0.1:8787/v1
API key    sk-ds-...

* deepseek-reasoner  (default)
    description        DeepSeek V4.1 Flash (web Reasoner), reasoning enabled, ...
    context_window     890,880
    max_output_tokens  131,072

OpenCode provider snippet (paste under "providers" in ~/.config/opencode/opencode.jsonc):
{
  "deepseek-bridge": {
    "name": "DeepSeek Bridge",
    "package": "@opencode/ai/providers/openai-compatible",
    "settings": { "baseURL": "http://127.0.0.1:8787/v1", ... },
    "models": { "deepseek-reasoner": { ... }, "deepseek-search": { ... } }
  }
}

Generic OpenAI-compatible env (JSON):
{
  "OPENAI_BASE_URL": "http://127.0.0.1:8787/v1",
  "OPENAI_API_KEY": "sk-ds-...",
  "OPENAI_MODEL": "deepseek-reasoner"
}
```

### Images, files, and PDFs

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

### Multi-turn conversations

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

### System prompts

The bridge can prepend its own system message to every request. Two keys in
`~/.config/deepseek-bridge/config.json`:

- `"systemPrompt": "..."` — exact text, sent verbatim.
- `"systemPreset"` — one of `coding`, `concise`, `tutor`, or `agent`.

An explicit `systemPrompt` wins over a `systemPreset`; an unknown preset name
is ignored with a one-line log. The bridge message is prepended as an extra
system message: the harness's own system message is kept verbatim, nothing is
deduped or rewritten. The config file is re-read per request, so edits apply on
the next request without restarting the bridge.

### Tool calling

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
  (`</｜｜DSML｜｜>` instead of `</｜｜DSML｜｜ invoke>`), a missing `calls`
  closer, and a JSON array wrapped inside `calls` instead of `invoke` tags. If
  the model emits a degenerate `calls` wrapper with no executable `invoke`,
  the markup is stripped instead of being streamed as assistant prose. The
  request finishes normally with no fake tool call, and the bridge logs how many
  markup characters were removed.
- **Continuation:** send results as normal
  `{"role": "tool", "tool_call_id": ...}` messages; the bridge renders them back
  into the DeepSeek transcript.
- Set `"toolMode": "off"` in the config to disable emulation.

Finish reason becomes `tool_calls`. `tool_choice: "none"` skips the preamble;
`"required"` or a specific function adds a must-call instruction.

### Using it from ZCode

ZCode → **Model settings** → **Add provider**, then:

| Field | Value |
| --- | --- |
| Base URL | `http://127.0.0.1:8787/v1` |
| API format | **Chat completions (`/chat/completions`)** — not Anthropic |
| API key | the `sk-ds-…` key from `deepseek key` |
| Model ID | `deepseek-reasoner` (add `deepseek-search` as a second model) |
| Context window | `890880` |
| Max output tokens | `65536` (the model supports more; the web session caps it server-side) |
| Input types | **Text + Image** (add PDF/file if your client supports it) |
| Capabilities | leave structured output / native search / mid-conversation system messages off |

Tool calls work through the emulation above (parallel calls supported), and
multi-turn agent loops reuse the same DeepSeek session. In direct mode you no
longer need a signed-in tab; in extension mode keep one open.

### Agent swarms

Multiple harness agents can share one bridge. Each conversation key
(model + system prompt + first user message) is distinct, so concurrent agents
get independent DeepSeek conversations automatically — no per-agent setup.

Set `"maxUpstream"` in the config (default `3`, clamped to 1-16) to cap how
many requests hit DeepSeek at the same time; extras queue FIFO and take the
first freed slot. This protects the single web session from parallel-swarm
rate limits without serializing every request. The queue is observable:
`/health` and `/v1/bridge/status` report `upstream: {active, queued, max}`,
and `deepseek ui` shows the same counts in its health panel.

## How it works

- **Direct session.** `deepseek --login` asks the extension for the
  `chat.deepseek.com` cookies and `localStorage.userToken`, then stores them in
  `session.json` (`0600`). The Node client sends those values as an ordinary
  `Cookie` header and `Authorization: Bearer <userToken>`.
- **Proof of work.** `create_pow_challenge` returns a hash challenge; the site
  hashes `salt_expireAt_nonce` with a Keccak-f[1600] sponge that differs from
  stock SHA3-256 (round constants 1..23, and a rho step that swaps lane halves
  for offsets ≥ 32). `src/pow.js` (and the extension copy) is a byte-accurate port and solves
  in ~1.2 s at the usual difficulty. A solved challenge is single-use, so a fresh
  challenge is requested per completion.
- **Stream translation.** The site sends patch events (`{v}`, `{p,o,v}` with
  `SET`/`APPEND`/`BATCH`, index `-1` = last element). The accumulator rebuilds
  the `response.fragments` array and emits `THINK` fragments as
  `reasoning_content`, `RESPONSE` fragments as `content`.
- **Tool adapter.** The bridge adds a compact tool schema to the prompt, watches
  the stream for tool-call fences/DSML, holds them until the block is complete,
  and emits native `tool_calls` deltas. Ordinary JSON fences are released as
  soon as their fence is complete.
- **Sessions.** The bridge reuses the DeepSeek `chat_session_id` for matching
  transcripts and sends only the new tail with `parent_message_id`. This keeps
  context and tool results consistent without resending the whole conversation
  to the website on every turn.
- **Fallback.** If `session.json` is absent, the bridge pushes the same job to
  the extension over its authenticated loopback WebSocket. The extension
  executes it in the real site origin.

## Security

- The session file is `~/.config/deepseek-bridge/session.json` and is written
  with mode `0600` on Linux/macOS (under your user profile on Windows). The
  config directory is `0700` where POSIX modes apply.
- Only `deepseek.com` cookies are copied. The extension never enumerates or
  exports cookies for other sites.
- The bridge prints only a truncated API key in the HTML status page and never
  prints the DeepSeek token or cookie values.
- The bridge listens on `127.0.0.1` only. The API key protects the loopback
  HTTP API; anyone with both local access and that key can use your session.
- `deepseek --logout` deletes the session file. Deleting it does not log out
  your browser; use DeepSeek's own logout for that.
- Copied web sessions are personal credentials. Do not commit `session.json`,
  paste it in issues, or share it. The repository's `.gitignore` excludes it.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `deepseek --login` says Chrome is not connected | Open Chrome, load/reload the extension from the folder printed by `deepseek`, and keep the popup port/key correct. Sign in at chat.deepseek.com. Then retry; Chrome may need up to 30 s to wake the extension worker. |
| `not_signed_in` / session expired | Run `deepseek --login` again. Direct mode does not fall back automatically, so an expired stored session is reported clearly. |
| `deepseek --login` says Chrome returned an incomplete session | The content script was stale. Reload the extension in `chrome://extensions`, refresh the `chat.deepseek.com` tab, then retry. |
| `extension disconnected` / `extension_offline` | You are in extension mode (no `session.json`) or you requested `--login` with Chrome closed. Start Chrome and keep a signed-in `chat.deepseek.com` tab open. |
| `INVALID_POW_RESPONSE` | Solved challenges are single-use. The bridge automatically requests a fresh challenge and retries. If it persists, restart with `deepseek stop && deepseek`. |
| Empty completion, `HTTP 200` | The site returned a JSON error body instead of SSE. The bridge retries transient errors; if it still fails, retry the request or run `deepseek --login` again. |
| Reply stops midway / `stream_interrupted` | The bridge detects a missing stream terminator, asks DeepSeek to continue the same assistant message, and appends only the missing text. If DeepSeek refuses to continue, the error is surfaced instead of silently truncating. |
| `401 invalid_api_key` | Use the key from `deepseek key`. |
| `deepseek: command not found` | Add npm's global bin directory to `PATH` (`npm prefix -g`), or use `node bin/deepseek.js`. |
| `EACCES` during `npm install -g .` | Use `npm install -g . --prefix "$HOME/.local"` and add `~/.local/bin` to `PATH`; do not use `sudo`. |
| PowerShell blocks `npm.ps1` | Use `npm.cmd install -g .`, or run in `cmd.exe`. |
| Port already in use | The bridge picks the next free port and saves it. Update the extension popup if used, or start with `deepseek start --port 9000`. |
| Extension stops receiving jobs | MV3 workers sleep. The extension keeps a 30 s alarm and reconnects automatically; reload the extension or the tab as a last resort. |
| `extension_outdated` or old behavior after an update | Chrome does not hot-reload unpacked extensions. Open `chrome://extensions`, press **Reload** on DeepSeek Bridge, then refresh the `chat.deepseek.com` tab once. |
| Chrome shows `WebSocket connection ... ERR_CONNECTION_REFUSED` | The bridge was stopped while the extension was retrying. Current extension builds probe `GET /health` before opening the WebSocket, so a stopped bridge no longer creates this error. Reload the extension, press **Clear all** on the Errors page to remove old entries, then start the bridge with `deepseek`. |
| Tool call appears as text / no tool executes | Restart the bridge after updating `src/`. It holds DSML, malformed DSML, and plain `json` fences until they can be parsed. If the old malformed text is already in the transcript, continue in a new turn or start a fresh session. |
| Hundreds of empty `<｜｜DSML｜｜>` tags | This is a degenerate model response after a tool-result turn. The bridge strips the markup, removes the loop, and returns the surrounding prose without fake tool calls. Retry the turn or start a fresh session; the regression fixture is `test/fixtures/empty-dsml.txt`. |
| Windows firewall prompt | Allow Node.js on **private networks** only. The bridge binds to `127.0.0.1`, not the LAN. |
| WSL | Run the bridge inside WSL and use `http://127.0.0.1:8787/v1` from Windows; WSL 2 forwards loopback. If it does not, use the WSL IP or `netsh interface portproxy`. For `--login`, the Chrome extension must be able to reach the bridge port. |

### Logs

```bash
deepseek logs
```

The background log is `bridge.log` next to the config. A foreground run
(`deepseek serve`) prints the same lines directly. Chat log lines include
`mode=direct` or `mode=extension`, so you can confirm which path served a
request.

## Development

```bash
npm test
```

The suite covers the PoW vector, session storage and cookie filtering,
prompt/tool parsing, the streaming guard, semantic version comparison and the
GitHub version fetch, and a full HTTP replay of every accepted tool-call format,
including the failing ZCode rollout payloads and the empty-DSML loop.

End-to-end harness (throwaway Chrome profile; it injects a token into
localStorage and never touches your real profile):

```bash
scripts/chrome-test.sh
node scripts/live-test.mjs --token '<userToken>' --prompt 'Reply with exactly: OK'
node scripts/live-test.mjs --token '<userToken>' --model deepseek-reasoner --debug
```

Live direct-mode smoke test with the stored session:

```bash
curl -s http://127.0.0.1:8787/v1/chat/completions \
  -H "authorization: Bearer $(deepseek key)" \
  -H 'content-type: application/json' \
  -d '{"model":"deepseek-reasoner","messages":[{"role":"user","content":"Reply with exactly DIRECT_OK"}]}'
```

After editing `extension/content.js` or `sw.js`, reload the unpacked extension
and the DeepSeek tab. Once a build that understands the reload message is
running, the bridge can request future reloads:

```bash
curl -s -X POST http://127.0.0.1:8787/v1/bridge/reload-extension \
  -H "authorization: Bearer $(deepseek key)"
```

The first update still needs one manual **Reload** in `chrome://extensions`,
because the previous worker does not know that message.

## Notes and limits

- Personal-use bridge: it rides your own web session. Bulk or commercial use
  will hit account rate limits and the site's terms.
- One account, one session. Direct-mode requests share the copied web session
  with that browser login; running both paths with the same account is fine,
  but they are not isolated accounts.
- The session file is a credential. Treat it like a browser cookie export.
- Image/file attachments are supported through the web upload endpoint, with a
  bridge cap of 10 MB per file and 20 MB total per request. Text files are
  additionally budgeted against the model context window; see
  [Images, files, and PDFs](#images-files-and-pdfs).
- The tool-call protocol is an adapter convention, not a native web-chat
  feature. Native DSML output is parsed as a fallback, and parallel calls are
  returned in one turn.
- Both advertised models always reason. `reasoning_effort` is accepted but the
  web gateway ignores numeric effort; `low`/`max` add a small prompt hint.
- The bridge is not a security boundary. Keep it on loopback and protect the
  API key and `session.json`.

## License

Released into the public domain under **The Unlicense**. See [LICENSE](LICENSE).
You may copy, modify, sell, or redistribute this software for any purpose,
commercial or non-commercial, with no attribution required.
