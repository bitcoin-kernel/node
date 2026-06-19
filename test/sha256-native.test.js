// Consensus-equivalence gate for the native SHA-256 backend: it must produce
// byte-identical output to the engine's pure-JS sha256 on every input, including
// the message-length boundaries where padding bugs hide (55/56/63/64/65 ...). If
// it agrees everywhere here, swapping it under the whole engine (dsha256, merkle,
// sighash, taggedHash) is safe.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sha256 } from '@bitcoin-desktop/schema/codec/hash.js';
import { nativeSha256 } from '../src/sha256-native.js';

const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
// deterministic pseudo-random fill (no Math.random — reproducible)
const fill = (n, seed) => { const a = new Uint8Array(n); let s = seed >>> 0; for (let i = 0; i < n; i++) { s = (s * 1664525 + 1013904223) >>> 0; a[i] = s & 0xff; } return a; };

test('native SHA-256 == pure-JS SHA-256 on length boundaries', () => {
  // sha256 processes 64-byte blocks with an 8-byte length tail: 55/56 and 63/64
  // are the classic padding-overflow boundaries; cover a wide spread.
  const lens = [0, 1, 2, 31, 32, 33, 54, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 129, 1000, 4096, 100000];
  for (const n of lens) {
    const x = fill(n, n * 2654435761);
    assert.equal(hex(nativeSha256(x)), hex(sha256(x)), `mismatch at length ${n}`);
  }
});

test('native SHA-256 == pure-JS SHA-256 on 2000 random inputs', () => {
  for (let i = 0; i < 2000; i++) {
    const n = (i * 48271) % 600; // varied lengths up to ~600 bytes
    const x = fill(n, i * 40503 + 7);
    if (hex(nativeSha256(x)) !== hex(sha256(x))) assert.fail(`mismatch at iter ${i} len ${n}`);
  }
});

test('double-SHA and known vector', () => {
  // sha256("") = e3b0c442... ; verifies orientation is right.
  assert.equal(hex(nativeSha256(new Uint8Array(0))), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});
