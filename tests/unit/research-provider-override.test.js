import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveResearchProviderOverrideDeps } from '../../src/index.js';
import { GdeltSearchProvider } from '../../src/providers/research/GdeltSearchProvider.js';

// src/index.js's resolveResearchProviderOverrideDeps() is the sole gate for
// the opt-in RESEARCH_SOURCE_PROVIDER_OVERRIDE manual workflow_dispatch
// control. It is a pure function of an env-like object, so these tests
// exercise it directly rather than spinning up the full entrypoint.

test('no override (unset) -> returns {} so existing default provider behavior in runAutonomousEntrypoint is unchanged', () => {
  const deps = resolveResearchProviderOverrideDeps({});
  assert.deepEqual(deps, {});
});

test('no override (empty string) -> returns {} so existing default provider behavior is unchanged', () => {
  const deps = resolveResearchProviderOverrideDeps({ RESEARCH_SOURCE_PROVIDER_OVERRIDE: '' });
  assert.deepEqual(deps, {});
});

test("RESEARCH_SOURCE_PROVIDER_OVERRIDE=gdelt -> deps.research.sourceProvider is an explicitly injected GdeltSearchProvider", () => {
  const deps = resolveResearchProviderOverrideDeps({ RESEARCH_SOURCE_PROVIDER_OVERRIDE: 'gdelt' });
  assert.ok(deps.research);
  assert.ok(deps.research.sourceProvider instanceof GdeltSearchProvider);
});

test('any non-gdelt value does NOT select GDELT and returns {} unchanged', () => {
  for (const value of ['Gdelt', 'GDELT', 'tavily', 'gdelt ', ' gdelt', 'gdelt-extra', 'googlenews', '0', 'false']) {
    const deps = resolveResearchProviderOverrideDeps({ RESEARCH_SOURCE_PROVIDER_OVERRIDE: value });
    assert.deepEqual(deps, {}, `value ${JSON.stringify(value)} must not select GDELT`);
  }
});