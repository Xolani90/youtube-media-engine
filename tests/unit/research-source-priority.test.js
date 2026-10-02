import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectCandidateSources, candidatePriority, sourceFreshness, sourceCredibility, PRIORITY_WEIGHTS } from '../../src/research/evidenceVerification.js';
import { computeEvidenceStatus, explainEvidenceSources } from '../../src/research/evidenceGrading.js';
import { buildSourceProvenance } from '../../src/research/sourceProvenance.js';
import researchPolicy from '../../config/research_policy.json' with { type: 'json' };

const NOW = Date.parse('2026-10-04T12:00:00Z');
const CLAIM = { id: 'c1', claim: 'Google announced Gemini 4 Argon on September 30, 2026.' };
const TEXT = 'Google announced Gemini 4 Argon on September 30, 2026 as its newest frontier model.';
const iso = (daysAgo) => new Date(NOW - daysAgo * 86400000).toISOString();
const src = (id, url, o = {}) => ({
  id, url, role: 'independent_reporting', quality_tier: 'MEDIUM', retrieval_status: 'SUCCESS',
  content: TEXT, retrieved_at: iso(0.01),
  notes: buildSourceProvenance({ url, status: 'SUCCESS', publishedAt: o.publishedAt ?? null }), ...o.fields
});
const pick = (sources, extra = {}) => selectCandidateSources({ claim: CLAIM, sources, policy: researchPolicy, nowMs: NOW, ...extra });

test('weights are the documented 0.50 / 0.35 / 0.15 and sum to 1', () => {
  assert.deepEqual({ ...PRIORITY_WEIGHTS }, { relevance: 0.5, credibility: 0.35, freshness: 0.15 });
  assert.equal(PRIORITY_WEIGHTS.relevance + PRIORITY_WEIGHTS.credibility + PRIORITY_WEIGHTS.freshness, 1);
});

test('same relevance: a high-credibility source outranks a lower-credibility one', () => {
  const hi = src('hi', 'https://a-news.com/x', { fields: { quality_tier: 'HIGH' } });
  const lo = src('lo', 'https://b-news.com/x', { fields: { quality_tier: 'MEDIUM' } });
  assert.deepEqual(pick([lo, hi]).map((c) => c.source.id), ['hi', 'lo']);
});

test('an authoritative role outranks an equally relevant independent source', () => {
  const auth = src('auth', 'https://blog.example/x', { fields: { role: 'primary_authoritative', quality_tier: 'HIGH' } });
  const ind = src('ind', 'https://b-news.com/x');
  assert.equal(pick([ind, auth])[0].source.id, 'auth');
});

test('comparable relevance: a fresh source outranks a stale one; unknown date is neutral', () => {
  const fresh = src('fresh', 'https://a-news.com/x', { publishedAt: iso(2) });
  const stale = src('stale', 'https://b-news.com/x', { publishedAt: iso(300) });
  const unknown = src('unk', 'https://c-news.com/x');
  assert.deepEqual(pick([stale, unknown, fresh]).map((c) => c.source.id), ['fresh', 'unk', 'stale']);
  assert.equal(sourceFreshness(unknown.fields ?? unknown, NOW), 0.5);
  assert.equal(sourceFreshness(fresh, NOW), 1);
  assert.equal(sourceFreshness(stale, NOW) > 0 && sourceFreshness(stale, NOW) < 0.5, true);
});

test('a future or unparseable publishedAt is ignored (neutral), never rewarded', () => {
  const future = src('f', 'https://a-news.com/x', { publishedAt: iso(-30) });
  const junk = src('j', 'https://b-news.com/x', { publishedAt: 'not a date' });
  assert.equal(sourceFreshness(future, NOW), 0.5);
  assert.equal(sourceFreshness(junk, NOW), 0.5);
});

test('a strong lexical match does not rescue social media, syndicated or unusable sources', () => {
  const social = src('soc', 'https://www.facebook.com/p/1', { fields: { role: 'social_media', quality_tier: 'LOW' } });
  const synd = src('syn', 'https://wire.example/x', { fields: { role: 'syndicated' } });
  const unusable = src('unu', 'https://dead.example/x', { fields: { quality_tier: 'UNUSABLE', retrieval_status: 'FAILED' } });
  const ok = src('ok', 'https://a-news.com/x');
  assert.deepEqual(pick([social, synd, unusable, ok]).map((c) => c.source.id), ['ok']);
});

test('priority never lets a low-relevance source in: the relevance floor still applies', () => {
  const off = src('off', 'https://auth.example/x', { fields: { role: 'primary_authoritative', quality_tier: 'HIGH', content: 'Completely unrelated cooking recipe about pasta.' } });
  assert.deepEqual(pick([off]), []);
});

test('same-domain duplicates still collapse to one candidate (registrable-domain independence)', () => {
  const a = src('a', 'https://www.news.example/1', { fields: { quality_tier: 'HIGH' } });
  const b = src('b', 'https://m.news.example/2', { fields: { quality_tier: 'MEDIUM' } });
  const r = pick([a, b]);
  assert.equal(r.length, 1);
  assert.equal(r[0].source.id, 'a');
});

test('ordering is deterministic regardless of input order', () => {
  const s = [src('x1', 'https://a-news.com/x'), src('x2', 'https://b-news.com/x'), src('x3', 'https://c-news.com/x')];
  assert.deepEqual(pick(s).map((c) => c.source.id), pick([...s].reverse()).map((c) => c.source.id));
});

test('priority is ordering only: a top-priority source alone never yields VERIFIED', () => {
  const best = src('best', 'https://a-news.com/x', { fields: { quality_tier: 'HIGH' }, publishedAt: iso(1) });
  const links = [{ claim_id: 'c1', source_id: 'best', role: 'primary' }];
  const status = computeEvidenceStatus({ claimSourceLinks: links, sourcesById: new Map([['best', best]]), policy: researchPolicy, nowMs: NOW });
  assert.notEqual(status, 'VERIFIED');
  assert.ok(candidatePriority(1, best, NOW) <= 1);
});

test('credibility: unknown/low tiers are not promoted by successful retrieval', () => {
  assert.equal(sourceCredibility({ role: 'independent_reporting', quality_tier: 'MEDIUM' }), 0.6);
  assert.equal(sourceCredibility({ role: 'independent_reporting', quality_tier: 'UNUSABLE' }), 0);
  assert.equal(sourceCredibility({ role: 'primary_authoritative', quality_tier: 'HIGH' }), 1);
  assert.equal(sourceCredibility({}), 0);
});
