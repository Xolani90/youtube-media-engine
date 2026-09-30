import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeEvidenceStatus, independenceKey } from '../../src/research/evidenceGrading.js';
import researchPolicy from '../../config/research_policy.json' with { type: 'json' };

const NOW = Date.parse('2026-09-10T00:00:00.000Z');

function source(overrides = {}) {
  return {
    id: 'src-1',
    url: 'https://example.com/article',
    role: 'independent_reporting',
    quality_tier: 'MEDIUM',
    retrieval_status: 'SUCCESS',
    retrieved_at: new Date(NOW).toISOString(),
    ...overrides
  };
}

function grade(sources, links, extra = {}) {
  const sourcesById = new Map(sources.map((s) => [s.id, s]));
  return computeEvidenceStatus({ claimSourceLinks: links, sourcesById, policy: researchPolicy, nowMs: NOW, ...extra });
}

// ---------------------------------------------------------------------------
// independenceKey: registrable-domain derivation (public-suffix aware)
// ---------------------------------------------------------------------------

test('independenceKey: www., subdomain and bare host collapse to the same registrable domain', () => {
  assert.equal(independenceKey('https://news.example.com/a'), 'example.com');
  assert.equal(independenceKey('https://www.example.com/b'), 'example.com');
  assert.equal(independenceKey('https://example.com/c'), 'example.com');
});

test('independenceKey: multi-label public suffixes (co.uk, com.au, co.za) are handled, not naively split', () => {
  assert.equal(independenceKey('https://www.bbc.co.uk/x'), 'bbc.co.uk');
  assert.equal(independenceKey('https://news.bbc.co.uk/y'), 'bbc.co.uk');
  assert.equal(independenceKey('https://www.abc.net.au/z'), 'abc.net.au');
  assert.equal(independenceKey('https://shop.example.com.au/z'), 'example.com.au');
  assert.equal(independenceKey('https://www.news24.co.za/q'), 'news24.co.za');
  // A naive hostname.split('.').slice(-2) would collapse both of these to "co.za".
  assert.notEqual(independenceKey('https://www.news24.co.za/q'), independenceKey('https://www.iol.co.za/q'));
});

test('independenceKey: hostname casing and port do not create distinct keys', () => {
  assert.equal(independenceKey('https://WWW.Example.COM:8443/a'), 'example.com');
});

test('independenceKey fails closed: missing, malformed, IP and suffix-less hosts yield null', () => {
  assert.equal(independenceKey(undefined), null);
  assert.equal(independenceKey(null), null);
  assert.equal(independenceKey(''), null);
  assert.equal(independenceKey('   '), null);
  assert.equal(independenceKey('not a url'), null);
  assert.equal(independenceKey('http://192.168.0.1/x'), null);
  assert.equal(independenceKey('http://localhost/x'), null);
});

// ---------------------------------------------------------------------------
// Test A — defect A: one source_id with multiple claim_sources roles
// ---------------------------------------------------------------------------

test('A: one source_id linked as both primary and corroborating counts as ONE source -> not VERIFIED', () => {
  const s1 = source({ id: 's1', url: 'https://example.com/article-a' });
  const status = grade([s1], [
    { claim_id: 'c1', source_id: 's1', role: 'primary' },
    { claim_id: 'c1', source_id: 's1', role: 'corroborating' }
  ]);
  assert.notEqual(status, 'VERIFIED');
  assert.equal(status, 'PARTIALLY_SUPPORTED');
});

test('A: many duplicate link rows for one source_id still never reach the corroboration minimum', () => {
  const s1 = source({ id: 's1', url: 'https://example.com/article-a' });
  const status = grade([s1], [
    { source_id: 's1', role: 'primary' },
    { source_id: 's1', role: 'corroborating' },
    { source_id: 's1', role: 'corroborating' },
    { source_id: 's1', role: 'primary' }
  ]);
  assert.equal(status, 'PARTIALLY_SUPPORTED');
});

// ---------------------------------------------------------------------------
// Test B — defect B: same registrable domain is one publisher
// ---------------------------------------------------------------------------

test('B: two URLs from the same registrable domain do NOT satisfy independent_reporting >= 2', () => {
  const s1 = source({ id: 's1', url: 'https://example.com/article-a' });
  const s2 = source({ id: 's2', url: 'https://example.com/article-b' });
  const status = grade([s1, s2], [{ source_id: 's1' }, { source_id: 's2' }]);
  assert.notEqual(status, 'VERIFIED');
  assert.equal(status, 'PARTIALLY_SUPPORTED');
});

