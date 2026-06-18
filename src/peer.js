// A Bitcoin p2p peer over a raw TCP socket, using the engine's P2pEngine for
// wire framing. This is the Node transport; in the browser the same message
// flow runs over a WebSocket-to-TCP bridge instead. Modelled on the engine's
// bridge/bridge.js peer connection.
import net from 'node:net';

export class Peer {
  constructor(engine, codec) {
    this.engine = engine;
    this.codec = codec;
    this.buf = new Uint8Array(0);
    this.waiters = [];
    this.closed = false;
  }

  connect(host, port, { userAgent = '/bitcoin-kernel-node:0.0.0/', connectTimeout = 8000 } = {}) {
    return new Promise((resolve, reject) => {
      this.socket = net.connect({ host, port });
      const to = setTimeout(() => { this.#fail(new Error('connect timeout')); }, connectTimeout);
      this.socket.once('error', (e) => { clearTimeout(to); this.#fail(e); reject(e); });
      this.socket.once('connect', async () => {
        clearTimeout(to);
        this.socket.on('data', (d) => this.#onData(new Uint8Array(d.buffer, d.byteOffset, d.byteLength)));
        this.socket.on('close', () => this.#fail(new Error('peer closed')));
        this.send('version', this.engine.buildVersion({ userAgent }));
        try { await this.waitFor(['verack']); resolve(this); } catch (e) { reject(e); }
      });
    });
  }

  send(command, payload) { if (!this.closed) this.socket.write(this.engine.encodeMessage(command, payload)); }

  // Resolve when a message with one of `commands` arrives.
  waitFor(commands, timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
      const w = { commands, resolve, reject };
      w.timer = setTimeout(() => { this.#drop(w); reject(new Error('timeout waiting for ' + commands.join('/'))); }, timeoutMs);
      this.waiters.push(w);
    });
  }

  close() { this.closed = true; try { this.socket?.destroy(); } catch {} }

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
    for (let i = this.waiters.length - 1; i >= 0; i--) {
      if (this.waiters[i].commands.includes(msg.command)) {
        const w = this.waiters.splice(i, 1)[0];
        clearTimeout(w.timer);
        w.resolve(msg);
      }
    }
  }

  #drop(w) { const i = this.waiters.indexOf(w); if (i >= 0) this.waiters.splice(i, 1); }

  #fail(err) {
    if (this.closed) return;
    this.closed = true;
    for (const w of this.waiters.splice(0)) { clearTimeout(w.timer); w.reject(err); }
  }
}
