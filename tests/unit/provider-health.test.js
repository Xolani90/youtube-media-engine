import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  resetProviderHealth, recordProviderRateLimit, isProviderCoolingDown, providerCooldownRemainingMs
} from '../../src/providers/llm/providerHealth.js';

beforeEach(() => {
  resetProviderHealth();
});

test('no cooldown recorded: provider is not cooling down and has 0ms remaining', () => {
  assert.equal(isProviderCoolingDown('groq-free'), false);
  assert.equal(providerCooldownRemainingMs('groq-free'), 0);
});

test('recordProviderRateLimit: provider cools down for the given duration, isolated from other providers', () => {
  const now = 1_000_000;
  recordProviderRateLimit('groq-free', 5000, now);

  assert.equal(isProviderCoolingDown('groq-free', now), true);
  assert.equal(providerCooldownRemainingMs('groq-free', now), 5000);
  // A different provider id is entirely unaffected.
  assert.equal(isProviderCoolingDown('gemini-free', now), false);
});

test('cooldown expiration: provider becomes eligible again once now passes cooldownUntil', () => {
  const now = 1_000_000;
  recordProviderRateLimit('groq-free', 5000, now);

  assert.equal(isProviderCoolingDown('groq-free', now + 4999), true);
  assert.equal(isProviderCoolingDown('groq-free', now + 5000), false, 'cooldown boundary is exclusive');
  assert.equal(isProviderCoolingDown('groq-free', now + 6000), false);
  assert.equal(providerCooldownRemainingMs('groq-free', now + 6000), 0);
});

test('repeated rate-limit events: a later, shorter cooldown never shortens an existing longer one (max-merge)', () => {
  const now = 1_000_000;
  recordProviderRateLimit('groq-free', 60000, now); // cooldownUntil = now + 60000
  recordProviderRateLimit('groq-free', 1000, now + 100); // would expire sooner than the first if it won

  // The longer, earlier-recorded cooldown still wins.
  assert.equal(providerCooldownRemainingMs('groq-free', now + 100), 59900);
  assert.equal(isProviderCoolingDown('groq-free', now + 1200), true);
});

test('repeated rate-limit events: a later, longer cooldown extends the existing one', () => {
  const now = 1_000_000;
  recordProviderRateLimit('groq-free', 1000, now);
  recordProviderRateLimit('groq-free', 60000, now + 100);

  assert.equal(providerCooldownRemainingMs('groq-free', now + 100), 60000);
});

test('non-finite or negative cooldownMs is a no-op', () => {
  recordProviderRateLimit('groq-free', NaN, 1000);
  recordProviderRateLimit('groq-free', -5, 1000);
  recordProviderRateLimit('groq-free', Infinity, 1000);
  assert.equal(isProviderCoolingDown('groq-free', 1000), false);
});

test('resetProviderHealth: clears all recorded cooldowns', () => {
  recordProviderRateLimit('groq-free', 5000, 1000);
  recordProviderRateLimit('gemini-free', 5000, 1000);
  resetProviderHealth();
  assert.equal(isProviderCoolingDown('groq-free', 1000), false);
  assert.equal(isProviderCoolingDown('gemini-free', 1000), false);
});