test('B: www., subdomain and bare-host variants of one registrable domain are still one publisher', () => {
  const s1 = source({ id: 's1', url: 'https://news.example.com/a' });
  const s2 = source({ id: 's2', url: 'https://www.example.com/b' });
  const s3 = source({ id: 's3', url: 'https://example.com/c' });
  const status = grade([s1, s2, s3], [{ source_id: 's1' }, { source_id: 's2' }, { source_id: 's3' }]);
  assert.equal(status, 'PARTIALLY_SUPPORTED');
});

test('B: two pages from the same multi-label-suffix publisher (bbc.co.uk) are one publisher', () => {
  const s1 = source({ id: 's1', url: 'https://www.bbc.co.uk/news/a' });
  const s2 = source({ id: 's2', url: 'https://news.bbc.co.uk/b' });
  const status = grade([s1, s2], [{ source_id: 's1' }, { source_id: 's2' }]);
  assert.equal(status, 'PARTIALLY_SUPPORTED');
});

test('B: independent sources with no derivable registrable domain never count as corroboration (fail closed)', () => {
  const noUrl1 = source({ id: 's1', url: undefined });
  const noUrl2 = source({ id: 's2', url: null });
  const badUrl = source({ id: 's3', url: 'not a url' });
  const status = grade([noUrl1, noUrl2, badUrl], [{ source_id: 's1' }, { source_id: 's2' }, { source_id: 's3' }]);
  assert.notEqual(status, 'VERIFIED');
  assert.equal(status, 'PARTIALLY_SUPPORTED'); // still eligible evidence, just not corroboration
});

test('B: a source with no derivable domain cannot combine with one real domain to reach the minimum', () => {
  const real = source({ id: 's1', url: 'https://publisher-one.com/a' });
  const noUrl = source({ id: 's2', url: undefined });
  const status = grade([real, noUrl], [{ source_id: 's1' }, { source_id: 's2' }]);
  assert.equal(status, 'PARTIALLY_SUPPORTED');
});

// ---------------------------------------------------------------------------
// Test C — genuinely different registrable domains may satisfy corroboration
// ---------------------------------------------------------------------------

test('C: two URLs from different registrable domains CAN produce VERIFIED', () => {
  const s1 = source({ id: 's1', url: 'https://publisher-one.com/story' });
  const s2 = source({ id: 's2', url: 'https://publisher-two.org/story' });
  assert.equal(grade([s1, s2], [{ source_id: 's1' }, { source_id: 's2' }]), 'VERIFIED');
});

test('C: two different publishers under the SAME multi-label public suffix (co.za) CAN produce VERIFIED', () => {
  const s1 = source({ id: 's1', url: 'https://www.news24.co.za/a' });
  const s2 = source({ id: 's2', url: 'https://www.iol.co.za/b' });
  assert.equal(grade([s1, s2], [{ source_id: 's1' }, { source_id: 's2' }]), 'VERIFIED');
});

test('C: distinct sources with distinct domains still VERIFY when each also carries duplicate role rows', () => {
  const s1 = source({ id: 's1', url: 'https://publisher-one.com/story' });
  const s2 = source({ id: 's2', url: 'https://publisher-two.org/story' });
  const status = grade([s1, s2], [
    { source_id: 's1', role: 'primary' },
    { source_id: 's1', role: 'corroborating' },
    { source_id: 's2', role: 'corroborating' }
  ]);
  assert.equal(status, 'VERIFIED');
});

test('C: other existing requirements still apply — a second distinct-domain source below minimum quality does not corroborate', () => {
  const s1 = source({ id: 's1', url: 'https://publisher-one.com/story' });
  const low = source({ id: 's2', url: 'https://publisher-two.org/story', quality_tier: 'LOW' });
  assert.equal(grade([s1, low], [{ source_id: 's1' }, { source_id: 's2' }]), 'PARTIALLY_SUPPORTED');
});

