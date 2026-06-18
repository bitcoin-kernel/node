// FULL block validation of testnet4 from genesis: download every block (with
// witness data), verify its merkle root against our PoW-validated header, then
// run the engine's full block-context validation, which executes every script
// and verifies every signature, evolving the UTXO set. Checkpoints so a restart
// resumes. This is the thesis test: can the engine fully validate a real chain?
//
// Run: `node src/validate-testnet4.js`   (MAXH=2000 to limit; for smoke tests)
import dns from 'node:dns/promises';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { Codec } from '@bitcoin-desktop/schema/codec/codec.js';
import { P2pEngine } from '@bitcoin-desktop/schema/codec/p2p.js';
import { HeaderEngine } from '@bitcoin-desktop/schema/codec/headers.js';
import { BlockEngine } from '@bitcoin-desktop/schema/codec/blocks.js';
import { Peer } from './peer.js';
import { FileHeaderStore } from './store/header-store.js';
import { HeaderSync } from './chain/header-sync.js';

const load = async (p) => JSON.parse(await readFile(new URL(import.meta.resolve('@bitcoin-desktop/schema/' + p)), 'utf8'));
const codec = new Codec(await load('schema/core.jsonld'), await load('schema/proof.jsonld'), await load('schema/p2p.jsonld'));
const chainSchema = await load('schema/chain.jsonld');
const validateSchema = await load('schema/validate.jsonld');
const scriptSchema = await load('schema/script.jsonld');
const p2pSchema = await load('schema/p2p.jsonld');
const t4 = await load('test/vectors/testnet4.json');
const params = chainSchema['@graph'].find((n) => n['@id'] === 'btc:testnet4');

const p2p = P2pEngine.fromSchemas(codec, p2pSchema, chainSchema, 'btc:testnet4');
const he = HeaderEngine.fromSchemas(codec, chainSchema, validateSchema, 'btc:testnet4');
const be = BlockEngine.fromSchemas(codec, chainSchema, validateSchema, scriptSchema, 'btc:testnet4');
const genesisHeader = codec.decode('BlockHeader', t4.genesisHeader);

const DATA = new URL('../data/', import.meta.url);
const HEADERS_FILE = new URL('testnet4-headers.bin', DATA);
const CKPT = new URL('validate-ckpt.json', DATA);
const SEEDS = ['seed.testnet4.bitcoin.sprovoost.nl', 'seed.testnet4.wiz.biz'];
const WITNESS_BLOCK = 0x40000002; // MSG_BLOCK | MSG_WITNESS_FLAG
const fmt = (n) => Number(n).toLocaleString();
const shuffle = (a) => a.map((v) => [Math.random(), v]).sort((x, y) => x[0] - y[0]).map((x) => x[1]);
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[s.length >> 1] : 0; };

async function candidates() { const c = []; for (const s of SEEDS) { try { for (const ip of shuffle(await dns.resolve4(s)).slice(0, 10)) c.push(ip); } catch {} c.push(s); } return c; }
async function firstPeer() { const hosts = await candidates(); while (hosts.length) { const peer = new Peer(p2p, codec); try { await peer.connect(hosts.shift(), params.port); return peer; } catch { peer.close(); } } throw new Error('no peer'); }
const getBlock = async (peer, hash) => { peer.send('getdata', { items: [{ type: WITNESS_BLOCK, hash }] }); return (await peer.waitFor(['block'], 30000)).payload; };

// --- headers (must be fully synced to know block hashes + mtp) ---
const store = new FileHeaderStore(codec, he, genesisHeader, HEADERS_FILE);
await store.load();
let peer = await firstPeer();
console.log(`syncing headers (have ${fmt(store.height)})...`);
await new HeaderSync(store, he, codec).sync(async (locator) => { peer.send('getheaders', { version: 70016, blockLocator: locator, hashStop: '0'.repeat(64) }); return (await peer.waitFor(['headers'])).payload?.entries?.map((e) => e.header) ?? []; });
console.log(`header tip: ${fmt(store.height)}`);

// --- resume from checkpoint ---
const utxo = new Map();
let start = 1;
try {
  const c = JSON.parse(await readFile(CKPT, 'utf8'));
  for (const [k, v] of c.utxo) utxo.set(k, v);
  start = c.height + 1;
  console.log(`resuming full validation from height ${fmt(start)} (utxo ${fmt(utxo.size)})`);
} catch { console.log('starting full validation from genesis'); }

const TIP = Math.min(store.height, Number(process.env.MAXH || store.height));
const t0 = Date.now();
let validated = 0;
const checkpoint = async (h) => { await mkdir(DATA, { recursive: true }); await writeFile(CKPT, JSON.stringify({ height: h, utxo: [...utxo.entries()] })); };

for (let h = start; h <= TIP; h++) {
  const headerHash = codec.blockHash(store.headerAt(h));
  let block;
  try { block = await getBlock(peer, headerHash); }
  catch { peer.close(); peer = await firstPeer(); block = await getBlock(peer, headerHash); }

  // tie the block to our validated header
  const root = codec.merkleRoot(block.transactions.map((t) => codec.txid(t)));
  if (root !== store.headerAt(h).merkleRoot) { console.error(`✗ height ${fmt(h)}: merkle root mismatch (block does not match our header)`); await checkpoint(h - 1); process.exit(1); }

  const times = []; for (let k = Math.max(1, h - 11); k < h; k++) times.push(store.headerAt(k).time);
  const mtp = median(times);

  // structural + full context (runs every script, verifies every signature)
  const structural = be.validateBlockStructure(block);
  const ctx = be.validateBlockContext(block, { height: h, utxo, external: new Map(), mtp });
  const bad = [...structural.results, ...ctx.results].filter((r) => r.ok === false);
  if (bad.length || ctx.spending?.valueUnresolved > 0) {
    console.error(`✗ height ${fmt(h)} INVALID: ${JSON.stringify(bad.map((r) => r.label + ':' + r.error))}${ctx.spending?.valueUnresolved > 0 ? ' valueUnresolved=' + ctx.spending.valueUnresolved : ''}`);
    await checkpoint(h - 1); process.exit(1);
  }
  be.applyBlock(utxo, block, h);
  validated++;

  if (h % 1000 === 0 || h === TIP) {
    const rate = validated / ((Date.now() - t0) / 1000);
    process.stdout.write(`\r  validated to ${fmt(h)} / ${fmt(TIP)}  |  ${rate.toFixed(0)} blk/s  |  utxo ${fmt(utxo.size)}  |  ${((Date.now() - t0) / 1000 / 60).toFixed(1)} min   `);
    if (h % 5000 === 0) await checkpoint(h);
  }
}
peer.close();
await checkpoint(TIP);
process.stdout.write('\n');
console.log(`✓ FULLY VALIDATED testnet4 to height ${fmt(TIP)} in ${((Date.now() - t0) / 1000 / 60).toFixed(1)} min`);
console.log(`  every block: merkle root vs our header, structure, all scripts + signatures, UTXO consistency`);
console.log(`  final UTXO set: ${fmt(utxo.size)} unspent outputs`);
