// Worker-thread pool for parallel secp256k1 signature verification, plus a
// "deferring" verify backend that records checks instead of running them inline.
//
// Usage (Bitcoin Core CCheckQueue pattern, made self-correcting by the caller):
//   const pool = new VerifyPool();
//   const defer = makeDeferBackend();
//   setVerifyBackend(defer.backend);          // phase 1: validate, records checks
//   ...validateBlockContext(block)...          // returns optimistic (all-true) scripts
//   const recs = defer.take();                 // every (msg,sig,pubkey) for the block
//   const ok = await pool.verifyAll(recs);     // phase 2: verify in parallel
//   if (!ok) { /* phase 3: re-validate inline with the real backend (authority) */ }
//
// Correctness: the backend returns true optimistically, so the block's scripts
// only "pass" the fast path if EVERY recorded signature actually verifies. On a
// valid chain all real results are true, so optimistic == real. Any false (a bad
// signature, or an optimistic multisig mis-pairing) forces the inline re-check.
import { Worker } from 'node:worker_threads';
import os from 'node:os';

const REC = 162;
const POOL_SIZE = Math.max(1, Math.min(16, (os.cpus()?.length || 4) - 2));

const b32 = (n) => { const b = new Uint8Array(32); let x = n; for (let i = 31; i >= 0; i--) { b[i] = Number(x & 0xffn); x >>= 8n; } return b; };

// A deferring verify backend: instead of verifying, packs each check into a
// 162-byte record and returns true. take() drains and returns the records.
export function makeDeferBackend() {
  let recs = [];
  const backend = {
    ecdsa(msgHash, sig, pubkey) {
      const r = new Uint8Array(REC);
      r[0] = 1; r.set(msgHash, 1);
      r.set(b32(sig.r), 33); r.set(b32(sig.s), 65);
      r[97] = 0x04; r.set(b32(pubkey[0]), 98); r.set(b32(pubkey[1]), 130);
      recs.push(r); return true;
    },
    schnorr(msg32, sig64, pubkey32) {
      const r = new Uint8Array(REC);
      r[0] = 2; r.set(msg32, 1); r.set(sig64, 33); r.set(pubkey32, 97);
      recs.push(r); return true;
    },
  };
  return { backend, take() { const all = recs; recs = []; return all; } };
}

export class VerifyPool {
  constructor() {
    this.workers = Array.from({ length: POOL_SIZE }, () =>
      new Worker(new URL('./verify-worker.js', import.meta.url)));
    this.size = POOL_SIZE;
  }

  // Verify an array of 162-byte records across the pool. Returns true iff every
  // signature verified. Splits the work into one chunk per worker.
  async verifyAll(recs) {
    const count = recs.length;
    if (count === 0) return true;
    const packed = new Uint8Array(count * REC);
    for (let i = 0; i < count; i++) packed.set(recs[i], i * REC);

    const per = Math.ceil(count / this.size);
    const jobs = [];
    for (let wi = 0, lo = 0; wi < this.size && lo < count; wi++, lo += per) {
      const hi = Math.min(count, lo + per);
      const chunk = packed.slice(lo * REC, hi * REC); // own buffer, transferable
      const worker = this.workers[wi];
      jobs.push(new Promise((resolve) => {
        const onMsg = (out) => { cleanup(); resolve(out); };
        const onErr = () => { cleanup(); resolve(null); }; // worker died -> can't trust; force inline recheck
        const cleanup = () => { worker.off('message', onMsg); worker.off('error', onErr); };
        worker.once('message', onMsg);
        worker.once('error', onErr);
        worker.postMessage(chunk, [chunk.buffer]);
      }));
    }
    const parts = await Promise.all(jobs);
    for (const out of parts) { if (!out) return false; for (let i = 0; i < out.length; i++) if (out[i] === 0) return false; }
    return true;
  }

  async close() { await Promise.all(this.workers.map((w) => w.terminate())); }
}
