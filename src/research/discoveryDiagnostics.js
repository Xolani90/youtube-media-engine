import { safeUrl } from '../diagnostics/trace.js';

/**
 * Discovery diagnostics for Research source acquisition.
 *
 * PURPOSE. Make "why did discovery yield zero candidates?" answerable from the
 * database. Before this module a provider failure (or an all-excluded feed)
 * and a genuinely empty result both produced `candidates: []` and left no
 * trace, because only a THROWN discovery was recorded.
 *
 * HARD GUARANTEES (each covered by tests/unit/research-discovery-diagnostics.test.js):
 *   - NEVER THROWS. Every exported function catches internally and degrades to
 *     a fixed fallback value. A diagnostics problem can never become a Research
 *     failure, a retry, or a change in acquisition counters.
 *   - READ-ONLY. It inspects the object the provider already returned. It never
 *     calls the provider, never mutates its input, and never feeds back into
 *     candidate selection, retries, caps, candidate exhaustion or evidence
 *     admissibility.
 *   - BOUNDED. At most MAX_DIAGNOSTIC_FAILURES entries, each at most
 *     MAX_DIAGNOSTIC_TEXT characters.
 *
 * SANITIZATION IS BEST-EFFORT, NOT COMPLETE REDACTION. Provider failure text is
 * free text (several providers append the raw HTTP response body). The
 * sanitizer below removes the credential shapes this repository can plausibly
 * produce -- URL userinfo/query/fragment, Bearer/Basic tokens, and
 * `<name containing key|token|secret|password|authorization|signature|credential> = / : value`
 * pairs -- then bounds length. A secret in free prose with no such label is NOT
 * detected. Do not describe this as guaranteed secret removal.
 */

export const DISCOVERY_OUTCOME = Object.freeze({
  CANDIDATES_RETURNED: 'candidates_returned',
  EMPTY_RESULT: 'empty_result',
  PROVIDER_REPORTED_FAILURE: 'provider_reported_failure',
  MALFORMED_RESPONSE: 'malformed_provider_response',
  DISCOVERY_THREW: 'discovery_threw',
  DIAGNOSTICS_UNAVAILABLE: 'diagnostics_unavailable'
});

export const MAX_DIAGNOSTIC_FAILURES = 5;
export const MAX_DIAGNOSTIC_TEXT = 300;
// Regex work is bounded BEFORE redaction so a multi-megabyte error page cannot
// make sanitization expensive. (Cut order is not itself a security property: a
// value cut mid-way still matches the labelled-credential pattern, and a cut
// label takes its value with it.)
const PRE_REDACTION_CAP = 2000;

const SAFE_TOKEN = /^[A-Za-z0-9_.:-]{1,64}$/;
const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi;
const BEARER_RE = /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]+/gi;
const LABELLED_SECRET_RE =
  /(["']?[\w-]*(?:key|token|secret|passw(?:or)?d|authorization|signature|credential)[\w-]*["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s&,;}"')\]]+)/gi;

/** Reduces any value to a short, single-line, credential-scrubbed string. Never throws. */
export function sanitizeDiscoveryText(value, max = MAX_DIAGNOSTIC_TEXT) {
  try {
    if (value === null || value === undefined) return null;
    let text = typeof value === 'string' ? value : String(value);
    text = text.slice(0, PRE_REDACTION_CAP);
    text = text.replace(URL_RE, (match) => {
      // Trailing sentence punctuation is not part of the URL.
      const trailing = match.match(/[.,;:!?)\]}]+$/)?.[0] ?? '';
      const cleaned = safeUrl(trailing ? match.slice(0, -trailing.length) : match);
      return `${cleaned === 'unparseable-url' ? '[url]' : cleaned}${trailing}`;
    });
    text = text.replace(BEARER_RE, 'Bearer [REDACTED]');
    text = text.replace(LABELLED_SECRET_RE, '$1[REDACTED]');
    text = text.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (text.length > max) text = `${text.slice(0, max)}…`;
    return text;
  } catch {
    return '[unavailable]';
  }
}

function readProviderId(provider) {
  try {
    const id = provider?.id; // may be a throwing getter on an unimplemented base class
    return typeof id === 'string' && SAFE_TOKEN.test(id) ? id : null;
  } catch {
    return null;
  }
}

