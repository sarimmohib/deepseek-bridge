# deepseek-bridge

An OpenAI-compatible local API for **chat.deepseek.com**. A small Node server
listens on loopback, a Chrome extension reuses your signed-in web session, and
any OpenAI client can talk to the model without a DeepSeek API key.

```
terminal / agent / SDK
        │  OpenAI HTTP + SSE
        ▼
  deepseek-bridge  (127.0.0.1:8787)
        │  WebSocket
        ▼
  extension service worker  ──►  content script on chat.deepseek.com
                                      │  same-origin fetch + cookies
                                      ▼
                              POST /api/v0/chat/completion
```

The extension runs on the real origin, so the site's cookies, `userToken`, and
proof-of-work checks work normally. It creates a chat session, solves the PoW
challenge, and translates the site's patch-based SSE stream into OpenAI chunks.
No DeepSeek API key and no scraping proxy are involved.

## Features

- OpenAI-compatible `POST /v1/chat/completions` with streaming SSE.
- `deepseek` command that starts the local server, shows status, and stops it.
- Image, file, and PDF input through OpenAI content parts.
- Emulated tool calling, including parallel calls, in native OpenAI format.
- Thinking on/off through `deepseek-chat` and `deepseek-reasoner`.
- Session reuse for multi-turn conversations.
- No npm runtime dependencies.

## Requirements

| Component | Requirement |
| --- | --- |
| Node.js | 18 or newer (`node --version`) |
| Browser | Chrome or Chromium 116+ |
| Account | A DeepSeek account signed in at <https://chat.deepseek.com> |
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

## First run

```bash
deepseek
```

On first use this creates:

- `~/.config/deepseek-bridge/config.json` (API key, port, defaults)
- `~/.config/deepseek-bridge/state.json` (cached chat sessions)
- `~/.config/deepseek-bridge/bridge.log` (background server log)

On Windows the base directory is
`%USERPROFILE%\.config\deepseek-bridge`. Set `DS_BRIDGE_HOME` to use a different
directory on any OS.

The command prints the base URL, API key, extension folder, and log path. Then:

1. Open `chrome://extensions` in Chrome/Chromium.
2. Enable **Developer mode**.
3. Click **Load unpacked** and select the printed extension folder
   (the `extension/` directory in this repository).
4. Open the extension popup. Set the port (`8787` by default) and paste the API
   key printed by `deepseek`.
5. Sign in at <https://chat.deepseek.com> in a normal tab and keep that tab
   available. The content script needs the site origin.
6. Check the connection:

   ```bash
   deepseek status
   ```

   `Extension: connected` means the bridge is ready.

The bridge listens on `127.0.0.1` only. If port 8787 is busy, it picks the next
free port and saves it in the config; update the extension popup to the new port.

## CLI reference

| Command | What it does |
| --- | --- |
| `deepseek` | Start the bridge in the background (or report that it is already running) and print status |
| `deepseek start` | Same as `deepseek` |
| `deepseek serve` | Run the bridge in the foreground; logs stream to the terminal |
| `deepseek stop` | Stop the background bridge using its PID file |
| `deepseek status` | Show base URL, extension state, config, and log path |
| `deepseek chat "hello"` | Send one chat message (starts the bridge if needed) |
| `deepseek "hello"` | Shorthand for `deepseek chat "hello"` |
| `deepseek --repl` | Interactive chat |
| `deepseek key` | Print the API key |
| `deepseek extension` | Print the absolute extension folder |
| `deepseek logs` | Print the log path and the last 40 lines |
| `deepseek help` | Show help |

Start options are passed through:

```bash
deepseek start --port 9000
deepseek serve --port 9000
```

## API

Base URL: `http://127.0.0.1:8787/v1`

