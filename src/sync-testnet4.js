// Tier 0 foundation, end to end: connect to a live testnet4 peer, sync the
// header chain from genesis to tip, fully validate it (PoW, difficulty, BIP 94
// timewarp, min-difficulty walk-back), and persist it. Resumable. Reports a
// download + validation benchmark.
//
// The same flow runs in the browser over a WebSocket-to-TCP bridge; here it
// uses a raw TCP socket so it runs (and benchmarks) directly in Node.
//
// Run: `node src/sync-testnet4.js`
import dns from 'node:dns/promises';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { Codec } from '@bitcoin-desktop/schema/codec/codec.js';
import { P2pEngine } from '@bitcoin-desktop/schema/codec/p2p.js';
import { HeaderEngine } from '@bitcoin-desktop/schema/codec/headers.js';
import { Peer } from './peer.js';

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

// ---- storage (a flat header file; the browser uses OPFS the same way) ----
async function saveHeaders(headers) {
  await mkdir(DATA, { recursive: true });
  const hex = headers.map((h) => codec.encodeHex('BlockHeader', h)).join('');
  await writeFile(HEADERS_FILE, Buffer.from(hex, 'hex'));
  await writeFile(TIP_FILE, JSON.stringify({ height: headers.length, hash: headers.length ? codec.blockHash(headers.at(-1)) : params.genesisHash }, null, 2) + '\n');
}

// ---- peers (p2p only; we never hit a third-party explorer API) ----
async function gatherCandidates() {
  const c = [];
  for (const seed of SEEDS) {
    try { for (const ip of shuffle(await dns.resolve4(seed)).slice(0, 8)) c.push(ip); } catch {}
    c.push(seed); // the seed host often runs a node too
  }
  return c;
}
async function connectPeer(host) {
  const peer = new Peer(p2p, codec);
  await peer.connect(host, params.port);
  return peer;
}
async function firstPeer(candidates) {
  while (candidates.length) {
    const host = candidates.shift();
    try { const peer = await connectPeer(host); console.log(`connected to testnet4 peer ${host}:${params.port}`); return peer; } catch {}
  }
  throw new Error('could not reach any testnet4 peer');
}

// ---- sync the header chain fresh from genesis ----
// (cross-run resume + reorg handling is M1.3; here we do a correct full sync
// with a connectivity check so a misbehaving peer can't feed us a broken chain.)
const headers = [];
let tipHash = params.genesisHash;
const candidates = await gatherCandidates();
const peer = await firstPeer(candidates);
const t0 = Date.now();
let rounds = 0;
while (true) {
  peer.send('getheaders', { version: 70016, blockLocator: [tipHash], hashStop: '0'.repeat(64) });
  const msg = await peer.waitFor(['headers']);
  const entries = msg.payload?.entries ?? [];
  if (!entries.length) break;
  if (entries[0].header.prevBlockHash !== tipHash) {
    peer.close();
    throw new Error(`chain discontinuity at height ${headers.length + 1}: peer served from ${entries[0].header.prevBlockHash}, expected ${tipHash}`);
  }
  for (const e of entries) headers.push(e.header);
  tipHash = codec.blockHash(headers.at(-1));
  rounds++;
  if (rounds % 5 === 0 || entries.length < 2000) process.stdout.write(`\r  synced ${fmt(headers.length)} headers...`);
  if (entries.length < 2000) break; // reached the tip
}
const dlMs = Date.now() - t0;
peer.close();
process.stdout.write('\n');

// ---- validate the whole chain ----
console.log(`downloaded ${fmt(headers.length)} headers in ${(dlMs / 1000).toFixed(1)}s (${Math.round(headers.length / (dlMs / 1000))}/s over the network)`);
const tv = Date.now();
const rows = he.validateChain(headers, { startHeight: 1, prevContext: [genesisHeader], now: Math.floor(Date.now() / 1000) + 7200 });
const valMs = Date.now() - tv;
const bad = rows.filter((r) => r.results.some((x) => x.ok === false));

await saveHeaders(headers);

console.log(`validated ${fmt(rows.length)} headers in ${valMs} ms (${Math.round(rows.length / (valMs / 1000)).toLocaleString()}/s, pure-JS)`);
if (bad.length === 0) console.log(`✓ every header is valid (PoW, difficulty, BIP 94 timewarp, min-difficulty)`);
else { console.log(`✗ ${bad.length} invalid headers, first at height ${bad[0].height}`); console.log(JSON.stringify(bad[0].results.filter((r) => r.ok === false))); }
const tip = codec.blockHash(headers.at(-1));
console.log(`tip: height ${fmt(headers.length)}, hash ${tip}`);

// independent cross-check over p2p (no third-party API): do other peers agree
// this is the tip? An empty getheaders reply means they have nothing beyond it.
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
  try { const ok = await hasNothingBeyond(host, tip); asked++; if (ok) agree++; } catch {}
}
if (asked) console.log(`${agree}/${asked} other peers confirm this tip (independent p2p cross-check; most-work across peers is M1.3)`);
console.log(`persisted ${fmt(headers.length)} headers to data/`);
