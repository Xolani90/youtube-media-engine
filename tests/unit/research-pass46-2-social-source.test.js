import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifySourceRole, classifySourceQuality, assessEvidenceAdmissibility } from '../../src/research/sourceClassification.js';
import { selectCandidateSources } from '../../src/research/evidenceVerification.js';
import { computeEvidenceStatus, explainEvidenceSources } from '../../src/research/evidenceGrading.js';
import { SOURCE_ROLE } from '../../src/research/constants.js';
import researchPolicy from '../../config/research_policy.json' with { type: 'json' };
import classificationConfig from '../../config/research_source_classification.json' with { type: 'json' };

const NOW = Date.now();
const recent = new Date(NOW - 1000).toISOString();
const CFG = { authoritativeDomains: classificationConfig.authoritativeDomains, syndicatedDomains: classificationConfig.syndicatedDomains, socialDomains: classificationConfig.socialDomains };
const FB = 'https://www.facebook.com/JamoraquaiPage/posts/google-announced-gemini-4-argon/1736821805117004';
const mk = (id, url, role, quality_tier, content = 'x') => ({ id, url, role, quality_tier, content, retrieval_status: 'SUCCESS', retrieved_at: recent });

test('1. config: facebook.com is social, blog.google stays authoritative', () => {
  assert.ok(classificationConfig.socialDomains.includes('facebook.com'));
  assert.deepEqual(classificationConfig.authoritativeDomains, ['blog.google']);
});

test('1. classification: facebook URL -> social_media', () => {
  assert.equal(classifySourceRole(FB, CFG).role, 'social_media');
  assert.equal(SOURCE_ROLE.SOCIAL_MEDIA, 'social_media');
});

test('2. unknown domains remain independent_reporting', () => {
  assert.equal(classifySourceRole('https://www.reuters.com/a', CFG).role, 'independent_reporting');
});

test('3. blog.google -> primary_authoritative / HIGH', () => {
  const r = classifySourceRole('https://blog.google/technology/ai/gemini-4/', CFG);
  assert.equal(r.role, 'primary_authoritative');
  assert.equal(classifySourceQuality('SUCCESS', r.role), 'HIGH');
});

test('4. social quality is not MEDIUM (LOW), even with substantive content', () => {
  assert.equal(classifySourceQuality('SUCCESS', 'social_media'), 'LOW');
  const text = 'Google announced Gemini 4 Argon on 30 September 2026. The model is its next frontier release. Details follow in the post.';
  const a = assessEvidenceAdmissibility('SUCCESS', 'social_media', text);
  assert.notEqual(a.quality, 'MEDIUM');
  assert.equal(a.quality, 'LOW');
});

test('5. corroboration: reuters + facebook => 1 independent domain, not VERIFIED', () => {
  const reuters = mk('r', 'https://reuters.com/a', 'independent_reporting', 'MEDIUM');
  const fb = mk('f', FB, 'social_media', 'LOW');
  const sourcesById = new Map([['r', reuters], ['f', fb]]);
  const links = [{ claim_id: 'c', source_id: 'r' }, { claim_id: 'c', source_id: 'f' }];
  const ex = explainEvidenceSources({ claimSourceLinks: links, sourcesById, policy: researchPolicy, nowMs: NOW });
  assert.equal(ex.independentCount, 1);
  assert.ok(!ex.independentDomains.includes('facebook.com'));
  assert.notEqual(computeEvidenceStatus({ claimSourceLinks: links, sourcesById, policy: researchPolicy, nowMs: NOW }), 'VERIFIED');
});

test('5b. social role is excluded even if mislabelled MEDIUM quality; authoritative + reuters + facebook => 1', () => {
  const sourcesById = new Map([
    ['r', mk('r', 'https://reuters.com/a', 'independent_reporting', 'MEDIUM')],
    ['f', mk('f', FB, 'social_media', 'MEDIUM')],
    ['g', mk('g', 'https://blog.google/x', 'primary_authoritative', 'HIGH')]
  ]);
  const ex = explainEvidenceSources({ claimSourceLinks: [{ source_id: 'r' }, { source_id: 'f' }], sourcesById, policy: researchPolicy, nowMs: NOW });
  assert.equal(ex.independentCount, 1);
  assert.notEqual(computeEvidenceStatus({ claimSourceLinks: [{ claim_id: 'c', source_id: 'r' }, { claim_id: 'c', source_id: 'f' }], sourcesById, policy: researchPolicy, nowMs: NOW }), 'VERIFIED');
});