Authentication: `Authorization: Bearer <key>` or `x-api-key: <key>`. The key is
printed at startup and stored in the config file.

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/v1/chat/completions` | Chat, streaming or non-streaming |
| `GET` | `/v1/models` | Model list |
| `GET` | `/v1/bridge/status` | Extension connection and queue |
| `GET` | `/v1/conversations` | Cached session map |
| `DELETE` | `/v1/conversations` | Forget cached sessions |
| `GET` | `/health` | Liveness and extension flag (no auth) |
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
  model = "deepseek-chat"
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
    model="deepseek-chat",
    messages=[{"role": "user", "content": "Explain quicksort in one paragraph."}],
)
print(response.choices[0].message.content)
```

Works with the OpenAI SDKs, LiteLLM, Continue, Aider, ZCode, or a local agent
loop.

### Models

The web app currently serves **DeepSeek-V4.1-Flash**, a multimodal MoE with a
552B backbone, a 1,048,576-token model context, and continuous reasoning effort.
The web session reports an **890,880-token** history/file budget and up to
**100 MB per uploaded file**. The bridge exposes four stable IDs:

| Model | Site mode |
| --- | --- |
| `deepseek-chat` | Default (Instant), thinking off |
| `deepseek-reasoner` | Default (Instant), thinking on; emits `reasoning_content` |
| `deepseek-expert` | `model_type: expert` (may be disabled on your account) |
| `deepseek-search` | Default, web search on |

`thinking_enabled`, `search_enabled`, `thinking`, and `reasoning_effort` in the
request body override the model defaults. `/v1/models` reports
`context_window: 890880` and `max_output_tokens: 131072` for each entry.

> **Thinking effort is only partially controllable.** The web client sends only
> `thinking_enabled`; it has no 1–100 effort field. The bridge accepts
> `reasoning_effort` for OpenAI compatibility (`none` turns thinking off,
> `low`/`high`/`max` turn it on) and adds a short prompt hint for low/max, but
> live tests showed the web gateway ignores numeric effort fields. Real numeric
> effort control requires the official DeepSeek API, not the web session.

### Images, files, and PDFs

Send ordinary OpenAI content parts. The bridge fetches remote URLs (http/https,
20 s timeout), decodes data URLs, caps at **10 MB per file / 20 MB total / 12
files**, uploads each file through the content script, and passes the returned
ids as `ref_file_ids`:

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

### Multi-turn conversations

The bridge keys a session on `(model, system prompt, first user message)`,
stores the DeepSeek `chat_session_id` and last assistant message id in
`state.json`, and, when the next request repeats the transcript and appends new
turns, continues that session with only the new tail as `parent_message_id`.
Keep sending the full transcript, like any OpenAI client does.
`DELETE /v1/conversations` starts fresh everywhere.

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
| Model ID | `deepseek-chat` (add `deepseek-reasoner` as a second model) |
| Context window | `890880` |
| Max output tokens | `65536` (the model supports more; the web session caps it server-side) |
| Input types | **Text + Image** (add PDF/file if your client supports it) |
| Capabilities | leave structured output / native search / mid-conversation system messages off |

Tool calls work through the emulation above (parallel calls supported), and
multi-turn agent loops reuse the same DeepSeek session. Keep a signed-in
`chat.deepseek.com` tab open.

## How it works

- **Extension, not scraping.** The content script runs on the real origin, so
  the site's cookies, `userToken`, and WAF expectations apply unchanged.
