// BlockStore: archive full blocks on disk, keyed by height. Same interface idea
// as HeaderStore — Node `FileBlockStore` now, `OpfsBlockStore` (browser) later.
// Blocks are stored as raw serialized bytes, sharded into directories of 10,000.
import { writeFileSync, mkdirSync, readFileSync, statSync } from 'node:fs';

export class FileBlockStore {
  constructor(dir, codec) {
    this.dir = dir;          // a URL like data/
    this.codec = codec;
    this._mkdirs = new Set();
  }
  #path(h) { return new URL(`blocks/${Math.floor(h / 10000)}/${h}.bin`, this.dir); }
  #ensureShard(h) { const d = new URL(`blocks/${Math.floor(h / 10000)}/`, this.dir); const key = d.href; if (!this._mkdirs.has(key)) { mkdirSync(d, { recursive: true }); this._mkdirs.add(key); } }

  has(h) { try { statSync(this.#path(h)); return true; } catch { return false; } }
  putSync(h, block) { this.#ensureShard(h); writeFileSync(this.#path(h), Buffer.from(this.codec.encodeHex('Block', block), 'hex')); }
  get(h) { try { return this.codec.decode('Block', readFileSync(this.#path(h)).toString('hex')); } catch { return null; } }
  sizeOf(h) { try { return statSync(this.#path(h)).size; } catch { return 0; } }
}
