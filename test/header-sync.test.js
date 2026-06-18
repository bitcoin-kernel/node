// Headless unit tests for the sync algorithm: extension, resume, reorg by the
// most-work rule, and prefix overlap. These use fake headers (plain objects
// with an id, a parent, and a work value) and a fake engine, so the algorithm
// is tested independently of real proof-of-work. Real validation is covered by
// testnet4.test.js (golden vectors) and the live sync integration.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryHeaderStore } from '../src/store/header-store.js';
import { HeaderSync } from '../src/chain/header-sync.js';

// --- fakes: a header is { id, prevBlockHash, work } ---
const codec = { blockHash: (h) => h.id, encodeHex: (_t, h) => h.id, decode: () => ({}) };
const engine = {
  work: (h) => BigInt(h.work ?? 1),
  validateChain: (headers, { startHeight }) => headers.map((h, i) => ({ height: startHeight + i, hash: h.id, results: [] })),
};
const GENESIS = { id: 'g', prevBlockHash: null, work: 1 };
const chain = (prefix, from, n, work = 1) => {
  const out = [];
  let prev = from;
  for (let i = 1; i <= n; i++) { const id = `${prefix}${i}`; out.push({ id, prevBlockHash: prev, work }); prev = id; }
  return out;
};
const newStore = () => new MemoryHeaderStore(codec, engine, GENESIS);
// a fetchHeaders that serves a fixed chain, honouring the block locator
const server = (full) => async (locator) => {
  const byId = new Map(full.map((h, i) => [h.id, i]));
  for (const hash of locator) {
    if (hash === 'g') return full.slice(0); // genesis: serve from start
    if (byId.has(hash)) return full.slice(byId.get(hash) + 1);
  }
  return full.slice(0);
};

test('fresh sync appends a chain from genesis', async () => {
  const store = newStore();
  const sync = new HeaderSync(store, engine, codec);
  const res = await sync.sync(server(chain('a', 'g', 10)));
  assert.equal(store.height, 10);
  assert.equal(store.tipHash(), 'a10');
  assert.equal(res.added, 10);
});

test('resume continues from the stored tip without re-adding', async () => {
  const store = newStore();
  const sync = new HeaderSync(store, engine, codec);
  const full = chain('a', 'g', 10);
  await sync.sync(server(full.slice(0, 5)));      // first peer has 1..5
  assert.equal(store.height, 5);
  const res = await sync.sync(server(full));      // second peer has 1..10
  assert.equal(store.height, 10);
  assert.equal(res.added, 5);                      // only 6..10 added
});

test('prefix overlap (peer re-serves blocks we have) extends correctly', async () => {
  const store = newStore();
  const sync = new HeaderSync(store, engine, codec);
  const full = chain('a', 'g', 8);
  await sync.sync(server(full.slice(0, 5)));
  // a server that, given our tip locator, still returns from height 3 (overlap 3..5, new 6..8)
  const overlapping = async () => full.slice(2); // a3..a8
  const res = await sync.sync(overlapping);
  assert.equal(store.height, 8);
  assert.equal(store.tipHash(), 'a8');
  assert.equal(res.added, 3);
});

test('heavier fork triggers a reorg (most-work rule)', async () => {
  const store = newStore();
  const sync = new HeaderSync(store, engine, codec);
  await sync.sync(server(chain('a', 'g', 5, 1)));   // chain A: 5 blocks, work 1 each => total 6 (incl genesis)
  assert.equal(store.tipHash(), 'a5');
  // fork B from height 2 (parent a2): 4 blocks of work 3 each => much heavier
  const forkB = [{ id: 'b3', prevBlockHash: 'a2', work: 3 }, ...chain('b', 'b3', 3, 3).map((h, i) => i === 0 ? h : h)];
  const branchB = [{ id: 'b3', prevBlockHash: 'a2', work: 3 }, { id: 'b4', prevBlockHash: 'b3', work: 3 }, { id: 'b5', prevBlockHash: 'b4', work: 3 }];
  const res = await sync.sync(async () => branchB);
  assert.ok(res.reorgs.length === 1, 'a reorg happened');
  assert.equal(store.headerAt(2).id, 'a2', 'kept the common ancestor');
  assert.equal(store.headerAt(3).id, 'b3', 'switched to the heavier branch');
  assert.equal(store.tipHash(), 'b5');
});

test('lighter fork is rejected (we keep the most-work chain)', async () => {
  const store = newStore();
  const sync = new HeaderSync(store, engine, codec);
  await sync.sync(server(chain('a', 'g', 5, 2)));   // chain A heavy: work 2 each
  const branchB = [{ id: 'b3', prevBlockHash: 'a2', work: 1 }, { id: 'b4', prevBlockHash: 'b3', work: 1 }]; // shorter + lighter
  const res = await sync.sync(async () => branchB);
  assert.equal(res.reorgs.length, 0, 'no reorg');
  assert.equal(store.tipHash(), 'a5', 'kept original chain');
});
