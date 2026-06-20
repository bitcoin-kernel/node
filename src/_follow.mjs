// Follow the chain with reorg handling. Bootstrap the UTXO set from the snapshot,
// catch up to the live testnet4 tip, then stay live — and when the chain reorgs,
// disconnect the orphaned blocks and reconnect the canonical chain *in place*.
//
// To disconnect a block you must restore the coins it spent — which aren't in the
// block, only referenced. So as we connect each block we keep its **undo data**
// (the spent coins' full records + the keys it created). On a reorg we walk down
// to the fork point, disconnect newest-first using that undo data, then connect
// the canonical chain forward. Reorg-aware down to the snapshot height.

import { performance } from 'node:perf_hooks';
import { readFile } from 'node:fs/promises';
import { Codec } from '@bitcoin-desktop/schema/codec/codec.js';
import { BlockEngine } from '@bitcoin-desktop/schema/codec/blocks.js';
import { setVerifyBackend } from '@bitcoin-desktop/schema/codec/secp256k1.js';
import { setSha256Backend, reverseHex, hexToBytes } from '@bitcoin-desktop/schema/codec/hash.js';
import { wasmBackend } from './wasm-secp.js';
import { nativeSha256 } from './sha256-native.js';
import { FileBlockStore } from './store/block-store.js';
import { ShardedUtxo } from './sharded-utxo.js';

const load = async (p) => JSON.parse(await readFile(new URL(import.meta.resolve('@bitcoin-desktop/schema/' + p)), 'utf8'));
const codec = new Codec(await load('schema/core.jsonld'), await load('schema/proof.jsonld'));
const be = BlockEngine.fromSchemas(codec, await load('schema/chain.jsonld'), await load('schema/validate.jsonld'), await load('schema/script.jsonld'), 'btc:testnet4');
setVerifyBackend(wasmBackend);
setSha256Backend(nativeSha256);

const API = 'https://mempool.space/testnet4/api';
const UNDO_DEPTH = 1000;            // reorgs deeper than this fall back to re-bootstrap
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(url, kind = 'text') {
  for (let a = 0; a < 6; a++) {
    const r = await fetch(url);
    if (r.status === 429) { await sleep(2000 * (a + 1)); continue; }
    if (!r.ok) throw new Error(`${r.status} ${url}`);
    return kind === 'buf' ? Buffer.from(await r.arrayBuffer()) : (await r.text());
  }
  throw new Error('rate-limited: ' + url);
}

// bootstrap
const bs = new FileBlockStore(new URL('../data/', import.meta.url), codec);
const bootstrapHeight = (() => { let t = 0; while (bs.has(t + 1)) t++; return t; })();
const bootstrapHash = codec.blockHash(bs.get(bootstrapHeight).header);
let tip = bootstrapHeight, tipHash = bootstrapHash;
console.log(`bootstrapping from snapshot at height ${tip}…`);
const snap = new ShardedUtxo(64);
await snap.load(new URL(`../data/chainstate/utxo-${tip}.ndjson`, import.meta.url));
const parse = (v) => { const a = v.indexOf('\t'), b = v.indexOf('\t', a + 1), c = v.lastIndexOf('\t'); return { output: { value: Number(v.slice(0, a)), scriptPubKey: v.slice(a + 1, b) }, height: Number(v.slice(b + 1, c)), coinbase: v.slice(c + 1) === '1' }; };
const view = { get: (k) => { const v = snap.get(k); return v === undefined ? undefined : parse(v); }, has: (k) => snap.has(k), get size() { return snap.size; } };
console.log(`coin view ready — ${view.size} coins at height ${tip} (${tipHash.slice(0, 16)}…)`);

// undo log: height -> { hash, created:[key], spent:[[key, compactRecord]] }
const undo = new Map();
const NULL_TXID = '00'.repeat(32);

