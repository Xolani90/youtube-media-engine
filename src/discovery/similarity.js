/**
 * Local, deterministic text similarity for Event Dedup Layer 2 (v0.6 §6).
 *
 * Implementation choice (reported per v0.6 §5 implementation-time-choices
 * requirement): token-set Jaccard similarity over normalized, stop-word-
 * filtered title+description text. Chosen because it is:
 *   - deterministic for identical inputs (no model, no randomness)
 *   - O(n) in token count, trivially fast at M0 scale
 *   - requires zero network calls and zero external services (satisfies
 *     the R0 constraint frozen in v0.6 §6 — "MUST NOT require a paid API,
 *     external embedding service, or network-dependent similarity
 *     provider")
 *   - transparent/auditable: the similarity score is directly inspectable
 *     from the two token sets, unlike an opaque embedding distance
 *
 * Known limitation (reported, not hidden): Jaccard similarity is a lexical
 * measure, not a semantic one — it will under-detect duplicates that are
 * reworded with different vocabulary. This is an accepted M0 trade-off;
 * Layer 3's LLM escalation exists specifically to catch semantically
 * similar but lexically different cases that fall in the ambiguous band.
 */

const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'for',
  'with', 'is', 'are', 'was', 'were', 'be', 'this', 'that', 'it', 'at',
  'as', 'by', 'from', 'has', 'have', 'had', 'not', 'will', 'its'
]);

export function tokenize(text = '') {
  return (text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

/**
 * Jaccard similarity between two token arrays: |A ∩ B| / |A ∪ B|.
 * Returns a value in [0, 1]. Pure function, no I/O.
 */
export function jaccardSimilarity(tokensA, tokensB) {
  const setA = new Set(tokensA);
  const setB = new Set(tokensB);
  if (setA.size === 0 && setB.size === 0) return 0;
  let intersection = 0;
  for (const t of setA) {
    if (setB.has(t)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Computes local deterministic similarity between two normalized
 * observations (title + description). This is the sole Layer 2
 * implementation — no network call, no external service.
 */
export function localSimilarity(observationA, observationB) {
  const textA = `${observationA.title || ''} ${observationA.description || ''}`;
  const textB = `${observationB.title || ''} ${observationB.description || ''}`;
  return jaccardSimilarity(tokenize(textA), tokenize(textB));
}

export default localSimilarity;
