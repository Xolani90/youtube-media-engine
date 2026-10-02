import { independenceKey } from './evidenceGrading.js';

/**
 * Per-claim evidence search cascade (Pass 47). Deterministic, no LLM.
 *
 * Donor principle (de2pressed/2see, per the Pass 47 brief): retrieve evidence
 * for ONE claim through several query families (literal, entity, metric,
 * attribution, official) instead of one formulation.
 *
 * This module only turns a claim into search-query candidates and merges
 * what an existing ResearchSourceProvider returns. It never certifies
 * evidence, creates identity, or classifies trust: every URL it surfaces
 * still goes through acquireSources(), source admissibility, relevance
 * ranking and Pass 44 verification, under the existing acquisition budget.
 */

export const QUERY_TYPE = Object.freeze({
  LITERAL: 'literal',
  ENTITY: 'entity',
  METRIC: 'metric',
  ATTRIBUTION: 'attribution',
  OFFICIAL: 'official'
});

export const DEFAULT_MAX_QUERIES_PER_CLAIM = 6;
export const MAX_OFFICIAL_QUERIES_PER_CLAIM = 2;

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MONTH_SET = new Set(MONTHS.map((m) => m.toLowerCase()));
const ATTRIBUTION_VERBS = 'announced|said|says|stated|reported|confirmed|unveiled|introduced|released|launched|claims|claimed|revealed|published';
const CONTENT_STOP = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'by', 'at', 'from', 'as', 'is', 'are', 'was', 'were', 'be', 'been', 'it', 'its', 'that', 'this', 'these', 'those', 'which', 'who', 'has', 'have', 'had', 'will', 'would', 'can', 'could', 'also', 'than', 'then', 'their', 'there', 'about', 'into', 'over', 'after', 'before', 'per']);

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const normQuery = (q) => clean(q).toLowerCase().replace(/["“”]/g, '');

/** Capitalised / digit-bearing token runs, e.g. "Gemini 4 Argon". Months are not entities. */
export function extractEntities(text) {
  const out = [];
  const re = /\b[A-Z][A-Za-z0-9&.-]*(?:\s+(?:[A-Z][A-Za-z0-9&.-]*|\d+(?:\.\d+)?))*/g;
  let m;
  while ((m = re.exec(String(text ?? ''))) !== null) {
    const words = m[0].split(' ').filter((w) => !MONTH_SET.has(w.toLowerCase()));
    const phrase = words.join(' ').replace(/[.,;:]+$/, '');
    if (phrase.length >= 2 && /^[A-Z]/.test(phrase) && !CONTENT_STOP.has(phrase.toLowerCase())) out.push({ phrase, index: m.index });
  }
  const seen = new Set();
  return out
    .filter((e) => (seen.has(e.phrase.toLowerCase()) ? false : seen.add(e.phrase.toLowerCase())))
    .sort((a, b) => b.phrase.split(' ').length - a.phrase.split(' ').length || a.index - b.index)
    .map((e) => e.phrase);
}

/** Dates, years, percentages, money and other numbers exactly as written; nothing is invented. */
export function extractMetrics(text) {
  const t = String(text ?? '');
  const found = [];
  const push = (v) => { const s = clean(v); if (s && !found.some((f) => f.toLowerCase() === s.toLowerCase())) found.push(s); };
  const monthRe = new RegExp(`\\b(?:${MONTHS.join('|')})\\s+\\d{1,2}(?:,?\\s+\\d{4})?|\\b\\d{1,2}\\s+(?:${MONTHS.join('|')})(?:\\s+\\d{4})?|\\b(?:${MONTHS.join('|')})\\s+\\d{4}`, 'g');
  for (const m of t.matchAll(monthRe)) push(m[0].replace(/,/g, ''));
  for (const m of t.matchAll(/[$€£]\s?\d[\d,]*(?:\.\d+)?(?:\s?(?:million|billion|trillion|[kKmMbB]))?/g)) push(m[0]);
  for (const m of t.matchAll(/\b\d+(?:\.\d+)?\s?%/g)) push(m[0]);
  for (const m of t.matchAll(/\b\d[\d,]*(?:\.\d+)?\s?(?:million|billion|trillion|tokens?|parameters?|GB|TB|MB|ms|users)\b/gi)) push(m[0]);
  for (const m of t.matchAll(/\b(?:19|20)\d{2}\b/g)) { if (!found.some((f) => f.includes(m[0]))) push(m[0]); }
  return found;
}

/** First explicit attribution ("Google announced ...", "according to Google"), or null. */
export function extractAttribution(text) {
  const t = String(text ?? '');
  const ent = '([A-Z][A-Za-z0-9&.-]*(?:\\s+[A-Z][A-Za-z0-9&.-]*)*)';
  const a = t.match(new RegExp(`\\b${ent}\\s+(${ATTRIBUTION_VERBS})\\b`));
  if (a && !MONTH_SET.has(a[1].toLowerCase())) return { entity: a[1], verb: a[2].toLowerCase() };
  const b = t.match(new RegExp(`\\baccording to\\s+${ent}`, 'i'));
  if (b) return { entity: b[1], verb: 'said' };
  return null;
}

function contentWords(text, exclude) {
  const ex = new Set(exclude.map((e) => e.toLowerCase()));
  return clean(text).split(/[^A-Za-z0-9$%.'’-]+/).filter(Boolean)
    .filter((w) => !CONTENT_STOP.has(w.toLowerCase()) && !/^\d/.test(w) && !ex.has(w.toLowerCase()) && w.length > 3 && !/^[A-Z]/.test(w));
}

function domainOverlap(domain, tokens) {
  return domain.toLowerCase().split(/[.-]/).filter((p) => p.length > 2 && p !== 'com' && p !== 'org' && p !== 'net' && p !== 'www')
    .filter((p) => tokens.has(p)).length;
}

/**
 * Ordered, deduplicated query candidates for one claim.
 * @returns {{ type: string, query: string }[]} at most `maxQueries` (default 6).
 */
export function buildEvidenceQueries({ claim, subject = null, coreQuestion = null, linkedSources = [], classification = {}, maxQueries = DEFAULT_MAX_QUERIES_PER_CLAIM } = {}) {
  const claimText = clean(typeof claim === 'string' ? claim : claim?.claim);
  if (!claimText) return [];
  const entities = extractEntities(claimText);
  const metrics = extractMetrics(claimText);
  const attribution = extractAttribution(claimText);
  const top = entities.slice(0, 2);
  const queries = [];
  const add = (type, query) => { const q = clean(query); if (q) queries.push({ type, query: q }); };

  add(QUERY_TYPE.LITERAL, claimText);

  if (top.length) {
    const words = contentWords(claimText, entities.flatMap((e) => e.split(' '))).slice(0, 1);
    add(QUERY_TYPE.ENTITY, [...top, ...words, ...metrics.slice(0, 1)].join(' '));
  }
  if (metrics.length) {
    add(QUERY_TYPE.METRIC, [...(top.length ? [`"${top[0]}"`] : []), ...metrics.slice(0, 2).map((m) => `"${m}"`)].join(' '));
  }
  if (attribution) {
    const rest = entities.filter((e) => e.toLowerCase() !== attribution.entity.toLowerCase()).slice(0, 2);
    add(QUERY_TYPE.ATTRIBUTION, [`"${attribution.entity}"`, attribution.verb, ...rest, ...metrics.slice(0, 1)].join(' '));
  }

  const termTokens = new Set(clean([claimText, subject ?? '', coreQuestion ?? ''].join(' ')).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  const keyTerms = [...top, ...metrics.slice(0, 1)].join(' ') || contentWords(claimText, []).slice(0, 4).join(' ');

  const official = (classification.authoritativeDomains ?? [])
    .map((d, i) => ({ d, i, score: domainOverlap(d, termTokens) }))
    .filter((o) => o.score > 0)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, MAX_OFFICIAL_QUERIES_PER_CLAIM);

  if (official[0]) add(QUERY_TYPE.OFFICIAL, `site:${official[0].d} ${keyTerms}`);
  if (official[1]) add(QUERY_TYPE.OFFICIAL, `site:${official[1].d} ${keyTerms}`);

  const seen = new Set();
  const out = [];
  for (const q of queries) {
    const key = normQuery(q.query);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(q);
    if (out.length >= Math.max(1, maxQueries)) break;
  }
  return out;
}

// Pass 48: no `site:<linked source domain>` query. A second page on a domain that
// already supports the claim is never independent corroboration (one registrable
// domain = one source), so such a query only spends source slots.
const LOCALE_PATH = /\/(intl\/[a-z]{2}(-[a-z]{2,4})?|[a-z]{2}-[a-z]{2,4})(\/|$)/i;
const pathOf = (u) => { try { return new URL(u).pathname; } catch { return ''; } };
const isLocalized = (u) => LOCALE_PATH.test(pathOf(u));
const hostOf = (u) => { try { return new URL(u).hostname.toLowerCase(); } catch { return null; } };
const domainKey = (u) => independenceKey(u) ?? hostOf(u) ?? String(u);
export const DEFAULT_MAX_CANDIDATES_PER_DOMAIN = 2;

const urlKey = (u) => String(u ?? '').trim().replace(/#.*$/, '').replace(/\/+$/, '');

/**
 * Runs the cascade through the EXISTING provider and merges candidates.
 * - At most min(queries.length, maxQueries) discovery calls (callers pass the
 *   remaining acquisition attempts as maxQueries, so the cascade cannot
 *   outgrow the acquisition budget).
 * - Candidates are interleaved round-robin across queries, deduplicated by
 *   URL, known URLs excluded, capped at `maxCandidates`.
 * - A candidate keeps the FIRST query type that found it and gains any
 *   metadata (title/snippet/publishedAt) its first discovery lacked.
 * - A throwing query is isolated; it only costs that query.
 */
export async function discoverWithCascade({ provider, queries, maxQueries, maxResults, knownUrls = [], maxCandidates, excludeDomains = [], maxPerDomain = DEFAULT_MAX_CANDIDATES_PER_DOMAIN, diagnostics = null }) {
  const known = new Set([...knownUrls].map(urlKey));
  const excluded = new Set([...excludeDomains].filter(Boolean).map((d) => String(d).toLowerCase()));
  const attempted = queries.slice(0, Math.max(0, maxQueries));
  const lists = [];
  const failures = [];
  let returned = 0;
  for (const q of attempted) {
    try {
      const d = await provider.discoverCandidates({ query: q.query, maxResults, alreadyAcquiredUrls: [...known] });
      const list = (d?.candidates ?? []).filter((c) => c?.url);
      returned += list.length;
      lists.push({ type: q.type, list });
      if (Array.isArray(d?.failures)) failures.push(...d.failures);
    } catch (err) {
      lists.push({ type: q.type, list: [] });
      failures.push({ query: q.type, error: String(err?.message ?? err) });
    }
  }
  const merged = new Map();
  const depth = Math.max(0, ...lists.map((l) => l.list.length));
  for (let i = 0; i < depth; i++) {
    for (const { type, list } of lists) {
      const c = list[i];
      if (!c) continue;
      const key = urlKey(c.url);
      if (known.has(key)) continue;
      if (excluded.has(domainKey(c.url))) continue;
      const prev = merged.get(key);
      if (!prev) { merged.set(key, { ...c, discoveryQueryType: type }); continue; }
      for (const f of ['title', 'snippet', 'publishedAt']) if (prev[f] == null && c[f] != null) prev[f] = c[f];
    }
  }
  // Prefer canonical (non-localized) URLs, keeping interleave order otherwise (stable),
  // then allow at most `maxPerDomain` URLs per registrable domain.
  const ordered = [...merged.values()].map((c, i) => ({ c, i, loc: isLocalized(c.url) ? 1 : 0 }))
    .sort((a, b) => a.loc - b.loc || a.i - b.i).map((x) => x.c);
  const perDomain = new Map();
  const capped = ordered.filter((c) => {
    const d = domainKey(c.url);
    const n = perDomain.get(d) ?? 0;
    if (n >= Math.max(1, maxPerDomain)) return false;
    perDomain.set(d, n + 1);
    return true;
  });
  const candidates = capped.slice(0, Number.isInteger(maxCandidates) ? maxCandidates : undefined);
  if (diagnostics) {
    diagnostics.queriesGenerated += queries.length;
    diagnostics.queriesAttempted += attempted.length;
    diagnostics.candidatesReturned += returned;
    diagnostics.candidatesDeduplicated += returned - merged.size;
    diagnostics.candidatesDomainCapped = (diagnostics.candidatesDomainCapped ?? 0) + (ordered.length - capped.length);
    for (const q of queries) diagnostics.queryTypes[q.type] = (diagnostics.queryTypes[q.type] ?? 0) + 1;
  }
  return { candidates, failures, queriesAttempted: attempted.length, candidatesReturned: returned };
}

export function newEvidenceSearchDiag() {
  return { queriesGenerated: 0, queriesAttempted: 0, candidatesReturned: 0, candidatesDeduplicated: 0,
    candidatesDomainCapped: 0,
    queryTypes: { literal: 0, entity: 0, metric: 0, attribution: 0, official: 0 } };
}
