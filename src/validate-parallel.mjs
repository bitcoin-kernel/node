// Parallel full validation via range-splitting. The expensive part of validation
// (phase-1 interpreter: sighash + script + UTXO, per input) is single-threaded
// per block, so we parallelize across HEIGHT RANGES instead: a fast sequential
// apply-only pass builds UTXO snapshots at range boundaries, then a work-queue of
// worker processes validates the ranges concurrently, each from its snapshot.
//
// Starts from the existing checkpoint (the early chain is already audited by the
// single-process runs). Resumable boundary = checkpoint height. Aggregates every
// range's discrepancy tally into one summary identical to the serial audit's.
//
// Run: node src/validate-parallel.mjs
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import { Codec } from '@bitcoin-desktop/schema/codec/codec.js';
import { HeaderEngine } from '@bitcoin-desktop/schema/codec/headers.js';
import { BlockEngine } from '@bitcoin-desktop/schema/codec/blocks.js';
import { FileHeaderStore } from './store/header-store.js';
import { FileBlockStore } from './store/block-store.js';

const load = async (p) => JSON.parse(await readFile(new URL(import.meta.resolve('@bitcoin-desktop/schema/' + p)), 'utf8'));
const codec = new Codec(await load('schema/core.jsonld'), await load('schema/proof.jsonld'));
const chainSchema = await load('schema/chain.jsonld');
const validateSchema = await load('schema/validate.jsonld');
const scriptSchema = await load('schema/script.jsonld');
const t4 = await load('test/vectors/testnet4.json');
const he = HeaderEngine.fromSchemas(codec, chainSchema, validateSchema, 'btc:testnet4');
const be = BlockEngine.fromSchemas(codec, chainSchema, validateSchema, scriptSchema, 'btc:testnet4');

const DATA = new URL('../data/', import.meta.url);
const SNAP = new URL('snap/', DATA);
const fmt = (n) => Number(n).toLocaleString();
const genesisHeader = codec.decode('BlockHeader', t4.genesisHeader);
const store = new FileHeaderStore(codec, he, genesisHeader, new URL('testnet4-headers.bin', DATA));
await store.load();
const blockStore = new FileBlockStore(DATA, codec);
const TIP = Math.min(store.height, Number(process.env.MAXH || store.height));

// resume from the existing checkpoint (early chain already audited serially)
const ckpt = JSON.parse(await readFile(new URL('validate-ckpt.json', DATA), 'utf8'));
const START = ckpt.height + 1;
const utxo = new Map(); for (const [k, v] of ckpt.utxo) utxo.set(k, v);
console.log(`parallel validation ${fmt(START)}..${fmt(TIP)} (early chain ${fmt(ckpt.height)} already audited serially)`);

// adaptive ranges: fine through the inscription flood, coarse afterwards
const FINE_HI = 65000, FINE = 400, COARSE = 6000;
const ranges = [];
for (let h = START; h <= TIP;) { const step = h < FINE_HI ? FINE : COARSE; const hi = Math.min(TIP, h + step - 1); ranges.push([h, hi]); h = hi + 1; }
const snapHeights = new Set(ranges.map(([lo]) => lo - 1));
await mkdir(SNAP, { recursive: true });

// snapshot at START-1 = the checkpoint itself
await writeFile(new URL(`${START - 1}.json`, SNAP), JSON.stringify({ height: START - 1, utxo: [...utxo.entries()] }));

// sequential apply-only pass, dumping a snapshot at each range boundary
console.log(`apply pass ${fmt(START)}..${fmt(TIP)} (${ranges.length} ranges)...`);
const t0 = Date.now();
for (let h = START; h <= TIP; h++) {
  const b = blockStore.get(h); if (!b) { console.error(`missing block ${h}`); process.exit(1); }
  try { be.applyBlock(utxo, b, h); } catch {}
  if (snapHeights.has(h)) await writeFile(new URL(`${h}.json`, SNAP), JSON.stringify({ height: h, utxo: [...utxo.entries()] }));
  if (h % 5000 === 0 || h === TIP) process.stdout.write(`\r  applied ${fmt(h)}/${fmt(TIP)}  utxo ${fmt(utxo.size)}  ${((Date.now() - t0) / 1000).toFixed(0)}s   `);
}
utxo.clear(); // free the orchestrator's copy before spawning workers
console.log(`\napply pass done in ${((Date.now() - t0) / 60000).toFixed(1)} min`);

// work-queue: N worker processes pull ranges
const N = Math.max(1, Math.min(14, (os.cpus()?.length || 4) - 2));
const SCRIPT = new URL('validate-range.mjs', import.meta.url).pathname;
console.log(`validating ${ranges.length} ranges across ${N} worker processes...`);
let idx = 0, done = 0;
const t1 = Date.now();
const runNext = () => {
  if (idx >= ranges.length) return Promise.resolve();
  const [lo, hi] = ranges[idx++];
  return new Promise((resolve) => {
    const c = spawn(process.execPath, ['--max-old-space-size=6144', SCRIPT, String(lo), String(hi)], { cwd: new URL('..', import.meta.url).pathname, stdio: 'ignore' });
    c.on('exit', () => { done++; process.stdout.write(`\r  ranges ${done}/${ranges.length}  (${((Date.now() - t1) / 60000).toFixed(1)} min)   `); resolve(); });
  }).then(runNext);
};
await Promise.all(Array.from({ length: N }, runNext));
console.log(`\nvalidate pass done in ${((Date.now() - t1) / 60000).toFixed(1)} min`);

// aggregate every range's tally
const agg = new Map();
let validated = 0, txs = 0; const mismatches = [];
for (const [lo] of ranges) {
  const r = JSON.parse(await readFile(new URL(`result-${lo}.json`, SNAP), 'utf8'));
  validated += r.validated; txs += r.txs;
  if (r.merkleMismatch) mismatches.push(r.merkleMismatch);
  for (const [k, count, firstHeight] of r.warns) { const e = agg.get(k); if (!e) agg.set(k, { count, firstHeight }); else { e.count += count; e.firstHeight = Math.min(e.firstHeight, firstHeight); } }
}
console.log(`\n=== parallel full validation: ${fmt(validated)} blocks (${fmt(START)}..${fmt(TIP)}), ${fmt(txs)} transactions, total ${((Date.now() - t0) / 60000).toFixed(1)} min ===`);
if (mismatches.length) console.log('  MERKLE/FETCH ISSUES:', mismatches);
if (!agg.size) console.log('  no rule failures across the parallel-validated range');
else { console.log('  engine discrepancies (rule failures on a valid chain = engine bugs):'); for (const [k, e] of [...agg.entries()].sort((a, b) => b[1].count - a[1].count)) console.log(`    ${fmt(e.count).padStart(9)}x  ${k}  (first @ height ${fmt(e.firstHeight)})`); }
await rm(SNAP, { recursive: true, force: true });
console.log('cleaned up snapshots.');
