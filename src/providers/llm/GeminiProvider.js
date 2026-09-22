import { LLMProvider } from './LLMProvider.js';

// Mirrors GroqProvider's non-2xx diagnostics and bounded 429 retry, adapted
// to the Gemini API's error shape (`{ error: { code, message, status } }`)
// and header names. Gemini does not document a stable set of rate-limit
// response headers analogous to Groq's x-ratelimit-*, so no header
// extraction is attempted here; Retry-After (when present) is still honored.

// Bounds how much of a non-JSON error body is retained on the thrown error,
// so an unexpectedly huge provider response can't bloat the exception.
const MAX_NON_JSON_ERROR_BODY_LENGTH = 2000;

// Bounded 429 retry, matching GroqProvider: exactly one retry (two attempts
// total) for a rate-limited request; every other non-2xx status remains
// immediately non-retryable.
const MAX_ATTEMPTS_ON_429 = 2;

// Used only when a 429 response has no usable Retry-After value.
const FALLBACK_RETRY_DELAY_MS = 2000;

/**
 * Parses Retry-After's numeric-seconds form. The HTTP-date form is
 * intentionally not handled -- an unparseable or missing value is treated
 * as absent, so the caller falls back to FALLBACK_RETRY_DELAY_MS.
 */
function parseRetryAfterMs(retryAfterHeaderValue) {
  if (retryAfterHeaderValue === null || retryAfterHeaderValue === undefined || retryAfterHeaderValue === '') {
    return null;
  }
  const seconds = Number(retryAfterHeaderValue);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }
  return null;
}

/**
 * Builds the Error thrown by complete() for a non-2xx Gemini response.
 * Reads the response body exactly once (as text), then attempts to parse
 * it as JSON to recover a useful provider error message; falls back to a
 * bounded plain-text representation when the body isn't JSON.
 */
async function buildGeminiRequestError(res) {
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
    if (typeof parsed?.error?.message === 'string') {
      providerMessage = parsed.error.message;
    }
  } catch {
    providerBody = bodyText.length > MAX_NON_JSON_ERROR_BODY_LENGTH
      ? `${bodyText.slice(0, MAX_NON_JSON_ERROR_BODY_LENGTH)}...(truncated)`
      : bodyText;
  }

  const error = new Error(
    `GeminiProvider request failed with HTTP ${res.status}${providerMessage ? `: ${providerMessage}` : ''}`
  );
  error.status = res.status;
  error.retryAfter = res.headers?.get?.('retry-after') ?? null;
  error.providerBody = providerBody;
  return error;
}

/**
 * Real implementation of the 'gemini-free' provider id (see candidates.js /
 * REGISTRY and ADR-0001's LLMProvider abstraction). Google's Gemini
 * Developer API (generativelanguage.googleapis.com), using a free-tier
 * model, added to unblock the Discovery LLM workload from Groq's free-tier
 * TPM limit -- Groq's integration is untouched (see GroqProvider.js) and
 * remains selectable via config.llmProviderPriority / the router's normal
 * fallthrough.
 *
 * Mirrors GroqProvider's fetchImpl-injection pattern so tests never make a
 * real network call and never need a real key.
 *
 * Contract (LLMProvider): complete() returns exactly
 * { text, model, requestId, inputTokens, outputTokens, estimatedCost, isPaid }
 * or throws. healthCheck() returns a boolean, never throws (the router
 * relies on this to fall through to the next provider in priority order).
 *
 * On a non-2xx response, the thrown Error carries error.status (number),
 * error.retryAfter (string|null, from the Retry-After header), and
 * error.providerBody (the parsed JSON error body, or a bounded text
 * excerpt if the body wasn't JSON), in addition to a human-readable
 * error.message. A 429 specifically is retried once (see
 * MAX_ATTEMPTS_ON_429), honoring Retry-After when present and otherwise
 * waiting FALLBACK_RETRY_DELAY_MS; every other non-2xx status remains
 * immediately non-retryable. This is transport-layer resilience only: it
 * does not change provider selection (LLMRouter is untouched), request
 * semantics, or the success/error contract shapes documented above.
 */
export class GeminiProvider extends LLMProvider {
  /**
   * @param {object} [opts]
   * @param {typeof fetch} [opts.fetchImpl] - injectable for tests; defaults to global fetch.
   * @param {() => string|undefined} [opts.apiKeyProvider] - defaults to reading GEMINI_FREE_API_KEY from process.env.
   * @param {string} [opts.model] - defaults to 'gemini-2.5-flash-lite' (a current Gemini free-tier model; see report for shutdown-date caveat).
   * @param {(ms: number) => Promise<void>} [opts.sleepImpl] - injectable delay for the 429 retry, so tests never wait in real time.
   */
  constructor({
    fetchImpl = fetch,
    apiKeyProvider = () => process.env.GEMINI_FREE_API_KEY,
    model = 'gemini-2.5-flash-lite',
    sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  } = {}) {
    super();
    this._fetch = fetchImpl;
    this._apiKeyProvider = apiKeyProvider;
    this._model = model;
    this._sleep = sleepImpl;
  }

  get id() {
    return 'gemini-free';
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
      throw new Error('GeminiProvider.complete() called with no GEMINI_FREE_API_KEY configured.');
    }

    const body = {
      contents: [{ role: 'user', parts: [{ text: prompt ?? '' }] }],
      ...(system ? { system_instruction: { parts: [{ text: system }] } } : {}),
      ...(maxTokens ? { generationConfig: { maxOutputTokens: maxTokens } } : {})
    };

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this._model}:generateContent`;

    let res;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS_ON_429; attempt++) {
      res = await this._fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey
        },
        body: JSON.stringify(body)
      });

      if (res.ok) break;

      // Only 429 is retryable, and only up to MAX_ATTEMPTS_ON_429 total
      // attempts -- every other non-2xx status (400/401/403/404/5xx, etc.)
      // and an exhausted 429 retry both throw immediately here.
      if (res.status !== 429 || attempt === MAX_ATTEMPTS_ON_429) {
        throw await buildGeminiRequestError(res);
      }

      const delayMs = parseRetryAfterMs(res.headers?.get?.('retry-after')) ?? FALLBACK_RETRY_DELAY_MS;
      await this._sleep(delayMs);
    }

    const data = await res.json();
    const parts = data?.candidates?.[0]?.content?.parts;
    const text = Array.isArray(parts) ? parts.map((p) => p?.text ?? '').join('') : '';
    if (!text) {
      throw new Error('GeminiProvider received a response with no usable completion text.');
    }

    return {
      text,
      model: data.modelVersion ?? this._model,
      requestId: data.responseId ?? null,
      inputTokens: data.usageMetadata?.promptTokenCount ?? null,
      outputTokens: data.usageMetadata?.candidatesTokenCount ?? null,
      estimatedCost: 0,
      isPaid: false
    };
  }
}

export default GeminiProvider;
