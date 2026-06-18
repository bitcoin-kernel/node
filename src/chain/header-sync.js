// HeaderSync: the platform-agnostic header-chain sync engine. It depends only
// on a HeaderStore (storage interface) and the engine's HeaderEngine, plus a
// transport-agnostic `fetchHeaders(locator) -> headers[]` function. The same
// object runs in Node (TCP peer + FileHeaderStore) and in the browser (WS
// bridge + OpfsHeaderStore) with no changes.
//
// It resumes from the store, validates every header incrementally (so the store
// only ever holds a valid chain), and handles reorgs by the most-work rule: a
// competing branch is adopted only if its cumulative work exceeds ours.
export class HeaderSync {
  constructor(store, headerEngine, codec, { now = () => Math.floor(Date.now() / 1000), context = 12 } = {}) {
    this.store = store;
    this.he = headerEngine;
    this.codec = codec;
    this.now = now;
    this.K = context;
    this._fork = null; // a competing branch being gathered: { ancestorHeight, headers }
  }

  async sync(fetchHeaders, { onBatch } = {}) {
    let added = 0;
    const reorgs = [];
    for (;;) {
      const locator = this._fork
        ? [this.codec.blockHash(this._fork.headers.at(-1)), ...this.store.locator()]
        : this.store.locator();
      const batch = await fetchHeaders(locator);
      if (!batch || batch.length === 0) break;
      const res = this.#ingest(batch);
      added += res.added;
      if (res.reorg) reorgs.push(res.reorg);
      onBatch?.({ tip: this.store.tip(), added: res.added, reorg: res.reorg, count: batch.length });
      if (res.stop) break;
      if (batch.length < 2000 && !this._fork) break;
    }
    await this.store.flush();
    return { tip: this.store.tip(), added, reorgs };
  }

  #at(h, fork) {
    if (h <= fork.ancestorHeight) return this.store.headerAt(h);
    return fork.headers[h - (fork.ancestorHeight + 1)] ?? null;
  }

  #assertValid(headers, startHeight, fork) {
    const prevContext = [];
    for (let h = Math.max(0, startHeight - this.K); h < startHeight; h++) {
      const hd = this.#at(h, fork);
      if (hd) prevContext.push(hd);
    }
    const all = { ancestorHeight: fork.ancestorHeight, headers: fork.headers.concat(headers) };
    const chainAt = (h) => this.#at(h, all);
    const rows = this.he.validateChain(headers, { startHeight, prevContext, chainAt, now: this.now() + 7200 });
    const bad = rows.find((r) => r.results.some((x) => x.ok === false));
    if (bad) {
      this._fork = null;
      throw new Error(`invalid header at height ${bad.height}: ${JSON.stringify(bad.results.filter((r) => r.ok === false).map((r) => r.error))}`);
    }
  }

  #ingest(batch) {
    // continuation of a pending fork
    if (this._fork) {
      if (batch[0].prevBlockHash === this.codec.blockHash(this._fork.headers.at(-1))) return this.#growFork(batch);
      this._fork = null; // peer changed course; re-evaluate from scratch
    }
    const aH = this.store.heightOf(batch[0].prevBlockHash);
    if (aH == null) throw new Error(`discontinuity: unknown prev ${batch[0].prevBlockHash}`);

    // skip any prefix the peer re-served that we already have
    let i = 0;
    let h = aH + 1;
    while (i < batch.length && h <= this.store.height && this.codec.blockHash(batch[i]) === this.codec.blockHash(this.store.headerAt(h))) { i++; h++; }
    if (i === batch.length) return { added: 0, reorg: null, stop: false }; // nothing new

    if (h > this.store.height) {
      // pure extension beyond our tip
      const tail = batch.slice(i);
      this.#assertValid(tail, h, { ancestorHeight: h - 1, headers: [] });
      this.store.append(tail, h);
      return { added: tail.length, reorg: null, stop: false };
    }

    // divergence at height h: a competing branch from common ancestor h - 1
    this._fork = { ancestorHeight: h - 1, headers: [] };
    return this.#growFork(batch.slice(i));
  }

  #growFork(batch) {
    const fork = this._fork;
    const startHeight = fork.ancestorHeight + 1 + fork.headers.length;
    this.#assertValid(batch, startHeight, fork);
    fork.headers.push(...batch);

    const candidate = this.store.cumWorkAt(fork.ancestorHeight) + fork.headers.reduce((w, x) => w + this.he.work(x), 0n);
    const ours = this.store.cumWorkAt(this.store.height);
    if (candidate > ours) {
      const depth = this.store.height - fork.ancestorHeight;
      this.store.truncate(fork.ancestorHeight);
      this.store.append(fork.headers, fork.ancestorHeight + 1);
      const reorg = { depth, atHeight: fork.ancestorHeight, length: fork.headers.length };
      this._fork = null;
      return { added: reorg.length, reorg, stop: false };
    }
    if (batch.length < 2000) { this._fork = null; return { added: 0, reorg: null, stop: true }; } // fork ended, ours wins
    return { added: 0, reorg: null, stop: false }; // keep gathering
  }
}