function connect(block, height) {
  const created = [], spent = [];
  block.transactions.forEach((tx, i) => {
    if (i > 0) for (const inp of tx.inputs) {
      const key = `${inp.prevout.txid}:${inp.prevout.vout}`;
      const rec = snap.get(key);
      if (rec !== undefined) { spent.push([key, rec]); snap.delete(key); }
    }
    const txid = codec.txid(tx);
    tx.outputs.forEach((o, vout) => {
      if (!o.scriptPubKey.startsWith('6a')) {
        const key = `${txid}:${vout}`;
        snap.set(key, `${o.value}\t${o.scriptPubKey}\t${height}\t${i === 0 ? 1 : 0}`);
        created.push(key);
      }
    });
  });
  undo.set(height, { hash: codec.blockHash(block.header), created, spent });
  undo.delete(height - UNDO_DEPTH);                 // prune
  return { created: created.length, spent: spent.length };
}

function disconnect(height) {
  const u = undo.get(height);
  // restore spent FIRST, then remove created — so a coin created *and* spent
  // within this same block (key in both lists) nets to correctly absent.
  for (const [key, rec] of u.spent) snap.set(key, rec); // restore what it spent
  for (const key of u.created) snap.delete(key);        // remove what it created
  undo.delete(height);
}

async function findFork() {                          // highest height where we agree with canonical
  for (let h = tip; h >= bootstrapHeight; h--) {
    const mine = h === bootstrapHeight ? bootstrapHash : undo.get(h)?.hash;
    if (mine === undefined) return null;             // undo pruned past the fork — too deep
    const canon = (await get(`${API}/block-height/${h}`)).trim();
    if (canon === mine) return { height: h, hash: canon };
  }
  return null;
}

const tipRev = (h) => reverseHex(hexToBytes(h));
let target = Number(await get(`${API}/blocks/tip/height`));
console.log(`live tip ${target} — catching up ${target - tip} blocks\n`);
const t0 = performance.now(); let done = 0;

while (true) {
  const h = tip + 1;
  if (h > target) {
    if (done > 0) { console.log(`\n✅ at live tip ${tip}. following — polling every 30s…`); done = 0; }
    await sleep(30000);
    const nt = Number(await get(`${API}/blocks/tip/height`));
    if (nt > target) { target = nt; console.log(`live tip advanced to ${target}`); }
    continue;
  }
  let block, hash;
  try {
    hash = (await get(`${API}/block-height/${h}`)).trim();
    block = codec.decode('Block', (await get(`${API}/block/${hash}/raw`, 'buf')).toString('hex'));
  } catch (e) { console.log(`h ${h}: fetch error (${e.message}) — retry in 5s`); await sleep(5000); continue; }

  const prev = block.header.prevBlockHash;
  if (prev !== tipHash && prev !== tipRev(tipHash)) {
    const fork = await findFork();
    if (!fork) { console.log(`\n⛔ reorg deeper than ${UNDO_DEPTH} blocks of undo — re-bootstrap needed. stopping.`); break; }
    let depth = 0;
    while (tip > fork.height) { disconnect(tip); tip--; depth++; }
    tipHash = fork.hash;
    console.log(`\n⟲ reorg: forked at ${fork.height} (disconnected ${depth} orphaned block${depth === 1 ? '' : 's'}), reconnecting canonical chain…`);
    continue;                                        // refetch fork+1 and connect forward
  }

  const failed = [...be.validateBlockStructure(block).results, ...be.validateBlockContext(block, { height: h, utxo: view }).results].filter((r) => r.ok === false);
  if (failed.length) { console.log(`\n❌ block ${h} INVALID: ${failed.map((f) => f.rule).join(', ')} — stopping`); break; }
  const { created, spent } = connect(block, h);
  tip = h; tipHash = hash; done++;
  const rate = done / ((performance.now() - t0) / 1000);
  console.log(`h ${h}  ${hash.slice(0, 12)}…  txs ${String(block.transactions.length).padStart(4)}  +${created} -${spent}  utxo ${view.size}  ${rate.toFixed(1)} blk/s`);
  await sleep(400);
}
