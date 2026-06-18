// Benchmark: header-chain validation throughput on the pure-JS engine.
// This measures the cheap part (PoW + difficulty + timewarp + min-difficulty
// walk-back), with no signatures. It is a real datapoint for the perf model:
// headers/sec sets the floor for Tier 0 (headers-first) sync.
// Run: `npm run bench`.
import { readFile } from 'node:fs/promises';
import { Codec } from '@bitcoin-desktop/schema/codec/codec.js';
import { HeaderEngine } from '@bitcoin-desktop/schema/codec/headers.js';

const load = async (p) => JSON.parse(await readFile(new URL(import.meta.resolve('@bitcoin-desktop/schema/' + p)), 'utf8'));
const codec = new Codec(await load('schema/core.jsonld'), await load('schema/proof.jsonld'));
const chainSchema = await load('schema/chain.jsonld');
const validateSchema = await load('schema/validate.jsonld');
const t4 = await load('test/vectors/testnet4.json');
const engine = HeaderEngine.fromSchemas(codec, chainSchema, validateSchema, 'btc:testnet4');

const headers = t4.run.headers.map((h) => codec.decode('BlockHeader', h));
const opts = { startHeight: t4.run.startHeight + 11, prevContext: headers.slice(0, 11), now: headers.at(-1).time + 7200 };
const batch = headers.slice(11);

// warm up the JIT
for (let i = 0; i < 20; i++) engine.validateChain(batch, opts);

const ROUNDS = 2000;
let validated = 0;
const t0 = process.hrtime.bigint();
for (let i = 0; i < ROUNDS; i++) validated += engine.validateChain(batch, opts).length;
const ms = Number(process.hrtime.bigint() - t0) / 1e6;
const perSec = validated / (ms / 1000);

console.log(`header validation (testnet4, incl. min-difficulty walk-back, no signatures):`);
console.log(`  ${validated.toLocaleString()} headers in ${ms.toFixed(0)} ms`);
console.log(`  ${Math.round(perSec).toLocaleString()} headers/sec (pure-JS engine, single core)`);
console.log(`  => a ~100k-header testnet4 chain validates in ~${(100000 / perSec * 1000).toFixed(0)} ms of CPU`);
console.log(`  => mainnet's ~900k headers in ~${(900000 / perSec).toFixed(1)} s of CPU`);
