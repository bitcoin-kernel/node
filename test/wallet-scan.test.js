// Tests for the BIP 158 filter primitive and the WalletScan, against the
// official BIP 158 vectors (real blocks + real filters). Deterministic, no
// network: proves the match-then-fetch wallet pipeline finds real outputs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Codec } from '@bitcoin-desktop/schema/codec/codec.js';
import { GcsFilter } from '@bitcoin-desktop/schema/codec/filters.js';
import { hexToBytes } from '@bitcoin-desktop/schema/codec/hash.js';
import { WalletScan } from '../src/wallet/wallet-scan.js';

const load = async (p) => JSON.parse(await readFile(new URL(import.meta.resolve('@bitcoin-desktop/schema/' + p)), 'utf8'));
const codec = new Codec(await load('schema/core.jsonld'), await load('schema/proof.jsonld'));
const bip158 = await load('test/vectors/bip158.json');
const gcs = new GcsFilter();

// a vector block that has spendable (non-OP_RETURN) outputs to watch
const withOutput = bip158.vectors.find((v) => {
  const b = codec.decode('Block', v.rawBlock);
  return b.transactions.some((t) => t.outputs.some((o) => o.scriptPubKey && !o.scriptPubKey.startsWith('6a')));
});

test('BIP 158 primitive: a created script matches its block filter; a stranger does not', () => {
  const v = withOutput;
  const block = codec.decode('Block', v.rawBlock);
  assert.equal(codec.blockHash(block.header || block), v.blockHash);
  const key = gcs.keyFor(v.blockHash);
  const filter = hexToBytes(v.filter);
  const aScript = block.transactions.flatMap((t) => t.outputs).find((o) => o.scriptPubKey && !o.scriptPubKey.startsWith('6a')).scriptPubKey;
  assert.equal(gcs.matchAny(key, filter, [hexToBytes(aScript)]), true, 'our script is in the filter');
  assert.equal(gcs.matchAny(key, filter, [hexToBytes('0014' + 'ab'.repeat(20))]), false, 'a stranger is not');
});

test('WalletScan finds a real output via filter-match-then-fetch', async () => {
  const v = withOutput;
  const block = codec.decode('Block', v.rawBlock);
  const out = block.transactions.flatMap((t) => t.outputs).find((o) => o.scriptPubKey && !o.scriptPubKey.startsWith('6a'));

  const w = new WalletScan(codec, gcs).watchScript(out.scriptPubKey);
  const res = await w.scan({
    from: v.height, to: v.height,
    headerHashAt: () => v.blockHash,
    fetchFilter: () => hexToBytes(v.filter),
    fetchBlock: () => v.rawBlock,
  });
  assert.equal(res.touched, 1, 'the block touched the wallet');
  assert.ok(w.utxos.size >= 1, 'a UTXO was recorded');
  assert.ok(w.balance >= BigInt(out.value), 'balance includes the output');
  assert.ok(w.history.some((e) => e.type === 'recv'), 'a receive is in the history');
});

test('WalletScan: a stranger wallet is untouched (filter false positives cost only a fetch)', async () => {
  const v = withOutput;
  const w = new WalletScan(codec, gcs).watchScript('0014' + 'cd'.repeat(20));
  const res = await w.scan({
    from: v.height, to: v.height,
    headerHashAt: () => v.blockHash,
    fetchFilter: () => hexToBytes(v.filter),
    fetchBlock: () => v.rawBlock,
  });
  assert.equal(res.touched, 0, 'no real coins for a stranger');
  assert.equal(w.balance, 0n);
});

test('scanBlocks (no filters) finds coins and rejects a block failing its merkle check', async () => {
  const SCRIPT = '0014' + '22'.repeat(20);
  const fakeCodec = { txid: (t) => t.id, decode: (_t, x) => x };
  const fakeGcs = { keyFor: () => new Uint8Array(16), matchAny: () => true };
  const block = { transactions: [{ id: 'c', inputs: [{ prevout: { txid: '00'.repeat(32), vout: 0 } }], outputs: [{ scriptPubKey: SCRIPT, value: 5000000000 }] }] };

  const good = new WalletScan(fakeCodec, fakeGcs).watchScript(SCRIPT);
  const res = await good.scanBlocks({ from: 1, to: 1, headerHashAt: () => 'h', fetchBlock: () => block, verifyBlock: () => true });
  assert.equal(res.touched, 1);
  assert.equal(good.balance, 5000000000n);

  const bad = new WalletScan(fakeCodec, fakeGcs).watchScript(SCRIPT);
  await assert.rejects(() => bad.scanBlocks({ from: 1, to: 1, headerHashAt: () => 'h', fetchBlock: () => block, verifyBlock: () => false }), /merkle check/);
});

test('WalletScan tracks a spend (receive then spend nets to zero)', async () => {
  // synthetic two-block scenario over a fake codec, to exercise UTXO spend tracking
  const SCRIPT = '0014' + '11'.repeat(20);
  const fakeCodec = {
    txid: (t) => t.id,
    decode: (_type, x) => x, // blocks passed through directly
  };
  const fakeGcs = { keyFor: () => new Uint8Array(16), matchAny: () => true };
  const w = new WalletScan(fakeCodec, fakeGcs).watchScript(SCRIPT);

  const recvBlock = { transactions: [{ id: 'tx1', inputs: [{ prevout: { txid: '00'.repeat(32), vout: 4294967295 } }], outputs: [{ scriptPubKey: SCRIPT, value: 50000 }] }] };
  const spendBlock = { transactions: [{ id: 'tx2', inputs: [{ prevout: { txid: 'tx1', vout: 0 } }], outputs: [{ scriptPubKey: '0014' + '99'.repeat(20), value: 49000 }] }] };

  await w.scan({ from: 1, to: 1, headerHashAt: () => 'h1', fetchFilter: () => new Uint8Array([1]), fetchBlock: () => recvBlock });
  assert.equal(w.balance, 50000n, 'received');
  await w.scan({ from: 2, to: 2, headerHashAt: () => 'h2', fetchFilter: () => new Uint8Array([1]), fetchBlock: () => spendBlock });
  assert.equal(w.balance, 0n, 'spent');
  assert.equal(w.utxos.size, 0);
  assert.equal(w.history.filter((e) => e.type === 'spend').length, 1);
});
