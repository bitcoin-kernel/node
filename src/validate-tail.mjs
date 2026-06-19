// Finish full validation past the point a single V8 Map gives out (~height 69k,
// where testnet4's UTXO exceeds 16.7M entries). Single process, sharded UTXO.
//
// Resume from the 51,500 checkpoint: apply-only through the already-audited flood
// to rebuild the UTXO (fast, native SHA-256), then FULL-validate from VALIDATE_FROM
// to TIP with inline WASM secp. Checkpoints the sharded UTXO periodically (NDJSON)
// so a restart skips the rebuild. Prints the discrepancy tally for the tail.
//
// Run: node --max-old-space-size=49152 src/validate-tail.mjs   (VALIDATE_FROM, TIP env optional)
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
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
// Signature verification: NOPOOL=1 -> inline WASM (fast for light post-flood
// blocks, where pool dispatch overhead exceeds the few sigs it parallelizes);
// default -> worker-thread pool (CCheckQueue 3-phase, fast for the heavy flood).
const NOPOOL = process.env.NOPOOL === '1';
let pool = null, defer = null;
if (NOPOOL) { setVerifyBackend(wasmBackend); }
else { pool = new VerifyPool(); defer = makeDeferBackend(); setVerifyBackend(defer.backend); }
setSha256Backend(nativeSha256);
console.log(NOPOOL ? 'verify: inline WASM (no pool)' : `verify: ${pool.size}-worker pool`);
const he = HeaderEngine.fromSchemas(codec, chainSchema, validateSchema, 'btc:testnet4');
const be = BlockEngine.fromSchemas(codec, chainSchema, validateSchema, scriptSchema, 'btc:testnet4');

const DATA = new URL('../data/', import.meta.url);
const fmt = (n) => Number(n).toLocaleString();
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[s.length >> 1] : 0; };
const store = new FileHeaderStore(codec, he, codec.decode('BlockHeader', t4.genesisHeader), new URL('testnet4-headers.bin', DATA));
await store.load();
const blockStore = new FileBlockStore(DATA, codec);
const TIP = Math.min(store.height, Number(process.env.TIP || store.height));
const VALIDATE_FROM = Number(process.env.VALIDATE_FROM || 65101);
const TAIL_CKPT = new URL('validate-tail-ckpt.ndjson', DATA);

const utxo = new ShardedUtxo(64);
let start;
try {
  const meta = await utxo.load(TAIL_CKPT);
  start = meta.height + 1;
  console.log(`resumed tail checkpoint at ${fmt(meta.height)} (utxo ${fmt(utxo.size)})`);
} catch {
  const ck = JSON.parse(await readFile(new URL('validate-ckpt.json', DATA), 'utf8'));
  for (const [k, v] of ck.utxo) utxo.set(k, v);
  start = ck.height + 1;
  console.log(`rebuilding from serial checkpoint ${fmt(ck.height)} (utxo ${fmt(utxo.size)}); apply-only to ${fmt(VALIDATE_FROM - 1)}, then validate to ${fmt(TIP)}`);
}

const warnings = new Map();
const warn = (label, error, h) => { const k = `${label}:${error || ''}`; const e = warnings.get(k); if (!e) { warnings.set(k, { count: 1, firstHeight: h }); process.stdout.write(`\nNEW discrepancy: ${k} (first @ ${fmt(h)})\n`); } else e.count++; };
const saveCkpt = async (h) => { const tmp = new URL('validate-tail-ckpt.tmp', DATA); await utxo.save(tmp, { height: h }); await rename(tmp, TAIL_CKPT); };

let validated = 0, applied = 0;
const t0 = Date.now();
process.on('SIGINT', async () => { console.log('\ncheckpointing before exit...'); await saveCkpt(lastH); try { if (pool) await pool.close(); } catch {} process.exit(0); });
let lastH = start - 1;

for (let h = start; h <= TIP; h++) {
  const block = blockStore.get(h);
  if (!block) { console.error(`\nmissing block ${h}`); break; }
  if (h >= VALIDATE_FROM) {
    const root = codec.merkleRoot(block.transactions.map((t) => codec.txid(t)));
    if (root !== store.headerAt(h).merkleRoot) { warn('merkle-mismatch', '', h); }
    const times = []; for (let j = Math.max(1, h - 11); j < h; j++) times.push(store.headerAt(j).time);
    const mtp = median(times);
    const collect = (ctx, results) => { const w = []; for (const r of results) if (r.ok === false) w.push([r.label, r.error]); if (ctx?.spending?.valueUnresolved > 0) w.push(['value-unresolved', String(ctx.spending.valueUnresolved)]); return w; };
    if (NOPOOL) {
      try {
        const ctx = be.validateBlockContext(block, { height: h, utxo, external: new Map(), mtp });
        for (const [l, e] of collect(ctx, [...be.validateBlockStructure(block).results, ...ctx.results])) warn(l, e, h);
      } catch (e) { warn('engine-threw', String(e.message).slice(0, 50), h); }
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
  } else { applied++; }
  try { be.applyBlock(utxo, block, h); } catch (e) { warn('applyBlock-threw', String(e.message).slice(0, 40), h); }
  lastH = h;
  if (h % 250 === 0 || h === TIP) {
    const secs = (Date.now() - t0) / 1000;
    process.stdout.write(`\r  h ${fmt(h)}/${fmt(TIP)}  applied ${fmt(applied)} validated ${fmt(validated)}  utxo ${fmt(utxo.size)}  warns ${warnings.size}  ${(((h - start + 1) / secs)).toFixed(0)} blk/s   `);
  }
  if ((h === VALIDATE_FROM || h % 20000 === 0) && h >= VALIDATE_FROM) await saveCkpt(h);
}
await saveCkpt(TIP);
process.stdout.write('\n');
console.log(`\n=== tail validation ${fmt(VALIDATE_FROM)}..${fmt(TIP)}: ${fmt(validated)} blocks validated (${fmt(applied)} apply-only rebuild), ${((Date.now() - t0) / 60000).toFixed(1)} min ===`);
if (!warnings.size) console.log('  no rule failures');
else for (const [k, e] of [...warnings.entries()].sort((a, b) => b[1].count - a[1].count)) console.log(`    ${fmt(e.count).padStart(8)}x  ${k}  (first @ ${fmt(e.firstHeight)})`);
if (pool) await pool.close();
process.exit(0);
