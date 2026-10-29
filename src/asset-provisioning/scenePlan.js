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
  MAX_SCENES: 12,
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

export function tokens(text) {
  return String(text ?? '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w))
    .map(stem);
}

/**
 * Light plural folding used only for matching (never shown in a query). The old rule stripped one
 * trailing "s" from every long word, which produced "businesse", "classe" and "glasse".
 */
function stem(w) {
  if (w.length <= 4) return w;
  if (w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (/(ss|sh|ch|x|z)es$/.test(w)) return w.slice(0, -2);
  if (w.endsWith('s') && !/(ss|us|is)$/.test(w)) return w.slice(0, -1);
  return w;
}

function rawSentences(body) {
  return String(body ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const HEADING_SMALL_WORDS = new Set(['and', 'of', 'the', 'to', 'for', 'in', 'on', 'with', 'a', 'an', 'vs']);

/** A short Title Case line with no comma or inner sentence punctuation ("Advisor Training and Workshops."). */
export function isHeading(sentence) {
  const s = String(sentence ?? '').trim();
  if (!/[A-Za-z]/.test(s) || /[?!]$/.test(s) || /[.!?;:,]\s/.test(s) || s.includes(',')) return false;
  const words = s.replace(/\.$/, '').split(/\s+/);
  if (words.length < 2 || words.length > 7) return false;
  if (!/^[A-Z]/.test(words[0])) return false;
  return words.every((w) => HEADING_SMALL_WORDS.has(w.toLowerCase()) || /^[A-Z0-9]/.test(w));
}

/**
 * Sentences with headings folded into the sentence they introduce, so a heading never becomes its own
 * ~2 second scene. A trailing heading folds into the previous sentence.
 */
function splitSentences(body) {
  const out = [];
  let pending = [];
  for (const s of rawSentences(body)) {
    if (isHeading(s)) { pending.push(s); continue; }
    out.push([...pending, s].join(' '));
    pending = [];
  }
  if (pending.length) {
    if (out.length) out[out.length - 1] = [out[out.length - 1], ...pending].join(' ');
    else out.push(pending.join(' '));
  }
  return out;
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


// Discourse/time words that survive the stopword list but make useless stock-photo queries
// (a probe produced "pilot among" and "again end" for scenes with no curated term).
const WEAK_QUERY_WORDS = new Set(('among again end however still around against later next year years week weeks month months ' +
  'time times first second third early late recent report reports percent cent plan plans said according').split(/\s+/));

// Abstract words with no photographable subject. Alone they mislead stock search ("access" -> padlock,
// "baseline" -> baseball base, "beyond" -> Ouija board, "artificial" -> plastic flowers).
const ABSTRACT_WORDS = new Set(('access beyond initial baseline baselines artificial development practical pathway valuable guidance ' +
  'structured specialized specific direct continued ongoing approximately several various varying combining ensure ' +
  'effectively safely increasingly major designed support plans planned established receive provide help gain ' +
  'capabilities capability participation participants initiatives initiative rollout pilot sector well complete furthermore ' +
  'aiming national technological navigate lean organizations across within performance model models delivers delivered speed ' +
  'fast faster fastest ultrafast powerful advanced leading latest innovative seamless seamlessly integration integrated impact ' +
  'next-generation position positions adoption widespread effectively manage').split(/\s+/));

/**
 * Scene concept lexicon: narration patterns -> concrete, photographable stock queries. Generic business/tech
 * explainer vocabulary, not tied to one script. `queries[n]` are interchangeable variants; a repeat of the
 * same concept in a later scene takes the next variant so scenes do not all ask for the same picture.
 */
const CONCEPTS = Object.freeze([
  { id: 'training', re: /\b(train(?:ing|ers?|ed|s)?|workshops?|advisors?|coach(?:ing|es)?|mentor(?:ing|s)?|seminars?|classroom|lessons?|curriculum|academy|learning)\b/, queries: ['business training workshop', 'people attending seminar'] },
  { id: 'partnership', re: /\b(partnerships?|partner(?:s|ed)?|collaborat\w*|alliance|agreements?|co-?develop\w*|joint)\b/, queries: ['business handshake partnership', 'two people shaking hands'] },
  { id: 'ai', re: /\b(ai|artificial intelligence|machine learning|automation|chatgpt|technolog\w*|digital tools?)\b/, queries: ['software developer coding laptop', 'data center server room'] },
  { id: 'tools', re: /\b(tools?|software|platforms?|subscriptions?|free access|hands-on|capabilit\w*)\b/, queries: ['person using laptop computer', 'typing on laptop keyboard'] },
  { id: 'resources', re: /\b(playbooks?|resources?|guides?|toolkits?|templates?|handbooks?|guidelines?)\b/, queries: ['business planning notebook', 'open notebook pen desk'] },
  { id: 'growth', re: /\b(long-term|scale|scaling|expand\w*|growth|grow\w*|rollout|roll out)\b/, queries: ['business growth chart', 'growing plant seedling'] },
  { id: 'report', re: /\b(reports?|surveys?|stud(?:y|ies)|trends?|statistics|findings)\b/, queries: ['business analytics chart', 'data charts on screen'] },
  { id: 'global', re: /\b(global\w*|worldwide|across the globe|international|nationwide|national)\b/, queries: ['world map network', 'globe connections'] },
  { id: 'hurdles', re: /\b(hurdles?|challenges?|limited time|obstacles?|barriers?|struggl\w*|risks?|pressure)\b/, queries: ['busy business owner desk', 'stressed worker office'] },
  { id: 'security', re: /\b(privacy|security|secure|reliab\w*|protect\w*|confidential\w*)\b/, queries: ['data security padlock', 'cyber security shield'] },
  { id: 'team', re: /\b(employees?|staff|teams?|workers?|workforce)\b/, queries: ['small business team office', 'colleagues working together'] },
  { id: 'local', re: /\b(local|neighbou?rhood|main street)\b/, queries: ['local shop owner', 'main street shops'] },
  // Concrete photographable subjects for common explainer topics. Photos of real people and places, never
  // "technology" abstractions (those return AI art, robots and toys).
  { id: 'restaurant', re: /\b(restaurants?|franchis\w*|caf[eé]s?|bakery|bakeries|menus?|kitchens?|diner|fast food|food service|takeaway|drive-?thru)\b/, queries: ['restaurant kitchen staff', 'cafe counter barista'] },
  { id: 'cash', re: /\b(cash|cashiers?|registers?|point of sale|checkout|payments?|reconcil\w*|invoices?|accounting|bookkeeping)\b/, queries: ['cashier at checkout counter', 'accountant calculator desk'] },
  { id: 'models', re: /\b(models?|llms?|gpt\S*|apis?|tokens?|inference|benchmarks?|parameters)\b/, queries: ['data center server room', 'software code on monitor'] },
  { id: 'speed', re: /\b(faster|fastest|speed\w*|ultrafast|latency|real-?time|instant\w*)\b/, queries: ['stopwatch timer close up', 'fast moving light trails'] },
  { id: 'developers', re: /\b(developers?|engineers?|programmers?|coding|software)\b/, queries: ['software developer coding laptop', 'programmer working at desk'] },
  { id: 'savings', re: /\b(save[sd]?|savings|costs?|budgets?|revenue|profits?|margins?)\b/, queries: ['business budget planning desk', 'financial documents calculator'] }
]);

function countMatches(re, text) {
  return (text.match(new RegExp(re.source, 'gi')) ?? []).length;
}

/** Ranks concepts for one scene: narration hits count once, heading hits twice. Highest first, lexicon order breaks ties. */
function sceneConcepts(chunkText) {
  const sentences = rawSentences(chunkText);
  return CONCEPTS.map((c, order) => {
    const score = sentences.reduce((n, s) => n + countMatches(c.re, s) * (isHeading(s) ? 2 : 1), 0);
    return { c, score, order };
  }).filter((x) => x.score > 0);
}

/**
 * A concrete two-word noun phrase taken from the scene itself ("training workshops"). Single words are never
 * produced: isolated keywords are exactly what produced padlocks and Ouija boards. Acronyms, brand-style
 * mixed-case words, mid-sentence proper nouns, abstract and discourse words break a phrase.
 */
function derivePhrase(chunkText) {
  const freq = new Map();
  const pairs = [];
  rawSentences(chunkText).forEach((sentence, si) => {
    const heading = isHeading(sentence);
    const words = sentence.split(/[^A-Za-z0-9'-]+/).filter(Boolean);
    let prev = null;
    words.forEach((raw, wi) => {
      if (raw.includes('-')) { prev = null; return; } // hyphenated compounds (in-person, long-term) are not phrase parts
      const w = raw.replace(/'s$/i, '').toLowerCase();
      const proper = /^[A-Z]{2,}$/.test(raw) || /[a-z][A-Z]/.test(raw) || (!heading && wi > 0 && /^[A-Z]/.test(raw));
      const content = !proper && w.length >= 4 && !/^\d+$/.test(w) && !STOPWORDS.has(w) && !WEAK_QUERY_WORDS.has(w) &&
        !ABSTRACT_WORDS.has(w) && !w.endsWith('ly');
      if (!content) { prev = null; return; }
      const key = stem(w);
      freq.set(key, (freq.get(key) ?? 0) + (heading ? 2 : 1));
      if (prev) pairs.push({ phrase: `${prev.w} ${w}`, order: si * 1000 + wi, a: prev.key, b: key });
      prev = { w, key };
    });
  });
  let best = null;
  for (const p of pairs) {
    const score = (freq.get(p.a) ?? 0) + (freq.get(p.b) ?? 0);
    if (!best || score > best.score || (score === best.score && p.order < best.order)) best = { ...p, score };
  }
  return best ? best.phrase : null;
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

  // 1. Lexical alignment: a visual term goes to the chunk whose text mentions it most (a term that shares
  //    no word with any scene is NOT forced onto an unrelated scene here; see the fallback below).
  const pairs = [];
  const overlapOf = new Map();
  terms.forEach((_, ti) => chunks.forEach((_, ci) => {
    const score = termTokens[ti].filter((w) => chunkTokens[ci].has(w)).length;
    if (score > 0) { pairs.push({ ti, ci, score }); overlapOf.set(`${ti}:${ci}`, score); }
  }));
  pairs.sort((a, b) => b.score - a.score || a.ti - b.ti || a.ci - b.ci);
  const assigned = chunks.map(() => []);
  const termUsed = new Set();
  for (const { ti, ci } of pairs) {
    if (termUsed.has(ti) || assigned[ci].length >= 2) continue;
    assigned[ci].push(ti);
    termUsed.add(ti);
  }

  // 2. Scene-specific candidates from the narration itself: concept queries (with repeat control) and one
  //    derived noun phrase.
  const conceptUse = new Map();
  const specific = chunks.map((chunk) => {
    const ranked = sceneConcepts(chunk.text)
      .map((x) => ({ ...x, adj: x.score - 0.75 * (conceptUse.get(x.c.id) ?? 0) }))
      .sort((a, b) => b.adj - a.adj || a.order - b.order)
      .slice(0, 2);
    const conceptQueries = ranked.map(({ c }) => {
      const n = conceptUse.get(c.id) ?? 0;
      conceptUse.set(c.id, n + 1);
      return c.queries[n % c.queries.length];
    });
    // A derived phrase is allowed from a heading (an explicit topic label) or as the only scene-specific
    // signal; next to concept queries it only adds noise.
    const headings = rawSentences(chunk.text).filter(isHeading);
    const phrase = headings.length ? derivePhrase(headings.join(' ')) : (conceptQueries.length ? null : derivePhrase(chunk.text));
    return { conceptQueries, phrase };
  });

  // 3. Terms nothing in the narration supports fill only scenes that have no scene-specific query at all,
  //    in narrative order (the old behaviour, now a last resort rather than the default).
  for (let ti = 0; ti < terms.length; ti++) {
    if (termUsed.has(ti)) continue;
    const ci = chunks.findIndex((_, i) => assigned[i].length === 0 && !specific[i].conceptQueries.length && !specific[i].phrase);
    if (ci < 0) break;
    assigned[ci].push(ti);
    termUsed.add(ti);
  }

  const MAX_SPECIFIC = Math.max(1, o.MAX_QUERIES_PER_SCENE - 1); // the last slot is reserved for the whole-video query
  const fallbackUse = new Map();
  const firstQueries = [];
  const plans = chunks.map((chunk, ci) => {
    const queries = [];
    const push = (q) => {
      const t = String(q ?? '').trim();
      if (t && !queries.some((x) => x.toLowerCase() === t.toLowerCase())) queries.push(t);
    };
    const mine = [...assigned[ci]].sort((a, b) => a - b);
    // A curated term the narration mostly mentions leads; one that only brushes it follows the scene's own concepts.
    const strong = mine.filter((ti) => (overlapOf.get(`${ti}:${ci}`) ?? 0) >= Math.ceil(termTokens[ti].length / 2));
    const weak = mine.filter((ti) => !strong.includes(ti));
    strong.forEach((ti) => push(terms[ti]));
    specific[ci].conceptQueries.forEach(push);
    weak.forEach((ti) => push(terms[ti]));
    push(specific[ci].phrase);
    // Generic but topic-relevant fallback: a curated term, rotated so neighbouring scenes differ.
    if (queries.length < 2 && terms.length) {
      const avoid = new Set([firstQueries[ci - 1]].filter(Boolean).map((q) => q.toLowerCase()));
      const pick = terms.map((t, ti) => ({ t, ti, n: fallbackUse.get(ti) ?? 0 }))
        .filter((x) => !avoid.has(x.t.toLowerCase()) && !queries.some((q) => q.toLowerCase() === x.t.toLowerCase()))
        .sort((a, b) => a.n - b.n || a.ti - b.ti)[0];
      if (pick) { push(pick.t); fallbackUse.set(pick.ti, pick.n + 1); }
    }
    const head = queries.slice(0, MAX_SPECIFIC);
    firstQueries[ci] = head[0] ?? null;
    const whole = String(fallbackQuery ?? visualIdeas ?? '').trim();
    if (whole && !head.some((x) => x.toLowerCase() === whole.toLowerCase())) head.push(whole); // unchanged whole-video query stays the last resort
    return { index: ci, total: chunks.length, span: chunk.span, text: chunk.text, queries: head };
  });
  return plans;
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