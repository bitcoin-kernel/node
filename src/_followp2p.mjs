// Follow the chain over the node's OWN P2P (no REST API). Bootstrap the UTXO set
// from the snapshot, then drive following off getheaders: send a back-off locator,
// the peer returns headers from our most-recent common ancestor — which gives us
// both new blocks (catch-up / tip) and reorgs (first header builds below our tip).
// getdata each block by hash, validate forward, connect (with undo), advance.
// Reorg-aware down to the snapshot height.

import { performance } from 'node:perf_hooks';
import { readFile } from 'node:fs/promises';
import dns from 'node:dns/promises';
import { Codec } from '@bitcoin-desktop/schema/codec/codec.js';
import { P2pEngine } from '@bitcoin-desktop/schema/codec/p2p.js';
import { BlockEngine } from '@bitcoin-desktop/schema/codec/blocks.js';
import { setVerifyBackend } from '@bitcoin-desktop/schema/codec/secp256k1.js';
import { setSha256Backend } from '@bitcoin-desktop/schema/codec/hash.js';
import { wasmBackend } from './wasm-secp.js';
import { nativeSha256 } from './sha256-native.js';
import { Peer } from './peer.js';
import { FileBlockStore } from './store/block-store.js';
import { ShardedUtxo } from './sharded-utxo.js';

const load = async (p) => JSON.parse(await readFile(new URL(import.meta.resolve('@bitcoin-desktop/schema/' + p)), 'utf8'));
const codec = new Codec(await load('schema/core.jsonld'), await load('schema/proof.jsonld'), await load('schema/p2p.jsonld'));
const chainSchema = await load('schema/chain.jsonld');
const params = chainSchema['@graph'].find((n) => n['@id'] === 'btc:testnet4');
const p2p = P2pEngine.fromSchemas(codec, await load('schema/p2p.jsonld'), chainSchema, 'btc:testnet4');
const be = BlockEngine.fromSchemas(codec, chainSchema, await load('schema/validate.jsonld'), await load('schema/script.jsonld'), 'btc:testnet4');
setVerifyBackend(wasmBackend);
setSha256Backend(nativeSha256);

const SEEDS = ['seed.testnet4.bitcoin.sprovoost.nl', 'seed.testnet4.wiz.biz'];
const WITNESS_BLOCK = 0x40000002;
const UNDO_DEPTH = 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shuffle = (a) => a.map((v) => [Math.random(), v]).sort((x, y) => x[0] - y[0]).map((x) => x[1]);
async function candidates() { const c = []; for (const s of SEEDS) { try { for (const ip of shuffle(await dns.resolve4(s)).slice(0, 12)) c.push(ip); } catch {} c.push(s); } return c; }

let peer = null;
async function connectPeer() { const hosts = await candidates(); while (hosts.length) { const p = new Peer(p2p, codec); const h = hosts.shift(); try { await p.connect(h, params.port); console.log(`peer: ${h}`); return p; } catch { p.close(); } } throw new Error('no peer'); }
async function ensurePeer() { if (!peer || peer.closed) peer = await connectPeer(); return peer; }
async function getHeaders(locator) { await ensurePeer(); peer.send('getheaders', { version: 70016, blockLocator: locator, hashStop: '0'.repeat(64) }); return (await peer.waitFor(['headers'], 20000)).payload?.entries?.map((e) => e.header) ?? []; }
async function getBlock(hash) { await ensurePeer(); peer.send('getdata', { items: [{ type: WITNESS_BLOCK, hash }] }); return (await peer.waitFor(['block'], 30000)).payload; }

// bootstrap
const bs = new FileBlockStore(new URL('../data/', import.meta.url), codec);
const bootstrapHeight = (() => { let t = 0; while (bs.has(t + 1)) t++; return t; })();
const bootstrapHash = codec.blockHash(bs.get(bootstrapHeight).header);
let tip = bootstrapHeight, tipHash = bootstrapHash;
console.log(`bootstrapping from snapshot at height ${tip}…`);
const snap = new ShardedUtxo(64);
await snap.load(new URL(`../data/chainstate/utxo-${tip}.ndjson`, import.meta.url));
const parse = (v) => { const a = v.indexOf('\t'), b = v.indexOf('\t', a + 1), c = v.lastIndexOf('\t'); return { output: { value: Number(v.slice(0, a)), scriptPubKey: v.slice(a + 1, b) }, height: Number(v.slice(b + 1, c)), coinbase: v.slice(c + 1) === '1' }; };
const view = { get: (k) => { const v = snap.get(k); return v === undefined ? undefined : parse(v); }, has: (k) => snap.has(k), get size() { return snap.size; } };
console.log(`coin view ready — ${view.size} coins at height ${tip} (${tipHash.slice(0, 16)}…)`);

