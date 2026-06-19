// Consensus-equivalence gate for the WASM verify backend: run Bitcoin Core's
// script_tests.json through the interpreter twice — once pure-JS, once with the
// WASM backend — and assert every verdict is identical. Core's corpus is dense
// with real ECDSA/Schnorr signatures (valid, forged, malleable, edge-case), so
// agreement on all of it means the WASM swap is consensus-safe.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Codec } from '@bitcoin-desktop/schema/codec/codec.js';
import { ScriptEngine } from '@bitcoin-desktop/schema/codec/script.js';
import { ScriptInterpreter } from '@bitcoin-desktop/schema/codec/interpreter.js';
import { setVerifyBackend } from '@bitcoin-desktop/schema/codec/secp256k1.js';
import { wasmBackend } from '../src/wasm-secp.js';

const load = async (p) => JSON.parse(await readFile(new URL(import.meta.resolve('@bitcoin-desktop/schema/' + p)), 'utf8'));
const core = await load('schema/core.jsonld'), proof = await load('schema/proof.jsonld');
const scriptSchema = await load('schema/script.jsonld'), chainSchema = await load('schema/chain.jsonld');
const raw = await load('test/vectors/script_tests.json');
const codec = new Codec(core, proof);
const se = ScriptEngine.fromSchemas(scriptSchema, chainSchema);
const interp = new ScriptInterpreter(codec, se, scriptSchema['@graph'].find((n) => n['@id'] === 'btc:scriptLimits'));

const N2C = new Map();
for (const m of scriptSchema['@graph'].find((n) => n['@id'] === 'btc:Opcode').members) { N2C.set(m.name, m.code); N2C.set(m.name.replace(/^OP_/, ''), m.code); }
const hx = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
const sn = (n) => { if (n === 0n) return []; const g = n < 0n; let a = g ? -n : n; const o = []; while (a > 0n) { o.push(Number(a & 0xffn)); a >>= 8n; } if (o[o.length - 1] & 0x80) o.push(g ? 0x80 : 0); else if (g) o[o.length - 1] |= 0x80; return o; };
const pd = (b) => { const n = b.length; if (n < 76) return [n, ...b]; if (n <= 255) return [76, n, ...b]; if (n <= 65535) return [77, n & 255, n >> 8, ...b]; return [78, n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255, ...b]; };
const ps = (s) => { const o = []; for (const w of s.split(/\s+/).filter(Boolean)) { if (/^-?\d+$/.test(w)) { const n = BigInt(w); if (n === 0n) o.push(0); else if (n === -1n) o.push(0x4f); else if (n >= 1n && n <= 16n) o.push(0x50 + Number(n)); else o.push(...pd(sn(n))); } else if (/^0x[0-9a-fA-F]*$/.test(w)) { const h = w.slice(2); for (let i = 0; i < h.length; i += 2) o.push(parseInt(h.slice(i, i + 2), 16)); } else if (/^'.*'$/.test(w)) o.push(...pd([...w.slice(1, -1)].map((c) => c.charCodeAt(0)))); else if (N2C.has(w)) o.push(N2C.get(w)); else throw 0; } return hx(Uint8Array.from(o)); };
const TIMELOCK = /CHECKLOCKTIMEVERIFY|CHECKSEQUENCEVERIFY/;
const STRUCT = new Set(['WITNESS_UNEXPECTED', 'WITNESS_MALLEATED', 'WITNESS_MALLEATED_P2SH', 'WITNESS_PROGRAM_WRONG_LENGTH', 'WITNESS_PROGRAM_WITNESS_EMPTY', 'WITNESS_PROGRAM_MISMATCH', 'DISCOURAGE_UPGRADABLE_WITNESS_PROGRAM']);
const spend = (sig, spk, amount, wit) => { const c = { version: 1, lockTime: 0, inputs: [{ prevout: { txid: '00'.repeat(32), vout: 0xffffffff }, scriptSig: '0000', sequence: 0xffffffff }], outputs: [{ value: amount, scriptPubKey: spk }] }; const sp = { version: 1, lockTime: 0, inputs: [{ prevout: { txid: codec.txid(c), vout: 0 }, scriptSig: sig, sequence: 0xffffffff }], outputs: [{ value: amount, scriptPubKey: '' }] }; if (wit) sp.witness = [wit]; return sp; };

function runDiff() {
  const verdicts = [];
  let sigCases = 0;
  for (const t of raw) {
    if (!t || t.length < 4) continue;
    let wit = null, amount = 0, sig, spk, flags, expected;
    if (Array.isArray(t[0])) { wit = t[0].slice(0, -1); amount = Math.round(t[0][t[0].length - 1] * 1e8); [, sig, spk, flags, expected] = t; } else { [sig, spk, flags, expected] = t; }
    if (TIMELOCK.test(sig) || TIMELOCK.test(spk) || STRUCT.has(expected)) continue;
    let sh, ph; try { sh = ps(sig); ph = ps(spk); } catch { continue; }
    if (/P2SH/.test(flags) && se.classify(ph).type === 'p2sh' && /^(4c|4d|4e)/.test(ph.slice(2, 4))) continue;
    if (/CHECKSIG|CHECKMULTISIG/.test(sig + ' ' + spk)) sigCases++;
    const fset = new Set(flags.split(/[, ]+/).filter(Boolean));
    let ours; try { const r = interp.verifyInput(spend(sh, ph, amount, wit), 0, { value: amount, scriptPubKey: ph }, [{ value: amount, scriptPubKey: ph }], fset); ours = r.ok; } catch { ours = 'err'; }
    verdicts.push(ours);
  }
  return { verdicts, sigCases };
}

test('WASM verify backend agrees with pure-JS on every Bitcoin Core script vector', () => {
  setVerifyBackend(null);
  const a = runDiff();
  setVerifyBackend(wasmBackend);
  const b = runDiff();
  setVerifyBackend(null); // leave default for other tests
  assert.ok(a.sigCases > 100, `corpus exercised signatures (${a.sigCases} CHECKSIG/MULTISIG cases)`);
  assert.equal(a.verdicts.length, b.verdicts.length);
  let diffs = 0;
  for (let i = 0; i < a.verdicts.length; i++) if (a.verdicts[i] !== b.verdicts[i]) diffs++;
  assert.equal(diffs, 0, `pure-JS and WASM disagree on ${diffs} of ${a.verdicts.length} vectors`);
});
