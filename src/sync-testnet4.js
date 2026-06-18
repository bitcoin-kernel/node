// Tier 0, end to end: connect to a live testnet4 peer, sync the header chain,
// fully validate it incrementally, handle reorgs by the most-work rule, and
// persist it. Resumable. Built on the platform-agnostic HeaderStore + HeaderSync
// (Node here; the browser swaps FileHeaderStore -> OpfsHeaderStore and the TCP
// Peer -> a WebSocket-bridge peer, with no other change).
//
// Run: `node src/sync-testnet4.js`
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
const TIP_FILE = new URL('testnet4-tip.json', DATA);
const SEEDS = ['seed.testnet4.bitcoin.sprovoost.nl', 'seed.testnet4.wiz.biz'];

const shuffle = (a) => a.map((v) => [Math.random(), v]).sort((x, y) => x[0] - y[0]).map((x) => x[1]);
const fmt = (n) => n.toLocaleString();

// ---- peers (p2p only; we never hit a third-party explorer API) ----
async function gatherCandidates() {
  const c = [];
  for (const seed of SEEDS) {
    try { for (const ip of shuffle(await dns.resolve4(seed)).slice(0, 8)) c.push(ip); } catch {}
    c.push(seed);
  }
  return c;
}
async function connectPeer(host) { const peer = new Peer(p2p, codec); await peer.connect(host, params.port); return peer; }
async function firstPeer(candidates) {
  while (candidates.length) {
    const host = candidates.shift();
    try { const peer = await connectPeer(host); console.log(`connected to testnet4 peer ${host}:${params.port}`); return peer; } catch {}
  }
  throw new Error('could not reach any testnet4 peer');
}

// ---- sync: resume from the store, validate incrementally, handle reorgs ----
const store = new FileHeaderStore(codec, he, genesisHeader, HEADERS_FILE);
await store.load();
if (store.height) console.log(`resuming from height ${fmt(store.height)} (tip ${store.tipHash().slice(0, 16)}…)`);

const candidates = await gatherCandidates();
const peer = await firstPeer(candidates);
const fetchHeaders = async (locator) => {
  peer.send('getheaders', { version: 70016, blockLocator: locator, hashStop: '0'.repeat(64) });
  const msg = await peer.waitFor(['headers']);
  return (msg.payload?.entries ?? []).map((e) => e.header);
};

const sync = new HeaderSync(store, he, codec);
let lastLog = store.height;
const t0 = Date.now();
const result = await sync.sync(fetchHeaders, {
  onBatch: ({ tip, reorg }) => {
    if (reorg) console.log(`\n  reorg: rolled back ${reorg.depth} block(s) at height ${fmt(reorg.atHeight)}, adopted a heavier branch`);
    if (tip.height >= lastLog + 10000) { lastLog = tip.height; process.stdout.write(`\r  validated to height ${fmt(tip.height)}...`); }
  },
});
const ms = Date.now() - t0;
peer.close();
process.stdout.write('\n');

const tip = store.tip();
console.log(`synced + fully validated to height ${fmt(tip.height)} in ${(ms / 1000).toFixed(1)}s`);
console.log(`  ${fmt(result.added)} new headers this run, ${result.reorgs.length} reorg(s) handled`);
console.log(`  every header valid by construction: PoW, difficulty, BIP 94 timewarp, min-difficulty`);
console.log(`tip: height ${fmt(tip.height)}, hash ${tip.hash}`);
await mkdir(DATA, { recursive: true });
await writeFile(TIP_FILE, JSON.stringify({ height: tip.height, hash: tip.hash }, null, 2) + '\n');

// independent cross-check over p2p (no third-party API): do other peers agree?
async function hasNothingBeyond(host, hash) {
  const p = await connectPeer(host);
  try {
    p.send('getheaders', { version: 70016, blockLocator: [hash], hashStop: '0'.repeat(64) });
    const m = await p.waitFor(['headers'], 12000);
    return (m.payload?.entries ?? []).length === 0;
  } finally { p.close(); }
}
let agree = 0, asked = 0;
for (const host of candidates) {
  if (asked >= 2) break;
  try { const ok = await hasNothingBeyond(host, tip.hash); asked++; if (ok) agree++; } catch {}
}
if (asked) console.log(`${agree}/${asked} other peers confirm this tip (independent p2p cross-check)`);
console.log(`persisted ${fmt(store.height)} headers to data/`);
