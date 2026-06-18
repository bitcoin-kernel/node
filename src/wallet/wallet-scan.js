// WalletScan: a Neutrino-style (BIP 157/158) light wallet. Given a set of
// scriptPubKeys to watch, it scans block ranges by their compact filters,
// downloads only the blocks that might touch the wallet, and builds a UTXO set,
// balance, and history from them.
//
// Platform-agnostic, like HeaderSync: it depends only on the codec, a GcsFilter,
// and three transport-agnostic fetchers, so the same object runs in Node (TCP
// peer) and the browser (WS bridge):
//   headerHashAt(height) -> block hash (from the validated HeaderStore)
//   fetchFilter(blockHash) -> Uint8Array | null   (a BIP 158 cfilter)
//   fetchBlock(blockHash) -> raw block hex          (only for matched blocks)
//
// The filter match is probabilistic (false positives are possible), so every
// candidate block is fetched and checked exactly. False positives cost a block
// download, never correctness.
import { hexToBytes } from '@bitcoin-desktop/schema/codec/hash.js';

export class WalletScan {
  constructor(codec, gcsFilter) {
    this.codec = codec;
    this.gcs = gcsFilter;
    this.watch = new Set();          // scriptPubKey hex (lowercase)
    this.utxos = new Map();          // "txid:vout" -> { script, value, height }
    this.history = [];               // { height, txid, type: 'recv'|'spend', value }
  }

  watchScript(hex) { this.watch.add(hex.toLowerCase()); return this; }
  get balance() { let b = 0n; for (const u of this.utxos.values()) b += BigInt(u.value); return b; }

  async scan({ from, to, headerHashAt, fetchFilter, fetchBlock, onMatch } = {}) {
    const targets = [...this.watch].map((h) => hexToBytes(h));
    let candidates = 0, touched = 0;
    for (let h = from; h <= to; h++) {
      const blockHash = await headerHashAt(h);
      if (!blockHash) continue;
      const filterBytes = await fetchFilter(blockHash);
      if (!filterBytes) continue;
      const key = this.gcs.keyFor(blockHash);
      if (!this.gcs.matchAny(key, filterBytes, targets)) continue;
      candidates++;
      const got = await fetchBlock(blockHash);
      const block = got && got.transactions ? got : this.codec.decode('Block', got);
      const hit = this.#applyBlock(block, h);
      if (hit) { touched++; onMatch?.({ height: h, blockHash, ...hit }); }
    }
    return { candidates, touched, balance: this.balance, utxos: this.utxos.size };
  }

  #applyBlock(block, height) {
    let recv = 0, spent = 0;
    for (const tx of block.transactions) {
      const txid = this.codec.txid(tx);
      for (const inp of tx.inputs) {
        const k = inp.prevout.txid + ':' + inp.prevout.vout;
        if (this.utxos.has(k)) {
          const u = this.utxos.get(k);
          this.utxos.delete(k);
          this.history.push({ height, txid, type: 'spend', value: u.value });
          spent++;
        }
      }
      tx.outputs.forEach((out, vout) => {
        if (this.watch.has(String(out.scriptPubKey).toLowerCase())) {
          this.utxos.set(txid + ':' + vout, { script: out.scriptPubKey, value: out.value, height });
          this.history.push({ height, txid, type: 'recv', value: out.value });
          recv++;
        }
      });
    }
    return recv || spent ? { recv, spent } : null;
  }
}
