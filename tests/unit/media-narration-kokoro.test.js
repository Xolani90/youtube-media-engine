import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';

import { synthesizeNarration, probeDurationSeconds, resolveNarrationProviderMode } from '../../src/media/narration.js';
import { encodeWav16, concatFloat32 } from '../../src/media/kokoroSupport.js';
import { buildRenderSpec } from '../../src/media/renderSpec.js';

const tmp = (ext = '.wav') => path.join(os.tmpdir(), `kokoro-unit-${process.pid}-${Date.now()}-${Math.random()}${ext}`);
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const throwingKokoro = () => { throw new Error('kokoro failed: injected fault'); };

// ---- provider mode resolution ------------------------------------------------
test('mode: defaults to espeak-ng; auto/kokoro accepted; anything else rejected', () => {
  assert.equal(resolveNarrationProviderMode({}), 'espeak-ng');
  assert.equal(resolveNarrationProviderMode({ NARRATION_PROVIDER: 'AUTO' }), 'auto');
  assert.equal(resolveNarrationProviderMode({ NARRATION_PROVIDER: 'kokoro' }), 'kokoro');
  assert.throws(() => resolveNarrationProviderMode({ NARRATION_PROVIDER: 'elevenlabs' }));
});

// ---- fallback behaviour (REAL espeak-ng; only the Kokoro failure is injected) ----
test('auto: Kokoro failure falls back to the real espeak-ng, reports provider + reason, artifact is valid', () => {
  const out = tmp();
  try {
    const r = synthesizeNarration('Fallback narration test sentence.', out, { mode: 'auto', engines: { kokoro: throwingKokoro } });
    assert.equal(r.provider, 'espeak-ng');
    assert.match(r.fallbackReason, /injected fault/);
    assert.ok(probeDurationSeconds(out) > 0);
  } finally { fs.rmSync(out, { force: true }); }
});

test('auto: a partial file left by a failing Kokoro is removed before the fallback writes', () => {
  const out = tmp();
  try {
    const r = synthesizeNarration('Partial file cleanup test.', out, {
      mode: 'auto', engines: { kokoro: (t, p) => { fs.writeFileSync(p, 'garbage'); throw new Error('boom'); } }
    });
    assert.equal(r.provider, 'espeak-ng');
    assert.notEqual(fs.readFileSync(out).toString('latin1', 0, 4), 'garb');
    assert.ok(probeDurationSeconds(out) > 0);
  } finally { fs.rmSync(out, { force: true }); }
});

test('kokoro (strict): failure throws, never silently downgrades, leaves no file', () => {
  const out = tmp();
  assert.throws(() => synthesizeNarration('Strict mode test.', out, { mode: 'kokoro', engines: { kokoro: throwingKokoro } }), /injected fault/);
  assert.equal(fs.existsSync(out), false);
});

test('espeak-ng mode never touches Kokoro and reports espeak-ng', () => {
  const out = tmp();
  try {
    const r = synthesizeNarration('Plain espeak path.', out, { mode: 'espeak-ng', engines: { kokoro: () => { throw new Error('must not be called'); } } });
    assert.deepEqual(r, { provider: 'espeak-ng', fallbackReason: null });
    assert.ok(probeDurationSeconds(out) > 0);
  } finally { fs.rmSync(out, { force: true }); }
});

test('auto: when Kokoro succeeds (engine seam), provider is kokoro and espeak is not run', () => {
  const out = tmp();
  try {
    const r = synthesizeNarration('Seam success.', out, {
      mode: 'auto', engines: {
        kokoro: (t, p) => fs.writeFileSync(p, encodeWav16(new Float32Array(24000), 24000)),
        'espeak-ng': () => { throw new Error('espeak must not run'); }
      }
    });
    assert.equal(r.provider, 'kokoro');
  } finally { fs.rmSync(out, { force: true }); }
});

test('empty text is rejected in every mode before any engine runs', () => {
  for (const mode of ['espeak-ng', 'auto', 'kokoro']) {
    assert.throws(() => synthesizeNarration('  ', tmp(), { mode, engines: { kokoro: throwingKokoro } }), /non-empty text/);
  }
});

// ---- WAV encoder (what the worker writes) is consumable by the existing pipeline tools ----
test('encodeWav16: valid mono 16-bit WAV that FFprobe measures correctly; clips out-of-range samples', () => {
  const out = tmp();
  try {
    const rate = 24000;
    const samples = concatFloat32([new Float32Array(rate).fill(0.25), new Float32Array(rate).fill(2)]); // 2 s, second half over-range
    fs.writeFileSync(out, encodeWav16(samples, rate));
    assert.ok(Math.abs(probeDurationSeconds(out) - 2) < 0.01);
    const buf = fs.readFileSync(out);
    assert.equal(buf.readInt16LE(44 + rate * 2), 0x7fff); // clipped, not wrapped
    assert.equal(sha(out), sha(out)); // stable read
  } finally { fs.rmSync(out, { force: true }); }
});

// ---- provenance in the render spec -------------------------------------------
test('buildRenderSpec: records narration.provider when supplied; unchanged shape when not', () => {
  const base = { contentVersion: { id: 'cv' }, narrationPath: '/n.wav', narrationDurationSeconds: 5, visualTiming: [] };
  assert.equal(buildRenderSpec({ ...base, narrationProvider: 'kokoro' }).narration.provider, 'kokoro');
  assert.deepEqual(Object.keys(buildRenderSpec(base).narration), ['path', 'duration_seconds']);
});

// ---- REAL Kokoro (donor runtime + model). Opt-in: needs the model downloaded. ----
const kokoroInstalled = (() => { try { createRequire(import.meta.url).resolve('kokoro-js'); return true; } catch { return false; } })();
const realKokoro = process.env.KOKORO_REAL_TEST === '1' && kokoroInstalled;
test('REAL Kokoro: synthesizes known text into a valid audio artifact (set KOKORO_REAL_TEST=1; downloads the model on first run)', {
  skip: realKokoro ? false : (kokoroInstalled ? 'KOKORO_REAL_TEST != 1 (model download not attempted)' : 'kokoro-js not installed'),
  timeout: 15 * 60 * 1000
}, () => {
  const out = tmp();
  try {
    const r = synthesizeNarration('Kokoro is running locally. This is a real synthesis test.', out, { mode: 'kokoro' });
    assert.equal(r.provider, 'kokoro');
    const d = probeDurationSeconds(out);
    assert.ok(d > 1.5 && d < 20, `unexpected duration ${d}`);
    assert.equal(fs.readFileSync(out).toString('latin1', 0, 4), 'RIFF');
  } finally { fs.rmSync(out, { force: true }); }
});
