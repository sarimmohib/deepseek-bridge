/*
 * Version and self-update support.
 *
 * The installed command is usually a git checkout (or a symlink to one), so the
 * updater can fast-forward the checkout from GitHub. Version comparisons use
 * package.json's semver rather than the git commit: a release bump is the
 * signal that users should update.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const REPO = 'sarimmohib/deepseek-bridge';
export const REPO_URL = `https://github.com/${REPO}`;
export const RAW_PACKAGE_URL = `https://raw.githubusercontent.com/${REPO}/main/package.json`;
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const PACKAGE_FILE = path.join(ROOT, 'package.json');

export function readLocalVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(PACKAGE_FILE, 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export const VERSION = readLocalVersion();

function parseVersion(value) {
  const text = String(value || '').trim().replace(/^v/i, '');
  const match = text.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] || '',
  };
}

function comparePrerelease(a, b) {
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  const aa = a.split('.');
  const bb = b.split('.');
  for (let i = 0; i < Math.max(aa.length, bb.length); i++) {
    if (aa[i] === undefined) return -1;
    if (bb[i] === undefined) return 1;
    const an = /^\d+$/.test(aa[i]) ? Number(aa[i]) : null;
    const bn = /^\d+$/.test(bb[i]) ? Number(bb[i]) : null;
    if (an !== null && bn !== null) {
      if (an !== bn) return an < bn ? -1 : 1;
    } else if (an !== null) {
      return -1;
    } else if (bn !== null) {
      return 1;
    } else if (aa[i] !== bb[i]) {
      return aa[i] < bb[i] ? -1 : 1;
    }
  }
  return 0;
}

/** Compare two semver strings. Returns -1, 0, or 1. */
export function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) throw new Error(`Invalid version comparison: ${a} vs ${b}`);
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
  }
  return comparePrerelease(left.prerelease, right.prerelease);
}

export function isNewer(candidate, current) {
  return compareVersions(candidate, current) > 0;
}

/**
 * Read the version published on GitHub main. Raw content is used instead of the
 * API so the check works without a token and does not consume API rate limits.
 */
export async function fetchLatestVersion({ timeout = 5000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  timer.unref?.();
  try {
    const res = await fetch(RAW_PACKAGE_URL, {
      headers: {
        accept: 'application/json',
        'user-agent': `deepseek-bridge/${VERSION}`,
      },
      cache: 'no-store',
      redirect: 'follow',
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`GitHub returned HTTP ${res.status}`);
    const pkg = await res.json();
    if (typeof pkg.version !== 'string' || !pkg.version) {
      throw new Error('GitHub package.json has no version');
    }
    return { version: pkg.version, url: RAW_PACKAGE_URL };
  } catch (err) {
    if (err?.name === 'AbortError') throw new Error('GitHub version check timed out');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function runGit(args) {
  const result = spawnSync('git', ['-C', ROOT, ...args], {
    encoding: 'utf8',
    timeout: 30000,
    windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: result.error || null,
  };
}

export function gitState() {
  if (!fs.existsSync(path.join(ROOT, '.git'))) {
    return { isGit: false, root: ROOT };
  }
  const head = runGit(['rev-parse', '--short', 'HEAD']);
  const branch = runGit(['rev-parse', '--abbrev-ref', 'HEAD']);
  const dirty = runGit(['status', '--porcelain']);
  const remote = runGit(['remote', 'get-url', 'origin']);
  if (head.error || head.status !== 0) {
    return { isGit: true, root: ROOT, error: head.stderr || head.error?.message || 'git error' };
  }
  return {
    isGit: true,
    root: ROOT,
    head: head.stdout.trim(),
    branch: branch.stdout.trim() || 'HEAD',
    dirty: Boolean(dirty.stdout.trim()),
    remote: remote.stdout.trim() || null,
  };
}

/**
 * Fast-forward the current checkout to origin/main. Refuses dirty trees and
 * non-main branches so a user's work is never overwritten.
 */
export function updateFromGit() {
  const state = gitState();
  if (!state.isGit) return { status: 'not-git', state };
  if (state.error) return { status: 'git-error', state, message: state.error };
  if (state.dirty) return { status: 'dirty', state };
  if (state.branch !== 'main') return { status: 'not-main', state };

  const fetched = runGit(['fetch', '--quiet', 'origin', 'main']);
  if (fetched.status !== 0) {
    return { status: 'fetch-failed', state, message: fetched.stderr.trim() || 'git fetch failed' };
  }

  const before = runGit(['rev-parse', 'HEAD']).stdout.trim();
  const remote = runGit(['rev-parse', 'origin/main']).stdout.trim();
  if (!before || !remote) return { status: 'git-error', state, message: 'could not resolve git revisions' };
  if (before === remote) return { status: 'up-to-date', state, before, after: before };

  const merged = runGit(['merge', '--ff-only', 'origin/main']);
  if (merged.status !== 0) {
    return { status: 'merge-failed', state, message: merged.stderr.trim() || 'git merge --ff-only failed' };
  }
  const after = runGit(['rev-parse', 'HEAD']).stdout.trim();
  return {
    status: before === after ? 'up-to-date' : 'updated',
    state: { ...state, head: after.slice(0, 7) },
    before,
    after,
    version: readLocalVersion(),
  };
}
