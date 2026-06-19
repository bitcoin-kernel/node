// Overnight run: download the ENTIRE testnet4 chain over p2p (witness blocks)
// and verify every block against our proof-of-work-validated header by
// recomputing its merkle root. No explorer, no third party: raw Bitcoin p2p.
// Resumable. Reports blocks, bytes, and throughput.
//
// (Full script/signature/UTXO validation is blocked on an engine bug the smoke
// test found: the BIP34 coinbase-height rule, active from height 1 on testnet4,
// fails because it was only ever exercised pre-activation on mainnet. Fix that
// in the engine, then this becomes full validation. Tonight: download + verify.)
//
// Run: `node src/download-testnet4.js`
import dns from 'node:dns/promises';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { Codec } from '@bitcoin-desktop/schema/codec/codec.js';
import { P2pEngine } from '@bitcoin-desktop/schema/codec/p2p.js';
import { HeaderEngine } from '@bitcoin-desktop/schema/codec/headers.js';
import { Peer } from './peer.js';
import { FileHeaderStore } from './store/header-store.js';
import { HeaderSync } from './chain/header-sync.js';

const load = async (p) => JSON.parse(await readFile(new URL(import.meta.resolve('@bitcoin-desktop/schema/' + p)), 'utf8'));
const codec = new Codec(await load('schema/core.jsonld'), await load('schema/proof.jsonld'), await load('schema/p2p.jsonld'));
const chainSchema = await load('schema/chain.jsonld');
const validateSchema = await load('schema/validate.jsonld');
const p2pSchema = await load('schema/p2p.jsonld');
const t4 = await load('test/vectors/testnet4.json');
const params = chainSchema['@graph'].find((n) => n['@id'] === 'btc:testnet4');

const p2p = P2pEngine.fromSchemas(codec, p2pSchema, chainSchema, 'btc:testnet4');
const he = HeaderEngine.fromSchemas(codec, chainSchema, validateSchema, 'btc:testnet4');
const genesisHeader = codec.decode('BlockHeader', t4.genesisHeader);

const DATA = new URL('../data/', import.meta.url);
const HEADERS_FILE = new URL('testnet4-headers.bin', DATA);
const CKPT = new URL('download-ckpt.json', DATA);
const SEEDS = ['seed.testnet4.bitcoin.sprovoost.nl', 'seed.testnet4.wiz.biz'];
const WITNESS_BLOCK = 0x40000002;
const fmt = (n) => Number(n).toLocaleString();
const shuffle = (a) => a.map((v) => [Math.random(), v]).sort((x, y) => x[0] - y[0]).map((x) => x[1]);

async function candidates() { const c = []; for (const s of SEEDS) { try { for (const ip of shuffle(await dns.resolve4(s)).slice(0, 12)) c.push(ip); } catch {} c.push(s); } return c; }
async function firstPeer() { const hosts = await candidates(); while (hosts.length) { const peer = new Peer(p2p, codec); try { await peer.connect(hosts.shift(), params.port); return peer; } catch { peer.close(); } } throw new Error('no peer'); }
const getBlock = async (peer, hash) => { peer.send('getdata', { items: [{ type: WITNESS_BLOCK, hash }] }); return (await peer.waitFor(['block'], 30000)).payload; };

const store = new FileHeaderStore(codec, he, genesisHeader, HEADERS_FILE);
await store.load();
let peer = await firstPeer();
console.log(`syncing headers (have ${fmt(store.height)})...`);
await new HeaderSync(store, he, codec).sync(async (locator) => { peer.send('getheaders', { version: 70016, blockLocator: locator, hashStop: '0'.repeat(64) }); return (await peer.waitFor(['headers'])).payload?.entries?.map((e) => e.header) ?? []; });
console.log(`header tip: ${fmt(store.height)}`);

let start = 1, bytes = 0;
try { const c = JSON.parse(await readFile(CKPT, 'utf8')); start = c.height + 1; bytes = c.bytes || 0; console.log(`resuming download from ${fmt(start)} (${(bytes / 1e9).toFixed(2)} GB so far)`); } catch {}

const TIP = store.height;
const BATCH = Number(process.env.BATCH || 256); // pipelined: one getdata per batch
const t0 = Date.now();
let done = 0;
const checkpoint = async (h) => { await mkdir(DATA, { recursive: true }); await writeFile(CKPT, JSON.stringify({ height: h, bytes })); };

// fetch a contiguous [lo, hi] window in one getdata, return Map(blockHash -> block)
async function fetchWindow(lo, hi) {
  const hashes = [];
  for (let k = lo; k <= hi; k++) hashes.push(codec.blockHash(store.headerAt(k)));
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      peer.send('getdata', { items: hashes.map((hash) => ({ type: WITNESS_BLOCK, hash })) });
      const msgs = await peer.collect('block', hashes.length, 90000);
      return new Map(msgs.map((m) => [codec.blockHash(m.payload.header), m.payload]));
    } catch { peer.close(); peer = await firstPeer(); }
  }
  throw new Error(`could not fetch window ${lo}..${hi}`);
}

for (let h = start; h <= TIP; h += BATCH) {
  const hi = Math.min(TIP, h + BATCH - 1);
  const blocks = await fetchWindow(h, hi);
  for (let k = h; k <= hi; k++) {
    const block = blocks.get(codec.blockHash(store.headerAt(k)));
    if (!block) { console.error(`\n✗ height ${fmt(k)}: peer omitted this block`); await checkpoint(k - 1); process.exit(1); }
    const root = codec.merkleRoot(block.transactions.map((t) => codec.txid(t)));
    if (root !== store.headerAt(k).merkleRoot) { console.error(`\n✗ height ${fmt(k)}: merkle mismatch`); await checkpoint(k - 1); process.exit(1); }
    bytes += codec.encodeHex('Block', block).length / 2;
    done++;
  }
  const secs = (Date.now() - t0) / 1000;
  const rate = done / secs;
  const eta = (TIP - hi) / rate / 60;
  process.stdout.write(`\r  verified ${fmt(hi)}/${fmt(TIP)}  |  ${rate.toFixed(0)} blk/s  |  ${(bytes / 1e9).toFixed(2)} GB  |  ${(secs / 60).toFixed(1)} min, ETA ${eta.toFixed(1)} min   `);
  await checkpoint(hi);
}
peer.close();
await checkpoint(TIP);
process.stdout.write('\n');
console.log(`✓ downloaded + verified the entire testnet4 chain: ${fmt(TIP)} blocks, ${(bytes / 1e9).toFixed(2)} GB, in ${((Date.now() - t0) / 1000 / 60).toFixed(1)} min`);
console.log(`  every block tied to a proof-of-work-validated header by its merkle root, all over raw p2p`);
