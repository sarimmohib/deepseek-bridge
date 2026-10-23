# Changelog

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
