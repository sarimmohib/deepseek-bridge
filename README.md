# deepseek-bridge

An OpenAI-compatible local API for **chat.deepseek.com**, with an unlimited account
pool and automatic rotation.

Add a DeepSeek `userToken` once, then point any OpenAI client at
`http://127.0.0.1:8787/v1`. The bridge talks to DeepSeek directly from Node — no
browser has to stay open, and there is no per-request browser RAM cost.

## What it does

- **OpenAI-compatible API** — `POST /v1/chat/completions`, streaming and
  non-streaming, plus `GET /v1/models`.
- **Unlimited accounts, automatic rotation** — store any number of DeepSeek
  logins. When one hits a rate window it cools down and the request continues on
  another account. Conversations stay pinned to the account that started them.
- **Headless after login** — cookies, PoW, SSE translation, uploads, and
  session reuse all run inside the bridge.
- **Images, files, and PDFs** through ordinary OpenAI content parts.
- **Emulated tool calling** in native OpenAI `tool_calls` format, including
  parallel calls.
- **Two stable models** — `deepseek-reasoner` (reasoning) and
  `deepseek-search` (reasoning + web search).
- **dsh-ready** — `dsb models --info` prints a pasteable DeepSeek Harness
  profile patch.
- **Web dashboard** at `http://127.0.0.1:8787/` for accounts, rules,
  conversations, and logs.
- **Android app** in [`android/`](android/README.md); the APK is attached to
  every [release](https://github.com/sarimmohib/deepseek-bridge/releases).

## Install

Requirements: **Node.js 18 or newer**, and a DeepSeek account.

```bash
git clone https://github.com/sarimmohib/deepseek-bridge.git
cd deepseek-bridge
npm install -g .
```

This installs both `deepseek` and the shorter `dsb` command. The package has no
runtime dependencies.

Windows (PowerShell):

```powershell
git clone https://github.com/sarimmohib/deepseek-bridge.git
cd deepseek-bridge
npm install -g .
dsb --help
```

If PowerShell blocks `npm.ps1`, use `npm.cmd install -g .` or run it in
`cmd.exe`. For a user-local install without `sudo` on Linux/macOS:

```bash
npm install -g . --prefix "$HOME/.local"
export PATH="$HOME/.local/bin:$PATH"
```

## Login

Open <https://chat.deepseek.com>, sign in, then open DevTools (`F12`) → Console
and run:

```js
copy((()=>{const v=localStorage.getItem('userToken');try{const p=JSON.parse(v);return typeof p==='string'?p:p.value}catch{return v}})())
```

Now add the copied token:

```bash
dsb login                 # hidden prompt; paste the token and press Enter
dsb login <token>         # add one account directly
dsb login <a> <b> <c>     # add several accounts in one run
dsb login --token-file tokens.txt   # one token per line
DEEPSEEK_TOKEN=<token> dsb login    # from the environment
dsb login <token> --replace         # replace the whole pool
```

Each token is verified against DeepSeek before it is kept. Re-adding the same
token is a health reset, not a duplicate. `--token` also works, but it can leak
into shell history; prefer the prompt, `--token-file`, or `DEEPSEEK_TOKEN`.

## Run

```bash
dsb                      # start in the background and print the status panel
dsb serve                # run in the foreground
dsb chat "hello"         # send one message
dsb status               # show endpoints, models, accounts, and tools
dsb stop                 # stop the background process
```

The API is then at `http://127.0.0.1:8787/v1`:

```bash
curl -s http://127.0.0.1:8787/v1/chat/completions \
  -H "authorization: Bearer $(dsb key)" \
  -H 'content-type: application/json' \
  -d '{"model":"deepseek-reasoner","messages":[{"role":"user","content":"17*23?"}]}'
```

## Android app

DSB Mobile lives in [`android/`](android/README.md). It connects to the bridge
over LAN or Tailscale, shows the pool, runs health checks, and adds fresh logins
through DeepSeek's official sign-in page in a WebView.

Download `app-debug.apk` from the [latest release](https://github.com/sarimmohib/deepseek-bridge/releases)
and sideload it:

```bash
adb install -r app-debug.apk
```

## Documentation

| Document | Contents |
| --- | --- |
| [docs/CLI.md](docs/CLI.md) | Every command, the setup wizard, config keys, updates, dashboard |
| [docs/API.md](docs/API.md) | Endpoints, curl/SDK examples, models, uploads, rules, tool calling |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Account pool, rotation, PoW, streaming, sessions, security model |
| [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | Common failures, logs, and fixes |
| [RULES.md](RULES.md) | The shipped system-prompt rules and how learning works |
| [android/README.md](android/README.md) | App screens, server modes, build, and WSA testing |

## Notes

- This is a personal-use bridge over your own web sessions. Bulk or commercial
  use will hit account rate limits and the site's terms.
- `accounts.json` is a credential store. It is written `0600` where POSIX modes
  apply and is excluded from git. Do not paste it into issues.
- The bridge listens on `127.0.0.1` by default. Set `host` to `0.0.0.0` (or use
  `dsb install --expose`) to let a phone or Tailscale peer reach it; every route
  still requires the API key.

## License

Released into the public domain under **The Unlicense**. See [LICENSE](LICENSE).
