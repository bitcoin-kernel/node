// HeaderStore tests: the index (heightOf, cumulative work, locator), truncate
// (reorg rollback), and File persistence round-trip with the real codec.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { Codec } from '@bitcoin-desktop/schema/codec/codec.js';
import { HeaderEngine } from '@bitcoin-desktop/schema/codec/headers.js';
import { MemoryHeaderStore, FileHeaderStore } from '../src/store/header-store.js';

const codec = { blockHash: (h) => h.id, encodeHex: (_t, h) => h.id, decode: () => ({}) };
const engine = { work: (h) => BigInt(h.work ?? 1) };
const G = { id: 'g', work: 1 };

test('index: heightOf, cumulative work, headerAt', () => {
  const s = new MemoryHeaderStore(codec, engine, G);
  s.append([{ id: 'a', work: 2 }, { id: 'b', work: 3 }], 1);
  assert.equal(s.height, 2);
  assert.equal(s.heightOf('g'), 0);
  assert.equal(s.heightOf('b'), 2);
  assert.equal(s.heightOf('zzz'), null);
  assert.equal(s.headerAt(1).id, 'a');
  assert.equal(s.cumWorkAt(0), 1n);
  assert.equal(s.cumWorkAt(2), 1n + 2n + 3n);
});

test('append enforces contiguity', () => {
  const s = new MemoryHeaderStore(codec, engine, G);
  assert.throws(() => s.append([{ id: 'a' }], 2), /append gap/);
});

test('truncate rolls back and frees the hash index', () => {
  const s = new MemoryHeaderStore(codec, engine, G);
  s.append([{ id: 'a', work: 1 }, { id: 'b', work: 1 }, { id: 'c', work: 1 }], 1);
  s.truncate(1);
  assert.equal(s.height, 1);
  assert.equal(s.tipHash(), 'a');
  assert.equal(s.heightOf('b'), null);
  assert.equal(s.heightOf('c'), null);
  assert.equal(s.cumWorkAt(1), 2n);
});

test('locator is exponential and ends at genesis', () => {
  const s = new MemoryHeaderStore(codec, engine, G);
  s.append(Array.from({ length: 50 }, (_, i) => ({ id: `h${i + 1}`, work: 1 })), 1);
  const loc = s.locator();
  assert.equal(loc[0], 'h50');           // tip first
  assert.equal(loc.at(-1), 'g');         // genesis last
  assert.ok(loc.length < 50, 'sparser than the full chain');
});

test('FileHeaderStore round-trips real headers through disk', async () => {
  const realCodec = new Codec(JSON.parse(await readFile(new URL(import.meta.resolve('@bitcoin-desktop/schema/schema/core.jsonld')), 'utf8')), JSON.parse(await readFile(new URL(import.meta.resolve('@bitcoin-desktop/schema/schema/proof.jsonld')), 'utf8')));
  const chainSchema = JSON.parse(await readFile(new URL(import.meta.resolve('@bitcoin-desktop/schema/schema/chain.jsonld')), 'utf8'));
  const validateSchema = JSON.parse(await readFile(new URL(import.meta.resolve('@bitcoin-desktop/schema/schema/validate.jsonld')), 'utf8'));
  const he = HeaderEngine.fromSchemas(realCodec, chainSchema, validateSchema, 'btc:testnet4');
  const t4 = JSON.parse(await readFile(new URL(import.meta.resolve('@bitcoin-desktop/schema/test/vectors/testnet4.json')), 'utf8'));
  const real = t4.run.headers.map((h) => realCodec.decode('BlockHeader', h));

  const path = new URL('file://' + tmpdir() + `/bk-store-test-${process.pid}.bin`);
  const a = new FileHeaderStore(realCodec, he, real[0], path); // treat run[0] as the store genesis
  a.append(real.slice(1), 1);
  const tipHash = a.tipHash();
  const tipWork = a.cumWorkAt(a.height);
  await a.flush();

  const b = new FileHeaderStore(realCodec, he, real[0], path);
  await b.load();
  assert.equal(b.height, real.length - 1);
  assert.equal(b.tipHash(), tipHash);
  assert.equal(b.cumWorkAt(b.height), tipWork);
  assert.equal(realCodec.blockHash(b.headerAt(5)), realCodec.blockHash(real[5]));
});
