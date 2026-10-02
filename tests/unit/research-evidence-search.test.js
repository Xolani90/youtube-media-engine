import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildEvidenceQueries, discoverWithCascade, newEvidenceSearchDiag, QUERY_TYPE, DEFAULT_MAX_QUERIES_PER_CLAIM } from '../../src/research/evidenceSearch.js';
import { classifySourceRole } from '../../src/research/sourceClassification.js';
import { selectCandidateSources } from '../../src/research/evidenceVerification.js';
import { explainEvidenceSources } from '../../src/research/evidenceGrading.js';
import { buildSourceProvenance } from '../../src/research/sourceProvenance.js';
import researchPolicy from '../../config/research_policy.json' with { type: 'json' };
import classification from '../../config/research_source_classification.json' with { type: 'json' };

const CLAIM = { id: 'c1', claim: 'Google announced Gemini 4 Argon on September 30, 2026 as its next frontier model.', claim_type: 'FACT' };
const types = (qs) => qs.map((q) => q.type);

test('query construction: literal, entity, metric, attribution and official queries exist', () => {
  const qs = buildEvidenceQueries({ claim: CLAIM, classification });
  assert.deepEqual(types(qs).slice(0, 4), ['literal', 'entity', 'metric', 'attribution']);
  assert.equal(qs[0].query, CLAIM.claim);
  assert.match(qs.find((q) => q.type === 'entity').query, /Google/);
  assert.match(qs.find((q) => q.type === 'metric').query, /"September 30 2026"/);
  assert.match(qs.find((q) => q.type === 'attribution').query, /"Google" announced/);
  assert.ok(qs.some((q) => q.type === 'official'));
});

test('official query comes from configuration, not a hard-coded hostname', () => {
  const qs = buildEvidenceQueries({ claim: CLAIM, classification });
  assert.match(qs.find((q) => q.type === 'official').query, /^site:blog\.google /);
  const other = buildEvidenceQueries({ claim: { claim: 'Acme released Widget 9 in March 2026.' }, classification: { authoritativeDomains: ['newsroom.acme.com', 'blog.google'] } });
  assert.match(other.find((q) => q.type === 'official').query, /^site:newsroom\.acme\.com /);
  assert.ok(!other.some((q) => /blog\.google/.test(q.query)), 'unrelated authoritative domain is not searched');
  const none = buildEvidenceQueries({ claim: CLAIM, classification: { authoritativeDomains: [] } });
  assert.ok(!none.some((q) => q.type === 'official'));
});

test('at most 2 official queries per claim and at most 6 queries overall', () => {
  const cls = { authoritativeDomains: ['blog.google', 'ai.google', 'deepmind.google'] };
  const qs = buildEvidenceQueries({ claim: CLAIM, classification: cls, linkedSources: [{ url: 'https://9to5google.com/a' }] });
  assert.ok(qs.length <= DEFAULT_MAX_QUERIES_PER_CLAIM);
  assert.ok(qs.filter((q) => q.type === 'official').length <= 2);
  assert.equal(buildEvidenceQueries({ claim: CLAIM, classification: cls, maxQueries: 3 }).length, 3);
});

test('numeric/date and attribution queries are absent when the claim has neither', () => {
  const qs = buildEvidenceQueries({ claim: { claim: 'the model is larger than earlier ones' }, classification: {} });
  assert.deepEqual(types(qs), ['literal']);
});

test('Pass 48: no site: query is ever built for a linked source domain (same domain cannot corroborate)', () => {
  const linked = [{ url: 'https://www.cnbc.com/a' }, { url: 'https://wire.example/x' }];
  const qs = buildEvidenceQueries({ claim: CLAIM, linkedSources: linked, classification });
  assert.ok(!qs.some((q) => q.type === 'sourceDomain'));
  assert.ok(!qs.some((q) => /^site:cnbc\.com/.test(q.query)));
  assert.equal(QUERY_TYPE.SOURCE_DOMAIN, undefined);
});

