import { SCRIPT_FALLBACK_QUERY_MAX_LENGTH } from './constants.js';

/**
 * Derives ONE free-text visual query from already-persisted content
 * context, per this milestone's explicit input-priority order:
 *
 *   1. content_briefs.visual_ideas
 *   2. a deterministic Script fallback, only if visual_ideas is empty
 *
 * Never invents unrelated topics, never calls an LLM, never makes a
 * network call. Returns null when there is genuinely no usable visual
 * context -- callers must treat that as "no acquisition", not as an
 * error and not as license to fabricate a query.
 *
 * The Script fallback is deliberately simple and deterministic: the
 * first sentence of `script.body` (split on '.', trimmed), truncated to
 * SCRIPT_FALLBACK_QUERY_MAX_LENGTH characters. This is a safe, bounded
 * signal already present on the row Production itself already depends
 * on (src/production/eligibility.js resolveCurrentScript) -- no new
 * schema, no new dependency, no derived/generated topic.
 *
 * @param {{visual_ideas?: string|null}} contentBrief
 * @param {{body?: string|null}} [script]
 * @returns {string|null}
 */
export function deriveVisualQuery(contentBrief, script) {
  const visualIdeas = typeof contentBrief?.visual_ideas === 'string' ? contentBrief.visual_ideas.trim() : '';
  if (visualIdeas) {
    return visualIdeas;
  }

  const body = typeof script?.body === 'string' ? script.body.trim() : '';
  if (!body) {
    return null;
  }

  const firstSentence = body.split('.')[0].trim();
  if (!firstSentence) {
    return null;
  }

  return firstSentence.length > SCRIPT_FALLBACK_QUERY_MAX_LENGTH
    ? firstSentence.slice(0, SCRIPT_FALLBACK_QUERY_MAX_LENGTH).trim()
    : firstSentence;
}

export default deriveVisualQuery;