function describeThrown(err) {
  try {
    const name = typeof err?.name === 'string' && SAFE_TOKEN.test(err.name) ? err.name : 'Error';
    const message = sanitizeDiscoveryText(err?.message ?? err);
    return message ? `${name}: ${message}` : name;
  } catch {
    return '[unavailable]';
  }
}

function normalizeFailure(raw) {
  let kind = null;
  let text = null;
  try {
    if (typeof raw === 'string') {
      text = raw;
    } else if (raw && typeof raw === 'object') {
      text = raw.error ?? raw.message ?? null;
      // `kind` is provider-supplied: kept only if it is a short safe token.
      if (typeof raw.kind === 'string' && SAFE_TOKEN.test(raw.kind)) kind = raw.kind;
    }
  } catch {
    // A hostile getter degrades to an entry with no text.
  }
  return { kind, error: sanitizeDiscoveryText(text) };
}

function buildSummary({ provider, discovery, thrown }) {
  const providerId = readProviderId(provider);
  const base = { provider: providerId, candidateCount: 0, failureCount: 0, failures: [], failuresTruncated: false, malformed: [], thrown: null };

  if (thrown !== null && thrown !== undefined) {
    return { ...base, outcome: DISCOVERY_OUTCOME.DISCOVERY_THREW, thrown: describeThrown(thrown) };
  }

  if (discovery === null || typeof discovery !== 'object' || Array.isArray(discovery)) {
    return { ...base, outcome: DISCOVERY_OUTCOME.MALFORMED_RESPONSE, malformed: ['response'] };
  }

  const malformed = [];
  const rawCandidates = discovery.candidates;
  const rawFailures = discovery.failures;
  let candidateCount = 0;
  if (Array.isArray(rawCandidates)) candidateCount = rawCandidates.length;
  else if (rawCandidates !== undefined && rawCandidates !== null) malformed.push('candidates');

  let failureList = [];
  if (Array.isArray(rawFailures)) failureList = rawFailures;
  else if (rawFailures !== undefined && rawFailures !== null) malformed.push('failures');

  const failures = failureList.slice(0, MAX_DIAGNOSTIC_FAILURES).map(normalizeFailure);
  const summary = {
    ...base, candidateCount, failureCount: failureList.length, failures,
    failuresTruncated: failureList.length > MAX_DIAGNOSTIC_FAILURES, malformed
  };

  if (candidateCount > 0) return { ...summary, outcome: DISCOVERY_OUTCOME.CANDIDATES_RETURNED };
  if (malformed.length > 0) return { ...summary, outcome: DISCOVERY_OUTCOME.MALFORMED_RESPONSE };
  if (failureList.length > 0) return { ...summary, outcome: DISCOVERY_OUTCOME.PROVIDER_REPORTED_FAILURE };
  return { ...summary, outcome: DISCOVERY_OUTCOME.EMPTY_RESULT };
}

/**
 * Summarizes ONE discovery call. Pass `thrown` for a discovery that threw,
 * otherwise `discovery` (whatever the provider returned, however malformed).
 * Never throws; on any internal problem returns a fixed DIAGNOSTICS_UNAVAILABLE value.
 */
export function summarizeDiscovery({ provider = null, discovery = null, thrown = null } = {}) {
  try {
    return buildSummary({ provider, discovery, thrown });
  } catch {
    return {
      provider: null, outcome: DISCOVERY_OUTCOME.DIAGNOSTICS_UNAVAILABLE, candidateCount: 0, failureCount: 0,
      failures: [], failuresTruncated: false, malformed: [], thrown: null
    };
  }
}

/** One-line, non-empty decision_log `reason` for a summary. Never throws. */
export function describeDiscoveryOutcome(summary) {
  try {
    const outcome = typeof summary?.outcome === 'string' ? summary.outcome : DISCOVERY_OUTCOME.DIAGNOSTICS_UNAVAILABLE;
    const first = summary?.failures?.[0]?.error;
    const detail = typeof first === 'string' && first ? first : (typeof summary?.thrown === 'string' ? summary.thrown : null);
    const count = Number.isInteger(summary?.failureCount) ? summary.failureCount : 0;
    return detail ? `${outcome} (failures=${count}): ${detail}` : `${outcome} (failures=${count})`;
  } catch {
    return DISCOVERY_OUTCOME.DIAGNOSTICS_UNAVAILABLE;
  }
}
