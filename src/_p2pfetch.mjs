// Step 1 of #20: prove the node can self-source a block over its OWN P2P (no REST).
// Connect to a live testnet4 peer via the DNS seeds, getheaders from our tip, then
// getdata the next block by hash and verify it links to our tip. This is the fetch
// path the follow-loop will use instead of the mempool.space REST API.

import { readFile } from 'node:fs/promises';
import dns from 'node:dns/promises';
import { Codec } from '@bitcoin-desktop/schema/codec/codec.js';
import { P2pEngine } from '@bitcoin-desktop/schema/codec/p2p.js';
import { Peer } from './peer.js';
import { FileBlockStore } from './store/block-store.js';

const load = async (p) => JSON.parse(await readFile(new URL(import.meta.resolve('@bitcoin-desktop/schema/' + p)), 'utf8'));
const codec = new Codec(await load('schema/core.jsonld'), await load('schema/proof.jsonld'), await load('schema/p2p.jsonld'));
const chainSchema = await load('schema/chain.jsonld');
const params = chainSchema['@graph'].find((n) => n['@id'] === 'btc:testnet4');
const p2p = P2pEngine.fromSchemas(codec, await load('schema/p2p.jsonld'), chainSchema, 'btc:testnet4');

const SEEDS = ['seed.testnet4.bitcoin.sprovoost.nl', 'seed.testnet4.wiz.biz'];
const WITNESS_BLOCK = 0x40000002;
const shuffle = (a) => a.map((v) => [Math.random(), v]).sort((x, y) => x[0] - y[0]).map((x) => x[1]);
async function candidates() { const c = []; for (const s of SEEDS) { try { for (const ip of shuffle(await dns.resolve4(s)).slice(0, 12)) c.push(ip); } catch {} c.push(s); } return c; }
async function firstPeer() { const hosts = await candidates(); while (hosts.length) { const peer = new Peer(p2p, codec); const h = hosts.shift(); try { await peer.connect(h, params.port); console.log(`connected to ${h}`); return peer; } catch { peer.close(); } } throw new Error('no peer'); }

const bs = new FileBlockStore(new URL('../data/', import.meta.url), codec);
let tip = 0; while (bs.has(tip + 1)) tip++;
const tipHash = codec.blockHash(bs.get(tip).header);
console.log(`our tip: ${tip} = ${tipHash}`);

console.log('connecting to a testnet4 peer via DNS seeds…');
const peer = await firstPeer();

// getheaders from our tip
peer.send('getheaders', { version: 70016, blockLocator: [tipHash], hashStop: '0'.repeat(64) });
const hdrs = (await peer.waitFor(['headers'], 20000)).payload?.entries?.map((e) => e.header) ?? [];
console.log(`peer returned ${hdrs.length} headers above our tip`);
if (!hdrs.length) { console.log('peer has no headers past our tip — done'); peer.close(); process.exit(0); }

const nextHeader = hdrs[0];
const nextHash = codec.blockHash(nextHeader);
console.log(`next header ${tip + 1} = ${nextHash}  links=${nextHeader.prevBlockHash === tipHash}`);

// getdata the block by hash
peer.send('getdata', { items: [{ type: WITNESS_BLOCK, hash: nextHash }] });
const block = (await peer.waitFor(['block'], 30000)).payload;
const fetchedHash = codec.blockHash(block.header);
const merkle = codec.merkleRoot(block.transactions.map((t) => codec.txid(t)));
peer.close();

console.log(`\nfetched block over P2P: ${block.transactions.length} txs`);
console.log(`  hash       ${fetchedHash}  ${fetchedHash === nextHash ? '✓ == header' : '✗'}`);
console.log(`  prev       ${block.header.prevBlockHash}  ${block.header.prevBlockHash === tipHash ? '✓ links to our tip' : '✗'}`);
console.log(`  merkle     ${merkle === block.header.merkleRoot ? '✓ matches header' : '✗'}`);
const ok = fetchedHash === nextHash && block.header.prevBlockHash === tipHash && merkle === block.header.merkleRoot;
console.log(ok ? '\n✅ node self-sourced a block over P2P (connect → getheaders → getdata), verified.' : '\n❌ verification failed');
process.exit(ok ? 0 : 1);
