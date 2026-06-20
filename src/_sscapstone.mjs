// SwiftSync capstone — full testnet4.
//
// Streams every block (genesis..tip) once and maintains, in parallel:
//   • acc   — the SwiftSync cancelling accumulator (add created, spend spent).
//             Its residual = UTXO set at tip, with NO set stored.
//   • utxo  — the real UTXO set, built the slow way (Set, add/delete). The oracle.
//
// Then it adds the survivor set into a fresh accumulator and asserts that digest
// equals the streaming accumulator's residual. Match ⇒ the stateless SwiftSync
// construction reproduces the real UTXO set across all of testnet4. The survivor
// COUNT is independently cross-checked against the fully-validated validate-sync run.
//
// assumevalid shape (outpoint-only elements, OP_RETURN/coinbase handled like the
// UTXO set), salt=null (deterministic reference construction), matching validate.js.

import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { readFile } from 'node:fs/promises';
import { Codec } from '@bitcoin-desktop/schema/codec/codec.js';
import { FileBlockStore } from './store/block-store.js';
import { Accumulator } from '../../kernel/packages/swiftsync/accumulator.js';
import { encodeOutpoint } from '../../kernel/packages/swiftsync/index.js';

const load = async (p) => JSON.parse(await readFile(new URL(import.meta.resolve('@bitcoin-desktop/schema/' + p)), 'utf8'));
const codec = new Codec(await load('schema/core.jsonld'), await load('schema/proof.jsonld'));
const bs = new FileBlockStore(new URL('../data/', import.meta.url), codec);
const sha256 = (b) => new Uint8Array(createHash('sha256').update(b).digest());
const hex = (b) => Buffer.from(b).toString('hex');

const NULL_TXID = '00'.repeat(32);
const isOpReturn = (spk) => typeof spk === 'string' && spk.startsWith('6a');
const NODE_REPORTED_UTXO = 14128340; // validate-sync log @ h140,500 (fully validated)

let tip = 0; while (bs.has(tip + 1)) tip++;
console.log(`block store tip: ${tip}`);

const acc = new Accumulator({ sha256 });
// Oracle UTXO set, sharded by the first txid byte. A single V8 Set caps at ~16.7M
// entries (incl. delete tombstones before rehash); testnet4's spam region churns
// well past that, so we spread across 256 shards (~tens of k live each).
const SHARDS = 256;
const utxo = Array.from({ length: SHARDS }, () => new Set());
const shardOf = (txid) => parseInt(txid.slice(0, 2), 16);
const utxoSize = () => utxo.reduce((s, m) => s + m.size, 0);
let outs = 0, ins = 0, opret = 0;
const t0 = performance.now(); let lastT = t0, lastH = 0;

for (let h = 1; h <= tip; h++) {
  const block = bs.get(h);
  if (!block) { console.error(`missing block ${h} — stopping`); break; }
  for (const tx of block.transactions) {
    const txid = codec.txid(tx);
    for (let v = 0; v < tx.outputs.length; v++) {
      if (isOpReturn(tx.outputs[v].scriptPubKey)) { opret++; continue; }
      acc.add(encodeOutpoint({ txid, vout: v }));
      utxo[shardOf(txid)].add(`${txid}:${v}`);
      outs++;
    }
    for (const inp of tx.inputs) {
      if (inp.prevout.txid === NULL_TXID) continue;
      acc.spend(encodeOutpoint({ txid: inp.prevout.txid, vout: inp.prevout.vout }));
      utxo[shardOf(inp.prevout.txid)].delete(`${inp.prevout.txid}:${inp.prevout.vout}`);
      ins++;
    }
  }
  if (h % 5000 === 0) {
    const now = performance.now();
    const rss = (process.memoryUsage().rss / 1e9).toFixed(1);
    console.log(`h ${h}/${tip}  utxo ${utxoSize()}  ${((h - lastH) / ((now - lastT) / 1000)).toFixed(0)} blk/s  rss ${rss}GB`);
    lastT = now; lastH = h;
  }
}
const tWalk = (performance.now() - t0) / 1000;

// oracle: survivors → fresh accumulator
const tO = performance.now();
const oracle = new Accumulator({ sha256 });
let utxoCount = 0;
for (const shard of utxo) {
  utxoCount += shard.size;
  for (const key of shard) {
    const i = key.lastIndexOf(':');
    oracle.add(encodeOutpoint({ txid: key.slice(0, i), vout: +key.slice(i + 1) }));
  }
}
const tOracle = (performance.now() - tO) / 1000;

const accDigest = hex(acc.digest());
const oracleDigest = hex(oracle.digest());
const match = accDigest === oracleDigest;
const countOk = utxoCount === NODE_REPORTED_UTXO;

console.log('\n──────────── SwiftSync capstone — testnet4 ────────────');
console.log(`blocks                 1..${tip}`);
console.log(`outputs (UTXO-eligible) ${outs}    inputs ${ins}    OP_RETURN skipped ${opret}`);
console.log(`final UTXO count        ${utxoCount}    node validate-sync: ${NODE_REPORTED_UTXO} (@h140,500)  ${countOk ? '✓ exact' : `Δ ${utxoCount - NODE_REPORTED_UTXO}`}`);
console.log(`walk                    ${tWalk.toFixed(1)}s   ${(tip / tWalk).toFixed(0)} blk/s   ${(outs / tWalk / 1e6).toFixed(2)} M out/s`);
console.log(`oracle rebuild          ${tOracle.toFixed(1)}s`);
console.log('');
console.log(`SwiftSync residual digest  ${accDigest}`);
console.log(`oracle (real set) digest   ${oracleDigest}`);
console.log(match
  ? '\n✅ CAPSTONE PASS — the stateless SwiftSync accumulator reproduces the real UTXO set across all of testnet4.'
  : '\n❌ DIGEST MISMATCH — investigate.');
process.exit(match ? 0 : 1);
