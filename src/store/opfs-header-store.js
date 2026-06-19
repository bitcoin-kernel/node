// OpfsHeaderStore: the browser backend for HeaderStore. Same in-memory index and
// logic as FileHeaderStore; persistence goes through an OPFS synchronous access
// handle (must run in a Web Worker). This is one of the two swaps that move the
// headless Node node into the browser (the other is the WS-bridge Peer).
//
// Untested in Node (OPFS is browser-only); it mirrors FileHeaderStore exactly,
// reading/writing the same flat 80-byte-per-header layout.
import { HeaderStore } from './header-store.js';

export class OpfsHeaderStore extends HeaderStore {
  constructor(codec, headerEngine, genesisHeader, filename = 'testnet4-headers.bin') {
    super(codec, headerEngine, genesisHeader);
    this.filename = filename;
  }

  async #handle() {
    const root = await navigator.storage.getDirectory();
    const fh = await root.getFileHandle(this.filename, { create: true });
    return fh.createSyncAccessHandle(); // Worker-only; synchronous read/write/flush
  }

  async load() {
    const a = await this.#handle();
    try {
      const size = a.getSize();
      if (size) { const buf = new Uint8Array(size); a.read(buf, { at: 0 }); this._ingestBytes(buf); }
    } finally { a.close(); }
    return this;
  }

  async flush() {
    if (!this._dirty) return;
    const bytes = this._toBytes();
    const a = await this.#handle();
    try { a.truncate(0); a.write(bytes, { at: 0 }); a.flush(); } finally { a.close(); }
    this._dirty = false;
  }
}
