// HeaderStore: the storage interface the sync engine depends on. The base class
// and the index are browser-safe (no Node imports); only FileHeaderStore touches
// node:fs, lazily, so this module imports cleanly in the browser too.
//
//   MemoryHeaderStore  in-memory only (tests)
//   FileHeaderStore    a flat 80-byte-per-header file (Node)
//   OpfsHeaderStore    the same logic over an OPFS sync access handle (browser),
//                      in ./opfs-header-store.js
//
// Heights: genesis is height 0 (known from params, not stored on disk); storage
// holds heights 1..N as raw 80-byte headers back to back.
import { hexToBytes, bytesToHex } from '@bitcoin-desktop/schema/codec/hash.js';

export class HeaderStore {
  constructor(codec, headerEngine, genesisHeader) {
    this.codec = codec;
    this.he = headerEngine;
    this.genesis = genesisHeader;
    this.genesisHash = codec.blockHash(genesisHeader);
    this._h = [];                                    // headers for heights 1..N
    this._byHash = new Map([[this.genesisHash, 0]]);
    this._work = [headerEngine.work(genesisHeader)]; // cumulative work, index = height
  }

  get height() { return this._h.length; }
  tipHash() { return this.height ? this.codec.blockHash(this._h[this.height - 1]) : this.genesisHash; }
  tip() { const h = this.height; return { height: h, hash: this.tipHash(), header: h ? this._h[h - 1] : this.genesis }; }
  heightOf(hash) { return this._byHash.has(hash) ? this._byHash.get(hash) : null; }
  headerAt(height) { if (height === 0) return this.genesis; return height >= 1 && height <= this.height ? this._h[height - 1] : null; }
  cumWorkAt(height) { return this._work[height] ?? 0n; }

  // A block locator: tip, then exponentially-spaced ancestors, ending at genesis.
  locator() {
    const locs = [];
    let step = 1;
    for (let n = this.height; n >= 1; n -= step) {
      locs.push(this.codec.blockHash(this._h[n - 1]));
      if (locs.length >= 10) step *= 2;
    }
    locs.push(this.genesisHash);
    return locs;
  }

  // Append already-validated headers that connect at startHeight - 1.
  append(headers, startHeight) {
    if (startHeight !== this.height + 1) throw new Error(`append gap: expected ${this.height + 1}, got ${startHeight}`);
    for (const hdr of headers) {
      this._h.push(hdr);
      const h = this._h.length;
      this._byHash.set(this.codec.blockHash(hdr), h);
      this._work.push(this._work[h - 1] + this.he.work(hdr));
    }
    this._dirty = true;
  }

  // Drop everything above `height` (reorg rollback).
  truncate(height) {
    for (let h = this.height; h > height; h--) this._byHash.delete(this.codec.blockHash(this._h[h - 1]));
    this._h.length = height;
    this._work.length = height + 1;
    this._dirty = true;
  }

  // Rebuild the index from a raw header buffer (used by persistent backends).
  _ingestBytes(bytes) {
    for (let i = 0; i + 80 <= bytes.length; i += 80) {
      const hdr = this.codec.decode('BlockHeader', bytesToHex(bytes.subarray(i, i + 80)));
      this._h.push(hdr);
      const h = this._h.length;
      this._byHash.set(this.codec.blockHash(hdr), h);
      this._work.push(this._work[h - 1] + this.he.work(hdr));
    }
  }
  _toBytes() { return hexToBytes(this._h.map((h) => this.codec.encodeHex('BlockHeader', h)).join('')); }

  async load() {}   // override
  async flush() {}  // override
}

export class MemoryHeaderStore extends HeaderStore {}

export class FileHeaderStore extends HeaderStore {
  constructor(codec, headerEngine, genesisHeader, path) {
    super(codec, headerEngine, genesisHeader);
    this.path = path;
  }
  async load() {
    const { readFile } = await import('node:fs/promises');
    try { this._ingestBytes(new Uint8Array(await readFile(this.path))); } catch {}
    return this;
  }
  async flush() {
    if (!this._dirty) return;
    const { writeFile, mkdir } = await import('node:fs/promises');
    await mkdir(new URL('.', this.path), { recursive: true });
    await writeFile(this.path, this._toBytes());
    this._dirty = false;
  }
}