- **Proof of work.** `create_pow_challenge` returns a hash challenge; the site
  hashes `salt_expireAt_nonce` with a Keccak-f[1600] sponge that differs from
  stock SHA3-256 (round constants 1..23, and a rho step that swaps lane halves
  for offsets ≥ 32). `extension/pow.js` is a byte-accurate port and solves in
  ~1.2 s at the usual difficulty. A solved challenge is single-use, so a fresh
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

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `extension disconnected` / `extension_offline` | Open the extension popup, check the port and key, and keep a `chat.deepseek.com` tab open. Run `deepseek status`. |
| `not_signed_in` | Log in at chat.deepseek.com and reload the tab. |
| `INVALID_POW_RESPONSE` | Solved challenges are single-use; restart the bridge (`deepseek stop && deepseek`) so a fresh challenge is fetched. |
| Empty completion, `HTTP 200` | The site returned a JSON error body instead of SSE. The bridge surfaces it as an error; retry usually clears it. |
| `401 invalid_api_key` | Use the key from `deepseek key`. |
| `deepseek: command not found` | Add npm's global bin directory to `PATH` (`npm prefix -g`), or use `node bin/deepseek.js`. |
| `EACCES` during `npm install -g .` | Use `npm install -g . --prefix "$HOME/.local"` and add `~/.local/bin` to `PATH`; do not use `sudo`. |
| PowerShell blocks `npm.ps1` | Use `npm.cmd install -g .`, or run in `cmd.exe`. |
| Port already in use | The bridge picks the next free port and saves it. Update the extension popup to the new port, or start with `deepseek start --port 9000`. |
| Extension stops receiving jobs | MV3 workers sleep. The extension keeps a 30 s alarm and reconnects automatically; reload the extension or the tab as a last resort. |
| `extension_outdated` or old behavior after an update | Chrome does not hot-reload unpacked extensions. Open `chrome://extensions`, press **Reload** on DeepSeek Bridge, then refresh the `chat.deepseek.com` tab once. |
| Tool call appears as text / no tool executes | Restart the bridge after updating `src/`. It holds DSML, malformed DSML, and plain `json` fences until they can be parsed. If the old malformed text is already in the transcript, continue in a new turn or start a fresh session. |
| Hundreds of empty `<｜｜DSML｜｜>` tags | This is a degenerate model response after a tool-result turn. The bridge now strips the markup, removes the loop, and returns the surrounding prose without fake tool calls. Retry the turn or start a fresh session; the regression fixture is `test/fixtures/empty-dsml.txt`. |
| Windows firewall prompt | Allow Node.js on **private networks** only. The bridge binds to `127.0.0.1`, not the LAN. |
| WSL | Run the bridge inside WSL and use `http://127.0.0.1:8787/v1` from Windows; WSL 2 forwards loopback. If it does not, use the WSL IP or `netsh interface portproxy`. The Chrome extension must run in a browser that can reach the WSL port. |

### Logs

```bash
deepseek logs
```

The background log is `bridge.log` next to the config. A foreground run
(`deepseek serve`) prints the same lines directly.

## Development

```bash
npm test
```

The suite covers the PoW vector, prompt/tool parsing, the streaming guard, and a
full HTTP replay of every accepted tool-call format, including the failing
ZCode rollout payloads and the empty-DSML loop.

End-to-end harness (throwaway Chrome profile; it injects a token into
localStorage and never touches your real profile):

```bash
scripts/chrome-test.sh
node scripts/live-test.mjs --token '<userToken>' --prompt 'Reply with exactly: OK'
node scripts/live-test.mjs --token '<userToken>' --model deepseek-reasoner --debug
```

The harness scripts are POSIX development helpers. The bridge itself and the
`deepseek` command are cross-platform.

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
- One account, one browser profile. Concurrent requests are serialised by the
  site's per-session stream; separate conversations can still overlap.
- Image/file attachments are supported through the web upload endpoint, with a
  bridge cap of 10 MB per file and 20 MB total per request. The site itself
  allows larger files.
- The tool-call protocol is an adapter convention, not a native web-chat
  feature. Native DSML output is parsed as a fallback, and parallel calls are
  returned in one turn.
- `reasoning_effort` is accepted but the web gateway ignores numeric effort;
  only thinking on/off is real. `low`/`max` add a small prompt hint.
- The bridge is not a security boundary. Anyone who can reach the port and has
  the key can use your DeepSeek session. Keep it on loopback.

## License

Released into the public domain under **The Unlicense**. See [LICENSE](LICENSE).
You may copy, modify, sell, or redistribute this software for any purpose,
commercial or non-commercial, with no attribution required.
