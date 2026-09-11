import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseClaimLinks, resolveResearchProject, resolveClaims, hasApplicableContradiction } from '../../src/fact-check/validate.js';

// --- parseClaimLinks ---------------------------------------------------

test('parseClaimLinks: well-formed shape is valid', () => {
  const script = { claim_links: JSON.stringify([{ heading: 'Intro', claim_ids: ['c1', 'c2'] }]) };
  const result = parseClaimLinks(script);
  assert.equal(result.valid, true);
  assert.deepEqual(result.sections, [{ heading: 'Intro', claim_ids: ['c1', 'c2'] }]);
});

test('parseClaimLinks: malformed JSON is a structural failure', () => {
  const script = { claim_links: 'not json{{{' };
  const result = parseClaimLinks(script);
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'CLAIM_LINKS_MALFORMED_JSON');
});

test('parseClaimLinks: non-array top level is a structural failure', () => {
  const script = { claim_links: JSON.stringify({ heading: 'x', claim_ids: [] }) };
  const result = parseClaimLinks(script);
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'CLAIM_LINKS_NOT_ARRAY');
});

test('parseClaimLinks: claim_ids wrong type is a structural failure', () => {
  const script = { claim_links: JSON.stringify([{ heading: 'Intro', claim_ids: 'c1' }]) };
  const result = parseClaimLinks(script);
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'CLAIM_LINKS_CLAIM_IDS_NOT_ARRAY');
});

test('parseClaimLinks: non-string claim id entry is a structural failure', () => {
  const script = { claim_links: JSON.stringify([{ heading: 'Intro', claim_ids: [42] }]) };
  const result = parseClaimLinks(script);
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'CLAIM_LINKS_INVALID_CLAIM_ID_TYPE');
});

test('parseClaimLinks: absent heading is accepted', () => {
  const script = { claim_links: JSON.stringify([{ claim_ids: ['c1'] }]) };
  const result = parseClaimLinks(script);
  assert.equal(result.valid, true);
  assert.deepEqual(result.sections, [{ claim_ids: ['c1'] }]);
});

test('parseClaimLinks: empty-string heading is accepted', () => {
  const script = { claim_links: JSON.stringify([{ heading: '', claim_ids: ['c1'] }]) };
  const result = parseClaimLinks(script);
  assert.equal(result.valid, true);
  assert.deepEqual(result.sections, [{ heading: '', claim_ids: ['c1'] }]);
});

test('parseClaimLinks: non-empty heading remains accepted and preserved', () => {
  const script = { claim_links: JSON.stringify([{ heading: 'Intro', claim_ids: ['c1'] }]) };
  const result = parseClaimLinks(script);
  assert.equal(result.valid, true);
  assert.deepEqual(result.sections, [{ heading: 'Intro', claim_ids: ['c1'] }]);
});

// --- resolveResearchProject (spec §5 join path) -------------------------

function fakeStorageForProject(briefRow) {
  return {
    get(sql, params) {
      if (sql.includes('FROM content_briefs')) {
        return briefRow && briefRow.id === params[0] ? briefRow : undefined;
      }
      throw new Error(`unexpected query: ${sql}`);
    }
  };
}

test('resolveResearchProject: uses scripts.content_brief_id -> content_briefs.research_project_id', () => {
  const storage = fakeStorageForProject({ id: 'brief1', research_project_id: 'proj1' });
  const result = resolveResearchProject(storage, { content_brief_id: 'brief1' });
  assert.equal(result.resolved, true);
  assert.equal(result.researchProjectId, 'proj1');
});

test('resolveResearchProject: missing Brief is unresolved', () => {
  const storage = fakeStorageForProject(undefined);
  const result = resolveResearchProject(storage, { content_brief_id: 'ghost' });
  assert.equal(result.resolved, false);
  assert.equal(result.reason, 'CONTENT_BRIEF_NOT_FOUND');
});

test('resolveResearchProject: Brief with no research_project_id is unresolved', () => {
  const storage = fakeStorageForProject({ id: 'brief1', research_project_id: null });
  const result = resolveResearchProject(storage, { content_brief_id: 'brief1' });
  assert.equal(result.resolved, false);
  assert.equal(result.reason, 'BRIEF_HAS_NO_RESEARCH_PROJECT');
});

