/*
 * Opt-in raw capture for diagnosing malformed upstream replies.
 *
 * Set DS_BRIDGE_DUMP_DIR to a writable directory and the bridge writes, per
 * request, the raw SSE frames and the assistant text the tool-call parser
 * actually received. Nothing is written when the variable is unset, so normal
 * runs never touch the disk here.
 */
import fs from 'node:fs';
import path from 'node:path';

const dir = () => String(process.env.DS_BRIDGE_DUMP_DIR || '').trim();

export function dumpEnabled() {
  return dir() !== '';
}

let counter = 0;

/** Append `text` to `<dir>/<requestId>-<name>`. Never throws. */
export function dumpAppend(requestId, name, text) {
  const base = dir();
  if (!base || !text) return;
  try {
    fs.mkdirSync(base, { recursive: true });
    const safeId = String(requestId || 'request').replace(/[^\w.-]+/g, '_');
    const safeName = String(name || `dump-${process.pid}-${counter++}`).replace(/[^\w.-]+/g, '_');
    fs.appendFileSync(path.join(base, `${safeId}-${safeName}`), text);
  } catch {
    /* diagnostics must never break a reply */
  }
}
