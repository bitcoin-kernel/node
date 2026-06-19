// Range worker for parallel full validation. Validates a half-open height range
// [lo, hi] starting from a UTXO snapshot at lo-1 (written by validate-parallel),
// using inline WASM secp + native SHA-256 (no sub-pool — parallelism is at the
// process/range level here). Writes its discrepancy tally to data/snap/result-<lo>.json.
//
// Run: node src/validate-range.mjs <lo> <hi>
import { readFile, writeFile } from 'node:fs/promises';
import { Codec } from '@bitcoin-desktop/schema/codec/codec.js';
import { HeaderEngine } from '@bitcoin-desktop/schema/codec/headers.js';
import { BlockEngine } from '@bitcoin-desktop/schema/codec/blocks.js';
import { setVerifyBackend } from '@bitcoin-desktop/schema/codec/secp256k1.js';
import { setSha256Backend } from '@bitcoin-desktop/schema/codec/hash.js';
import { wasmBackend } from './wasm-secp.js';
import { nativeSha256 } from './sha256-native.js';
import { FileHeaderStore } from './store/header-store.js';
import { FileBlockStore } from './store/block-store.js';

const lo = Number(process.argv[2]), hi = Number(process.argv[3]);
const load = async (p) => JSON.parse(await readFile(new URL(import.meta.resolve('@bitcoin-desktop/schema/' + p)), 'utf8'));
const codec = new Codec(await load('schema/core.jsonld'), await load('schema/proof.jsonld'));
const chainSchema = await load('schema/chain.jsonld');
const validateSchema = await load('schema/validate.jsonld');
const scriptSchema = await load('schema/script.jsonld');
const t4 = await load('test/vectors/testnet4.json');
const he = HeaderEngine.fromSchemas(codec, chainSchema, validateSchema, 'btc:testnet4');
const be = BlockEngine.fromSchemas(codec, chainSchema, validateSchema, scriptSchema, 'btc:testnet4');
setVerifyBackend(wasmBackend);
setSha256Backend(nativeSha256);

const DATA = new URL('../data/', import.meta.url);
const genesisHeader = codec.decode('BlockHeader', t4.genesisHeader);
const store = new FileHeaderStore(codec, he, genesisHeader, new URL('testnet4-headers.bin', DATA));
await store.load();
const blockStore = new FileBlockStore(DATA, codec);
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[s.length >> 1] : 0; };

// starting UTXO: snapshot at lo-1 (empty for the genesis-anchored first range)
const utxo = new Map();
if (lo > 1) { const snap = JSON.parse(await readFile(new URL(`snap/${lo - 1}.json`, DATA), 'utf8')); for (const [k, v] of snap.utxo) utxo.set(k, v); }

const warns = new Map();
const warn = (label, error, h) => { const k = `${label}:${error || ''}`; const e = warns.get(k); if (!e) warns.set(k, { count: 1, firstHeight: h }); else e.count++; };
const collect = (ctx, results, k) => { for (const r of results) if (r.ok === false) warn(r.label, r.error, k); if (ctx?.spending?.valueUnresolved > 0) warn('value-unresolved', String(ctx.spending.valueUnresolved), k); };

let validated = 0, txs = 0, merkleMismatch = null;
for (let k = lo; k <= hi; k++) {
  const block = blockStore.get(k);
  if (!block) { merkleMismatch = `missing block ${k}`; break; }
  const root = codec.merkleRoot(block.transactions.map((t) => codec.txid(t)));
  if (root !== store.headerAt(k).merkleRoot) { merkleMismatch = `merkle mismatch at ${k}`; break; }
  const times = []; for (let j = Math.max(1, k - 11); j < k; j++) times.push(store.headerAt(j).time);
  try {
    const ctx = be.validateBlockContext(block, { height: k, utxo, external: new Map(), mtp: median(times) });
    collect(ctx, [...be.validateBlockStructure(block).results, ...ctx.results], k);
  } catch (e) { warn('engine-threw', String(e.message).slice(0, 50), k); }
  try { be.applyBlock(utxo, block, k); } catch (e) { warn('applyBlock-threw', String(e.message).slice(0, 40), k); }
  validated++; txs += block.transactions.length;
}

await writeFile(new URL(`snap/result-${lo}.json`, DATA), JSON.stringify({
  lo, hi, validated, txs, merkleMismatch,
  warns: [...warns.entries()].map(([k, e]) => [k, e.count, e.firstHeight]),
}));
process.exit(merkleMismatch ? 1 : 0);
