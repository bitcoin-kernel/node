// assumeUTXO "validate forward": load the saved snapshot as a coin view, fetch the
// next real block above our tip from the live testnet4 network, verify it links to
// our tip, then fully validate it forward against the snapshot (prevout resolution,
// scripts/signatures, fees, maturity). The untrusted source is fine — we verify the
// block links to our own validated tip and validate it ourselves.

import { performance } from 'node:perf_hooks';
import { readFile } from 'node:fs/promises';
import { Codec } from '@bitcoin-desktop/schema/codec/codec.js';
import { BlockEngine } from '@bitcoin-desktop/schema/codec/blocks.js';
import { setVerifyBackend } from '@bitcoin-desktop/schema/codec/secp256k1.js';
import { setSha256Backend } from '@bitcoin-desktop/schema/codec/hash.js';
import { wasmBackend } from './wasm-secp.js';
import { nativeSha256 } from './sha256-native.js';
import { FileBlockStore } from './store/block-store.js';
import { ShardedUtxo } from './sharded-utxo.js';

const load = async (p) => JSON.parse(await readFile(new URL(import.meta.resolve('@bitcoin-desktop/schema/' + p)), 'utf8'));
const codec = new Codec(await load('schema/core.jsonld'), await load('schema/proof.jsonld'));
const be = BlockEngine.fromSchemas(codec, await load('schema/chain.jsonld'), await load('schema/validate.jsonld'), await load('schema/script.jsonld'), 'btc:testnet4');
setVerifyBackend(wasmBackend);
setSha256Backend(nativeSha256);

const NULL_TXID = '00'.repeat(32);
const API = 'https://mempool.space/testnet4/api';
const mark = (r) => r.ok === true ? '✓' : r.ok === false ? '✗ FAIL' : '– skip';

// our validated tip
const bs = new FileBlockStore(new URL('../data/', import.meta.url), codec);
let tip = 0; while (bs.has(tip + 1)) tip++;
const tipHash = codec.blockHash(bs.get(tip).header);
console.log(`our tip: block ${tip} = ${tipHash}`);

// load the snapshot as a coin view (parse the compact record on get)
console.log('loading snapshot as coin view...');
let t = performance.now();
const snap = new ShardedUtxo(64);
await snap.load(new URL(`../data/chainstate/utxo-${tip}.ndjson`, import.meta.url));
const coinview = {
  get(key) {
    const v = snap.get(key);
    if (v === undefined) return undefined;
    const t1 = v.indexOf('\t'), t2 = v.indexOf('\t', t1 + 1), t3 = v.lastIndexOf('\t');
    return { output: { value: Number(v.slice(0, t1)), scriptPubKey: v.slice(t1 + 1, t2) }, height: Number(v.slice(t2 + 1, t3)), coinbase: v.slice(t3 + 1) === '1' };
  },
};
console.log(`coin view ready in ${((performance.now() - t) / 1000).toFixed(0)}s — ${snap.size} coins`);

// fetch the next real block from the live network
const NEXT = tip + 1;
const hash = (await (await fetch(`${API}/block-height/${NEXT}`)).text()).trim();
const meta = await (await fetch(`${API}/block/${hash}`)).json();
const raw = Buffer.from(await (await fetch(`${API}/block/${hash}/raw`)).arrayBuffer());
const block = codec.decode('Block', raw.toString('hex'));
console.log(`\nfetched block ${NEXT} = ${hash}\n  ${raw.length} bytes, ${block.transactions.length} txs`);

// 1) linkage — does it build on OUR tip? (untrusted source, verified)
const links = meta.previousblockhash === tipHash;
console.log(`\nlinkage: prev = ${meta.previousblockhash}\n  ${links ? '✓ builds on our tip' : '✗ does NOT link to our tip (reorg / non-canonical) — aborting'}`);
if (!links) process.exit(1);

// 2) how many of its inputs resolve against OUR snapshot (the payoff)
let inputs = 0, fromSnapshot = 0, fromThisBlock = 0;
const createdHere = new Set();
for (const tx of block.transactions) {
  const txid = codec.txid(tx);
  for (let v = 0; v < tx.outputs.length; v++) createdHere.add(`${txid}:${v}`);
  for (const inp of tx.inputs) {
    if (inp.prevout.txid === NULL_TXID) continue;
    inputs++;
    const key = `${inp.prevout.txid}:${inp.prevout.vout}`;
    if (coinview.get(key)) fromSnapshot++; else if (createdHere.has(key)) fromThisBlock++;
  }
}
console.log(`\nprevout resolution: ${inputs} spends — ${fromSnapshot} from the snapshot, ${fromThisBlock} created in this block, ${inputs - fromSnapshot - fromThisBlock} unresolved`);

// 3) full forward validation against the coin view
console.log('\nstructure:');
for (const r of be.validateBlockStructure(block).results) console.log(`  ${mark(r)}  ${r.rule}`);
console.log('context (resolved against the snapshot):');
const ctx = be.validateBlockContext(block, { height: NEXT, utxo: coinview });
for (const r of ctx.results) console.log(`  ${mark(r)}  ${r.rule}`);

const failed = ctx.results.filter((r) => r.ok === false).length;
console.log(failed === 0
  ? `\n✅ block ${NEXT} validated forward against the snapshot — no rule failed. The bootstrapped node is live and accepting new blocks.`
  : `\n❌ ${failed} rule(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
