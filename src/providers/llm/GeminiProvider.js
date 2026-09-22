import { LLMProvider } from './LLMProvider.js';

// Mirrors GroqProvider's non-2xx diagnostics and bounded 429 retry, adapted
// to the Gemini API's error shape (`{ error: { code, message, status,
// details } }`). Gemini does not send a standard Retry-After header; its
// actual retry guidance instead arrives inside the JSON error body, either
// as a `type.googleapis.com/google.rpc.RetryInfo` detail entry (e.g.
// `{ retryDelay: "6.203550290s" }`) or, failing that, embedded in the
// message text ("...Please retry in 6.203550290s."). Both are parsed below;
// the Retry-After header is still checked first for forward-compatibility,
// but in practice it is not what Gemini returns.

// Bounds how much of a non-JSON error body is retained on the thrown error,
// so an unexpectedly huge provider response can't bloat the exception.
const MAX_NON_JSON_ERROR_BODY_LENGTH = 2000;

// Bounded 429 retry, matching GroqProvider: exactly one retry (two attempts
// total) for a rate-limited request; every other non-2xx status remains
// immediately non-retryable.
const MAX_ATTEMPTS_ON_429 = 2;

// Used only when a 429 response has no usable retry-delay value from any
// source (header, RetryInfo detail, or message text).
const FALLBACK_RETRY_DELAY_MS = 2000;

// Provider-local pacing floor, added after a real GitHub Actions run hit
// Gemini's confirmed free-tier limit of 15 requests/minute for
// gemini-3.5-flash-lite (generate_content_free_tier_requests, HTTP 429
// RESOURCE_EXHAUSTED). Discovery's LLM calls are already strictly
// sequential (no concurrency to coordinate here), so a simple minimum
// gap between the START of one complete() call and the START of the next
// is sufficient to keep normal, successful traffic under quota. 4.5s
// targets ~13.3 requests/minute -- under the 15/min limit with a safety
// margin, without touching Discovery's candidate limits, dedup workload
// caps, retry count, model, or router priority. This paces the outer
// complete() call only; the existing bounded 429 retry (and its own,
// much larger, Gemini-supplied retry delay) is untouched below.
const MIN_REQUEST_INTERVAL_MS = 4500;

/**
 * Parses a numeric-seconds value (as used by both the Retry-After header's
 * numeric-seconds form and Gemini's RetryInfo `retryDelay` field, e.g. "6"
 * or "6.203550290s"). Trailing non-digit units (like the "s" suffix
 * RetryInfo always includes) are stripped before parsing. An unparseable
 * or missing value returns null so the caller can fall through to the next
 * source.
 */
function parseSecondsToMs(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const seconds = Number.parseFloat(String(value));
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }
  return null;
}

/**
 * Extracts Gemini's own retry-delay guidance from an already-parsed JSON
 * error body: first from a `google.rpc.RetryInfo` detail entry (the
 * structured, documented source), then as a fallback from the "Please
 * retry in <N>s." text Gemini also includes in `error.message`. Returns
 * milliseconds, or null if neither source yields a usable value.
 */
function extractGeminiRetryDelayMs(providerBody) {
  const details = providerBody?.error?.details;
  if (Array.isArray(details)) {
    const retryInfo = details.find((d) => d?.['@type']?.includes('RetryInfo') && d?.retryDelay);
    const fromDetail = parseSecondsToMs(retryInfo?.retryDelay);
    if (fromDetail !== null) return fromDetail;
  }

  const message = providerBody?.error?.message;
  if (typeof message === 'string') {
    const match = message.match(/retry in\s+([\d.]+)\s*s/i);
    if (match) {
      const fromMessage = parseSecondsToMs(match[1]);
      if (fromMessage !== null) return fromMessage;
    }
  }

  return null;
}

/**
 * Reads and parses a non-2xx Gemini response body exactly once. Returns
 * `{ providerBody, providerMessage, retryDelayMs }` -- the parsed JSON
 * body (or a bounded plain-text excerpt if the body wasn't JSON), the
 * human-readable provider message if present, and Gemini's own retry
 * delay in milliseconds if either source in extractGeminiRetryDelayMs()
 * yielded one.
 */
async function readGeminiErrorBody(res) {
  let bodyText = '';
  try {
    bodyText = await res.text();
  } catch {
    bodyText = '';
  }

  let providerBody;
  let providerMessage = null;
  let retryDelayMs = null;
  try {
    const parsed = JSON.parse(bodyText);
    providerBody = parsed;
    if (typeof parsed?.error?.message === 'string') {
      providerMessage = parsed.error.message;
    }
    retryDelayMs = extractGeminiRetryDelayMs(parsed);
  } catch {
    providerBody = bodyText.length > MAX_NON_JSON_ERROR_BODY_LENGTH
      ? `${bodyText.slice(0, MAX_NON_JSON_ERROR_BODY_LENGTH)}...(truncated)`
      : bodyText;
  }

  return { providerBody, providerMessage, retryDelayMs };
}

