import test from 'node:test';
import assert from 'node:assert/strict';
import { digestHex, solveChallenge } from '../extension/pow.js';

// Real challenge/answer pair captured from chat.deepseek.com.
const CHALLENGE = {
  algorithm: 'DeepSeekHashV1',
  challenge: 'a182ce904af882c214ca4188f36816785b11d5f56209f9fd7eec515986de9212',
  salt: '1bcffbdbb0ffa2365d3b',
  difficulty: 144000,
  signature: '67880bbabbb3c8c972329ec588889fcfa0f615c403f7781de741006abb9a92fd',
  expire_at: 1792685705706,
  target_path: '/api/v0/chat/completion',
};

test('hash of the winning nonce matches the site challenge', () => {
  const digest = digestHex(`${CHALLENGE.salt}_${CHALLENGE.expire_at}_85022`);
  assert.equal(digest, CHALLENGE.challenge);
});

test('hash vector for a fixed input is stable', () => {
  // Guards the two deliberate deviations from stock SHA3-256: round constants
  // 1..23 and the rho lane-half swap. This value was independently confirmed
  // against the site's own worker (it solves a synthetic challenge with answer 0).
  assert.equal(
    digestHex('deadbeefcafe0123456789_1792685705706_0'),
    'be5dcc1d3633314f98e46b0fb9a1fab36c2765f978dd8b2b3887df9b81fcf256',
  );
});

test('solveChallenge finds the captured answer', () => {
  const started = Date.now();
  const answer = solveChallenge(CHALLENGE);
  const ms = Date.now() - started;
  assert.equal(answer.answer, 85022);
  assert.equal(answer.challenge, CHALLENGE.challenge);
  assert.equal(answer.target_path, '/api/v0/chat/completion');
  assert.ok(ms < 10000, `solver took ${ms}ms`);
});

test('answer round-trips through the base64 header format', () => {
  const header = Buffer.from(JSON.stringify(solveChallenge(CHALLENGE)), 'utf8').toString('base64');
  const decoded = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
  assert.deepEqual(Object.keys(decoded).sort(), ['algorithm', 'answer', 'challenge', 'salt', 'signature', 'target_path']);
  assert.equal(decoded.target_path, '/api/v0/chat/completion');
});

test('an impossible difficulty fails instead of hanging', () => {
  assert.throws(() => solveChallenge({ ...CHALLENGE, difficulty: 10 }), /no PoW solution/);
});