test('C: a stale second distinct-domain source does not corroborate', () => {
  const staleMs = NOW - (researchPolicy.staleness.maximum_source_age_hours + 100) * 60 * 60 * 1000;
  const s1 = source({ id: 's1', url: 'https://publisher-one.com/story' });
  const stale = source({ id: 's2', url: 'https://publisher-two.org/story', retrieved_at: new Date(staleMs).toISOString() });
  assert.equal(grade([s1, stale], [{ source_id: 's1' }, { source_id: 's2' }]), 'PARTIALLY_SUPPORTED');
});

test('C: a syndicated source on a different domain still does not count toward corroboration', () => {
  const s1 = source({ id: 's1', url: 'https://publisher-one.com/story' });
  const synd = source({ id: 's2', url: 'https://wire-copy.net/story', role: 'syndicated', quality_tier: 'LOW' });
  assert.equal(grade([s1, synd], [{ source_id: 's1' }, { source_id: 's2' }]), 'PARTIALLY_SUPPORTED');
});

// ---------------------------------------------------------------------------
// Test D — authoritative-source behavior unchanged
// ---------------------------------------------------------------------------

test('D: a single primary_authoritative source is still sufficient alone -> VERIFIED', () => {
  const auth = source({ id: 's1', url: 'https://acme.com/press-release', role: 'primary_authoritative', quality_tier: 'HIGH' });
  assert.equal(grade([auth], [{ source_id: 's1' }]), 'VERIFIED');
});

test('D: primary_authoritative does not depend on a derivable independence key', () => {
  const auth = source({ id: 's1', url: undefined, role: 'primary_authoritative', quality_tier: 'HIGH' });
  assert.equal(grade([auth], [{ source_id: 's1' }]), 'VERIFIED');
});

test('D: primary_authoritative is unaffected by duplicate role rows and by same-domain independent sources', () => {
  const auth = source({ id: 's1', url: 'https://acme.com/press-release', role: 'primary_authoritative', quality_tier: 'HIGH' });
  const ind = source({ id: 's2', url: 'https://acme.com/blog' });
  const status = grade([auth, ind], [
    { source_id: 's1', role: 'primary' },
    { source_id: 's1', role: 'corroborating' },
    { source_id: 's2', role: 'corroborating' }
  ]);
  assert.equal(status, 'VERIFIED');
});

test('D: a stale primary_authoritative source still does not verify (freshness rule unchanged)', () => {
  const staleMs = NOW - (researchPolicy.staleness.maximum_source_age_hours + 100) * 60 * 60 * 1000;
  const auth = source({ id: 's1', role: 'primary_authoritative', quality_tier: 'HIGH', retrieved_at: new Date(staleMs).toISOString() });
  assert.equal(grade([auth], [{ source_id: 's1' }]), 'UNSUPPORTED');
});

// ---------------------------------------------------------------------------
// Test E — a single independent source stays PARTIALLY_SUPPORTED
// ---------------------------------------------------------------------------

test('E: a normal single independent source remains PARTIALLY_SUPPORTED, not VERIFIED', () => {
  const s1 = source({ id: 's1', url: 'https://publisher-one.com/story' });
  assert.equal(grade([s1], [{ source_id: 's1', role: 'primary' }]), 'PARTIALLY_SUPPORTED');
});

test('E: no usable sources remains UNSUPPORTED', () => {
  assert.equal(grade([], []), 'UNSUPPORTED');
});

// ---------------------------------------------------------------------------
// Test F — contested / contradiction behavior unchanged
// ---------------------------------------------------------------------------

test('F: an unresolved contradiction still forces CONTESTED even with two genuinely independent domains', () => {
  const s1 = source({ id: 's1', url: 'https://publisher-one.com/story' });
  const s2 = source({ id: 's2', url: 'https://publisher-two.org/story' });
  const status = grade([s1, s2], [{ source_id: 's1' }, { source_id: 's2' }], { hasUnresolvedContradiction: true });
  assert.equal(status, 'CONTESTED');
});

test('F: an unresolved contradiction still forces CONTESTED over a primary_authoritative source', () => {
  const auth = source({ id: 's1', role: 'primary_authoritative', quality_tier: 'HIGH' });
  assert.equal(grade([auth], [{ source_id: 's1' }], { hasUnresolvedContradiction: true }), 'CONTESTED');
});

test('F: an unresolved contradiction is CONTESTED even with no sources at all', () => {
  assert.equal(grade([], [], { hasUnresolvedContradiction: true }), 'CONTESTED');
});
