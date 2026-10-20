import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveNarrationProviderMode, DEFAULT_NARRATION_PROVIDER } from '../../src/media/narration.js';

test('engine default narration provider is strict kokoro, independent of the test-suite pin', () => {
  assert.equal(DEFAULT_NARRATION_PROVIDER, 'kokoro');
  assert.equal(resolveNarrationProviderMode({}), 'kokoro');
  assert.equal(resolveNarrationProviderMode({ NARRATION_PROVIDER: '' }), 'kokoro');
});

test('the npm test pin makes the suite use espeak-ng unless a test overrides it', () => {
  assert.equal(process.env.NARRATION_PROVIDER, 'espeak-ng');
});
