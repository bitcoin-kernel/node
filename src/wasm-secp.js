// WASM verify backend for the engine: delegates ECDSA/Schnorr verification to
// tiny-secp256k1 (libsecp256k1 compiled to WebAssembly), ~16x the pure-JS engine
// per call. Injected via the engine's setVerifyBackend() hook. The engine stays
// zero-dependency; only this node opts into the WASM dependency.
//
// Conversions: the engine passes ECDSA sig as {r,s} BigInts + pubkey as [x,y]
// BigInts; tiny wants a 64-byte compact sig + a 65-byte uncompressed key.
import * as wasm from 'tiny-secp256k1';

const b32 = (n) => { const b = new Uint8Array(32); let x = n; for (let i = 31; i >= 0; i--) { b[i] = Number(x & 0xffn); x >>= 8n; } return b; };

export const wasmBackend = {
  ecdsa(msgHash, sig, pubkey) {
    const pub = new Uint8Array(65); pub[0] = 4; pub.set(b32(pubkey[0]), 1); pub.set(b32(pubkey[1]), 33);
    const s = new Uint8Array(64); s.set(b32(sig.r), 0); s.set(b32(sig.s), 32);
    try { return wasm.verify(msgHash, pub, s); } catch { return false; }
  },
  schnorr(msg32, sig64, pubkey32) {
    try { return wasm.verifySchnorr(msg32, pubkey32, sig64); } catch { return false; }
  },
};
