// WsPeer: the browser transport for a Bitcoin p2p peer. A browser tab cannot
// open raw TCP, so it connects to a local WebSocket-to-TCP bridge that relays
// raw Bitcoin p2p message bytes both ways. Identical message flow and public API
// to the Node `Peer` (src/peer.js) — connect / send / waitFor / collect / close —
// so the rest of the node (HeaderSync, WalletScan, validators) runs unchanged.
//
// This is the third and last browser swap (after OpfsHeaderStore/OpfsBlockStore).
// Browser-only (uses the global WebSocket); the bridge relays raw p2p frames, so
// the engine's encode/decode is reused as-is.
export class WsPeer {
  constructor(engine, codec) {
    this.engine = engine;
    this.codec = codec;
    this.buf = new Uint8Array(0);
    this.waiters = [];
    this.listeners = [];
    this.closed = false;
  }

  // url: the local bridge, e.g. ws://127.0.0.1:8334 (the bridge dials the peer)
  connect(url, { userAgent = '/bitcoin-kernel-node:0.0.0/', connectTimeout = 8000 } = {}) {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(url);
      this.ws.binaryType = 'arraybuffer';
      const to = setTimeout(() => { this.#fail(new Error('connect timeout')); reject(new Error('connect timeout')); }, connectTimeout);
      this.ws.onerror = () => { clearTimeout(to); this.#fail(new Error('ws error')); reject(new Error('ws error')); };
      this.ws.onclose = () => this.#fail(new Error('peer closed'));
      this.ws.onmessage = (ev) => this.#onData(new Uint8Array(ev.data));
      this.ws.onopen = async () => {
        clearTimeout(to);
        this.send('version', this.engine.buildVersion({ userAgent }));
        try { await this.waitFor(['verack']); resolve(this); } catch (e) { reject(e); }
      };
    });
  }

  send(command, payload) { if (!this.closed) this.ws.send(this.engine.encodeMessage(command, payload)); }

  waitFor(commands, timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
      const w = { commands, resolve, reject };
      w.timer = setTimeout(() => { this.#drop(w); reject(new Error('timeout waiting for ' + commands.join('/'))); }, timeoutMs);
      this.waiters.push(w);
    });
  }

  collect(command, count, { onItem, timeoutMs = 90000 } = {}) {
    return new Promise((resolve, reject) => {
      let n = 0;
      const out = onItem ? null : [];
      const done = () => { clearTimeout(timer); const i = this.listeners.indexOf(l); if (i >= 0) this.listeners.splice(i, 1); };
      const l = { command, fn: (msg) => { n++; if (onItem) { try { onItem(msg); } catch (e) { done(); reject(e); return; } } else out.push(msg); if (n >= count) { done(); resolve(onItem ? n : out); } } };
      const timer = setTimeout(() => { done(); reject(new Error(`collect timeout: ${n}/${count} ${command}`)); }, timeoutMs);
      l.cancel = () => { done(); reject(new Error('peer closed')); };
      this.listeners.push(l);
    });
  }

  close() { this.closed = true; try { this.ws?.close(); } catch {} }

  #onData(chunk) {
    const merged = new Uint8Array(this.buf.length + chunk.length);
    merged.set(this.buf);
    merged.set(chunk, this.buf.length);
    const { messages, consumed } = this.engine.decodeStream(merged);
    this.buf = merged.slice(consumed);
    for (const msg of messages) this.#dispatch(msg);
  }

  #dispatch(msg) {
    if (msg.command === 'version') { this.peerVersion = msg.payload; this.send('verack'); return; }
    if (msg.command === 'ping') { this.send('pong', { nonce: msg.payload?.nonce ?? 0 }); return; }
    for (const l of this.listeners) { if (l.command === msg.command) { l.fn(msg); return; } }
    for (let i = this.waiters.length - 1; i >= 0; i--) {
      if (this.waiters[i].commands.includes(msg.command)) { const w = this.waiters.splice(i, 1)[0]; clearTimeout(w.timer); w.resolve(msg); }
    }
  }

  #drop(w) { const i = this.waiters.indexOf(w); if (i >= 0) this.waiters.splice(i, 1); }

  #fail(err) {
    if (this.closed) return;
    this.closed = true;
    for (const w of this.waiters.splice(0)) { clearTimeout(w.timer); w.reject(err); }
    for (const l of this.listeners.splice(0)) l.cancel?.();
  }
}
