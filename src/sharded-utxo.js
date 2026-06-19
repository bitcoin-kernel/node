// A Map-compatible UTXO set sharded across N sub-Maps. A single V8 Map throws
// `RangeError: Map maximum size exceeded` past 2^24 (~16.7M) entries, and
// testnet4's UTXO set crosses that around height ~69k. Sharding by a hash of the
// outpoint key spreads entries across N maps (N x 16.7M capacity) while exposing
// the same get/set/delete/has/size/entries surface the engine uses.
import { createWriteStream } from 'node:fs';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

export class ShardedUtxo {
  constructor(shards = 64) {
    this.n = shards;
    this.maps = Array.from({ length: shards }, () => new Map());
  }

  _shard(k) {
    // cheap rolling hash over the first 16 chars (txid hex is uniformly random)
    let h = 0; const n = k.length < 16 ? k.length : 16;
    for (let i = 0; i < n; i++) h = (h * 31 + k.charCodeAt(i)) >>> 0;
    return h % this.n;
  }

  get(k) { return this.maps[this._shard(k)].get(k); }
  set(k, v) { this.maps[this._shard(k)].set(k, v); return this; }
  delete(k) { return this.maps[this._shard(k)].delete(k); }
  has(k) { return this.maps[this._shard(k)].has(k); }
  get size() { let s = 0; for (const m of this.maps) s += m.size; return s; }
  *entries() { for (const m of this.maps) yield* m.entries(); }
  *[Symbol.iterator]() { yield* this.entries(); }
  clear() { for (const m of this.maps) m.clear(); }

  // Stream the whole set to NDJSON (one [key,value] per line) — never builds a
  // >512MB string, so it survives a UTXO set far past V8's max string length.
  async save(url, meta = {}) {
    const ws = createWriteStream(url);
    const put = (s) => (ws.write(s) ? Promise.resolve() : new Promise((r) => ws.once('drain', r)));
    await put(JSON.stringify(meta) + '\n');
    let buf = '', c = 0;
    for (const e of this.entries()) { buf += JSON.stringify(e) + '\n'; if (++c % 10000 === 0) { await put(buf); buf = ''; } }
    if (buf) await put(buf);
    await new Promise((res) => ws.end(res));
  }

  // Load NDJSON written by save(); returns the meta header object.
  async load(url) {
    const rl = createInterface({ input: createReadStream(url), crlfDelay: Infinity });
    let meta = {}, first = true;
    for await (const line of rl) { if (!line) continue; if (first) { meta = JSON.parse(line); first = false; continue; } const [k, v] = JSON.parse(line); this.set(k, v); }
    return meta;
  }
}