test('identical normalized queries collapse to one and ordering is deterministic', () => {
  const a = buildEvidenceQueries({ claim: CLAIM, classification });
  const b = buildEvidenceQueries({ claim: CLAIM, classification });
  assert.deepEqual(a, b);
  const norm = a.map((q) => q.query.toLowerCase().replace(/["“”]/g, ''));
  assert.equal(new Set(norm).size, norm.length);
});

function fakeProvider(byQuery) {
  const calls = [];
  return { calls, id: 'fake', async discoverCandidates({ query }) { calls.push(query); return { candidates: byQuery(query), failures: [] }; } };
}

test('budget: with one remaining attempt only one query is attempted', async () => {
  const p = fakeProvider(() => [{ url: 'https://a.com/1' }]);
  const qs = buildEvidenceQueries({ claim: CLAIM, classification });
  const r = await discoverWithCascade({ provider: p, queries: qs, maxQueries: 1, maxResults: 5, maxCandidates: 1 });
  assert.equal(p.calls.length, 1);
  assert.equal(r.queriesAttempted, 1);
  assert.equal(r.candidates.length, 1);
  assert.equal((await discoverWithCascade({ provider: p, queries: qs, maxQueries: 0, maxResults: 5 })).queriesAttempted, 0);
});

test('same URL from three query families becomes one candidate that keeps the first family and fills metadata', async () => {
  const p = fakeProvider((q) => [{ url: 'https://news.example/a', ...(/^site:/.test(q) ? { title: 'T', publishedAt: '2026-09-30' } : {}) }]);
  const qs = buildEvidenceQueries({ claim: CLAIM, classification });
  const diag = newEvidenceSearchDiag();
  const r = await discoverWithCascade({ provider: p, queries: qs, maxQueries: 6, maxResults: 5, diagnostics: diag });
  assert.equal(r.candidates.length, 1);
  assert.equal(r.candidates[0].discoveryQueryType, 'literal');
  assert.equal(r.candidates[0].title, 'T');
  assert.equal(diag.candidatesDeduplicated, diag.candidatesReturned - 1);
  assert.equal(diag.queriesAttempted, qs.length);
  assert.equal(diag.queryTypes.literal, 1);
});

test('already-acquired URLs are excluded and a failing query is isolated', async () => {
  const p = { id: 'f', async discoverCandidates({ query }) { if (/^site:/.test(query)) throw new Error('boom'); return { candidates: [{ url: 'https://known.com/x' }, { url: 'https://new.com/y' }] }; } };
  const r = await discoverWithCascade({ provider: p, queries: buildEvidenceQueries({ claim: CLAIM, classification }), maxQueries: 6, maxResults: 5, knownUrls: ['https://known.com/x/'] });
  assert.deepEqual(r.candidates.map((c) => c.url), ['https://new.com/y']);
  assert.ok(r.failures.some((f) => /boom/.test(f.error)));
});

test('merged candidates are interleaved across families and capped by maxCandidates', async () => {
  const p = fakeProvider((q) => [1, 2, 3].map((i) => ({ url: `https://s${i}-${q.length}.com/` })));
  const qs = buildEvidenceQueries({ claim: CLAIM, classification }).slice(0, 3);
  const r = await discoverWithCascade({ provider: p, queries: qs, maxQueries: 3, maxResults: 5, maxCandidates: 3 });
  assert.equal(r.candidates.length, 3);
  assert.deepEqual(r.candidates.map((c) => c.discoveryQueryType), qs.map((q) => q.type));
});

test('provenance records discovery_query_type only when present, with no schema change', () => {
  const base = { url: 'https://a.com', status: 'SUCCESS', title: 't' };
  assert.ok(!('discovery_query_type' in JSON.parse(buildSourceProvenance(base)).discovery));
  assert.equal(JSON.parse(buildSourceProvenance({ ...base, discoveryQueryType: 'official' })).discovery.discovery_query_type, 'official');
});

test('one registrable domain stays one independent domain, whichever query found the URLs', () => {
  const mk = (id, url) => ({ id, url, role: 'independent_reporting', quality_tier: 'MEDIUM', retrieval_status: 'SUCCESS', retrieved_at: new Date().toISOString() });
  const sourcesById = new Map([['a', mk('a', 'https://news.example.com/1')], ['b', mk('b', 'https://www.example.com/2')]]);
  const ex = explainEvidenceSources({ claimSourceLinks: [{ source_id: 'a' }, { source_id: 'b' }], sourcesById, policy: researchPolicy });
  assert.equal(ex.independentCount, 1);
});

test('cascade cannot bypass Pass 46.2: a social URL it surfaces is social_media and never a corroboration candidate', () => {
  const fb = 'https://www.facebook.com/JamoraquaiPage/posts/gemini-4-argon/1';
  assert.equal(classifySourceRole(fb, classification).role, 'social_media');
  const text = 'Google announced Gemini 4 Argon on September 30, 2026 as its next frontier model for complex work.';
  const src = { id: 'f', url: fb, role: 'social_media', quality_tier: 'MEDIUM', retrieval_status: 'SUCCESS', content: text, retrieved_at: new Date().toISOString() };
  assert.deepEqual(selectCandidateSources({ claim: CLAIM, sources: [src], policy: researchPolicy }), []);
});

test('a date fragment is never an entity (no bare "30" in any query)', () => {
  const qs = buildEvidenceQueries({ claim: CLAIM, classification });
  for (const q of qs.filter((x) => x.type === 'entity' || x.type === 'attribution')) assert.doesNotMatch(q.query, /(^|\s)30 September/);
});

test('Pass 48: URLs on an excluded (already-linked) registrable domain are dropped, subdomains included', async () => {
  const p = fakeProvider(() => [{ url: 'https://www.cnbc.com/a' }, { url: 'https://video.cnbc.com/b' }, { url: 'https://other.com/c' }]);
  const qs = buildEvidenceQueries({ claim: CLAIM, classification }).slice(0, 2);
  const r = await discoverWithCascade({ provider: p, queries: qs, maxQueries: 2, maxResults: 5, excludeDomains: ['cnbc.com'] });
  assert.deepEqual(r.candidates.map((c) => c.url), ['https://other.com/c']);
});

test('Pass 48: at most maxPerDomain URLs per registrable domain; extras are counted, not returned', async () => {
  const p = fakeProvider(() => [1, 2, 3, 4].map((i) => ({ url: `https://news.example/p${i}` })).concat([{ url: 'https://b.com/x' }]));
  const diag = newEvidenceSearchDiag();
  const qs = buildEvidenceQueries({ claim: CLAIM, classification }).slice(0, 1);
  const r = await discoverWithCascade({ provider: p, queries: qs, maxQueries: 1, maxResults: 5, diagnostics: diag });
  assert.equal(r.candidates.filter((c) => c.url.includes('news.example')).length, 2);
  assert.equal(diag.candidatesDomainCapped, 2);
  const one = await discoverWithCascade({ provider: p, queries: qs, maxQueries: 1, maxResults: 5, maxPerDomain: 1 });
  assert.equal(one.candidates.filter((c) => c.url.includes('news.example')).length, 1);
});

test('Pass 48: a canonical URL outranks a localized copy of the same domain when the cap bites', async () => {
  const p = fakeProvider(() => [
    { url: 'https://blog.google/intl/id-id/products/gemini-4-argon' },
    { url: 'https://blog.google/products/gemini-4-argon' },
    { url: 'https://blog.google/updates/september' }
  ]);
  const qs = buildEvidenceQueries({ claim: CLAIM, classification }).slice(0, 1);
  const r = await discoverWithCascade({ provider: p, queries: qs, maxQueries: 1, maxResults: 5, maxPerDomain: 1 });
  assert.deepEqual(r.candidates.map((c) => c.url), ['https://blog.google/products/gemini-4-argon']);
  const two = await discoverWithCascade({ provider: p, queries: qs, maxQueries: 1, maxResults: 5, maxPerDomain: 2 });
  assert.ok(!two.candidates.some((c) => c.url.includes('/intl/id-id/')));
});

test('Pass 50: social-platform URLs never enter the candidate list and are counted', async () => {
  const p = fakeProvider(() => [
    { url: 'https://www.instagram.com/p/1' }, { url: 'https://m.facebook.com/x/1' }, { url: 'https://x.com/Google/status/1' },
    { url: 'https://www.reuters.com/a' }, { url: 'https://notx.com/b' }
  ]);
  const diag = newEvidenceSearchDiag();
  const qs = buildEvidenceQueries({ claim: CLAIM, classification }).slice(0, 2);
  const r = await discoverWithCascade({ provider: p, queries: qs, maxQueries: 2, maxResults: 5, socialDomains: classification.socialDomains, diagnostics: diag });
  assert.deepEqual(r.candidates.map((c) => c.url), ['https://www.reuters.com/a', 'https://notx.com/b']);
  assert.equal(diag.candidatesSocialDropped, 3);
  assert.equal(diag.candidatesDeduplicated, diag.candidatesReturned - 3 - 2, 'repeats of the same URL still count as duplicates');
});

test('Pass 50: without socialDomains nothing is dropped (behaviour unchanged for other callers)', async () => {
  const p = fakeProvider(() => [{ url: 'https://www.instagram.com/p/1' }]);
  const qs = buildEvidenceQueries({ claim: CLAIM, classification }).slice(0, 1);
  const r = await discoverWithCascade({ provider: p, queries: qs, maxQueries: 1, maxResults: 5 });
  assert.equal(r.candidates.length, 1);
});
