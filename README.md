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
node src/sync-testnet4.js     # live: sync + fully validate the testnet4 header chain
```

`sync-testnet4.js` connects to a real testnet4 peer over TCP, syncs the header
chain, fully validates it incrementally (proof of work, difficulty, the BIP 94
timewarp fix, the 20-minute min-difficulty walk-back), handles reorgs by the
most-work rule, persists it, **resumes** from disk on the next run, and
cross-checks the tip against other p2p peers (never a third-party explorer).
Recent run: **140k headers, all validated, persisted; a resume completed in
0.3s.** Header validation measures **~15-21k headers/sec** on the pure-JS engine.

## Headless and browser-ready by design

The platform-specific pieces are interfaces, so the core logic is pure and
proven headless before it ever touches a browser:

- `src/store/header-store.js` — the `HeaderStore` interface with
  `MemoryHeaderStore` (tests) and `FileHeaderStore` (Node). The browser adds
  `OpfsHeaderStore` with the same logic over an OPFS sync access handle.
- `src/chain/header-sync.js` — `HeaderSync`, a platform-agnostic engine that
  resumes, validates each header, and reorgs by most-work. It depends only on
  the store interface, the engine, and a transport-agnostic `fetchHeaders(locator)`.

So the browser node is two swaps: `FileHeaderStore` → `OpfsHeaderStore`, and the
TCP `Peer` → a WS-bridge `Peer`. Everything else is the same code, covered by
headless unit tests (`npm test`).

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
