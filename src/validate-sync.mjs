// Clean full-chain validation from genesis: build the UTXO from an empty set and
// FULL-validate every block (structure, scripts, signatures, UTXO, every rule)
// from height START (default 1) to tip, reading blocks offline from the local
// archive. No checkpoint resume — this is the from-scratch sync-speed baseline
// and the zero-divergence re-validation against the *fixed* engine.
//
// Run: node --max-old-space-size=49152 src/validate-sync.mjs   (START, TIP, LIGHT_THRESHOLD env optional)
import { readFile } from 'node:fs/promises';
import { Codec } from '@bitcoin-desktop/schema/codec/codec.js';
import { HeaderEngine } from '@bitcoin-desktop/schema/codec/headers.js';
import { BlockEngine } from '@bitcoin-desktop/schema/codec/blocks.js';
import { setVerifyBackend } from '@bitcoin-desktop/schema/codec/secp256k1.js';
import { setSha256Backend } from '@bitcoin-desktop/schema/codec/hash.js';
import { wasmBackend } from './wasm-secp.js';
import { nativeSha256 } from './sha256-native.js';
import { VerifyPool, makeDeferBackend } from './verify-pool.js';
import { ShardedUtxo } from './sharded-utxo.js';
import { FileHeaderStore } from './store/header-store.js';
import { FileBlockStore } from './store/block-store.js';

const load = async (p) => JSON.parse(await readFile(new URL(import.meta.resolve('@bitcoin-desktop/schema/' + p)), 'utf8'));
const codec = new Codec(await load('schema/core.jsonld'), await load('schema/proof.jsonld'));
const chainSchema = await load('schema/chain.jsonld');
const validateSchema = await load('schema/validate.jsonld');
const scriptSchema = await load('schema/script.jsonld');
const t4 = await load('test/vectors/testnet4.json');

const pool = new VerifyPool();
const defer = makeDeferBackend();
setVerifyBackend(defer.backend);
setSha256Backend(nativeSha256);
const LIGHT = Number(process.env.LIGHT_THRESHOLD || 600);
console.log(`clean full-chain validation from genesis | hybrid verify (inline <=${LIGHT} inputs, ${pool.size}-worker pool above)`);

const he = HeaderEngine.fromSchemas(codec, chainSchema, validateSchema, 'btc:testnet4');
const be = BlockEngine.fromSchemas(codec, chainSchema, validateSchema, scriptSchema, 'btc:testnet4');

const DATA = new URL('../data/', import.meta.url);
const fmt = (n) => Number(n).toLocaleString();
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[s.length >> 1] : 0; };
const store = new FileHeaderStore(codec, he, codec.decode('BlockHeader', t4.genesisHeader), new URL('testnet4-headers.bin', DATA));
await store.load();
const blockStore = new FileBlockStore(DATA, codec);
const TIP = Math.min(store.height, Number(process.env.TIP || store.height));
const START = Number(process.env.START || 1);

const utxo = new ShardedUtxo(64);
const warnings = new Map();
const warn = (label, error, h) => { const k = `${label}:${error || ''}`; const e = warnings.get(k); if (!e) { warnings.set(k, { count: 1, firstHeight: h }); process.stdout.write(`\nNEW discrepancy: ${k} (first @ ${fmt(h)})\n`); } else e.count++; };
const collect = (ctx, results) => { const w = []; for (const r of results) if (r.ok === false) w.push([r.label, r.error]); if (ctx?.spending?.valueUnresolved > 0) w.push(['value-unresolved', String(ctx.spending.valueUnresolved)]); return w; };

let validated = 0;
const t0 = Date.now();
process.on('SIGINT', async () => { try { if (pool) await pool.close(); } catch {} process.exit(0); });

for (let h = START; h <= TIP; h++) {
  const block = blockStore.get(h);
  if (!block) { console.error(`\nmissing block ${h}`); break; }
  const root = codec.merkleRoot(block.transactions.map((t) => codec.txid(t)));
  if (root !== store.headerAt(h).merkleRoot) warn('merkle-mismatch', '', h);
  const times = []; for (let j = Math.max(1, h - 11); j < h; j++) times.push(store.headerAt(j).time);
  const mtp = median(times);
  let ins = 0; for (const tx of block.transactions) ins += tx.inputs.length;
  if (ins <= LIGHT) {
    setVerifyBackend(wasmBackend);
    try {
      const ctx = be.validateBlockContext(block, { height: h, utxo, external: new Map(), mtp });
      for (const [l, e] of collect(ctx, [...be.validateBlockStructure(block).results, ...ctx.results])) warn(l, e, h);
    } catch (e) { warn('engine-threw', String(e.message).slice(0, 50), h); }
    setVerifyBackend(defer.backend);
  } else {
    let pend = null, threw = null;
    try {
      const ctx = be.validateBlockContext(block, { height: h, utxo, external: new Map(), mtp });
      pend = collect(ctx, [...be.validateBlockStructure(block).results, ...ctx.results]);
    } catch (e) { threw = String(e.message).slice(0, 50); }
    const recs = defer.take();
    const sigsOk = threw ? false : await pool.verifyAll(recs);
    if (threw) warn('engine-threw', threw, h);
    else if (sigsOk) { for (const [l, e] of pend) warn(l, e, h); }
    else {
      setVerifyBackend(wasmBackend);
      try {
        const ctx = be.validateBlockContext(block, { height: h, utxo, external: new Map(), mtp });
        for (const [l, e] of collect(ctx, [...be.validateBlockStructure(block).results, ...ctx.results])) warn(l, e, h);
      } catch (e) { warn('engine-threw', String(e.message).slice(0, 50), h); }
      setVerifyBackend(defer.backend); defer.take();
    }
  }
  validated++;
  try { be.applyBlock(utxo, block, h); } catch (e) { warn('applyBlock-threw', String(e.message).slice(0, 40), h); }
  if (h % 250 === 0 || h === TIP) {
    const secs = (Date.now() - t0) / 1000;
    process.stdout.write(`\r  h ${fmt(h)}/${fmt(TIP)}  validated ${fmt(validated)}  utxo ${fmt(utxo.size)}  warns ${warnings.size}  ${((h - START + 1) / secs).toFixed(0)} blk/s  ${(secs / 60).toFixed(1)}m   `);
  }
}
process.stdout.write('\n');
console.log(`\n=== clean full validation ${fmt(START)}..${fmt(TIP)}: ${fmt(validated)} blocks in ${((Date.now() - t0) / 60000).toFixed(1)} min ===`);
if (!warnings.size) console.log('  ZERO rule failures — the engine agrees with testnet4 on every rule, genesis to tip');
else for (const [k, e] of [...warnings.entries()].sort((a, b) => b[1].count - a[1].count)) console.log(`    ${fmt(e.count).padStart(8)}x  ${k}  (first @ ${fmt(e.firstHeight)})`);
if (pool) await pool.close();
process.exit(0);
