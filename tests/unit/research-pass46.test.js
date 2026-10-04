import test from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { assessContent, CONTENT_VERDICT } from '../../src/research/contentAssessment.js';
import { retrieveSource } from '../../src/research/retrieval.js';
import { classifySourceRole, assessEvidenceAdmissibility } from '../../src/research/sourceClassification.js';
import { buildSourceProvenance, parseSourceProvenance } from '../../src/research/sourceProvenance.js';
import { scoreClaimSourceRelevance, sourceTokenSet, selectCandidateSources } from '../../src/research/evidenceVerification.js';

const html = (b) => ({ ok: true, status: 200, headers: { get: () => 'text/html' }, text: async () => `<html><body>${b}</body></html>` });
const ARTICLE = 'Google announced Gemini 4 Argon on September 30, 2026 with new reasoning features.';

test('assessContent: short real sentence is substantive; chrome and wrappers are not', () => {
  assert.equal(assessContent('The tool measurably cuts costs.').verdict, CONTENT_VERDICT.SUBSTANTIVE);
  assert.equal(assessContent('Google News').verdict, CONTENT_VERDICT.BOILERPLATE);
  assert.equal(assessContent('Please enable JavaScript to continue using this site').verdict, CONTENT_VERDICT.BOILERPLATE);
  assert.equal(assessContent('Home About Contact Products Pricing Blog Careers').verdict, CONTENT_VERDICT.WEAK);
});

test('substantive plain page never touches the fallback', async () => {
  let readerCalls = 0;
  const r = await retrieveSource('https://a.com/x', { fetchImpl: async () => html(ARTICLE), readerBaseUrl: 'https://reader.example/', readerFetchImpl: async () => { readerCalls++; return html(ARTICLE); } });
  assert.equal(r.status, 'SUCCESS'); assert.equal(r.retrievalMethod, 'plain'); assert.equal(readerCalls, 0);
});

test('boilerplate triggers exactly one fallback; success returns reader text', async () => {
  let readerCalls = 0;
  const r = await retrieveSource('https://a.com/x', { fetchImpl: async () => html('Loading'), readerBaseUrl: 'https://reader.example/', readerFetchImpl: async (u) => { readerCalls++; assert.ok(u.startsWith('https://reader.example/https://a.com/x')); return { ok: true, status: 200, text: async () => ARTICLE }; } });
  assert.equal(r.status, 'SUCCESS'); assert.equal(r.retrievalMethod, 'reader_fallback'); assert.equal(readerCalls, 1);
  assert.equal(r.fallback.attempted, true); assert.equal(r.fallback.success, true);
});

test('fallback failure or weak reader text fails closed as CONTENT_UNPARSEABLE (never retryable FAILED)', async () => {
  for (const readerFetchImpl of [async () => { throw new Error('boom'); }, async () => ({ ok: true, status: 200, text: async () => 'Loading' })]) {
    const r = await retrieveSource('https://a.com/x', { fetchImpl: async () => html('Loading'), readerBaseUrl: 'https://reader.example/', readerFetchImpl });
    assert.equal(r.status, 'CONTENT_UNPARSEABLE'); assert.equal(r.fallback.attempted, true); assert.equal(r.fallback.success, false);
  }
});

test('fallback disabled by default: no attempt recorded', async () => {
  const r = await retrieveSource('https://a.com/x', { fetchImpl: async () => html('Loading'), readerBaseUrl: null });
  assert.equal(r.status, 'CONTENT_UNPARSEABLE'); assert.equal(r.fallback.attempted, false);
});

test('provenance preserves discovery metadata and labels publishedAt as unverified', () => {
  const p = parseSourceProvenance(buildSourceProvenance({ url: 'https://a.com/x', title: 'T', snippet: 'S', publishedAt: '2026-09-30', status: 'SUCCESS', retrievalMethod: 'plain' }));
  assert.equal(p.discovery.title, 'T'); assert.equal(p.discovery.snippet, 'S');
  assert.equal(p.discovery.publishedAtProvenance, 'provider_reported_unverified');
  assert.equal(p.retrieval.method, 'plain'); assert.equal(p.retrieval.status, 'SUCCESS'); assert.ok(p.retrieval.retrievedAt);
});

test('roles unchanged; weak content is inadmissible even when HTTP succeeded', () => {
  const cfg = { authoritativeDomains: ['blog.google'], syndicatedDomains: ['msn.com'] };
  assert.equal(classifySourceRole('https://blog.google/a', cfg).role, 'primary_authoritative');
  assert.equal(classifySourceRole('https://www.msn.com/a', cfg).role, 'syndicated');
  assert.equal(assessEvidenceAdmissibility('SUCCESS', 'independent_reporting', ARTICLE).quality, 'MEDIUM');
  const weak = assessEvidenceAdmissibility('SUCCESS', 'independent_reporting', 'Home About Contact Blog Careers Pricing');
  assert.equal(weak.admissible, false); assert.equal(weak.quality, 'UNUSABLE');
});

test('relevance: relevant source outranks irrelevant; diagnostics recorded', () => {
  const claim = 'Google announced Gemini 4 Argon on September 30, 2026';
  const rel = scoreClaimSourceRelevance(claim, sourceTokenSet(ARTICLE));
  const irr = scoreClaimSourceRelevance(claim, sourceTokenSet('A recipe for sourdough bread with rye flour and salt.'));
  assert.ok(rel.score > irr.score); assert.ok(rel.breakdown.entities.total > 0);
  const policy = JSON.parse(readFileSync(new URL('../../config/research_policy.json', import.meta.url), 'utf8'));
  const diagnostics = { candidatesScored: 0, candidatesRejectedAsIrrelevant: 0, entries: [] };
  const mk = (id, url, content) => ({ id, url, content, retrieval_status: 'SUCCESS', role: 'independent_reporting', quality_tier: 'MEDIUM', retrieved_at: new Date().toISOString() });
  const picked = selectCandidateSources({ claim: { claim }, sources: [mk('1', 'https://a.com/1', ARTICLE), mk('2', 'https://b.com/2', 'A recipe for sourdough bread with rye flour and salt.')], policy, diagnostics });
  assert.equal(diagnostics.candidatesScored, 2);
  assert.equal(diagnostics.candidatesRejectedAsIrrelevant, 1);
  assert.deepEqual(picked.map((c) => c.source.id), ['1']);
  assert.equal(diagnostics.entries.find((e) => e.sourceId === '2').decision, 'rejected');
});
