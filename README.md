# bitcoin-kernel / node

A browser-native Bitcoin node. Validate Bitcoin's consensus rules in a tab,
persist the chain to OPFS, and sync through a thin local bridge. Built on the
[bitcoin-kernel](https://github.com/bitcoin-kernel/bitcoin-kernel.github.io) engine.

**Status: early. The Tier 0 core runs in Node today (testnet4).** See the [roadmap](../../issues/1).

## Try it now (Node)

```sh
npm install
npm test                      # deterministic testnet4 consensus checks
npm run bench                 # header-validation throughput
node src/sync-testnet4.mjs    # live: sync + fully validate the testnet4 header chain
```

`sync-testnet4.mjs` connects to a real testnet4 peer over TCP, syncs the whole
header chain from genesis, fully validates it (proof of work, difficulty, the
BIP 94 timewarp fix, the 20-minute min-difficulty walk-back), persists it, and
checks the tip against a public explorer. Recent run: **140k headers downloaded
in ~3s, all validated, tip matched mempool.space/testnet4.** Header validation
on the pure-JS engine measures **~15k headers/sec** single-core.

The same flow runs in the browser over a WebSocket-to-TCP bridge; in Node it
uses a raw TCP socket (`src/peer.mjs`) so it runs and benchmarks directly.

## The idea: usable first, trustless later

Three resource tiers. Opt into more to trust less.

| Tier | Does | Cost | Device |
|---|---|---|---|
| 0 Lite | headers + Neutrino wallet (BIP 157/158) | ~100 MB, minutes | phone |
| 1 Validating | assumeutxo snapshot, validate new blocks live | a few GB | laptop |
| 2 Full | backfill genesis to tip, fully trustless | ~650 GB, lots of RAM | desktop |

## Pillars

- **Storage:** OPFS (synchronous access handles in a Web Worker). In Node, a flat file stands in.
- **Compute:** WASM-SIMD secp256k1 + Web Workers; the UTXO set lives in RAM, not a DB.
- **Networking:** a small local WebSocket-to-TCP bridge (a browser cannot open raw TCP).

Everything is built for both mainnet and testnet4 by passing the network; testnet4
is the default first target because it is small and exercises the trickiest
difficulty rules. Every milestone is gated by a benchmark.

Independent community project, not affiliated with Bitcoin Core.
