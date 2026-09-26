import { RETRIEVAL_STATUS } from './constants.js';
import { retrieveSource } from './retrieval.js';
import { traceAsync, safeHost } from '../diagnostics/trace.js';

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
 * @param {object} deps.policy - research_policy.json
 * @param {function} [deps.retrieveImpl] - injectable for testing (defaults to retrieveSource)
 * @param {function} [deps.fetchImpl] - forwarded to retrieveImpl
 * @returns {Promise<{acquired: Array, attemptsUsed: number, candidatesConsidered: number, candidatesExhausted: boolean, discoveryFailed: boolean, discoveryError: string|null}>}
 *   `acquired` entries: { url, title, snippet, publishedAt, status, content, error, attemptCount }
 *   `candidatesExhausted`: true iff every discovered candidate was visited
 *   by the loop below — i.e. the loop ran out of candidates on its own,
 *   rather than being cut short by `max_sources_per_research_project` or
 *   `max_acquisition_attempts`. Used by the Research pipeline to determine
 *   whether the acquisition pass reached a legitimate stopping boundary
 *   (candidate exhaustion or the source cap) as opposed to merely hitting
 *   the attempts safety ceiling while candidates remained (Owner decision:
 *   see docs/DECISIONS/RESEARCH-GOVERNANCE-BASELINE.md §10, §15 — the
 *   attempts cap is a resource/safety ceiling, not evidence the bounded
 *   acquisition pass was completed).
 */
export async function acquireSources({ provider, query, policy, retrieveImpl = retrieveSource, fetchImpl }) {
  const maxSources = policy.acquisition.max_sources_per_research_project;
  const maxAttempts = policy.acquisition.max_acquisition_attempts;
  const maxRetriesPerSource = policy.retry.max_retries_per_source;

  let candidates = [];
  let discoveryFailed = false;
  let discoveryError = null;
  try {
    const discovery = await traceAsync(
      'research.discover', { provider: provider?.id },
      () => provider.discoverCandidates({ query, maxResults: maxSources, alreadyAcquiredUrls: [] }),
      (d) => ({ candidates: d?.candidates?.length, failures: d?.failures?.length })
    );
    candidates = discovery.candidates || [];
  } catch (err) {
    // Discovery failure is isolated: the acquisition run reports zero
    // acquired sources rather than throwing (v0.3 S3: three-way failure
    // distinction — this is the "discovery failure" case).
    discoveryFailed = true;
    discoveryError = err.message;
    return { acquired: [], attemptsUsed: 0, candidatesConsidered: 0, candidatesExhausted: false, discoveryFailed, discoveryError };
  }

  const acquired = [];
  let attemptsUsed = 0;
  // Counts candidates the loop actually entered (i.e. neither break below
  // fired before reaching them). Compared against candidates.length after
  // the loop to determine candidatesExhausted — see the returns-JSDoc note
  // above for why this distinction matters.
  let candidatesVisited = 0;

  for (const candidate of candidates) {
    if (acquired.length >= maxSources) break;
    if (attemptsUsed >= maxAttempts) break;
    candidatesVisited++;

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

  const candidatesExhausted = candidatesVisited === candidates.length;

  return { acquired, attemptsUsed, candidatesConsidered: candidates.length, candidatesExhausted, discoveryFailed, discoveryError };
}