/*
 * DeepSeekHashV1 proof-of-work (the Node-side copy).
 *
 * Keep this file in sync with extension/pow.js. The extension cannot import
 * outside its own directory, so the browser and the terminal client each carry
 * a copy of the solver.
 *
 * The site hashes `salt + "_" + expire_at + "_" + nonce` with a Keccak-f[1600]
 * sponge (rate 136, SHA3 padding, 32-byte output) and looks for a digest equal
 * to the server-supplied `challenge` (a full 64-hex preimage).
 *
 * Two details differ from stock SHA3-256, and both matter:
 *   1. the permutation runs rounds 1..23 against round constants 1..23,
 *      skipping round constant 0;
 *   2. the rho step selects its destination word with `offset < 32 ? 0 : 1`,
 *      which swaps the two 32-bit halves of the lane for offsets >= 32.
 * hashlib/crypto libraries therefore do NOT reproduce these digests. This is a
 * literal port of the site's worker, verified against a live challenge.
 */

const RC64 = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];

const RC_LO = new Uint32Array(24);
const RC_HI = new Uint32Array(24);
for (let i = 0; i < 24; i++) {
  RC_LO[i] = Number(RC64[i] & 0xffffffffn);
  RC_HI[i] = Number((RC64[i] >> 32n) & 0xffffffffn);
}

const PILN = [10, 7, 11, 17, 18, 3, 5, 16, 8, 21, 24, 4, 15, 23, 19, 13, 12, 2, 20, 14, 22, 9, 6, 1];
const ROTC = [1, 3, 6, 10, 15, 21, 28, 36, 45, 55, 2, 14, 27, 41, 56, 8, 25, 43, 62, 18, 39, 61, 20, 44];

const RATE = 136;
const OUT = 32;

const C = new Uint32Array(10);
const T = new Uint32Array(10);
const W = new Uint32Array(2);
const state = new Uint32Array(50);
const scratch = new Uint8Array(RATE);
const enc = new TextEncoder();

function permute() {
  const s = state;
  for (let round = 1; round < 24; round++) {
    for (let x = 0; x < 5; x++) {
      const i = 2 * x;
      C[i] = s[i] ^ s[i + 10] ^ s[i + 20] ^ s[i + 30] ^ s[i + 40];
      C[i + 1] = s[i + 1] ^ s[i + 11] ^ s[i + 21] ^ s[i + 31] ^ s[i + 41];
    }
    for (let x = 0; x < 5; x++) {
      const i = 2 * x;
      const p = 2 * ((x + 4) % 5);
      const q = 2 * ((x + 1) % 5);
      const lo = C[p] ^ ((C[q] << 1) | (C[q + 1] >>> 31));
      const hi = C[p + 1] ^ ((C[q + 1] << 1) | (C[q] >>> 31));
      for (let y = 0; y < 5; y++) {
        s[i + 10 * y] ^= lo;
        s[i + 1 + 10 * y] ^= hi;
      }
    }

    W[0] = s[2];
    W[1] = s[3];
    for (let i = 0; i < 24; i++) {
      const j = 2 * PILN[i];
      const r = ROTC[i];
      const lo = s[j];
      const hi = s[j + 1];
      const w0 = W[0];
      const w1 = W[1];
      const u = 32 - r;
      const k = r < 32 ? 0 : 1;
      W[k] = (w0 << r) | (w1 >>> u);
      W[(k + 1) % 2] = (w1 << r) | (w0 >>> u);
      s[j] = W[0];
      s[j + 1] = W[1];
      W[0] = lo;
      W[1] = hi;
    }

    for (let y = 0; y < 25; y += 5) {
      for (let x = 0; x < 5; x++) {
        T[2 * x] = s[2 * (y + x)];
        T[2 * x + 1] = s[2 * (y + x) + 1];
      }
      for (let x = 0; x < 5; x++) {
        const b = 2 * ((x + 1) % 5);
        const c = 2 * ((x + 2) % 5);
        s[2 * (y + x)] ^= ~T[b] & T[c];
        s[2 * (y + x) + 1] ^= ~T[b + 1] & T[c + 1];
      }
    }

    s[0] ^= RC_LO[round];
    s[1] ^= RC_HI[round];
  }
}

function absorbBlock(bytes, len) {
  const s = state;
  for (let i = 0; i < RATE; i += 8) {
    const n = i >> 2;
    const g = (k) => (i + k < len ? bytes[i + k] : 0);
    s[n] ^= g(0) | (g(1) << 8) | (g(2) << 16) | (g(3) << 24);
    s[n + 1] ^= g(4) | (g(5) << 8) | (g(6) << 16) | (g(7) << 24);
  }
  permute();
}

const HEX = [];
for (let i = 0; i < 256; i++) HEX.push((i < 16 ? '0' : '') + i.toString(16));

export function digestHex(str) {
  const bytes = enc.encode(str);
  state.fill(0);
  let off = 0;
  for (let i = 0; i < bytes.length; i++) {
    scratch[off++] = bytes[i];
    if (off === RATE) {
      absorbBlock(scratch, RATE);
      off = 0;
    }
  }
  scratch.fill(0, off);
  scratch[off] ^= 0x06;
  scratch[RATE - 1] ^= 0x80;
  absorbBlock(scratch, RATE);

  let out = '';
  for (let i = 0; i < OUT; i++) {
    out += HEX[(state[i >> 2] >>> (8 * (i & 3))) & 0xff];
  }
  return out;
}

/** Solve one challenge. Returns the answer payload the header expects. */
export function solveChallenge(challenge) {
  const { salt, expire_at: expireAt, challenge: target, difficulty, algorithm, signature, target_path } = challenge;
  const prefix = `${salt}_${expireAt}_`;
  const limit = Number.isInteger(difficulty) && difficulty > 0 ? difficulty : 1_000_000;
  for (let nonce = 0; nonce < limit; nonce++) {
    if (digestHex(prefix + nonce) === target) {
      return {
        algorithm: algorithm || 'DeepSeekHashV1',
        challenge: target,
        salt,
        answer: nonce,
        signature,
        target_path,
      };
    }
  }
  throw new Error(`no PoW solution found within difficulty ${limit}`);
}
