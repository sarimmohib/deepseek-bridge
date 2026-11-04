# Troubleshooting

Start with the built-in diagnostics:

```bash
dsb status          # endpoints, mode, accounts, tools
dsb accounts        # per-account health and cooldowns
dsb logs            # log path + last 40 lines
dsb version         # local, GitHub, and update state
```

## Login and accounts

| Symptom | Fix |
| --- | --- |
| `deepseek login` rejects the token | Copy a fresh `userToken` from a signed-in <https://chat.deepseek.com> tab. The DevTools snippet is in the [main README](../README.md#login). |
| `not_signed_in` / session expired | Run `dsb login <newToken>` again. With two or more accounts the bridge rotates to a healthy one and parks the expired account (`dsb accounts` shows `not_signed_in`); re-add its token to reset it. |
| `dsb accounts` shows `cooling 45s` | Normal: that account hit DeepSeek's per-account rate window. Requests use other ready accounts; wait out the countdown or add another account. |
| Every account is cooling / empty replies continue | All stored accounts are inside their rate window. Add another account or wait for the longest cool-down; the bridge errors with `empty_reply` only when no account can serve. |
| Only one account, no rotation | Rotation needs at least two stored accounts. Check with `dsb accounts` and add one (`dsb login <token>`). |
| `dsb accounts` says the bridge has no accounts API | The running bridge is older than 0.8.0. Restart it (`dsb stop && dsb`) so it loads the new pool. |
| A re-added token did not create a second account | Tokens dedupe by hash. The re-add is a health reset of the existing entry; add a different account's token to grow the pool. |
| `--label` was rejected | `--label` only applies when one token is supplied. Add labels one login at a time. |
| The bridge starts but every client gets connection refused | The saved port is authoritative. Check `dsb status` and `config.json`; free the port (usually a stale instance: `dsb stop`) or move it deliberately with `dsb start --port 9000`. |

## Requests

| Symptom | Fix |
| --- | --- |
| `401 invalid_api_key` | Use the key from `dsb key`. The CLI and the bridge must use the same config directory (`DS_BRIDGE_HOME`). |
| `INVALID_POW_RESPONSE` | Solved challenges are single-use. The bridge automatically requests a fresh challenge and retries. If it persists, restart with `dsb stop && dsb`. |
| Empty completion, `HTTP 200` | The site returned a JSON error body instead of SSE. The bridge retries transient errors; if it still fails, retry the request or add a fresh login. |
| Reply stops midway / `stream_interrupted` | The bridge detects a missing stream terminator, asks DeepSeek to continue the same assistant message, and appends only the missing text. If DeepSeek refuses to continue, the error is surfaced instead of silently truncating. |
| Tool call appears as text / no tool executes | Restart the bridge after updating `src/`. It holds DSML, malformed DSML, and plain `json` fences until they can be parsed. If the old malformed text is already in the transcript, continue in a new turn or start a fresh session. |
| Hundreds of empty DSML tags | This is a degenerate model response after a tool-result turn. The bridge strips the markup, removes the loop, and returns the surrounding prose without fake tool calls. Retry the turn or start a fresh session; the regression fixture is `test/fixtures/empty-dsml.txt`. |
| Upload rejected or silently skipped | Check the caps: 10 MB per file, 20 MB total, 12 files. Text files are also budgeted against the 890,880-token context window; the prompt gets a note when a file is dropped. |
| Windows firewall prompt | Allow Node.js on **private networks** only. The bridge binds to `127.0.0.1` by default. |
| WSL | Run the bridge inside WSL and use `http://127.0.0.1:8787/v1` from Windows; WSL 2 forwards loopback. If it does not, use the WSL IP or `netsh interface portproxy`. |

## Install and CLI

| Symptom | Fix |
| --- | --- |
| `dsb: command not found` | Add npm's global bin directory to `PATH` (`npm prefix -g`), or run `node bin/deepseek.js`. |
| `EACCES` during `npm install -g .` | Use `npm install -g . --prefix "$HOME/.local"` and add `~/.local/bin` to `PATH`; do not use `sudo`. |
| PowerShell blocks `npm.ps1` | Use `npm.cmd install -g .`, or run in `cmd.exe`. |
| `dsb update` says the install is not a git checkout | `npm install -g .` copies the package. Use a git checkout with `npm link`, or pull and reinstall. |
| Port already in use | The bridge refuses to start and says why: the port in `config.json` is the one dsh, the dashboard proxy and every other client dial. Free the port (`dsb stop`), choose another deliberately with `dsb start --port 9000`, or use `ds-bridge --port-next` for a one-off run (not saved). |

## Logs

```bash
dsb logs
```

The background log is `bridge.log` next to the config. A foreground run
(`dsb serve`) prints the same lines directly. Chat log lines include
`mode=direct` or `mode=agent`, so you can confirm which path served a request.

Set `DS_BRIDGE_DUMP_DIR=/some/dir` to write raw SSE frames and the exact
assistant text the tool parser saw, per request. Nothing is written when the
variable is unset.

## Android

See [android/README.md](../android/README.md) for server modes, the Gradle
build, and WSA testing. The usual issue is reachability: the phone must be on
the same LAN or tailnet, and the bridge must listen on an address the phone can
dial (`host: "0.0.0.0"` or a Tailscale IP).
