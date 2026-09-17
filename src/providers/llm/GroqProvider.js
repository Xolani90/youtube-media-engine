import { LLMProvider } from './LLMProvider.js';

// M3-B: observability-only diagnostics for non-2xx Groq responses. No
// retry/backoff/fallback is implemented here -- see GroqProvider#complete's
// docstring. Rate-limit header names Groq is documented to return; reading
// via the standard Headers#get() API is inherently case-insensitive.
const RATE_LIMIT_HEADER_NAMES = Object.freeze([
  'x-ratelimit-limit-requests',
  'x-ratelimit-remaining-requests',
  'x-ratelimit-reset-requests',
  'x-ratelimit-limit-tokens',
  'x-ratelimit-remaining-tokens',
  'x-ratelimit-reset-tokens'
]);

// Bounds how much of a non-JSON error body is retained on the thrown error,
// so an unexpectedly huge provider response can't bloat the exception.
const MAX_NON_JSON_ERROR_BODY_LENGTH = 2000;

function extractRateLimitHeaders(headers) {
  const out = {};
  for (const name of RATE_LIMIT_HEADER_NAMES) {
    const value = headers?.get?.(name);
    if (value !== null && value !== undefined) {
      out[name] = value;
    }
  }
  return out;
}

/**
 * Builds the Error thrown by complete() for a non-2xx Groq response.
 * Reads the response body exactly once (as text), then attempts to parse
 * it as JSON to recover a useful provider error message without requiring
 * the caller to understand Groq's response schema; falls back to a
 * bounded plain-text representation when the body isn't JSON. Never
 * throws itself -- a body-read failure degrades to an empty body rather
 * than masking the original HTTP failure.
 */
async function buildGroqRequestError(res) {
  let bodyText = '';
  try {
    bodyText = await res.text();
  } catch {
    bodyText = '';
  }

  let providerBody;
  let providerMessage = null;
  try {
    const parsed = JSON.parse(bodyText);
    providerBody = parsed;
    if (parsed && typeof parsed.error === 'string') {
      providerMessage = parsed.error;
    } else if (parsed && typeof parsed.error?.message === 'string') {
      providerMessage = parsed.error.message;
    }
  } catch {
    providerBody = bodyText.length > MAX_NON_JSON_ERROR_BODY_LENGTH
      ? `${bodyText.slice(0, MAX_NON_JSON_ERROR_BODY_LENGTH)}...(truncated)`
      : bodyText;
  }

  const error = new Error(
    `GroqProvider request failed with HTTP ${res.status}${providerMessage ? `: ${providerMessage}` : ''}`
  );
  error.status = res.status;
  error.retryAfter = res.headers?.get?.('retry-after') ?? null;
  error.rateLimit = extractRateLimitHeaders(res.headers);
  error.providerBody = providerBody;
  return error;
}

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
 *
 * M3-B: on a non-2xx response, the thrown Error carries structured
 * diagnostics -- error.status (number), error.retryAfter (string|null,
 * from the Retry-After header), error.rateLimit (object of whichever
 * x-ratelimit-* headers Groq returned), and error.providerBody (the
 * parsed JSON error body, or a bounded text excerpt if the body wasn't
 * JSON) -- in addition to a human-readable error.message. This is
 * observability only: no retry, backoff, or fallback is performed here
 * or in LLMRouter as a result of these diagnostics.
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
    model = 'openai/gpt-oss-20b'
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
      throw await buildGroqRequestError(res);
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
