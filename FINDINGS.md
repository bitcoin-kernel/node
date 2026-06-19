# Findings: full-validation differential audit of testnet4

This documents what came out of running the node's pipeline against the live
testnet4 chain: download + archive every block over p2p, then fully validate
each one from disk and treat any consensus-rule failure as an engine bug to
catalogue (the chain is valid by definition, so a failure is a bug in us).

## Engine bugs found (both filed against the engine, bitcoin-desktop/schema)

1. **BIP34 `coinbase-height` for heights 1-16** — [schema#60](https://github.com/bitcoin-desktop/schema/issues/60).
   `bip34Height` only parses a length-prefixed push; heights 1-16 are pushed as
   OP_1..OP_16 (the minimal encoding), so it returns `null` and the rule fails on
   the first 16 blocks of any chain that enforces BIP34 from genesis (testnet4,
   regtest). Never seen on mainnet (BIP34 activates at 227,931, pre-activation
   the rule is skipped). Minor.

2. **BIP342 tapscript wrongly hitting the legacy 10 kB `MAX_SCRIPT_SIZE`** —
   [schema#61](https://github.com/bitcoin-desktop/schema/issues/61). **Consensus-critical.**
   The interpreter applies the legacy 10,000-byte script-size limit to Taproot
   script-path (tapscript) execution, but BIP342 removed it. So large Taproot
   inscription / DMT-mint spends are rejected as `"script too large"`. Pinned to
   testnet4 block 30,608 (a real DMT-mint inscription input); first occurrence at
   height 28,527. This would reject **valid mainnet inscription transactions** — a
   chain-splitting divergence. Fix: skip `MAX_SCRIPT_SIZE` (and the 201-opcode
   limit) for tapscript; it's bounded by block weight + the sigops budget instead.

Through 30,000+ blocks / ~500k transactions, these were the only two rule
failures — the engine otherwise agreed with the real chain on every rule.

## Performance reality (measured, not modeled)

The wall is pure-JS crypto, in two places:

- **Signature verification:** engine pure-JS secp ~**248 verify/s**; WASM
  (tiny-secp256k1) ~**3,840/s** (16x, but ~2.6x slower than the 10k/s the model
  assumed — per-call JS<->WASM marshalling dominates). Batch verify + a SIMD
  build are the real levers, not "just compile to WASM."
- **Hashing:** merkle-verifying the spam-era blocks (re-hashing every tx) is also
  pure-JS-bound. WASM is needed for SHA-256 too, not only secp.

Concrete: the early empty chain validates at thousands of blocks/sec; the
inscription-dense stretches drop to single digits. Full validation is an
overnight grind in pure JS — which is exactly the case for WASM.

## What works

- **Full chain archived:** ~140,503 blocks, **11.9 GB**, every block merkle-verified
  against a PoW-validated header, all over raw p2p (no explorer, no third party).
- **Full consensus validation from disk:** scripts, signatures, UTXO, every rule,
  reading blocks from the local BlockStore (network-decoupled).
- **Architecture is interface-first and headless-tested** (19 unit tests):
  `HeaderStore`/`HeaderSync` (resume + most-work reorg), `WalletScan`
  (Neutrino + verified p2p block scan), `BlockStore`.
- **Browser port drafted** behind the same interfaces: `OpfsHeaderStore`,
  `OpfsBlockStore`, `WsPeer` (the three swaps; the base `HeaderStore` is
  browser-safe). A browser node is now assembly, not new design.

## Honest boundaries

- testnet4 only here (mainnet is a network-param flip; not run).
- The two engine bugs are in the engine (schema), not this repo; filed, not fixed.
- Public testnet4 peers don't serve compact filters (0/10), so the live wallet
  uses a verified p2p block scan; Electrum is the noted path for efficient SPV.
