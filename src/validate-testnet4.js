// FULL block validation of testnet4 from genesis, as a differential AUDIT.
// Download each block over p2p, verify its merkle root against our PoW-validated
// header, then run the engine's full block-context validation (executes every
// script, verifies every signature, evolves the UTXO set).
//
// The testnet4 chain is valid by definition, so any consensus-rule failure is an
// ENGINE bug, not an invalid block. We therefore LOG rule failures as warnings
// and keep going (still applying the block), building a catalogue of every rule
// the engine gets wrong, with counts. A merkle mismatch stays fatal (that would
// be a decode bug or a lying peer). Resumable; prints a summary at the end or on
// Ctrl-C.
//
// Run: `node src/validate-testnet4.js`   (MAXH=N to limit)
import dns from 'node:dns/promises';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { Codec } from '@bitcoin-desktop/schema/codec/codec.js';
import { P2pEngine } from '@bitcoin-desktop/schema/codec/p2p.js';
import { HeaderEngine } from '@bitcoin-desktop/schema/codec/headers.js';
import { BlockEngine } from '@bitcoin-desktop/schema/codec/blocks.js';
import { setVerifyBackend } from '@bitcoin-desktop/schema/codec/secp256k1.js';
import { wasmBackend } from './wasm-secp.js';
import { Peer } from './peer.js';
import { FileHeaderStore } from './store/header-store.js';
import { FileBlockStore } from './store/block-store.js';
import { HeaderSync } from './chain/header-sync.js';

const load = async (p) => JSON.parse(await readFile(new URL(import.meta.resolve('@bitcoin-desktop/schema/' + p)), 'utf8'));
const codec = new Codec(await load('schema/core.jsonld'), await load('schema/proof.jsonld'), await load('schema/p2p.jsonld'));
const chainSchema = await load('schema/chain.jsonld');
const validateSchema = await load('schema/validate.jsonld');
const scriptSchema = await load('schema/script.jsonld');
const p2pSchema = await load('schema/p2p.jsonld');
const t4 = await load('test/vectors/testnet4.json');
const params = chainSchema['@graph'].find((n) => n['@id'] === 'btc:testnet4');

// Swap the engine's pure-JS secp for WASM libsecp256k1 (~16x), proven
// consensus-equivalent on Bitcoin Core's script vectors (test/wasm-secp.test.js).
// This is what makes the inscription-flood blocks feasible to validate.
setVerifyBackend(wasmBackend);

const p2p = P2pEngine.fromSchemas(codec, p2pSchema, chainSchema, 'btc:testnet4');
const he = HeaderEngine.fromSchemas(codec, chainSchema, validateSchema, 'btc:testnet4');
const be = BlockEngine.fromSchemas(codec, chainSchema, validateSchema, scriptSchema, 'btc:testnet4');
const genesisHeader = codec.decode('BlockHeader', t4.genesisHeader);

const DATA = new URL('../data/', import.meta.url);
const HEADERS_FILE = new URL('testnet4-headers.bin', DATA);
const CKPT = new URL('validate-ckpt.json', DATA);
const SEEDS = ['seed.testnet4.bitcoin.sprovoost.nl', 'seed.testnet4.wiz.biz'];
const WITNESS_BLOCK = 0x40000002;
const BATCH = Number(process.env.BATCH || 16);
const fmt = (n) => Number(n).toLocaleString();
const shuffle = (a) => a.map((v) => [Math.random(), v]).sort((x, y) => x[0] - y[0]).map((x) => x[1]);
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[s.length >> 1] : 0; };

async function candidates() { const c = []; for (const s of SEEDS) { try { for (const ip of shuffle(await dns.resolve4(s)).slice(0, 10)) c.push(ip); } catch {} c.push(s); } return c; }
async function firstPeer() { const hosts = await candidates(); while (hosts.length) { const peer = new Peer(p2p, codec); try { await peer.connect(hosts.shift(), params.port); return peer; } catch { peer.close(); } } throw new Error('no peer'); }

const store = new FileHeaderStore(codec, he, genesisHeader, HEADERS_FILE);
const blockStore = new FileBlockStore(DATA, codec);
await store.load();

// A peer is optional: needed only to top up headers and to fetch blocks the
// BlockStore is missing. With a complete store, this validates fully offline.
let peer = null;
try {
  peer = await firstPeer();
  console.log(`syncing headers (have ${fmt(store.height)})...`);
  await new HeaderSync(store, he, codec).sync(async (locator) => { peer.send('getheaders', { version: 70016, blockLocator: locator, hashStop: '0'.repeat(64) }); return (await peer.waitFor(['headers'])).payload?.entries?.map((e) => e.header) ?? []; });
} catch (e) { console.log(`offline: validating from the local store (no peer: ${e.message})`); }
console.log(`header tip: ${fmt(store.height)}`);

