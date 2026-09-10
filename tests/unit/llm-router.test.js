import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LLMRouter } from '../../src/providers/llm/router.js';
import { LLMProvider } from '../../src/providers/llm/LLMProvider.js';

class FakeHealthyFree extends LLMProvider {
  get id() { return 'fake-free'; }
  get isPaid() { return false; }
  async healthCheck() { return true; }
  async complete() {
    return { text: 'ok', model: 'fake', requestId: null, inputTokens: 1, outputTokens: 1, estimatedCost: 0, isPaid: false };
  }
}

class FakeUnhealthyFree extends LLMProvider {
  get id() { return 'fake-unhealthy'; }
  get isPaid() { return false; }
  async healthCheck() { return false; }
  async complete() { throw new Error('should not be called'); }
}

class FakePaid extends LLMProvider {
  get id() { return 'fake-paid'; }
  get isPaid() { return true; }
  async healthCheck() { return true; }
  async complete() {
    return { text: 'paid-ok', model: 'fake-paid-model', requestId: null, inputTokens: 1, outputTokens: 1, estimatedCost: 1.5, isPaid: true };
  }
}

test('selects first healthy free provider in priority order', async () => {
  const router = new LLMRouter({
    priority: ['fake-unhealthy', 'fake-free'],
    allowPaidProviders: false,
    registry: {
      'fake-unhealthy': () => new FakeUnhealthyFree(),
      'fake-free': () => new FakeHealthyFree()
    }
  });
  const { providerUsed } = await router.complete({ prompt: 'hi' });
  assert.equal(providerUsed, 'fake-free');
});

test('never uses a paid provider unless allowPaidProviders is true', async () => {
  const router = new LLMRouter({
    priority: ['fake-paid'],
    allowPaidProviders: false,
    registry: { 'fake-paid': () => new FakePaid() }
  });
  await assert.rejects(() => router.complete({ prompt: 'hi' }), /No usable LLM provider/);
});

test('uses paid provider only when explicitly allowed', async () => {
  const router = new LLMRouter({
    priority: ['fake-paid'],
    allowPaidProviders: true,
    registry: { 'fake-paid': () => new FakePaid() }
  });
  const { providerUsed } = await router.complete({ prompt: 'hi' });
  assert.equal(providerUsed, 'fake-paid');
});

test('does not silently fall through to paid when free options are exhausted', async () => {
  const router = new LLMRouter({
    priority: ['fake-unhealthy', 'fake-paid'],
    allowPaidProviders: false,
    registry: {
      'fake-unhealthy': () => new FakeUnhealthyFree(),
      'fake-paid': () => new FakePaid()
    }
  });
  await assert.rejects(() => router.complete({ prompt: 'hi' }), /No usable LLM provider/);
});
