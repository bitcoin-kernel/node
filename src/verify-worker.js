// Worker thread: verifies a batch of secp256k1 signature checks with WASM
// libsecp256k1 (tiny-secp256k1). Receives a packed, transferable ArrayBuffer of
// fixed-size records, verifies each, and posts back a Uint8Array of 0/1 results
// (also transferable — zero-copy both ways).
//
// Record layout (162 bytes): [0]=type (1=ecdsa, 2=schnorr),
//   [1..33)=msg32, [33..97)=sig64, [97..162)=pubkey (65B ecdsa / 32B schnorr).
import { parentPort } from 'node:worker_threads';
import * as wasm from 'tiny-secp256k1';

const REC = 162;

parentPort.on('message', (buf) => {
  const u = new Uint8Array(buf);
  const count = (u.length / REC) | 0;
  const out = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    const o = i * REC;
    try {
      const msg = u.subarray(o + 1, o + 33);
      const sig = u.subarray(o + 33, o + 97);
      if (u[o] === 1) out[i] = wasm.verify(msg, u.subarray(o + 97, o + 162), sig) ? 1 : 0;
      else out[i] = wasm.verifySchnorr(msg, u.subarray(o + 97, o + 129), sig) ? 1 : 0;
    } catch { out[i] = 0; }
  }
  parentPort.postMessage(out, [out.buffer]);
});
