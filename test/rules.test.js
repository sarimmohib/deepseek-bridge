import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Point the store at a throwaway file before importing the module: rulesFile()
// is read lazily per call, so this env var is enough even on a cached import.
const storeFile = path.join(os.tmpdir(), `dsb-rules-test-${process.pid}.json`);
process.env.DS_BRIDGE_RULES_FILE = storeFile;

const rules = await import('../src/rules.js');

function freshStore() {
  fs.rmSync(storeFile, { force: true });
}

test.after(() => {
  fs.rmSync(storeFile, { force: true });
});

test('first read seeds the builtin rules and writes the store', () => {
  freshStore();
  const list = rules.listRules();
  assert.equal(list.length, rules.BUILTIN_RULES.length);
  assert.ok(list.every((rule) => rule.source === 'builtin'));
  assert.ok(list.every((rule) => /^[a-f0-9]{10}$/.test(rule.id)));
  assert.ok(fs.existsSync(storeFile), 'store file was created');
  const summary = rules.rulesSummary();
  assert.equal(summary.builtin, rules.BUILTIN_RULES.length);
  assert.equal(summary.user, 0);
  assert.equal(summary.learned, 0);
});

test('a deleted builtin is not re-seeded on the next read', () => {
  freshStore();
  const first = rules.listRules()[0];
  assert.equal(rules.removeRule(first.id).removed, true);
  const after = rules.listRules();
  assert.ok(!after.some((rule) => rule.id === first.id), 'deleted rule stays deleted');
  assert.equal(after.length, rules.BUILTIN_RULES.length - 1);
});

test('addRule stores a user rule and dedupes identical text', () => {
  freshStore();
  const added = rules.addRule({ text: 'Always run the test suite before claiming success.' });
  assert.equal(added.duplicate, false);
  assert.equal(added.rule.source, 'user');
  assert.equal(added.rule.category, 'general');
  const again = rules.addRule({ text: '  Always run the test suite before claiming success.  ' });
  assert.equal(again.duplicate, true);
  assert.equal(again.rule.id, added.rule.id);
  const userRules = rules.listRules().filter((rule) => rule.source === 'user');
  assert.equal(userRules.length, 1, 'whitespace-only differences dedupe');
});

test('addRule rejects too-short and oversized text', () => {
  freshStore();
  assert.throws(() => rules.addRule({ text: 'ab' }), /at least 3 characters/);
  assert.throws(() => rules.addRule({ text: 'x'.repeat(400) }), /capped at 320 characters/);
});

test('learnRule records a known failure once and increments the count', () => {
  freshStore();
  const first = rules.learnRule('tool-markup');
  assert.ok(first);
  assert.equal(first.source, 'learned');
  assert.equal(first.count, 1);
  const second = rules.learnRule('tool-markup');
  assert.equal(second.id, first.id);
  assert.equal(second.count, 2);
  const learned = rules.listRules().filter((rule) => rule.source === 'learned');
  assert.equal(learned.length, 1);
  assert.equal(learned[0].count, 2);
});

test('learnRule ignores unknown kinds and never throws', () => {
  freshStore();
  assert.equal(rules.learnRule('not-a-known-failure'), null);
  assert.equal(rules.rulesSummary().learned, 0);
});

test('clearLearned drops learned rules but keeps builtin and user rules', () => {
  freshStore();
  rules.addRule({ text: 'A user rule that must survive clearing learned rules.' });
  rules.learnRule('degenerate-dsml');
  rules.learnRule('empty-reply');
  const cleared = rules.clearLearned();
  assert.equal(cleared.removed, 2);
  const summary = rules.rulesSummary();
  assert.equal(summary.learned, 0);
  assert.equal(summary.user, 1);
  assert.equal(summary.builtin, rules.BUILTIN_RULES.length);
});

test('renderRulesSection is model-facing, bounded, and empty-safe', () => {
  freshStore();
  const section = rules.renderRulesSection();
  assert.match(section, /^# Rules/);
  assert.match(section, /- \[tool-format\] A tool call is exactly one fenced block/);
  assert.ok(section.length <= 2400);

  // A tiny budget keeps the header and drops rule lines instead of truncating.
  const tiny = rules.renderRulesSection({ maxChars: 120 });
  assert.ok(tiny.length <= 120);
  assert.ok(!tiny.includes('Verify a change'), 'later rules are dropped, not cut');

  freshStore();
  for (const rule of rules.listRules()) rules.removeRule(rule.id);
  assert.equal(rules.renderRulesSection(), '', 'no rules renders nothing');
});

test('a corrupt store file is replaced with the builtin seed', () => {
  fs.writeFileSync(storeFile, '{not json');
  const list = rules.listRules();
  assert.equal(list.length, rules.BUILTIN_RULES.length);
  const parsed = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
  assert.equal(parsed.version, 1);
  assert.equal(parsed.rules.length, rules.BUILTIN_RULES.length);
});

test('the store file is written with restrictive permissions on POSIX', () => {
  freshStore();
  rules.listRules();
  if (process.platform === 'win32') return;
  const mode = fs.statSync(storeFile).mode & 0o777;
  assert.equal(mode, 0o600);
});
