/**
 * Multi-scene visual planning for Asset Provisioning (on by default; MULTI_SCENE_VISUALS=off
 * restores the single-asset path; see resolveMultiSceneEnabled). Pure and deterministic: no LLM, no network, no
 * clock, no randomness.
 *
 * Design lineage: the per-segment "several alternative queries, fall back
 * down the list, never reuse an asset" shape follows ShortGPT
 * (RayVentura/ShortGPT, MIT; shortGPT/gpt/gpt_editing.py
 * getVideoSearchQueriesTimed + engine/content_video_engine.py
 * _generateVideoUrls). No donor source is copied: ShortGPT asks an LLM for
 * timed queries; here the queries come from data the pipeline already has
 * (content_briefs.visual_ideas and the script body), so this stage keeps its
 * "never calls an LLM" boundary.
 *
 * Output: an ordered list of scenes. Each scene owns a fractional span of the
 * script/narration ([start, end) in 0..1, by script characters) and an ordered
 * list of candidate queries (primary first, last resort = the unchanged
 * whole-video query so the old behaviour is always the final fallback).
 *
 * The span is recorded in asset_usages.usage_context (free text, existing
 * column) so Media Production can place each asset where its scene is told.
 */

export const MULTI_SCENE_DEFAULTS = Object.freeze({
  MAX_SCENES: 6,
  MIN_SCENES: 2,
  SECONDS_PER_SCENE: 10,
  WORDS_PER_SECOND: 2.5,
  MAX_QUERIES_PER_SCENE: 4
});

const STOPWORDS = new Set((
  'a an and are as at be been but by can could did do does for from had has have he her his how i if in into is it its ' +
  'just like may more most much my no not of on one or our out over she so some than that the their them then there these ' +
  'they this to up us was we were what when which who why will with would you your about after also because before being ' +
  'between both each few get got here him how many must only other same should such too very while through during every ' +
  'new says said say using use used make makes made'
).split(/\s+/));

/** 'on' (default) | 'off' (explicit single-asset override). Anything else is a configuration error, never silently coerced. */
export function resolveMultiSceneEnabled(env = process.env) {
  const raw = env.MULTI_SCENE_VISUALS;
  if (raw === undefined || raw === null) return true;
  const v = String(raw).trim().toLowerCase();
  if (v === 'off' || v === '0' || v === 'false') return false;
  if (v === '' || v === 'on' || v === '1' || v === 'true') return true;
  throw new Error(`MULTI_SCENE_VISUALS must be one of on, off (got "${v}")`);
}

