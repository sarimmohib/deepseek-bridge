# CLI reference

`dsb` and `deepseek` are the same command. The package installs both names, plus
`deepseek-bridge`, `ds`, `ds-bridge`, and `ds-chat` aliases.

## Install

```bash
git clone https://github.com/sarimmohib/deepseek-bridge.git
cd deepseek-bridge
npm install -g .
```

The package has no runtime dependencies. Without a global install, every
command also works from the checkout:

```bash
node bin/deepseek.js
node bin/deepseek.js serve
node bin/ds-chat.js "hello"
```

Linux/macOS user-local install:

```bash
npm install -g . --prefix "$HOME/.local"
export PATH="$HOME/.local/bin:$PATH"
```

Windows: `npm install -g .` creates `dsb.cmd` and `deepseek.cmd` in
`%APPDATA%\npm`. If PowerShell blocks `npm.ps1`, use `npm.cmd` or `cmd.exe`.

For automatic updates, keep a git checkout. `npm install -g .` copies the
package into npm's global directory, so `dsb update` can only report that the
install is not a git checkout. `npm link` from the checkout keeps it linked.

## Setup wizard

A global install finishes with a short setup screen when npm runs in an
interactive terminal. Reopen it at any time:

```bash
dsb install
```

Set `DEEPSEEK_NO_SETUP=1` to skip the post-install prompt entirely (CI does this
automatically). The wizard probes the machine and only offers the extras you
pick:

| # | Tool | What it is for |
| --- | --- | --- |
| 1 | Git | `dsb update` |
| 2 | Tailscale | phone / remote access |
| 3 | DeepSeek Harness | the supported coding-agent CLI |
| 4 | Node.js | the runtime this bridge uses |
| 5 | Autostart | start at login |

Missing tools are installed with the machine's package manager — winget,
Chocolatey, or Scoop on Windows; Homebrew on macOS; apt, dnf, pacman, zypper,
or apk on Linux. Tailscale falls back to the official installer when the distro
package is unavailable. Nothing is installed silently, and `sudo` prompts in
your own terminal.

Autostart is a real service, not a shell alias:

| OS | What gets installed |
| --- | --- |
| Linux | `~/.config/systemd/user/deepseek-bridge.service` (`systemctl --user enable --now`, plus linger) |
| macOS | `~/Library/LaunchAgents/com.sarimmohib.deepseek-bridge.plist` (`launchctl load -w`) |
| Windows | A hidden logon task named `DeepSeek Bridge` (`schtasks`) running through `wscript.exe`, so no console window appears |

Non-interactive form:

```bash
dsb install --tools git,tailscale --autostart --yes
dsb install --tools tailscale --expose --yes   # also set host = 0.0.0.0
dsb install --no-tools --no-autostart --yes    # remove autostart
dsb install --dry-run --tools dsh              # print commands, install nothing
dsb install --list                             # JSON: detection + package names
```

`--expose` writes `host: "0.0.0.0"` so phones and Tailscale peers can reach the
bridge; every route still requires the API key. The interactive wizard asks
before doing this.

## Start screen

`dsb`, `dsb start`, and `dsb status` print a live panel with the endpoints, both
model ids, the API key, and every stored token grouped by health:

```text
 DEEPSEEK BRIDGE v0.9.20                          ONLINE 127.0.0.1:8787
 started in the background

 ENDPOINTS
   OpenAI       http://127.0.0.1:8787/v1
   Dashboard    http://127.0.0.1:8787/
   LAN          http://192.168.1.5:8787/v1
   Tailscale    http://desktop.tailce34b1.ts.net:8787/v1

 MODELS
   deepseek-reasoner   890,880 ctx   DeepSeek V4.1 Flash (web Reasoner), reasoning enabled
   deepseek-search     890,880 ctx   DeepSeek V4.1 Flash (web Search), reasoning + web search

 API KEY
   sk-ds-...

 TOKENS - 4 WORKING - 0 COOLING - 3 EXPIRED
   727717ba 727717ba       working    4 ok -  0 fail - 23m ago
   d81a1808 (no label)     expired   11 ok -  0 fail - 8h ago
   3 tokens need a fresh login - run `dsb login`

 TOOLS
   git 2.56.0 - tailscale 1.104.5 - dsh missing - node 24.22.1 - autostart off

 NEXT
   dsb accounts - dsb install - dsb ui - dsb logs - dsb stop
```