// resume
const utxo = new Map();
let start = 1;
try { const c = JSON.parse(await readFile(CKPT, 'utf8')); for (const [k, v] of c.utxo) utxo.set(k, v); start = c.height + 1; console.log(`resuming from ${fmt(start)} (utxo ${fmt(utxo.size)})`); } catch { console.log('starting from genesis'); }

const TIP = Math.min(store.height, Number(process.env.MAXH || store.height));
const warnings = new Map();
const warn = (label, error, h) => {
  const k = `${label}:${error || ''}`;
  const e = warnings.get(k);
  if (!e) { warnings.set(k, { count: 1, firstHeight: h }); process.stdout.write(`\nNEW engine discrepancy: ${k} (first at height ${fmt(h)})\n`); }
  else e.count++;
};
let validated = 0, txs = 0, lastH = start - 1;
const t0 = Date.now();

const checkpoint = async (h) => { await mkdir(DATA, { recursive: true }); await writeFile(CKPT, JSON.stringify({ height: h, utxo: [...utxo.entries()] })); };
function summary() {
  console.log(`\n--- audit: ${fmt(validated)} blocks fully validated, ${fmt(txs)} transactions, in ${((Date.now() - t0) / 1000 / 60).toFixed(1)} min ---`);
  if (!warnings.size) console.log('  no rule failures: the engine agreed with the real chain on every rule of every block');
  else { console.log('  engine discrepancies (rule failures on a valid chain = engine bugs to fix):'); for (const [k, e] of [...warnings.entries()].sort((a, b) => b[1].count - a[1].count)) console.log(`    ${fmt(e.count).padStart(9)}x  ${k}  (first @ height ${fmt(e.firstHeight)})`); }
}
process.on('SIGINT', async () => { summary(); await checkpoint(lastH); process.exit(0); });

let fromDisk = 0, fromNet = 0;
async function fetchWindow(lo, hi) {
  const win = new Map();
  const want = new Map(); // hash -> height, for blocks not on disk
  for (let k = lo; k <= hi; k++) {
    const b = blockStore.get(k);
    if (b) { win.set(k, b); fromDisk++; } else want.set(codec.blockHash(store.headerAt(k)), k);
  }
  for (let attempt = 0; want.size && attempt < 5; attempt++) {
    if (!peer) peer = await firstPeer();
    const need = [...want.keys()];
    try {
      peer.send('getdata', { items: need.map((hash) => ({ type: WITNESS_BLOCK, hash })) });
      await peer.collect('block', need.length, { timeoutMs: 120000, onItem: (m) => { const b = m.payload; const hash = codec.blockHash(b.header); const k = want.get(hash); if (k != null) { blockStore.putSync(k, b); win.set(k, b); want.delete(hash); fromNet++; } } });
    } catch { try { peer?.close(); } catch {} peer = null; }
  }
  if (want.size) throw new Error(`window ${lo}..${hi}: ${want.size} block(s) not in store and no peer`);
  return win;
}

for (let h = start; h <= TIP; h += BATCH) {
  const hi = Math.min(TIP, h + BATCH - 1);
  const win = await fetchWindow(h, hi);
  for (let k = h; k <= hi; k++) {
    const block = win.get(k);
    const root = codec.merkleRoot(block.transactions.map((t) => codec.txid(t)));
    if (root !== store.headerAt(k).merkleRoot) { console.error(`\n✗ height ${fmt(k)}: merkle mismatch (fatal)`); summary(); await checkpoint(k - 1); process.exit(1); }
    const times = []; for (let j = Math.max(1, k - 11); j < k; j++) times.push(store.headerAt(j).time);
    // The real chain is valid, so a rule failure OR a thrown exception is an
    // engine bug: log both as discrepancies and keep going (don't let one block
    // crash the audit).
    try {
      const ctx = be.validateBlockContext(block, { height: k, utxo, external: new Map(), mtp: median(times) });
      for (const r of [...be.validateBlockStructure(block).results, ...ctx.results]) if (r.ok === false) warn(r.label, r.error, k);
      if (ctx.spending?.valueUnresolved > 0) warn('value-unresolved', String(ctx.spending.valueUnresolved), k);
    } catch (e) { warn('engine-threw', String(e.message).slice(0, 50), k); }
    try { be.applyBlock(utxo, block, k); } catch (e) { warn('applyBlock-threw', String(e.message).slice(0, 40), k); }
    validated++; txs += block.transactions.length; lastH = k;
  }
  const secs = (Date.now() - t0) / 1000, rate = validated / secs;
  process.stdout.write(`\r  validated ${fmt(hi)}/${fmt(TIP)}  |  ${rate.toFixed(0)} blk/s  |  disk ${fmt(fromDisk)} net ${fmt(fromNet)}  |  utxo ${fmt(utxo.size)}  |  warns ${warnings.size}  |  ETA ${((TIP - hi) / rate / 60).toFixed(0)} min   `);
  if (hi % 2000 < BATCH) await checkpoint(hi);
}
await checkpoint(TIP);
process.stdout.write('\n');
console.log(`✓ ran full validation to height ${fmt(TIP)}`);
summary();