const undo = new Map();                  // height -> { hash, created:[key], spent:[[key, rec]] }
const hashHeight = new Map([[bootstrapHash, bootstrapHeight]]);
function connect(block, height) {
  const created = [], spent = [];
  block.transactions.forEach((tx, i) => {
    if (i > 0) for (const inp of tx.inputs) { const key = `${inp.prevout.txid}:${inp.prevout.vout}`; const rec = snap.get(key); if (rec !== undefined) { spent.push([key, rec]); snap.delete(key); } }
    const txid = codec.txid(tx);
    tx.outputs.forEach((o, vout) => { if (!o.scriptPubKey.startsWith('6a')) { const key = `${txid}:${vout}`; snap.set(key, `${o.value}\t${o.scriptPubKey}\t${height}\t${i === 0 ? 1 : 0}`); created.push(key); } });
  });
  const hash = codec.blockHash(block.header);
  undo.set(height, { hash, created, spent }); hashHeight.set(hash, height);
  const old = undo.get(height - UNDO_DEPTH); if (old) { hashHeight.delete(old.hash); undo.delete(height - UNDO_DEPTH); }
  return { created: created.length, spent: spent.length };
}
function disconnect(height) { const u = undo.get(height); for (const [key, rec] of u.spent) snap.set(key, rec); for (const key of u.created) snap.delete(key); hashHeight.delete(u.hash); undo.delete(height); }

function locator() { const loc = []; let h = tip, step = 1, n = 0; while (h > bootstrapHeight) { const hh = (h === bootstrapHeight) ? bootstrapHash : undo.get(h)?.hash; if (hh) loc.push(hh); if (++n >= 10) step *= 2; h -= step; } loc.push(bootstrapHash); return loc; }

const t0 = performance.now(); let done = 0, announced = false;
while (true) {
  let headers;
  try { headers = await getHeaders(locator()); }
  catch (e) { console.log(`getheaders error (${e.message}) — reconnecting`); if (peer) peer.close(); peer = null; await sleep(3000); continue; }

  if (!headers.length) {                 // at the peer's tip
    if (!announced) { console.log(`\n✅ at the chain tip ${tip}. following over P2P — polling every 30s…`); announced = true; }
    await sleep(30000); continue;
  }
  announced = false;

  // reorg? first header builds on our common ancestor, which may be below tip
  const forkPrev = headers[0].prevBlockHash;
  if (forkPrev !== tipHash) {
    const forkHeight = hashHeight.get(forkPrev);
    if (forkHeight == null) { console.log(`\n⛔ reorg deeper than ${UNDO_DEPTH}-block undo — re-bootstrap needed. stopping.`); break; }
    let depth = 0; while (tip > forkHeight) { disconnect(tip); tip--; depth++; }
    tipHash = forkPrev;
    console.log(`\n⟲ reorg: forked at ${forkHeight} (disconnected ${depth} orphaned block${depth === 1 ? '' : 's'}), reconnecting canonical chain…`);
  }

  for (const header of headers) {
    if (header.prevBlockHash !== tipHash) break;   // batch boundary / next getheaders
    const h = tip + 1, hash = codec.blockHash(header);
    let block;
    try { block = await getBlock(hash); }
    catch (e) { console.log(`h ${h}: getblock error (${e.message}) — reconnecting`); if (peer) peer.close(); peer = null; await sleep(3000); break; }
    if (codec.merkleRoot(block.transactions.map((t) => codec.txid(t))) !== block.header.merkleRoot) { console.log(`\n❌ block ${h} merkle mismatch — stopping`); process.exit(1); }
    const failed = [...be.validateBlockStructure(block).results, ...be.validateBlockContext(block, { height: h, utxo: view }).results].filter((r) => r.ok === false);
    if (failed.length) { console.log(`\n❌ block ${h} INVALID: ${failed.map((f) => f.rule).join(', ')} — stopping`); process.exit(1); }
    const { created, spent } = connect(block, h);
    tip = h; tipHash = hash; done++;
    const rate = done / ((performance.now() - t0) / 1000);
    console.log(`h ${h}  ${hash.slice(0, 12)}…  txs ${String(block.transactions.length).padStart(4)}  +${created} -${spent}  utxo ${view.size}  ${rate.toFixed(1)} blk/s`);
  }
}
