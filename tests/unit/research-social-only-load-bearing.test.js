import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateSocialOnlyLoadBearing, downgradeSocialOnlyLoadBearing } from '../../src/research/socialOnlyLoadBearing.js';
import { computeEvidenceStatus } from '../../src/research/evidenceGrading.js';
import { evaluateCompleteness } from '../../src/research/completeness.js';
import { classifySourceQuality } from '../../src/research/sourceClassification.js';
import researchPolicy from '../../config/research_policy.json' with { type: 'json' };

const NOW = Date.now();
const recent = new Date(NOW - 1000).toISOString();
const src = (id, url, role, quality_tier) => ({ id, url, role, quality_tier, retrieval_status: 'SUCCESS', retrieved_at: recent });
const IG = src('ig', 'https://www.instagram.com/reel/abc/', 'social_media', 'LOW');
const BLOG = src('bg', 'https://blog.google/x', 'primary_authoritative', 'HIGH');
const NEWS = src('rt', 'https://reuters.com/a', 'independent_reporting', 'MEDIUM');
const byId = (...s) => new Map(s.map((x) => [x.id, x]));
const link = (source_id, role = 'primary') => ({ claim_id: 'c', source_id, role });

test('1. social-only claim -> downgrade', () => {
  const v = evaluateSocialOnlyLoadBearing({ claimSourceLinks: [link('ig')], sourcesById: byId(IG) });
  assert.equal(v.downgrade, true);
  assert.equal(v.reason, 'only_social_media_sources');
});

test('1b. several links to the same social source (primary + corroborating) -> still downgrade', () => {
  const v = evaluateSocialOnlyLoadBearing({ claimSourceLinks: [link('ig'), link('ig', 'corroborating')], sourcesById: byId(IG) });
  assert.equal(v.downgrade, true);
});

test('2. social + admissible independent source -> preserved', () => {
  for (const other of [BLOG, NEWS]) {
    const v = evaluateSocialOnlyLoadBearing({ claimSourceLinks: [link('ig'), link(other.id)], sourcesById: byId(IG, other) });
    assert.equal(v.downgrade, false);
  }
});

test('2b. non-social-only, no links, unresolvable source, and contradicting-only social are not downgraded on a guess', () => {
  assert.equal(evaluateSocialOnlyLoadBearing({ claimSourceLinks: [link('bg')], sourcesById: byId(BLOG) }).downgrade, false);
  assert.equal(evaluateSocialOnlyLoadBearing({ claimSourceLinks: [], sourcesById: byId() }).downgrade, false);
  assert.equal(evaluateSocialOnlyLoadBearing({ claimSourceLinks: [link('missing')], sourcesById: byId() }).downgrade, false);
  // A contradicting non-social link is not support: only the social support counts.
  assert.equal(evaluateSocialOnlyLoadBearing({ claimSourceLinks: [link('ig'), link('bg', 'contradicting')], sourcesById: byId(IG, BLOG) }).downgrade, true);
});

test('3. downgrade is applied and audited; preserved and non-load-bearing claims are untouched', () => {
  const claims = [
    { id: 'a', is_load_bearing: true }, { id: 'b', is_load_bearing: true }, { id: 'c', is_load_bearing: false }
  ];
  const links = { a: [link('ig')], b: [link('ig'), link('bg')], c: [link('ig')] };
  const sets = []; const logs = [];
  const out = downgradeSocialOnlyLoadBearing({
    claims, getLinks: (id) => links[id], sourcesById: byId(IG, BLOG),
    setNotLoadBearing: (id) => sets.push(id), logDowngrade: (c, v) => logs.push({ id: c.id, v })
  });
  assert.deepEqual(out, ['a']);
  assert.deepEqual(sets, ['a']);
  assert.equal(claims[0].is_load_bearing, false);
  assert.equal(claims[1].is_load_bearing, true);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].v.sources[0].role, 'social_media');
  assert.equal(logs[0].v.sources[0].domain, 'instagram.com');
});

test('4. social-source evidence rules unchanged: social-only claim still grades UNSUPPORTED, social never verifies', () => {
  const sourcesById = byId(IG);
  assert.equal(classifySourceQuality('SUCCESS', 'social_media'), 'LOW');
  assert.equal(computeEvidenceStatus({ claimSourceLinks: [link('ig')], sourcesById, policy: researchPolicy, nowMs: NOW }), 'UNSUPPORTED');
  const mixed = byId(IG, NEWS);
  assert.notEqual(computeEvidenceStatus({ claimSourceLinks: [link('ig'), link('rt')], sourcesById: mixed, policy: researchPolicy, nowMs: NOW }), 'VERIFIED');
});

test('5. completeness/thresholds unchanged: UNSUPPORTED load-bearing still blocks; ratio threshold still enforced', () => {
  assert.equal(researchPolicy.completeness.overall_resolution_threshold, 0.7);
  const verified = { id: 'v', claim_type: 'FACT', is_load_bearing: true, evidence_status: 'VERIFIED' };
  const blocked = { id: 'u', claim_type: 'FACT', is_load_bearing: true, evidence_status: 'UNSUPPORTED' };
  const args = { policy: researchPolicy, coreQuestionType: 'FACTUAL', stoppingConditionMet: true };
  assert.equal(evaluateCompleteness({ claims: [verified, blocked], ...args }).status, 'INSUFFICIENT_EVIDENCE');
  // Once the same claim is NOT load-bearing the (unchanged) rules pass it on ratio: 1/2 resolved < 0.7.
  const demoted = { ...blocked, is_load_bearing: false };
  const r = evaluateCompleteness({ claims: [verified, demoted], ...args });
  assert.equal(r.stopReason, 'OVERALL_RESOLUTION_THRESHOLD_NOT_MET');
  const ok = evaluateCompleteness({ claims: [verified, verified, verified, demoted], ...args });
  assert.equal(ok.status, 'RESEARCH_COMPLETE');
});
