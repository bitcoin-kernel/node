// Native SHA-256 backend for the engine: delegates to Node's crypto (OpenSSL,
// hardware SHA-NI when available) — multi-GB/s vs the pure-JS engine's tens of
// MB/s. Injected via the engine's setSha256Backend() hook. The engine stays
// zero-dependency; only this node opts into the native hasher.
//
// On the inscription-flood blocks the residual cost (after the WASM secp swap)
// is SHA-256: each block hashes thousands of inputs' worth of sighash + merkle
// data. This makes that linear cost cheap.
import { createHash } from 'node:crypto';

export const nativeSha256 = (data) => new Uint8Array(createHash('sha256').update(data).digest());
