// M0.1 benchmark: ECDSA (and Schnorr) signature-verification throughput, the
// number that gates the whole full-node story. Signatures dominate IBD cost.
//
//   pure JS   the engine's secp256k1.js (what bitcoin-kernel uses today)
//   WASM      tiny-secp256k1 (libsecp256k1 compiled to WebAssembly)
//
// Both verify the same (hash, signature, pubkey) triples, single core.
// Run: `node bench/secp-verify.js`
import { randomBytes } from 'node:crypto';
import * as wasm from 'tiny-secp256k1';
import { verifyEcdsa, verifySchnorr, parsePubkey } from '@bitcoin-desktop/schema/codec/secp256k1.js';

const big = (u8) => BigInt('0x' + Buffer.from(u8).toString('hex'));
const SAMPLES = 1000;

// --- generate valid triples with the WASM lib ---
const ecdsa = [];
const schnorr = [];
while (ecdsa.length < SAMPLES) {
  const priv = randomBytes(32);
  if (!wasm.isPrivate(priv)) continue;
  const msg = randomBytes(32);
  const pubC = wasm.pointFromScalar(priv, true);   // 33-byte compressed (WASM verify)
  const pubU = wasm.pointFromScalar(priv, false);  // 65-byte uncompressed (engine parse)
  const sig = wasm.sign(msg, priv);                // 64-byte compact
  ecdsa.push({ msg, sig, pubC, xy: parsePubkey(pubU), rs: { r: big(sig.subarray(0, 32)), s: big(sig.subarray(32, 64)) } });
  const xonly = wasm.xOnlyPointFromScalar(priv);   // 32-byte x-only (BIP340)
  const ssig = wasm.signSchnorr(msg, priv);
  schnorr.push({ msg, ssig, xonly });
}

// --- sanity: pure JS and WASM agree on the same inputs ---
const e0 = ecdsa[0];
if (!wasm.verify(e0.msg, e0.pubC, e0.sig)) throw new Error('WASM rejected a valid ECDSA sig');
if (!verifyEcdsa(e0.msg, e0.rs, e0.xy)) throw new Error('engine rejected a valid ECDSA sig');
const s0 = schnorr[0];
if (!wasm.verifySchnorr(s0.msg, s0.xonly, s0.ssig)) throw new Error('WASM rejected a valid Schnorr sig');
if (!verifySchnorr(s0.msg, s0.ssig, s0.xonly)) throw new Error('engine rejected a valid Schnorr sig');

const time = (rounds, fn) => {
  const t0 = process.hrtime.bigint();
  let ok = 0;
  for (let i = 0; i < rounds; i++) if (fn(i)) ok++;
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  return { rate: rounds / (ms / 1000), ok, rounds };
};

// warm up the JIT / WASM
time(2000, (i) => wasm.verify(ecdsa[i % SAMPLES].msg, ecdsa[i % SAMPLES].pubC, ecdsa[i % SAMPLES].sig));
time(1000, (i) => { const t = ecdsa[i % SAMPLES]; return verifyEcdsa(t.msg, t.rs, t.xy); });

const wEcdsa = time(40000, (i) => wasm.verify(ecdsa[i % SAMPLES].msg, ecdsa[i % SAMPLES].pubC, ecdsa[i % SAMPLES].sig));
const jEcdsa = time(4000, (i) => { const t = ecdsa[i % SAMPLES]; return verifyEcdsa(t.msg, t.rs, t.xy); });
const wSchnorr = time(40000, (i) => wasm.verifySchnorr(schnorr[i % SAMPLES].msg, schnorr[i % SAMPLES].xonly, schnorr[i % SAMPLES].ssig));
const jSchnorr = time(4000, (i) => { const t = schnorr[i % SAMPLES]; return verifySchnorr(t.msg, t.ssig, t.xonly); });

const r = (n) => Math.round(n).toLocaleString();
const SIGS = 2.5e9; // order-of-magnitude total signature verifications in Bitcoin's history
const ibd = (rate, cores) => { const s = SIGS / (rate * cores); return s < 3600 ? `${(s / 60).toFixed(0)} min` : `${(s / 3600).toFixed(1)} h`; };

console.log('ECDSA verify (single core):');
console.log(`  pure JS (engine)      ${r(jEcdsa.rate).padStart(9)} /s`);
console.log(`  WASM (libsecp256k1)   ${r(wEcdsa.rate).padStart(9)} /s   (${(wEcdsa.rate / jEcdsa.rate).toFixed(0)}x faster)`);
console.log('Schnorr verify (single core):');
console.log(`  pure JS (engine)      ${r(jSchnorr.rate).padStart(9)} /s`);
console.log(`  WASM (libsecp256k1)   ${r(wSchnorr.rate).padStart(9)} /s   (${(wSchnorr.rate / jSchnorr.rate).toFixed(0)}x faster)`);
console.log(`\nProjected full-chain signature work (~${SIGS / 1e9} billion ECDSA verifications):`);
console.log(`  pure JS, 1 core:      ${ibd(jEcdsa.rate, 1)}`);
console.log(`  WASM,    1 core:      ${ibd(wEcdsa.rate, 1)}`);
console.log(`  WASM,    8 cores:     ${ibd(wEcdsa.rate, 8)}`);
console.log(`  WASM,   24 cores:     ${ibd(wEcdsa.rate, 24)}`);
console.log(`\n(modeled: WASM here is generic tiny-secp256k1; a SIMD build + batch verify go further. Native libsecp ~1.5-2x faster than this WASM.)`);
