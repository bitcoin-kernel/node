// Build the real UTXO set (the chainstate) from the saved blocks and PERSIST it to
// disk, so it never has to be re-derived from scratch again. Single process, normal
// priority — one core. Uses the node's ShardedUtxo (sharded Maps + NDJSON save/load),
// which is built to survive past V8's ~16.7M Map cap and >512MB strings.
//
//   SS_TIP=H   cap the tip (smoke test)
//
// Entry shape matches what the engine's coin view uses:
//   { outpoint:{txid,vout}, output:{value,scriptPubKey}, height, coinbase }
// so the saved file reloads directly into a usable UTXO set.

import { performance } from 'node:perf_hooks';
import { readFile, mkdir } from 'node:fs/promises';
import { Codec } from '@bitcoin-desktop/schema/codec/codec.js';
import { FileBlockStore } from './store/block-store.js';
import { ShardedUtxo } from './sharded-utxo.js';

const load = async (p) => JSON.parse(await readFile(new URL(import.meta.resolve('@bitcoin-desktop/schema/' + p)), 'utf8'));
const codec = new Codec(await load('schema/core.jsonld'), await load('schema/proof.jsonld'));
const bs = new FileBlockStore(new URL('../data/', import.meta.url), codec);
const NULL_TXID = '00'.repeat(32);
const isOpReturn = (spk) => typeof spk === 'string' && spk.startsWith('6a');

let tip = 0; while (bs.has(tip + 1)) tip++;
if (process.env.SS_TIP) tip = Math.min(tip, +process.env.SS_TIP);
console.log(`building chainstate (UTXO set) from blocks 1..${tip}`);

const utxo = new ShardedUtxo(64);
let outs = 0, ins = 0;
const t0 = performance.now(); let lastT = t0, lastH = 0;
for (let h = 1; h <= tip; h++) {
  const block = bs.get(h);
  if (!block) { console.error(`missing block ${h} — aborting`); process.exit(1); }
  block.transactions.forEach((tx, ti) => {
    const txid = codec.txid(tx);
    for (let v = 0; v < tx.outputs.length; v++) {
      const output = tx.outputs[v];
      if (isOpReturn(output.scriptPubKey)) continue;
      // compact: one tab-joined string per coin (value, scriptPubKey, height, coinbase)
      // — a fraction of the memory of a nested object across 14M entries.
      utxo.set(`${txid}:${v}`, `${output.value}\t${output.scriptPubKey}\t${h}\t${ti === 0 ? 1 : 0}`);
      outs++;
    }
    for (const inp of tx.inputs) {
      if (inp.prevout.txid === NULL_TXID) continue;
      utxo.delete(`${inp.prevout.txid}:${inp.prevout.vout}`);
      ins++;
    }
  });
  if (h % 5000 === 0) {
    const now = performance.now();
    console.log(`h ${h}/${tip}  utxo ${utxo.size}  ${((h - lastH) / ((now - lastT) / 1000)).toFixed(0)} blk/s  rss ${(process.memoryUsage().rss / 1e9).toFixed(1)}GB`);
    lastT = now; lastH = h;
  }
}
const buildSec = (performance.now() - t0) / 1000;
const count = utxo.size;

await mkdir(new URL('../data/chainstate/', import.meta.url), { recursive: true });
const outUrl = new URL(`../data/chainstate/utxo-${tip}.ndjson`, import.meta.url);
console.log(`\nwriting ${count} coins to ${outUrl.pathname} ...`);
const tw = performance.now();
await utxo.save(outUrl, { format: 'bitcoin-kernel-utxo', version: 1, network: 'btc:testnet4', height: tip, count, outputs: outs, inputs: ins });
const writeSec = (performance.now() - tw) / 1000;

console.log(`\n✅ chainstate saved: ${outUrl.pathname}`);
console.log(`   ${count} coins · built ${buildSec.toFixed(0)}s · written ${writeSec.toFixed(0)}s · outputs ${outs} inputs ${ins}`);
