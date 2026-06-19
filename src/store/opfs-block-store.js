// OpfsBlockStore: the browser backend for the block archive, mirroring
// FileBlockStore (src/store/block-store.js). Blocks are stored as raw serialized
// bytes, sharded into OPFS subdirectories of 10,000 by height. Must run in a Web
// Worker (synchronous access handles). Untested in Node (OPFS is browser-only).
import { hexToBytes, bytesToHex } from '@bitcoin-desktop/schema/codec/hash.js';

export class OpfsBlockStore {
  constructor(codec, { dirName = 'blocks' } = {}) {
    this.codec = codec;
    this.dirName = dirName;
    this._dirs = new Map(); // shard -> FileSystemDirectoryHandle
  }

  async #shardDir(h) {
    const shard = String(Math.floor(h / 10000));
    if (this._dirs.has(shard)) return this._dirs.get(shard);
    const root = await navigator.storage.getDirectory();
    const blocks = await root.getDirectoryHandle(this.dirName, { create: true });
    const dir = await blocks.getDirectoryHandle(shard, { create: true });
    this._dirs.set(shard, dir);
    return dir;
  }

  async has(h) {
    try { const dir = await this.#shardDir(h); await dir.getFileHandle(`${h}.bin`); return true; } catch { return false; }
  }

  async put(h, block) {
    const dir = await this.#shardDir(h);
    const fh = await dir.getFileHandle(`${h}.bin`, { create: true });
    const a = await fh.createSyncAccessHandle();
    try { const bytes = hexToBytes(this.codec.encodeHex('Block', block)); a.truncate(0); a.write(bytes, { at: 0 }); a.flush(); } finally { a.close(); }
  }

  async get(h) {
    try {
      const dir = await this.#shardDir(h);
      const fh = await dir.getFileHandle(`${h}.bin`);
      const a = await fh.createSyncAccessHandle();
      try { const size = a.getSize(); const buf = new Uint8Array(size); a.read(buf, { at: 0 }); return this.codec.decode('Block', bytesToHex(buf)); } finally { a.close(); }
    } catch { return null; }
  }

  async sizeOf(h) {
    try { const dir = await this.#shardDir(h); const fh = await dir.getFileHandle(`${h}.bin`); const a = await fh.createSyncAccessHandle(); try { return a.getSize(); } finally { a.close(); } } catch { return 0; }
  }
}