- **working** — ready for rotation.
- **cooling** — temporarily throttled by DeepSeek; the bridge retries it later.
- **expired** — `not_signed_in`; only a fresh login fixes it.

The panel respects `NO_COLOR`, truncates to the terminal width, and switches to
ASCII box drawing with `DEEPSEEK_ASCII=1` (useful over serial consoles). All
values are read locally; the panel never sends the key anywhere.

## Login

```bash
dsb login                              # hidden prompt
dsb login <token>                      # add one account
dsb login <a> <b> <c>                  # add several accounts
dsb login --token-file tokens.txt      # one token per line
DEEPSEEK_TOKEN=<token> dsb login       # from the environment
dsb login <token> --label work         # name the account
dsb login <token> --replace            # replace the whole pool
```

`--manual` and the legacy `--login` flag are still accepted as aliases:

```bash
dsb --login <token>
dsb login --manual --token <token>
```

Each token is verified against DeepSeek before it is kept. A rejected token is
removed again and the rest of the pool is untouched. Re-adding a token that is
already stored is a health reset, not a second entry. `--replace` clears the
pool first; the previous pool is restored if the new token is rejected.

`--label` can only be used with a single token.

## Accounts

```bash
dsb accounts                  # id, label/user, cookies, ready/cooling, throttle hits, last used
dsb accounts --json           # machine-readable (never contains token values)
dsb accounts remove 2         # by 1-based index
dsb accounts remove 1a2b3c4d  # by (partial) account id
dsb accounts clear            # show what would be removed
dsb accounts clear --yes      # remove every account + legacy session.json
dsb --logout                  # same effect, kept for compatibility
```

`dsb accounts` reads a running bridge when one is up (its stats are freshest)
and `accounts.json` directly when it is not.

## Command reference

| Command | What it does |
| --- | --- |
| `dsb` | Start the bridge in the background (or report that it is already running) and print status |
| `dsb start` | Same as `dsb` |
| `dsb serve` | Run the bridge in the foreground; logs stream to the terminal |
| `dsb stop` | Stop the background bridge using its PID file |
| `dsb status` | Show base URL, mode, account state, config, and log path |
| `dsb login` | Paste a `userToken` at a hidden prompt; appends one account |
| `dsb login <token>` | Add one account |
| `dsb login <a> <b> ...` | Add several accounts in one run |
| `dsb login --token-file tokens.txt` | Add tokens from a file (one per line) |
| `dsb login <token> --replace` | Replace the whole account pool with this token |
| `dsb login <token> --label NAME` | Name the account in lists and the dashboard |
| `dsb accounts` | List the stored account pool |
| `dsb accounts --json` | Machine-readable account list (never contains token values) |
| `dsb accounts remove <id\|index>` | Remove one account by full/partial id or 1-based index |
| `dsb accounts clear --yes` | Remove every account and the legacy `session.json` |
| `dsb --logout` | Remove every stored account |
| `dsb session` | Show stored account metadata, never the token |
| `dsb version` | Show the local version, commit, and GitHub `main` version |
| `dsb update --check` | Check GitHub without changing files |
| `dsb update` | Fast-forward a clean `main` git checkout and optionally restart the bridge |
| `dsb chat "hello"` | Send one chat message (starts the bridge if needed) |
| `dsb "hello"` | Shorthand for `dsb chat "hello"` |
| `dsb --repl` | Interactive chat |
| `dsb key` | Print the API key |
| `dsb key --file PATH` | Write the API key to a `0600` file for another client |
| `dsb rules` | Show the system-prompt preset and every rule |
| `dsb rules --json` | Machine-readable rules plus the active preset |
| `dsb rules add "<text>" [--category NAME]` | Add a user rule injected into every bridge prompt |
| `dsb rules remove <id>` | Remove one rule by id |
| `dsb rules clear-learned` | Drop auto-learned rules, keep builtin and user rules |
| `dsb logs` | Print the log path and the last 40 lines |
| `dsb install` | Interactive setup: optional tools and autostart |
| `dsb setup` | Alias for `dsb install` |
| `dsb install --list` | JSON tool catalog with detection state and package names |
| `dsb install --tools git,tailscale --autostart --yes` | Non-interactive setup |
| `dsb install --dry-run ...` | Print the package-manager commands without running them |
| `dsb models` | One line per advertised model |
| `dsb models --info` | Model details, a pasteable dsh profile patch, and generic OpenAI env JSON |
| `dsb help` | Show help |

