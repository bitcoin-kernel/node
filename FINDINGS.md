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

## The pure-JS wall, confirmed: full validation is infeasible on the flood

The full-validation audit got through **~51,500 blocks** (validating ~500k+
transactions, surfacing the three bugs above), then **stalled** on testnet4's
inscription/dust-flood stretch. Those blocks carry **~10k+ inputs each** (the
UTXO set churns by 100k+ per block as dust is consolidated), i.e. tens of
thousands of script/signature verifications per block. At the engine's pure-JS
**~248 verifies/sec**, a single flood block takes **>14 minutes**; the validator
made **zero progress across two consecutive 14-minute checks** on one such block.
A sustained run of these blocks would take **months**.

This is the concrete, final form of the performance finding: on real spam-era
data, **WASM-secp is not an optimization — it is the difference between
"completes" and "doesn't."** The remedy is the M0.1 path: a WASM-SIMD
libsecp256k1 with **batch verification** (the per-call WASM figure is already
~16x the pure-JS engine, and batching amortises the JS↔WASM boundary that
dominates). The architecture, storage, validation logic, and bug-finding all
work; the only thing standing between this and a completed full validation is
the crypto backend. A third engine bug (#62) and a validator robustness fix
(catch engine exceptions) came directly out of pushing it this far.

Bottom line: **~51.5k blocks fully validated, 3 engine bugs found and filed, the
whole chain archived (11.9 GB), and the WASM requirement proven on real data.**

## WASM secp integrated — the wall is gone

The remedy above is now implemented. The engine grew an injectable verify hook
(`setVerifyBackend`, additive, still zero-dependency); the node supplies a WASM
backend (`src/wasm-secp.js`) wrapping tiny-secp256k1 (libsecp256k1 compiled to
WebAssembly). Crucially this is **gated by a consensus-equivalence proof**: a
test (`test/wasm-secp.test.js`) runs Bitcoin Core's full `script_tests.json`
through the interpreter twice — once pure-JS, once WASM — and asserts every
verdict is identical. You do not swap consensus crypto on faith. It agrees on
every vector.

With the backend injected, the validator **resumed from the checkpoint (height
50,000) and walked straight through the ~51,500 stall** that pure-JS could not
move past in two consecutive 14-minute checks — reading every block offline from
the local archive (no network), no per-block hang. The crypto backend was the
only thing in the way, and it is now in place.

## Honest boundaries

- testnet4 only here (mainnet is a network-param flip; not run).
- The two engine bugs are in the engine (schema), not this repo; filed, not fixed.
- Public testnet4 peers don't serve compact filters (0/10), so the live wallet
  uses a verified p2p block scan; Electrum is the noted path for efficient SPV.