// --- resolveClaims (spec §5: project-scoped resolution only) -----------

function fakeStorageForClaims(claimsById) {
  return {
    get(sql, params) {
      if (sql.includes('FROM claims')) {
        return claimsById[params[0]];
      }
      throw new Error(`unexpected query: ${sql}`);
    }
  };
}

test('resolveClaims: every claim in the correct project resolves', () => {
  const storage = fakeStorageForClaims({
    c1: { id: 'c1', research_project_id: 'proj1', evidence_status: 'VERIFIED' }
  });
  const result = resolveClaims(storage, 'proj1', [{ heading: 'Intro', claim_ids: ['c1'] }]);
  assert.equal(result.valid, true);
  assert.equal(result.resolved.length, 1);
  assert.equal(result.resolved[0].claim.id, 'c1');
});

test('resolveClaims: nonexistent claim id is a structural failure, not a missing/unsupported finding', () => {
  const storage = fakeStorageForClaims({});
  const result = resolveClaims(storage, 'proj1', [{ heading: 'Intro', claim_ids: ['ghost'] }]);
  assert.equal(result.valid, false);
  assert.match(result.reason, /^INVALID_CLAIM_REFERENCE_ghost$/);
});

test('resolveClaims: claim from an unrelated Research project is rejected, not silently substituted', () => {
  const storage = fakeStorageForClaims({
    c1: { id: 'c1', research_project_id: 'OTHER_PROJECT', evidence_status: 'VERIFIED' }
  });
  const result = resolveClaims(storage, 'proj1', [{ heading: 'Intro', claim_ids: ['c1'] }]);
  assert.equal(result.valid, false);
  assert.match(result.reason, /^CLAIM_WRONG_RESEARCH_PROJECT_c1$/);
});

test('resolveClaims: empty claim set (no claim_ids anywhere) is a structural failure', () => {
  const storage = fakeStorageForClaims({});
  const result = resolveClaims(storage, 'proj1', [{ heading: 'Intro', claim_ids: [] }]);
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'CLAIM_LINKS_EMPTY');
});

// --- hasApplicableContradiction (spec §6) -------------------------------

function fakeStorageForContradiction({ relations, claimsById }) {
  return {
    all(sql, params) {
      if (sql.includes('FROM claim_relations')) {
        return relations.filter((r) => r.claim_id === params[0] || r.related_claim_id === params[1]);
      }
      throw new Error(`unexpected query: ${sql}`);
    },
    get(sql, params) {
      if (sql.includes('FROM claims')) {
        return claimsById[params[0]];
      }
      throw new Error(`unexpected query: ${sql}`);
    }
  };
}

test('hasApplicableContradiction: same-project CONTRADICTS relation is applicable', () => {
  const storage = fakeStorageForContradiction({
    relations: [{ claim_id: 'c1', related_claim_id: 'c2', relation_type: 'CONTRADICTS' }],
    claimsById: { c2: { id: 'c2', research_project_id: 'proj1' } }
  });
  const result = hasApplicableContradiction(storage, { id: 'c1' }, 'proj1');
  assert.equal(result, true);
});

test('hasApplicableContradiction: cross-project CONTRADICTS relation is NOT applicable', () => {
  const storage = fakeStorageForContradiction({
    relations: [{ claim_id: 'c1', related_claim_id: 'c2', relation_type: 'CONTRADICTS' }],
    claimsById: { c2: { id: 'c2', research_project_id: 'OTHER_PROJECT' } }
  });
  const result = hasApplicableContradiction(storage, { id: 'c1' }, 'proj1');
  assert.equal(result, false);
});

test('hasApplicableContradiction: undirected — matches when claim is the related_claim_id side too', () => {
  const storage = fakeStorageForContradiction({
    relations: [{ claim_id: 'c2', related_claim_id: 'c1', relation_type: 'CONTRADICTS' }],
    claimsById: { c2: { id: 'c2', research_project_id: 'proj1' } }
  });
  const result = hasApplicableContradiction(storage, { id: 'c1' }, 'proj1');
  assert.equal(result, true);
});

test('hasApplicableContradiction: no relation -> not applicable', () => {
  const storage = fakeStorageForContradiction({ relations: [], claimsById: {} });
  const result = hasApplicableContradiction(storage, { id: 'c1' }, 'proj1');
  assert.equal(result, false);
});