/**
 * Builds the Error thrown by complete() for a non-2xx Gemini response, from
 * an already-read body (see readGeminiErrorBody -- the body is read at
 * most once per attempt, whether or not that attempt is retried).
 */
function buildGeminiRequestError(res, { providerBody, providerMessage }) {
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
 * error.retryAfter (string|null, from the Retry-After header -- normally
 * absent for Gemini; see module docstring), and error.providerBody (the
 * parsed JSON error body, or a bounded text excerpt if the body wasn't
 * JSON), in addition to a human-readable error.message. A 429 specifically
 * is retried once (see MAX_ATTEMPTS_ON_429), waiting for whichever of these
 * yields a value first: the Retry-After header, Gemini's own RetryInfo
 * detail, the "Please retry in Ns" text in its message, or otherwise
 * FALLBACK_RETRY_DELAY_MS. Every other non-2xx status remains immediately
 * non-retryable. This is transport-layer resilience only: it does not
 * change provider selection (LLMRouter is untouched), request semantics,
 * or the success/error contract shapes documented above.
 */
export class GeminiProvider extends LLMProvider {
  /**
   * @param {object} [opts]
   * @param {typeof fetch} [opts.fetchImpl] - injectable for tests; defaults to global fetch.
   * @param {() => string|undefined} [opts.apiKeyProvider] - defaults to reading GEMINI_FREE_API_KEY from process.env.
   * @param {string} [opts.model] - defaults to 'gemini-3.5-flash-lite'. gemini-2.5-flash-lite was the
   *   original choice but returns HTTP 404 "no longer available to new users" for keys created after
   *   its cutoff (confirmed against this project's key via the scheduled workflow's first real run);
   *   Google's own error body names gemini-3.5-flash-lite as the replacement, which is what's used here.
   * @param {(ms: number) => Promise<void>} [opts.sleepImpl] - injectable delay for the 429 retry and the pacing floor, so tests never wait in real time.
   * @param {() => number} [opts.nowImpl] - injectable clock (ms) for the pacing floor, so tests never wait in real time.
   */
  constructor({
    fetchImpl = fetch,
    apiKeyProvider = () => process.env.GEMINI_FREE_API_KEY,
    model = 'gemini-3.5-flash-lite',
    sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    nowImpl = () => Date.now()
  } = {}) {
    super();
    this._fetch = fetchImpl;
    this._apiKeyProvider = apiKeyProvider;
    this._model = model;
    this._sleep = sleepImpl;
    this._now = nowImpl;
    // Timestamp (per nowImpl) that the most recent complete() call started
    // its request at. null until the first call. Instance-scoped, so
    // pacing is per-GeminiProvider-instance -- Groq/OpenRouter, and any
    // other provider, are entirely unaffected (see module docstring).
    this._lastRequestStartedAt = null;
  }

  /**
   * Blocks (via sleepImpl) only long enough to keep at least
   * MIN_REQUEST_INTERVAL_MS between the start of consecutive complete()
   * calls on this instance. The first call is never delayed. Runs once
   * per complete() call, not per retry attempt -- the 429 retry's own,
   * larger, Gemini-supplied delay already covers the retry sub-request.
   */
  async _waitForPacingSlot() {
    const now = this._now();
    if (this._lastRequestStartedAt !== null) {
      const elapsed = now - this._lastRequestStartedAt;
      const remaining = MIN_REQUEST_INTERVAL_MS - elapsed;
      if (remaining > 0) {
        await this._sleep(remaining);
      }
    }
    this._lastRequestStartedAt = this._now();
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

    await this._waitForPacingSlot();

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

      // The body is read at most once per attempt (never again below),
      // whether this attempt is the final failure or a retryable 429.
      const errorBody = await readGeminiErrorBody(res);

      // Only 429 is retryable, and only up to MAX_ATTEMPTS_ON_429 total
      // attempts -- every other non-2xx status (400/401/403/404/5xx, etc.)
      // and an exhausted 429 retry both throw immediately here.
      if (res.status !== 429 || attempt === MAX_ATTEMPTS_ON_429) {
        throw buildGeminiRequestError(res, errorBody);
      }

      const delayMs = parseSecondsToMs(res.headers?.get?.('retry-after'))
        ?? errorBody.retryDelayMs
        ?? FALLBACK_RETRY_DELAY_MS;
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
