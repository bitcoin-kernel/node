# bitcoin-kernel / node

A browser-native Bitcoin node. Validate Bitcoin's consensus rules in a tab,
persist the chain to OPFS, and sync through a thin local bridge. Built on the
[bitcoin-kernel](https://github.com/bitcoin-kernel/bitcoin-kernel.github.io) engine.

**Status: planning.** See the [roadmap](../../issues/1).

## The idea: usable first, trustless later

Three resource tiers. Opt into more to trust less.

| Tier | Does | Cost | Device |
|---|---|---|---|
| 0 Lite | headers + Neutrino wallet (BIP 157/158) | ~100 MB, minutes | phone |
| 1 Validating | assumeutxo snapshot, validate new blocks live | a few GB | laptop |
| 2 Full | backfill genesis to tip, fully trustless | ~650 GB, lots of RAM | desktop |

## Pillars

- **Storage:** OPFS (synchronous access handles in a Web Worker).
- **Compute:** WASM-SIMD secp256k1 + Web Workers; the UTXO set lives in RAM, not a DB.
- **Networking:** a small local WebSocket-to-TCP bridge (a browser cannot open raw TCP).

Every milestone is gated by a benchmark. Honest target: usable in minutes via
assumeutxo, fully validated from genesis in an afternoon on commodity hardware.
Not an archival node, not a Bitcoin Core replacement.

Independent community project, not affiliated with Bitcoin Core.
