#!/usr/bin/env bash
# Launch a throwaway Chrome profile with remote debugging enabled.
# The extension is loaded over CDP by scripts/live-test.mjs.
#
# Linux/macOS development helper. Set CHROME_BIN if Chrome/Chromium is not on
# PATH under one of the usual names.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROFILE="${CHROME_PROFILE:-${TMPDIR:-/tmp}/deepseek-bridge-chrome-profile}"
PORT="${DEVTOOLS_PORT:-9333}"
EXT="${1:-$DIR/extension}"
LOG="${CHROME_LOG:-${TMPDIR:-/tmp}/deepseek-bridge-chrome.log}"

CHROME_BIN="${CHROME_BIN:-}"
if [ -z "$CHROME_BIN" ]; then
  for candidate in google-chrome-stable google-chrome chromium chromium-browser; do
    if command -v "$candidate" >/dev/null 2>&1; then
      CHROME_BIN="$(command -v "$candidate")"
      break
    fi
  done
fi
if [ -z "$CHROME_BIN" ]; then
  echo "Chrome/Chromium not found. Install one or set CHROME_BIN." >&2
  exit 1
fi

mkdir -p "$(dirname "$LOG")"
pkill -f "deepseek-bridge-chrome-prof[i]le" 2>/dev/null || true
sleep 0.5
rm -rf "$PROFILE"

"$CHROME_BIN" \
  --headless=new \
  --user-data-dir="$PROFILE" \
  --remote-debugging-port="$PORT" \
  --no-first-run \
  --no-default-browser-check \
  --enable-unsafe-extension-debugging \
  --disable-background-timer-throttling \
  --disable-backgrounding-occluded-windows \
  --disable-renderer-backgrounding \
  --window-size=1280,900 \
  about:blank \
  > "$LOG" 2>&1 &

for i in $(seq 1 40); do
  if curl -sf "http://127.0.0.1:$PORT/json/version" > /dev/null; then
    echo "chrome ready on $PORT (extension: $EXT)"
    exit 0
  fi
  sleep 0.25
done

echo "chrome failed to start; see $LOG" >&2
exit 1
