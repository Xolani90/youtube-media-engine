import { RETRIEVAL_STATUS } from './constants.js';
import { retrieveSource } from './retrieval.js';
import { traceAsync, safeHost } from '../diagnostics/trace.js';

/**
 * R0 GDELT query-shaping (bounded experiment). Donor GDELT implementations
 * consistently pass compact keyword/phrase queries rather than a full
 * natural-language question verbatim. This is a small, explicit set of
 * interrogative/function words that are clearly unhelpful in a keyword
 * search query -- intentionally NOT a giant generic stopword list, so
 * meaningful content words, named entities, and domain-specific terms
 * always survive.
 */
const RESEARCH_QUERY_STOPWORDS = new Set([
  'what', 'how', 'why', 'when', 'where', 'who', 'which',
  'can', 'could', 'would', 'should', 'does', 'do',
  'is', 'are', 'was', 'were',
  'the', 'a', 'an', 'to', 'of', 'for', 'in', 'on', 'and'
]);

/** Deterministic bound on shaped-query length (documented by the tests). */
export const RESEARCH_QUERY_MAX_WORDS = 12;

/**
 * Absolute ceiling the bound may extend to in order to avoid truncating
 * away a word that also appears in the proposition's own `subject` field
 * (see `shapeResearchQuery`'s `subjectHint`). Still deterministic and
 * bounded -- this is not "no limit", just a slightly larger one reserved
 * for the case where the primary subject would otherwise be cut.
 */
const RESEARCH_QUERY_HARD_MAX_WORDS = 20;

function boundQueryWords(contentWords, subjectHint) {
  if (contentWords.length <= RESEARCH_QUERY_MAX_WORDS) return contentWords;

  let cutoff = RESEARCH_QUERY_MAX_WORDS;
  if (typeof subjectHint === 'string' && subjectHint.trim()) {
    const subjectWords = new Set(
      subjectHint.toLowerCase().split(/[^\p{L}\p{N}-]+/u).filter(Boolean)
    );
    const scanLimit = Math.min(contentWords.length, RESEARCH_QUERY_HARD_MAX_WORDS);
    for (let i = 0; i < scanLimit; i++) {
      if (subjectWords.has(contentWords[i].toLowerCase())) {
        cutoff = Math.max(cutoff, i + 1);
      }
    }
  }

  return contentWords.slice(0, Math.min(cutoff, RESEARCH_QUERY_HARD_MAX_WORDS));
}

/**
 * Shapes an LLM-generated `core_question` into a compact, GDELT-friendly
 * keyword/phrase query. Deterministic, bounded, and side-effect-free:
 *
 *  - strips question punctuation and possessive 's/'s (e.g. "OpenAI's" ->
 *    "OpenAI", not "OpenAIs")
 *  - normalizes whitespace
 *  - removes RESEARCH_QUERY_STOPWORDS (small explicit interrogative/
 *    function-word list) case-insensitively; everything else -- named
 *    entities, organizations, products, technologies, locations,
 *    domain-specific terms -- is preserved verbatim, including its
 *    original casing
 *  - bounds the result to RESEARCH_QUERY_MAX_WORDS words, extending the
 *    bound only as far as RESEARCH_QUERY_HARD_MAX_WORDS when needed to
 *    avoid truncating away a word already present in `subjectHint`
 *    (the proposition's existing structured `subject` field, when
 *    available -- preferred here over inventing new extraction logic)
 *  - NEVER returns an empty string: if shaping would strip everything
 *    (e.g. an all-stopword input), falls back to the normalized
 *    (whitespace-collapsed) original `coreQuestion` untouched
 *
 * @param {string} coreQuestion
 * @param {object} [opts]
 * @param {string} [opts.subjectHint] - proposition.subject, when available; used only to avoid truncating away the primary subject, never to add new content to the query
 * @returns {string}
 */
