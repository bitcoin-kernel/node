// Tier 0 payoff, live: a light wallet over testnet4. Sync + validate headers,
// then find a watched script's coins. Two paths, same trust (everything is
// checked against our proof-of-work-validated headers):
//   1. compact filters (BIP 158) if a peer serves them (private, efficient)
//   2. else a block scan over plain p2p, each block's merkle root verified
//      against our header (no third-party server, no filter peer needed)
//
// Self-validating by default: watches the coinbase output of a recent block,
// so the scan must rediscover it. Override with WATCH=<scriptPubKey hex>.
// Run: `node src/scan-testnet4.js`
import dns from 'node:dns/promises';
import { readFile } from 'node:fs/promises';
import { Codec } from '@bitcoin-desktop/schema/codec/codec.js';
import { P2pEngine } from '@bitcoin-desktop/schema/codec/p2p.js';
import { HeaderEngine } from '@bitcoin-desktop/schema/codec/headers.js';
import { GcsFilter } from '@bitcoin-desktop/schema/codec/filters.js';
import { hexToBytes } from '@bitcoin-desktop/schema/codec/hash.js';
import { Peer } from './peer.js';
import { FileHeaderStore } from './store/header-store.js';
import { HeaderSync } from './chain/header-sync.js';
import { WalletScan } from './wallet/wallet-scan.js';

const load = async (p) => JSON.parse(await readFile(new URL(import.meta.resolve('@bitcoin-desktop/schema/' + p)), 'utf8'));
const codec = new Codec(await load('schema/core.jsonld'), await load('schema/proof.jsonld'), await load('schema/p2p.jsonld'));
const chainSchema = await load('schema/chain.jsonld');
const validateSchema = await load('schema/validate.jsonld');
const p2pSchema = await load('schema/p2p.jsonld');
const t4 = await load('test/vectors/testnet4.json');
const params = chainSchema['@graph'].find((n) => n['@id'] === 'btc:testnet4');

const p2p = P2pEngine.fromSchemas(codec, p2pSchema, chainSchema, 'btc:testnet4');
const he = HeaderEngine.fromSchemas(codec, chainSchema, validateSchema, 'btc:testnet4');
const gcs = new GcsFilter();
const genesisHeader = codec.decode('BlockHeader', t4.genesisHeader);
const SEEDS = ['seed.testnet4.bitcoin.sprovoost.nl', 'seed.testnet4.wiz.biz'];
const HEADERS_FILE = new URL('../data/testnet4-headers.bin', import.meta.url);
const fmt = (n) => n.toLocaleString();
const shuffle = (a) => a.map((v) => [Math.random(), v]).sort((x, y) => x[0] - y[0]).map((x) => x[1]);
const btc = (sat) => (Number(sat) / 1e8).toFixed(8);

async function candidates() {
  const c = [];
  for (const seed of SEEDS) { try { for (const ip of shuffle(await dns.resolve4(seed)).slice(0, 10)) c.push(ip); } catch {} c.push(seed); }
  return c;
}
async function connectPeer(host) { const peer = new Peer(p2p, codec); await peer.connect(host, params.port); return peer; }
async function firstPeer(hosts) { while (hosts.length) { try { return await connectPeer(hosts.shift()); } catch {} } throw new Error('no peer'); }
const getBlock = async (peer, hash) => { peer.send('getdata', { items: [{ type: 2, hash }] }); return (await peer.waitFor(['block'], 20000)).payload; };

// --- headers (resume + sync) ---
const store = new FileHeaderStore(codec, he, genesisHeader, HEADERS_FILE);
await store.load();
const peer = await firstPeer(await candidates());
console.log(`syncing headers (have ${fmt(store.height)})...`);
await new HeaderSync(store, he, codec).sync(async (locator) => { peer.send('getheaders', { version: 70016, blockLocator: locator, hashStop: '0'.repeat(64) }); return (await peer.waitFor(['headers'])).payload?.entries?.map((e) => e.header) ?? []; });
console.log(`header tip: height ${fmt(store.height)}`);

const to = store.height;
const SPAN = Number(process.env.SPAN || 50);
const from = Math.max(1, to - SPAN + 1);
const stopHash = store.tipHash();
const headerHashAt = (h) => codec.blockHash(store.headerAt(h));

// --- watch target ---
let watchScript = process.env.WATCH;
if (watchScript) console.log(`watching script ${watchScript.slice(0, 16)}… (from WATCH)`);
else {
  const sample = await getBlock(peer, store.tipHash());
  watchScript = sample.transactions[0].outputs.find((o) => o.scriptPubKey && !o.scriptPubKey.startsWith('6a')).scriptPubKey;
  console.log(`watching the coinbase output of block ${fmt(to)} (self-validating)`);
}
const wallet = new WalletScan(codec, gcs).watchScript(watchScript);
const onMatch = ({ height, recv, spent }) => console.log(`  block ${fmt(height)}: ${recv} received, ${spent} spent`);

// --- try compact filters; otherwise verified block scan over p2p ---
async function findFilterPeer() {
  const hosts = await candidates();
  for (let n = 0; n < 8 && hosts.length; n++) {
    let p;
    try { p = await connectPeer(hosts.shift()); } catch { continue; }
    if ((BigInt(p.peerVersion?.services ?? 0) & 64n) === 0n) { p.close(); continue; } // NODE_COMPACT_FILTERS
    try { p.send('getcfilters', { filterType: 0, startHeight: to, stopHash }); await p.waitFor(['cfilter'], 6000); return p; } catch { p.close(); }
  }
  return null;
}

let res, mode;
const fp = await findFilterPeer();
if (fp) {
  mode = 'compact filters (BIP 158)';
  const filters = new Map();
  fp.send('getcfilters', { filterType: 0, startHeight: from, stopHash });
  for (let i = 0; i < to - from + 1; i++) { const m = await fp.waitFor(['cfilter'], 15000); filters.set(m.payload.blockHash, hexToBytes(m.payload.filter)); }
  console.log(`downloaded ${filters.size} compact filters for blocks ${fmt(from)}..${fmt(to)}`);
  res = await wallet.scan({ from, to, headerHashAt, fetchFilter: (h) => filters.get(h), fetchBlock: (h) => getBlock(fp, h), onMatch });
  fp.close();
} else {
  mode = 'block scan over p2p (no filter peer; each block verified against our header)';
  console.log(`no peer serves compact filters; ${mode}`);
  const verifyBlock = (block, h) => codec.merkleRoot(block.transactions.map((t) => codec.txid(t))) === store.headerAt(h).merkleRoot;
  res = await wallet.scanBlocks({ from, to, headerHashAt, fetchBlock: (h) => getBlock(peer, h), verifyBlock, onMatch });
}
peer.close();

console.log(`\nmode: ${mode}`);
console.log(`scanned blocks ${fmt(from)}..${fmt(to)} (${SPAN}); wallet touched in ${res.touched} block(s)`);
console.log(`wallet: ${res.utxos} UTXO(s), balance ${btc(wallet.balance)} tBTC, ${wallet.history.length} history entr${wallet.history.length === 1 ? 'y' : 'ies'}`);
if (res.touched > 0) console.log(`✓ rediscovered the watched coins, every block verified against our PoW-validated headers`);
else console.log(`(no coins for this script in the last ${SPAN} blocks)`);
