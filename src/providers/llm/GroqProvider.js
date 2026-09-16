import { LLMProvider } from './LLMProvider.js';

/**
 * Real implementation of the 'groq-free' provider id (see candidates.js /
 * REGISTRY and ADR-0001's LLMProvider abstraction). Groq's OpenAI-
 * compatible chat completions endpoint, using a free-tier model, chosen
 * as the smallest real provider that fits the existing R0-first
 * architecture: no SDK, a single REST call, and an API key already
 * documented as GROQ_FREE_API_KEY in .env.example.
 *
 * Mirrors the established fetchImpl-injection pattern used by
 * src/publication/youtube/YouTubeAdapter.js: fetchImpl is injectable so
 * tests never make a real network call and never need a real key.
 *
 * Contract (LLMProvider): complete() returns exactly
 * { text, model, requestId, inputTokens, outputTokens, estimatedCost, isPaid }
 * or throws. healthCheck() returns a boolean, never throws (the router
 * relies on this to fall through to the next provider in priority order).
 */
export class GroqProvider extends LLMProvider {
  /**
   * @param {object} [opts]
   * @param {typeof fetch} [opts.fetchImpl] - injectable for tests; defaults to global fetch.
   * @param {() => string|undefined} [opts.apiKeyProvider] - defaults to reading GROQ_FREE_API_KEY from process.env.
   * @param {string} [opts.model] - defaults to 'llama-3.1-8b-instant' (a Groq free-tier model).
   */
  constructor({
    fetchImpl = fetch,
    apiKeyProvider = () => process.env.GROQ_FREE_API_KEY,
    model = 'llama-3.1-8b-instant'
  } = {}) {
    super();
    this._fetch = fetchImpl;
    this._apiKeyProvider = apiKeyProvider;
    this._model = model;
  }

  get id() {
    return 'groq-free';
  }

  get isPaid() {
    return false;
  }

  /** True only when an API key is present. Never makes a network call. */
  async healthCheck() {
    return Boolean(this._apiKeyProvider());
  }

  async complete({ prompt, system, maxTokens } = {}) {
    const apiKey = this._apiKeyProvider();
    if (!apiKey) {
      throw new Error('GroqProvider.complete() called with no GROQ_FREE_API_KEY configured.');
    }

    const messages = [];
    if (system) messages.push({ role: 'system', content: system });
    messages.push({ role: 'user', content: prompt ?? '' });

    const body = {
      model: this._model,
      messages,
      ...(maxTokens ? { max_tokens: maxTokens } : {})
    };

    const res = await this._fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      throw new Error(`GroqProvider request failed with HTTP ${res.status}`);
    }

    const data = await res.json();
    const choice = data?.choices?.[0]?.message?.content;
    if (typeof choice !== 'string') {
      throw new Error('GroqProvider received a response with no usable completion text.');
    }

    return {
      text: choice,
      model: data.model ?? this._model,
      requestId: data.id ?? null,
      inputTokens: data.usage?.prompt_tokens ?? null,
      outputTokens: data.usage?.completion_tokens ?? null,
      estimatedCost: 0,
      isPaid: false
    };
  }
}

export default GroqProvider;