export function shapeResearchQuery(coreQuestion, { subjectHint } = {}) {
  const normalized = typeof coreQuestion === 'string' ? coreQuestion.trim().replace(/\s+/g, ' ') : '';
  if (!normalized) return normalized;

  // Possessive 's / \u2019s first, so "OpenAI's" -> "OpenAI" rather than
  // "OpenAIs" once the apostrophe itself is stripped below.
  const depossessed = normalized.replace(/([\p{L}\p{N}])['\u2019]s\b/gu, '$1');

  // Drop remaining punctuation; keep letters, digits, internal hyphens
  // (so multi-word technical/product terms like "GPT-4" survive intact).
  const stripped = depossessed
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const words = stripped.split(' ').filter(Boolean);
  const contentWords = words.filter((w) => !RESEARCH_QUERY_STOPWORDS.has(w.toLowerCase()));

  // CRITICAL FALLBACK: never let shaping produce an empty/unusable query.
  if (contentWords.length === 0) return normalized;

  return boundQueryWords(contentWords, subjectHint).join(' ');
}

/**
 * Orchestrates bounded source acquisition (Research Subsystem
 * Specification v0.3 S3, v0.4 S7).
 *
 * CRITICAL distinction enforced here: `max_acquisition_attempts` bounds
 * ACTUAL retrieval calls made via `retrieveImpl`, never merely the number
 * of discovered candidates. A source that fails is retried up to
 * `max_retries_per_source` times (so 1 initial attempt + up to 2 retries =
 * 3 attempts max per source), but the GLOBAL count of actual retrieval
 * invocations across the whole acquisition run must never exceed
 * `max_acquisition_attempts`, and the loop must terminate deterministically
 * once that cap is reached, mid-source or not.
 *
 * CONTENT_UNPARSEABLE does not retry (v0.3 S3: retrying an unparseable
 * format won't help) — it consumes exactly one attempt slot and moves on.
 *
 * @param {object} deps
 * @param {import('./ResearchSourceProvider.js').ResearchSourceProvider} deps.provider
 * @param {string} deps.query
 * @param {string} [deps.subjectHint] - proposition.subject, when available; forwarded to shapeResearchQuery to avoid truncating away the primary subject. Never sent to the provider directly.
 * @param {object} deps.policy - research_policy.json
 * @param {function} [deps.retrieveImpl] - injectable for testing (defaults to retrieveSource)
 * @param {function} [deps.fetchImpl] - forwarded to retrieveImpl
 * @returns {Promise<{acquired: Array, attemptsUsed: number, candidatesConsidered: number, discoveryFailed: boolean, discoveryError: string|null}>}
 *   `acquired` entries: { url, title, snippet, publishedAt, status, content, error, attemptCount }
 */
export async function acquireSources({ provider, query, subjectHint, policy, retrieveImpl = retrieveSource, fetchImpl }) {
  const maxSources = policy.acquisition.max_sources_per_research_project;
  const maxAttempts = policy.acquisition.max_acquisition_attempts;
  const maxRetriesPerSource = policy.retry.max_retries_per_source;

  // R0 GDELT query-shaping (bounded experiment): convert the LLM-generated
  // core_question into a compact keyword/phrase query before it reaches
  // the provider, rather than passing it through verbatim. Deterministic
  // and always non-empty (see shapeResearchQuery's fallback).
  const shapedQuery = shapeResearchQuery(query, { subjectHint });

  let candidates = [];
  let discoveryFailed = false;
  let discoveryError = null;
  try {
    const discovery = await traceAsync(
      'research.discover', { provider: provider?.id },
      () => provider.discoverCandidates({ query: shapedQuery, maxResults: maxSources, alreadyAcquiredUrls: [] }),
      (d) => ({ candidates: d?.candidates?.length, failures: d?.failures?.length })
    );
    candidates = discovery.candidates || [];
  } catch (err) {
    // Discovery failure is isolated: the acquisition run reports zero
    // acquired sources rather than throwing (v0.3 S3: three-way failure
    // distinction — this is the "discovery failure" case).
    discoveryFailed = true;
    discoveryError = err.message;
    return { acquired: [], attemptsUsed: 0, candidatesConsidered: 0, discoveryFailed, discoveryError };
  }

  const acquired = [];
  let attemptsUsed = 0;

  for (const candidate of candidates) {
    if (acquired.length >= maxSources) break;
    if (attemptsUsed >= maxAttempts) break;

    let result = null;
    let attemptCount = 0;
    const maxAttemptsPerSource = 1 + maxRetriesPerSource;

    // Initial attempt plus up to maxRetriesPerSource retries — but only on
    // FAILED (transient retrieval failure). CONTENT_UNPARSEABLE never
    // retries. Both paths are bounded by the global attempt cap.
    while (attemptsUsed < maxAttempts) {
      result = await traceAsync(
        'research.retrieve', { host: safeHost(candidate.url), attempt: attemptCount + 1 },
        () => retrieveImpl(candidate.url, { fetchImpl }),
        (r) => ({ status: r?.status })
      );
      attemptsUsed++;
      attemptCount++;

      if (result.status !== RETRIEVAL_STATUS.FAILED) break; // SUCCESS or CONTENT_UNPARSEABLE: stop, no retry
      if (attemptCount >= maxAttemptsPerSource) break; // exhausted this source's retry budget
    }

    if (result === null) break; // ran out of global attempt budget before even one try

    acquired.push({
      url: candidate.url,
      title: candidate.title ?? null,
      snippet: candidate.snippet ?? null,
      publishedAt: candidate.publishedAt ?? null,
      status: result.status,
      content: result.content,
      error: result.error,
      attemptCount
    });
  }

  return { acquired, attemptsUsed, candidatesConsidered: candidates.length, discoveryFailed, discoveryError };
}