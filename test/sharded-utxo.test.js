// ShardedUtxo must be indistinguishable from a Map for the operations the engine
// uses (get/set/has/delete/size + full iteration). Differential test against a
// reference Map over a randomized op sequence with realistic outpoint keys.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { ShardedUtxo } from '../src/sharded-utxo.js';

// realistic outpoint keys: a real sha256 hex (like a txid) + ":vout"
const hexKey = (seed) => `${createHash('sha256').update('' + seed).digest('hex')}:${seed % 8}`;

test('ShardedUtxo matches Map over a randomized op sequence', () => {
  const ref = new Map();
  const u = new ShardedUtxo(16);
  for (let i = 0; i < 200000; i++) {
    const k = hexKey((i * 2654435761) % 50000); // reuse keys so deletes/overwrites hit
    const op = (i * 48271) % 5;
    if (op < 2) { const v = { h: i }; ref.set(k, v); u.set(k, v); }
    else if (op === 2) { assert.equal(u.has(k), ref.has(k)); assert.equal(u.get(k), ref.get(k)); }
    else if (op === 3) { assert.equal(u.delete(k), ref.delete(k)); }
    else { assert.equal(u.size, ref.size, `size mismatch at i=${i}`); }
  }
  assert.equal(u.size, ref.size);
  // full iteration yields exactly the same entries
  const a = [...u.entries()].sort((x, y) => (x[0] < y[0] ? -1 : 1));
  const b = [...ref.entries()].sort((x, y) => (x[0] < y[0] ? -1 : 1));
  assert.equal(a.length, b.length);
  for (let i = 0; i < a.length; i++) { assert.equal(a[i][0], b[i][0]); assert.equal(a[i][1], b[i][1]); }
});

test('shards distribute roughly evenly (no degenerate hashing)', () => {
  const u = new ShardedUtxo(32);
  for (let i = 0; i < 64000; i++) u.set(hexKey(i), 1);
  const sizes = u.maps.map((m) => m.size);
  const min = Math.min(...sizes), max = Math.max(...sizes);
  assert.ok(min > 0, 'every shard used');
  assert.ok(max / min < 2, `distribution skew too high: ${min}..${max}`);
});
