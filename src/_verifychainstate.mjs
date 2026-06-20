// Verify a saved chainstate snapshot: reload it from disk, recompute the SwiftSync
// commitment digest over the reloaded UTXO set, and assert it equals the trusted
// commitment. This is the assumeUTXO "is this snapshot the real thing?" check
// (issue #14, step 2). Single process, one core.

import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { ShardedUtxo } from './sharded-utxo.js';
import { Accumulator } from '../../kernel/packages/swiftsync/accumulator.js';
import { encodeOutpoint } from '../../kernel/packages/swiftsync/index.js';

const COMMITMENT = '85562fb9cee8b822f19c37473988fc23db71d5d84d503e4f9f15167c0a5a4716';
const FILE = new URL('../data/chainstate/utxo-140503.ndjson', import.meta.url);
const sha256 = (b) => new Uint8Array(createHash('sha256').update(b).digest());
const hex = (b) => Buffer.from(b).toString('hex');

console.log('reloading chainstate from disk...');
let t = performance.now();
const utxo = new ShardedUtxo(64);
const meta = await utxo.load(FILE);
const loadSec = (performance.now() - t) / 1000;
console.log(`reloaded ${utxo.size} coins in ${loadSec.toFixed(0)}s (meta says ${meta.count})`);

console.log('recomputing SwiftSync commitment digest over the reloaded set...');
t = performance.now();
const acc = new Accumulator({ sha256 });   // salt=null, matches the capstone
let n = 0;
for (const [key] of utxo.entries()) {
  const i = key.lastIndexOf(':');
  acc.add(encodeOutpoint({ txid: key.slice(0, i), vout: +key.slice(i + 1) }));
  if (++n % 2000000 === 0) console.log(`  ${n}/${utxo.size}`);
}
const digest = hex(acc.digest());
const digestSec = (performance.now() - t) / 1000;

const sizeOk = utxo.size === meta.count;
const match = digest === COMMITMENT;

console.log('\n──────────── chainstate verification ────────────');
console.log(`reloaded count    ${utxo.size}   ${sizeOk ? '✓ == file header' : '✗ MISMATCH'}`);
console.log(`reload time       ${loadSec.toFixed(0)}s    digest time ${digestSec.toFixed(0)}s`);
console.log(`recomputed digest ${digest}`);
console.log(`commitment        ${COMMITMENT}`);
console.log(match && sizeOk
  ? '\n✅ VERIFIED — the saved chainstate reloads intact and its digest matches the commitment.'
  : '\n❌ FAILED — snapshot does not match the commitment.');
process.exit(match && sizeOk ? 0 : 1);
