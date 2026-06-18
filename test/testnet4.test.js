// Deterministic testnet4 consensus checks, mirroring the engine's own golden
// vectors. Proves the network-aware validation handles testnet4's hard rules:
// the BIP 94 timewarp fix and the 20-minute min-difficulty walk-back. Offline,
// no network. Run: `npm test`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Codec } from '@bitcoin-desktop/schema/codec/codec.js';
import { HeaderEngine } from '@bitcoin-desktop/schema/codec/headers.js';

const load = async (p) => JSON.parse(await readFile(new URL(import.meta.resolve('@bitcoin-desktop/schema/' + p)), 'utf8'));
const codec = new Codec(await load('schema/core.jsonld'), await load('schema/proof.jsonld'));
const chainSchema = await load('schema/chain.jsonld');
const validateSchema = await load('schema/validate.jsonld');
const t4 = await load('test/vectors/testnet4.json');
const params = chainSchema['@graph'].find((n) => n['@id'] === 'btc:testnet4');
const engine = HeaderEngine.fromSchemas(codec, chainSchema, validateSchema, 'btc:testnet4');
const dec = (h) => codec.decode('BlockHeader', h);

test('testnet4 genesis hash derives from our params', () => {
  const genesis = dec(t4.genesisHeader);
  assert.equal(codec.blockHash(genesis), params.genesisHash);
  assert.equal(params.genesisHash, t4.genesisHash);
  assert.ok(engine.checks['btc:rule-header-pow']({ header: genesis }));
});

test('BIP 94 retarget is epoch-first based and reproduced bit-for-bit', () => {
  const first = dec(t4.retarget.epochFirst);
  const last = dec(t4.retarget.epochLast);
  const next = dec(t4.retarget.next);
  assert.equal(engine.expectedBits(last, t4.retarget.epochLastHeight, first), next.bits);
});

test('timewarp rule: real boundary passes, a warped one fails', () => {
  const prev = dec(t4.retarget.epochLast);
  const next = dec(t4.retarget.next);
  const check = engine.checks['btc:rule-header-timewarp'];
  assert.equal(check({ header: next, prev, height: t4.retarget.nextHeight }), true);
  assert.equal(check({ header: { ...next, time: prev.time - 601 }, prev, height: t4.retarget.nextHeight }), false);
});

test('a real min-difficulty testnet4 run validates, including walk-backs', () => {
  const headers = t4.run.headers.map(dec);
  const powBits = engine.compactFromTarget(engine.powLimit);
  assert.ok(headers.some((h) => h.bits === powBits), 'run contains min-difficulty blocks');
  assert.ok(headers.some((h) => h.bits !== powBits), 'run contains real-difficulty blocks');
  const rows = engine.validateChain(headers.slice(11), {
    startHeight: t4.run.startHeight + 11,
    prevContext: headers.slice(0, 11),
    now: headers.at(-1).time + 7200,
  });
  for (const row of rows) {
    assert.equal(row.ok, true, `${row.height}: ${JSON.stringify(row.results.filter((r) => r.ok === false))}`);
  }
});