function tokens(text) {
  return String(text ?? '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w))
    .map((w) => (w.length > 4 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w));
}

function splitSentences(body) {
  return String(body ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function splitVisualTerms(visualIdeas) {
  const seen = new Set();
  const out = [];
  for (const raw of String(visualIdeas ?? '').split(/[,;\n]+/)) {
    const t = raw.trim();
    const key = t.toLowerCase();
    if (t && !seen.has(key)) { seen.add(key); out.push(t); }
  }
  return out;
}

/** Groups sentences into k contiguous chunks balanced by character count. */
function chunkSentences(sentences, k) {
  const total = sentences.reduce((n, s) => n + s.length, 0);
  const chunks = Array.from({ length: k }, () => ({ sentences: [], chars: 0 }));
  let cum = 0;
  let g = 0;
  for (let i = 0; i < sentences.length; i++) {
    const s = sentences[i];
    chunks[g].sentences.push(s);
    chunks[g].chars += s.length;
    cum += s.length;
    // Advance once this chunk reached its share, or when later chunks need every remaining sentence.
    const remainingSentences = sentences.length - 1 - i;
    const remainingChunks = k - g - 1;
    if (g < k - 1 && remainingSentences >= remainingChunks && (cum >= ((g + 1) / k) * total || remainingSentences === remainingChunks)) g++;
  }
  let start = 0;
  return chunks.filter((c) => c.sentences.length).map((c) => {
    const span = { start: round4(start / total), end: round4((start + c.chars) / total) };
    start += c.chars;
    return { text: c.sentences.join(' '), span };
  });
}

function round4(n) { return Math.round(n * 10000) / 10000; }

/**
 * Returns a permutation of term indices: terms that appear in the script are placed in the
 * order of their overlap-weighted mean sentence position (ties keep the original order);
 * terms with no overlap stay at their original index. Identity when already in order.
 */
function orderTermsByMention(overlap, k) {
  const pos = Array.from({ length: k }, (_, j) => {
    let w = 0; let sum = 0;
    overlap.forEach((row, i) => { w += row[j]; sum += row[j] * i; });
    return w > 0 ? sum / w : null;
  });
  const movable = pos.map((p, j) => ({ j, p })).filter((x) => x.p !== null)
    .sort((a, b) => a.p - b.p || a.j - b.j);
  const out = Array(k).fill(-1);
  pos.forEach((p, j) => { if (p === null) out[j] = j; });
  let m = 0;
  for (let slot = 0; slot < k; slot++) if (out[slot] < 0) out[slot] = movable[m++].j;
  return out;
}

/**
 * Topic-aware chunking. chunkSentences() balances by characters only, so uneven
 * sentence lengths can move a scene boundary into the middle of a topic (the second
 * proof script put the solar sentence in the coffee scene). When there is exactly one
 * curated visual term per scene and at least one sentence shares a word with a term,
 * choose the contiguous split that maximises term<->sentence word overlap (term j is
 * scored against chunk j, narrative order, as the lexical step below already assumes),
 * breaking ties by character balance. Returns null when it does not apply, so the
 * caller keeps the existing behaviour.
 */
function chunkByTerms(sentences, terms, k) {
  const n = sentences.length;
  if (terms.length !== k || n < k || k < 2) return null;
  const tokSets = terms.map((t) => new Set(tokens(t)));
  const rawOverlap = sentences.map((s) => {
    const st = new Set(tokens(s));
    return tokSets.map((tt) => [...tt].filter((w) => st.has(w)).length);
  });
  if (!rawOverlap.some((row) => row.some((v) => v > 0))) return null;
  // The curated terms are not guaranteed to be listed in the order the script mentions them,
  // and the scoring below pairs term j with chunk j. Order the terms by the overlap-weighted
  // mean sentence position first; a term with no overlap keeps its own slot.
  const order = orderTermsByMention(rawOverlap, k);
  const termTok = order.map((j) => tokSets[j]);
  const overlap = rawOverlap.map((row) => order.map((j) => row[j]));
  const chars = sentences.map((s) => s.length);
  const total = chars.reduce((a, b) => a + b, 0);
  const pre = [0]; chars.forEach((c) => pre.push(pre[pre.length - 1] + c));
  const preO = termTok.map((_, j) => { const a = [0]; overlap.forEach((r) => a.push(a[a.length - 1] + r[j])); return a; });
  // best[j][i]: best {score, dev} placing the first i sentences into chunks 0..j-1
  const best = Array.from({ length: k + 1 }, () => Array(n + 1).fill(null));
  best[0][0] = { score: 0, dev: 0, from: -1 };
  for (let j = 1; j <= k; j++) {
    for (let i = j; i <= n - (k - j); i++) {
      for (let m = j - 1; m < i; m++) {
        const prev = best[j - 1][m];
        if (!prev) continue;
        const score = prev.score + (preO[j - 1][i] - preO[j - 1][m]);
        const share = (pre[i] - pre[m]) / total - 1 / k;
        const dev = prev.dev + share * share;
        const cur = best[j][i];
        if (!cur || score > cur.score || (score === cur.score && dev < cur.dev - 1e-12)) best[j][i] = { score, dev, from: m };
      }
    }
  }
  if (!best[k][n]) return null;
  const cuts = []; let i = n;
  for (let j = k; j >= 1; j--) { const m = best[j][i].from; cuts.unshift([m, i]); i = m; }
  return cuts.map(([a, b]) => ({
    text: sentences.slice(a, b).join(' '),
    span: { start: round4(pre[a] / total), end: round4(pre[b] / total) }
  }));
}


function topKeywords(text, n = 2) {
  const freq = new Map();
  for (const t of tokens(text)) freq.set(t, (freq.get(t) ?? 0) + 1);
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, n)
    .map(([w]) => w);
}

/**
 * @param {{visualIdeas?: string|null, scriptBody?: string|null, fallbackQuery?: string|null}} input
 * @returns {Array<{index:number,total:number,span:{start:number,end:number},queries:string[]}>}
 *   [] when there is not enough material to plan >= MIN_SCENES scenes (caller keeps the single-query path).
 */
export function planScenes({ visualIdeas, scriptBody, fallbackQuery = null } = {}, opts = {}) {
  const o = { ...MULTI_SCENE_DEFAULTS, ...opts };
  const sentences = splitSentences(scriptBody);
  if (sentences.length < o.MIN_SCENES) return [];

  const words = String(scriptBody).split(/\s+/).filter(Boolean).length;
  const estSeconds = words / o.WORDS_PER_SECOND;
  const k = Math.max(o.MIN_SCENES, Math.min(o.MAX_SCENES, Math.ceil(estSeconds / o.SECONDS_PER_SCENE), sentences.length));
  const terms = splitVisualTerms(visualIdeas);
  const chunks = chunkByTerms(sentences, terms, k) ?? chunkSentences(sentences, k);
  if (chunks.length < o.MIN_SCENES) return [];

  const chunkTokens = chunks.map((c) => new Set(tokens(c.text)));
  const termTokens = terms.map((t) => tokens(t));

  // 1. Lexical alignment: a visual term goes to the chunk whose text mentions it most.
  const pairs = [];
  terms.forEach((_, ti) => chunks.forEach((_, ci) => {
    const score = termTokens[ti].filter((w) => chunkTokens[ci].has(w)).length;
    if (score > 0) pairs.push({ ti, ci, score });
  }));
  pairs.sort((a, b) => b.score - a.score || a.ti - b.ti || a.ci - b.ci);
  const assigned = chunks.map(() => []);
  const termUsed = new Set();
  for (const { ti, ci } of pairs) {
    if (termUsed.has(ti) || assigned[ci].length >= 2) continue;
    assigned[ci].push(ti);
    termUsed.add(ti);
  }
  // 2. Remaining terms fill still-empty scenes in narrative order, then the lightest scenes.
  for (let ti = 0; ti < terms.length; ti++) {
    if (termUsed.has(ti)) continue;
    let ci = assigned.findIndex((a) => a.length === 0);
    if (ci < 0) ci = assigned.reduce((best, a, i) => (a.length < assigned[best].length ? i : best), 0);
    assigned[ci].push(ti);
    termUsed.add(ti);
  }

  return chunks.map((chunk, ci) => {
    const queries = [];
    const push = (q) => {
      const t = String(q ?? '').trim();
      if (t && !queries.some((x) => x.toLowerCase() === t.toLowerCase())) queries.push(t);
    };
    for (const ti of assigned[ci].sort((a, b) => a - b)) push(terms[ti]);
    // Script keywords are a weak query; use them only for a scene that got no curated visual term.
    if (assigned[ci].length === 0) {
      const kw = topKeywords(chunk.text, 2);
      if (kw.length) push(kw.join(' '));
    }
    push(fallbackQuery ?? visualIdeas); // unchanged whole-video query: the old behaviour is always the last resort
    return { index: ci, total: chunks.length, span: chunk.span, queries: queries.slice(0, o.MAX_QUERIES_PER_SCENE) };
  });
}

/** After acquisition, closes gaps left by scenes that found no asset so spans tile [0,1] exactly. */
export function tileSpans(acquiredScenes) {
  const sorted = [...acquiredScenes].sort((a, b) => a.index - b.index);
  return sorted.map((s, i) => ({
    ...s,
    span: {
      start: i === 0 ? 0 : s.span.start,
      end: i === sorted.length - 1 ? 1 : sorted[i + 1].span.start
    }
  }));
}

export function formatSceneUsageContext({ order, count, span }) {
  return `b-roll scene ${order}/${count} span ${span.start.toFixed(4)}-${span.end.toFixed(4)}`;
}

const CONTEXT_RE = /^b-roll scene (\d+)\/(\d+) span (\d(?:\.\d+)?)-(\d(?:\.\d+)?)$/;

/** @returns {{order:number,count:number,span:{start:number,end:number}}|null} */
export function parseSceneUsageContext(ctx) {
  const m = CONTEXT_RE.exec(String(ctx ?? ''));
  if (!m) return null;
  const order = Number(m[1]); const count = Number(m[2]);
  const start = Number(m[3]); const end = Number(m[4]);
  if (!(order >= 1 && order <= count && start >= 0 && end <= 1 && end > start)) return null;
  return { order, count, span: { start, end } };
}