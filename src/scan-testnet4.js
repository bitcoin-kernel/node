// Tier 0 payoff, live: a Neutrino (BIP 157/158) wallet scan over testnet4.
// Sync headers, then for a watched script: download compact filters, match,
// fetch only the matching blocks, and report received/spent coins.
//
// Self-validating by default: it watches the coinbase output of a recent block,
// so the scan must rediscover it. Override with WATCH=<scriptPubKey hex>.
//
// Run: `node src/scan-testnet4.js`   (or `WATCH=0014... node src/scan-testnet4.js`)
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

// --- headers (resume or sync) so we know block hashes by height ---
const store = new FileHeaderStore(codec, he, genesisHeader, HEADERS_FILE);
await store.load();
{
  const hosts = await candidates();
  let peer;
  while (hosts.length && !peer) { try { peer = await connectPeer(hosts.shift()); } catch {} }
  if (!peer) throw new Error('no peer');
  console.log(`syncing headers (have ${fmt(store.height)})...`);
  const sync = new HeaderSync(store, he, codec);
  await sync.sync(async (locator) => { peer.send('getheaders', { version: 70016, blockLocator: locator, hashStop: '0'.repeat(64) }); return (await peer.waitFor(['headers'])).payload?.entries?.map((e) => e.header) ?? []; });
  peer.close();
}
console.log(`header tip: height ${fmt(store.height)}`);

// --- find a peer that serves compact filters (NODE_COMPACT_FILTERS) ---
async function getFilters(peer, from, stopHash, count) {
  peer.send('getcfilters', { filterType: 0, startHeight: from, stopHash });
  const map = new Map();
  for (let i = 0; i < count; i++) {
    const m = await peer.waitFor(['cfilter'], 15000);
    map.set(m.payload.blockHash, hexToBytes(m.payload.filter));
  }
  return map;
}
async function getBlock(peer, hash) {
  peer.send('getdata', { items: [{ type: 2, hash }] });
  return (await peer.waitFor(['block'], 20000)).payload;
}

const to = store.height;
const SPAN = 50;
const from = Math.max(1, to - SPAN + 1);
const stopHash = store.tipHash();

async function filterPeer() {
  const hosts = await candidates();
  while (hosts.length) {
    let peer;
    try { peer = await connectPeer(hosts.shift()); } catch { continue; }
    try { peer.send('getcfilters', { filterType: 0, startHeight: to, stopHash }); await peer.waitFor(['cfilter'], 7000); console.log(`filter peer found`); return peer; }
    catch { peer.close(); }
  }
  throw new Error('no reachable testnet4 peer serves compact filters');
}
let peer;
try { peer = await filterPeer(); }
catch {
  console.log('\nNo reachable testnet4 peer advertises NODE_COMPACT_FILTERS (bit 6).');
  console.log('Public testnet4 nodes rarely enable blockfilterindex, so the live filter scan');
  console.log('needs a filter-serving source: point this at your own node');
  console.log('(bitcoind -testnet4 -blockfilterindex=1 -peerblockfilters=1), or supply filters');
  console.log('another way. The BIP 158 match + wallet logic is proven by `npm test`.');
  process.exit(0);
}

// --- pick a watch target: a recent block's coinbase output (self-validating) ---
let watchScript = process.env.WATCH;
let watchDesc;
if (watchScript) { watchDesc = `script ${watchScript.slice(0, 16)}… (from WATCH)`; }
else {
  const sample = await getBlock(peer, store.tipHash());
  const out = sample.transactions[0].outputs.find((o) => o.scriptPubKey && !o.scriptPubKey.startsWith('6a'));
  watchScript = out.scriptPubKey;
  watchDesc = `the coinbase output of block ${fmt(to)} (self-validating)`;
}
console.log(`watching ${watchDesc}`);

// --- scan ---
const filters = await getFilters(peer, from, stopHash, to - from + 1);
console.log(`downloaded ${filters.size} compact filters for blocks ${fmt(from)}..${fmt(to)}`);
const wallet = new WalletScan(codec, gcs).watchScript(watchScript);
const res = await wallet.scan({
  from, to,
  headerHashAt: (h) => store.tipHash() && codec.blockHash(store.headerAt(h)),
  fetchFilter: (hash) => filters.get(hash),
  fetchBlock: (hash) => getBlock(peer, hash),
  onMatch: ({ height, recv, spent }) => console.log(`  block ${fmt(height)}: ${recv} received, ${spent} spent`),
});
peer.close();

console.log(`\nscanned ${SPAN} blocks by filter; fetched ${res.candidates} matching block(s)`);
console.log(`wallet: ${res.utxos} UTXO(s), balance ${btc(wallet.balance)} tBTC, ${wallet.history.length} history entr${wallet.history.length === 1 ? 'y' : 'ies'}`);
if (res.touched > 0) console.log(`✓ the scan rediscovered the watched coins via BIP 158 filters, downloading only ${res.candidates} of ${SPAN} blocks`);
else console.log(`(no coins for this script in the last ${SPAN} blocks)`);