Start options are passed through:

```bash
dsb start --port 9000    # changes the saved port on purpose
dsb serve --port 9000
dsb start --no-update   # skip the automatic GitHub version check
```

`dsb`, `dsb start`, `dsb serve`, and `dsb chat` check GitHub before starting.
The check is throttled to once every six hours and can be disabled with
`autoUpdate: false` in the config or `DEEPSEEK_NO_UPDATE=1` in the environment.

The saved port is authoritative. The bridge binds `127.0.0.1:8787` by default,
and if that port is busy it **refuses to start** instead of quietly moving:
dsh (`baseURL`), the dashboard proxy, and the remote stack all read the number
from `config.json`, so a silent port change is exactly the "bridge is running
but every client says connection refused" failure. Free the port (usually a
stale instance: `dsb stop`), or move it deliberately with
`dsb start --port 9000`. `ds-bridge --port-next` falls forward to the next free
port for that run only and never saves it.

## Web dashboard

Open <http://127.0.0.1:8787/> while the bridge runs. The page is served by the
bridge itself — one self-contained HTML file, no external requests, nothing
installed.

Unlock it with the API key (`dsb key` prints it; the key is stored in your
browser's localStorage and sent only to the bridge). Panels:

- **Header** — version, mode, base URL, and the upstream queue
  (`active/queued/max`); refreshes every few seconds.
- **Models** — the advertised models with context/output limits and a
  "Copy dsh config" button that produces the DeepSeek Harness profile patch.
- **System prompt & rules** — the active preset, whether rules are on, every
  builtin/user/learned rule (with a seen count for learned ones), an add-rule
  form, and "Clear learned".
- **Accounts** — every stored account with id, label, cookie count,
  ready/cooling state, throttle hits and last use; per-row delete, an add-token
  form (the bridge verifies the token before keeping it) and a double-confirm
  "Clear all accounts". Token values are never rendered.
- **Conversations** — searchable, filterable, sortable table of cached
  conversations (model, turns, input/output and session token counts, age,
  preview) with per-row delete and a double-confirm "Clear all".
- **Log** — the tail of `bridge.log` (auth-gated `GET /v1/bridge/log`).

## Versioning and self-update

Versions follow [semantic versioning](https://semver.org/) and live in
`package.json`. The current version is exposed in `/health`,
`/v1/bridge/status`, the HTML status page, and the startup log.

```bash
dsb version          # local + GitHub main + update status
dsb version --local  # no network
dsb version --json   # machine-readable
dsb update --check   # check without changing files
dsb update           # fast-forward main, restart a running bridge
dsb update --no-restart
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
dsb start --no-update
# or
DEEPSEEK_NO_UPDATE=1 dsb
```

or edit `~/.config/deepseek-bridge/config.json`:

```json
{
  "autoUpdate": false
}
```

## Config

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
| `maxUpstream` | `2` | Maximum simultaneous DeepSeek requests; extras queue FIFO. Measured: DeepSeek starts returning empty replies above ~2 parallel generations per account |
| `systemPrompt` | empty | Exact bridge system prompt, prepended to every request (wins over the preset) |
| `systemPreset` | `dsh-agent` | Named preset used when `systemPrompt` is empty: `dsh-agent`, `dsh-plan`, `dsh-tool`, or `none` |
| `systemRules` | `true` | Append the Rules section (builtin + user + learned) to the bridge system message |

A running bridge is restarted only after a successful update. The command itself
is still the old process for that invocation; the next invocation and the
restarted bridge use the new code.
