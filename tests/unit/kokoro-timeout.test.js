import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveKokoroTimeoutMs } from '../../src/media/narration.js';

const THIRTY_MIN = 30 * 60 * 1000;

test('defaults to 30 minutes when KOKORO_TIMEOUT_MS is unset or blank', () => {
  assert.equal(resolveKokoroTimeoutMs({}), THIRTY_MIN);
  assert.equal(resolveKokoroTimeoutMs({ KOKORO_TIMEOUT_MS: '' }), THIRTY_MIN);
  assert.equal(resolveKokoroTimeoutMs({ KOKORO_TIMEOUT_MS: '   ' }), THIRTY_MIN);
});

test('honors a valid KOKORO_TIMEOUT_MS override', () => {
  assert.equal(resolveKokoroTimeoutMs({ KOKORO_TIMEOUT_MS: '900000' }), 900000);
});

test('rejects zero, negative and non-numeric values', () => {
  for (const bad of ['0', '-5', 'abc', 'Infinity']) {
    assert.throws(() => resolveKokoroTimeoutMs({ KOKORO_TIMEOUT_MS: bad }), /KOKORO_TIMEOUT_MS must be a positive number/);
  }
});
