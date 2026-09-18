// Candidate provider implementations. Each is a thin adapter around a
// specific vendor's API. None of these are architectural commitments —
// they are swappable via config.llmProviderPriority (see ADR-0001).
//
// Network calls are deliberately NOT wired to real endpoints in M0
// scaffolding — that's an application concern for Phase 2+, once API
// keys exist. These stubs establish the CONTRACT (interface + cost
// accounting shape) so business logic can be built and tested against
// them now via the LocalStubProvider below.

import { LLMProvider } from './LLMProvider.js';
import { GroqProvider } from './GroqProvider.js';

class UnconfiguredProvider extends LLMProvider {
  constructor(id, { isPaid = false } = {}) {
    super();
    this._id = id;
    this._isPaid = isPaid;
  }

  get id() {
    return this._id;
  }

  get isPaid() {
    return this._isPaid;
  }

  async healthCheck() {
    // No live implementation exists yet in M0 scaffolding, regardless of
    // whether an API key happens to be configured -> always reports
    // unhealthy so the router falls through instead of selecting a
    // provider whose complete() is guaranteed to throw (F2-L1).
    return false;
  }

  async complete() {
    throw new Error(
      `Provider "${this._id}" has no live implementation yet in M0 scaffolding. ` +
      'Wire the real API call in Phase 2+ once credentials are configured.'
    );
  }
}

export const GeminiFreeProvider = () => new UnconfiguredProvider('gemini-free', { isPaid: false });
export const GroqFreeProvider = () => new GroqProvider();
export const OpenRouterFreeProvider = () => new UnconfiguredProvider('openrouter-free', { isPaid: false });
export const DeepSeekPaidProvider = () => new UnconfiguredProvider('deepseek-paid', { isPaid: true });

/**
 * A fully local, zero-network, zero-cost provider. Used for tests,
 * simulation-mode dry runs, and offline development so the pipeline can
 * be exercised end-to-end without any external dependency.
 */
export class LocalStubProvider extends LLMProvider {
  get id() {
    return 'local-stub';
  }

  get isPaid() {
    return false;
  }

  async healthCheck() {
    return true;
  }

  async complete({ prompt = '' }) {
    return {
      text: `[local-stub response for prompt of length ${prompt.length}]`,
      model: 'local-stub-v0',
      requestId: null,
      inputTokens: prompt.length,
      outputTokens: 0,
      estimatedCost: 0,
      isPaid: false
    };
  }
}

export const REGISTRY = {
  'gemini-free': GeminiFreeProvider,
  'groq-free': GroqFreeProvider,
  'openrouter-free': OpenRouterFreeProvider,
  'deepseek-paid': DeepSeekPaidProvider,
  'local-stub': () => new LocalStubProvider()
};