test('6. candidate selection: highly relevant facebook source is excluded', () => {
  const claim = { id: 'c1', claim: 'Google announced Gemini 4 Argon on 30 September 2026.', claim_type: 'FACT', identity: { subject: 'Google', predicate: 'announce' } };
  const text = 'Google announced Gemini 4 Argon on 30 September 2026. Google announced Gemini 4 Argon as its next frontier model.';
  const fb = mk('f', FB, 'social_media', 'MEDIUM', text); // MEDIUM on purpose: role alone must exclude it
  const ok = mk('o', 'https://other-news.org/a', 'independent_reporting', 'MEDIUM', text);
  const ids = selectCandidateSources({ claim, sources: [fb, ok], policy: researchPolicy, nowMs: NOW }).map((c) => c.source.id);
  assert.ok(!ids.includes('f'));
  assert.deepEqual(ids, ['o']);
});

test('7. a weak social-looking page is never evidence because of domain config', () => {
  const a = assessEvidenceAdmissibility('SUCCESS', 'social_media', 'Log in to Facebook.');
  assert.equal(a.admissible, false);
  assert.equal(a.quality, 'UNUSABLE');
  // an unlisted social-looking domain is plain independent_reporting; admissibility still rests on content
  const b = assessEvidenceAdmissibility('SUCCESS', classifySourceRole('https://www.instagram.com/p/1', CFG).role, 'Log in.');
  assert.equal(b.admissible, false);
});

test('Pass 49: every major social platform is social_media, including subdomains, and never independent', () => {
  for (const u of [
    'https://www.instagram.com/p/Dd8e-BPq9pa', 'https://x.com/Google/status/2105388143902175529', 'https://twitter.com/Google/status/1',
    'https://mobile.twitter.com/a/status/1', 'https://m.facebook.com/p/1', 'https://t.co/abc', 'https://www.threads.net/@a/post/1',
    'https://www.tiktok.com/@a/video/1', 'https://www.linkedin.com/posts/a-1', 'https://old.reddit.com/r/x/comments/1',
    'https://www.youtube.com/watch?v=l6jusMhGXVk', 'https://youtu.be/l6jusMhGXVk', 'https://bsky.app/profile/a/post/1', 'https://fb.watch/abc'
  ]) assert.equal(classifySourceRole(u, CFG).role, 'social_media', u);
});

test('Pass 49: lookalike and unrelated domains are not social; authoritative stays exact-match', () => {
  for (const u of ['https://notx.com/a', 'https://fox.com/a', 'https://reuters.com/a', 'https://nextdoor.example/a'])
    assert.equal(classifySourceRole(u, CFG).role, 'independent_reporting', u);
  assert.equal(classifySourceRole('https://blog.google/a', CFG).role, 'primary_authoritative');
  assert.equal(classifySourceRole('https://evil.blog.google.attacker.com/a', CFG).role, 'independent_reporting');
});

test('Pass 49: an X post plus one independent publisher is ONE independent domain, not VERIFIED', () => {
  const reuters = mk('r', 'https://reuters.com/a', 'independent_reporting', 'MEDIUM');
  const xRole = classifySourceRole('https://x.com/Google/status/1', CFG).role;
  const x = mk('x', 'https://x.com/Google/status/1', xRole, 'MEDIUM');
  const sourcesById = new Map([['r', reuters], ['x', x]]);
  const links = [{ claim_id: 'c', source_id: 'r' }, { claim_id: 'c', source_id: 'x' }];
  const ex = explainEvidenceSources({ claimSourceLinks: links, sourcesById, policy: researchPolicy, nowMs: NOW });
  assert.equal(xRole, 'social_media');
  assert.equal(ex.independentCount, 1);
  assert.ok(!ex.independentDomains.includes('x.com'));
  assert.notEqual(computeEvidenceStatus({ claimSourceLinks: links, sourcesById, policy: researchPolicy, nowMs: NOW }), 'VERIFIED');
});
