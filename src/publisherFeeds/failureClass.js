import { FAILURE_CLASS, FAILURE_UNCLASSIFIED } from './constants.js';

const PROVENANCE_SCHEMA = 'source_provenance/v1';

/**
 * Reads the `retrieval` block of a sources.notes provenance JSON. Parsed
 * locally (not via src/research) so this module stays decoupled from the
 * frozen Research surface. Returns null when notes are absent/unreadable.
 */
export function readRetrievalProvenance(notes) {
  if (typeof notes !== 'string' || notes === '') return null;
  try {
    const p = JSON.parse(notes);
    if (!p || p.schema !== PROVENANCE_SCHEMA || !p.retrieval || typeof p.retrieval !== 'object') return null;
    const r = p.retrieval;
    return {
      retrievedAt: r.retrievedAt ?? null,
      method: r.method ?? null,
      status: r.status ?? null,
      error: typeof r.error === 'string' ? r.error : null
    };
  } catch {
    return null;
  }
}

/**
 * An HTTP failure is recognised only when the status is the FIRST thing in the
 * message, optionally behind one known retrieval wrapper prefix such as
 * `reader HTTP 403` or `reader fallback failed: HTTP 503`. The status must be
 * 400-599 and followed by end, whitespace or punctuation. "HTTP 403" appearing
 * later in free text (e.g. a proxy or parse message that merely mentions it)
 * is NOT an HTTP failure.
 */
const HTTP_STATUS_TEXT = /^(?:(?:reader(?:[ _-]fallback)?|fallback|plain|retrieval)(?:\s+(?:failed|error))?\s*:?\s+)?HTTP (\d{3})(?=$|[\s:.,;)\]-])/i;

/**
 * Error texts that positively establish "our client obtained no HTTP response", so no host decision was
 * made: Node's fetch reports `fetch failed` (connection/DNS/TLS level; the cause is not in the message)
 * and the abort/timeout messages. Matched against the WHOLE message (trimmed, whitespace collapsed,
 * case-insensitive), optionally behind the reader wrapper `reader failed: `. A message that merely
 * contains these words (`prefetch failed`, `fetch failed to parse the page`) does NOT match. This states
 * what happened to the attempt, never why. Anything else is `unclassified`: absence of evidence is not
 * reported as an internal failure.
 */
const NETWORK_ERROR_TEXT = /^(?:reader failed:\s+)?fetch failed$/i;
const TIMEOUT_ERROR_TEXT = /^(?:reader failed:\s+)?(?:this operation was aborted|the operation was aborted(?: due to timeout)?)\.?$/i;
function noResponseDetail(text) {
  const t = text.trim().replace(/\s+/g, ' ');
  if (NETWORK_ERROR_TEXT.test(t)) return 'no_http_response:network_error';
  if (TIMEOUT_ERROR_TEXT.test(t)) return 'no_http_response:timeout';
  return null;
}

/**
 * Classifies a FAILED retrieval from its recorded error text. The original
 * text and HTTP status are always returned unmodified. The class says WHO
 * refused or failed, never WHY: a 401/403 is reported as the host refusing
 * the request. No claim is made about the mechanism behind it.
 *
 * @returns {{failureClass: string, httpStatus: number|null, originalError: string|null, detail: string|null}}
 */
export function classifyRetrievalFailure(error) {
  const text = typeof error === 'string' && error !== '' ? error : null;
  const m = text ? HTTP_STATUS_TEXT.exec(text.trim()) : null;
  if (!m || Number(m[1]) < 400 || Number(m[1]) > 599) {
    const noResponse = text ? noResponseDetail(text) : null;
    if (noResponse) {
      return { failureClass: FAILURE_CLASS.INTERNAL_RETRIEVAL_FAILURE, httpStatus: null, originalError: text, detail: noResponse };
    }
    return {
      failureClass: FAILURE_UNCLASSIFIED,
      httpStatus: null,
      originalError: text,
      detail: text ? 'unrecognized_error_text' : 'no_error_recorded'
    };
  }
  const httpStatus = Number(m[1]);
  let failureClass = FAILURE_CLASS.HOST_HTTP_ERROR;
  if (httpStatus === 401 || httpStatus === 403) failureClass = FAILURE_CLASS.HOST_ACCESS_DENIED;
  else if (httpStatus === 429) failureClass = FAILURE_CLASS.HOST_RATE_LIMITED;
  return { failureClass, httpStatus, originalError: text, detail: null };
}

/** Convenience: classify straight from a sources row's notes. */
export function classifySourceFailure(notes) {
  const retrieval = readRetrievalProvenance(notes);
  const c = classifyRetrievalFailure(retrieval?.error ?? null);
  if (!retrieval && c.detail === 'no_error_recorded') c.detail = 'provenance_unreadable';
  return { ...c, retrievalMethod: retrieval?.method ?? null, retrievalStatus: retrieval?.status ?? null };
}
