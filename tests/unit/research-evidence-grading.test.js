import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeEvidenceStatus, isSourceFresh } from '../../src/research/evidenceGrading.js';
import researchPolicy from '../../config/research_policy.json' with { type: 'json' };

const NOW = Date.parse('2026-09-10T00:00:00.000Z');

function source(overrides = {}) {
  return {
    id: overrides.id || 'src-1',
    role: 'independent_reporting',
    quality_tier: 'MEDIUM',
    retrieval_status: 'SUCCESS',
    retrieved_at: new Date(NOW).toISOString(),
    ...overrides
  };
}

test('a single primary_authoritative source is sufficient alone -> VERIFIED', () => {
  const src = source({ id: 's1', role: 'primary_authoritative', quality_tier: 'HIGH' });
  const sourcesById = new Map([[src.id, src]]);
  const status = computeEvidenceStatus({
    claimSourceLinks: [{ source_id: src.id }], sourcesById, policy: researchPolicy, nowMs: NOW
  });
  assert.equal(status, 'VERIFIED');
});

test('fewer independent_reporting sources than the configured minimum -> PARTIALLY_SUPPORTED, not VERIFIED', () => {
  const s1 = source({ id: 's1' });
  const sourcesById = new Map([[s1.id, s1]]);
  const status = computeEvidenceStatus({
    claimSourceLinks: [{ source_id: s1.id }], sourcesById, policy: researchPolicy, nowMs: NOW
  });
  assert.equal(status, 'PARTIALLY_SUPPORTED');
});

test('meeting the configured independent_reporting minimum -> VERIFIED', () => {
  const s1 = source({ id: 's1' });
  const s2 = source({ id: 's2' });
  const sourcesById = new Map([[s1.id, s1], [s2.id, s2]]);
  const status = computeEvidenceStatus({
    claimSourceLinks: [{ source_id: 's1' }, { source_id: 's2' }], sourcesById, policy: researchPolicy, nowMs: NOW
  });
  assert.equal(status, 'VERIFIED');
});

test('three syndicated sources from distinct domains do NOT satisfy corroboration (domain diversity is not independence)', () => {
  const s1 = source({ id: 's1', role: 'syndicated', quality_tier: 'LOW' });
  const s2 = source({ id: 's2', role: 'syndicated', quality_tier: 'LOW' });
  const s3 = source({ id: 's3', role: 'syndicated', quality_tier: 'LOW' });
  const sourcesById = new Map([[s1.id, s1], [s2.id, s2], [s3.id, s3]]);
  const status = computeEvidenceStatus({
    claimSourceLinks: [{ source_id: 's1' }, { source_id: 's2' }, { source_id: 's3' }],
    sourcesById, policy: researchPolicy, nowMs: NOW
  });
  assert.notEqual(status, 'VERIFIED');
  assert.equal(status, 'UNSUPPORTED'); // LOW quality also fails the minimum-quality-for-corroboration gate
});

test('no usable sources at all -> UNSUPPORTED', () => {
  const status = computeEvidenceStatus({ claimSourceLinks: [], sourcesById: new Map(), policy: researchPolicy, nowMs: NOW });
  assert.equal(status, 'UNSUPPORTED');
});

test('an unresolved contradiction forces CONTESTED regardless of otherwise-sufficient evidence', () => {
  const s1 = source({ id: 's1', role: 'primary_authoritative', quality_tier: 'HIGH' });
  const sourcesById = new Map([[s1.id, s1]]);
  const status = computeEvidenceStatus({
    claimSourceLinks: [{ source_id: 's1' }], sourcesById, policy: researchPolicy, nowMs: NOW, hasUnresolvedContradiction: true
  });
  assert.equal(status, 'CONTESTED');
});

test('isSourceFresh: fresh source is eligible, stale source is not', () => {
  const fresh = source({ retrieved_at: new Date(NOW - 60 * 60 * 1000).toISOString() }); // 1h old
  const stale = source({ retrieved_at: new Date(NOW - (researchPolicy.staleness.maximum_source_age_hours + 1) * 60 * 60 * 1000).toISOString() });
  assert.equal(isSourceFresh(fresh, researchPolicy, NOW), true);
  assert.equal(isSourceFresh(stale, researchPolicy, NOW), false);
});

test('a stale primary_authoritative source does NOT satisfy evidence requirements on its own', () => {
  const stale = source({
    id: 's1', role: 'primary_authoritative', quality_tier: 'HIGH',
    retrieved_at: new Date(NOW - (researchPolicy.staleness.maximum_source_age_hours + 100) * 60 * 60 * 1000).toISOString()
  });
  const sourcesById = new Map([[stale.id, stale]]);
  const status = computeEvidenceStatus({
    claimSourceLinks: [{ source_id: 's1' }], sourcesById, policy: researchPolicy, nowMs: NOW
  });
  assert.equal(status, 'UNSUPPORTED');
});

test('a below-minimum-quality-tier source does not count toward corroboration', () => {
  const low1 = source({ id: 's1', quality_tier: 'LOW' });
  const low2 = source({ id: 's2', quality_tier: 'LOW' });
  const sourcesById = new Map([[low1.id, low1], [low2.id, low2]]);
  const status = computeEvidenceStatus({
    claimSourceLinks: [{ source_id: 's1' }, { source_id: 's2' }], sourcesById, policy: researchPolicy, nowMs: NOW
  });
  assert.equal(status, 'UNSUPPORTED');
});

test('a FAILED-retrieval source never counts as eligible evidence even if linked', () => {
  const failed = source({ id: 's1', retrieval_status: 'FAILED', quality_tier: 'UNUSABLE' });
  const sourcesById = new Map([[failed.id, failed]]);
  const status = computeEvidenceStatus({
    claimSourceLinks: [{ source_id: 's1' }], sourcesById, policy: researchPolicy, nowMs: NOW
  });
  assert.equal(status, 'UNSUPPORTED');
});