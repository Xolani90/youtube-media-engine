import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { SqliteStorageDriver } from '../../src/storage/SqliteStorageDriver.js';
import { selectEligibleKeyClaims, validateKeyClaimIds } from '../../src/brief/claims.js';
import { recordContradiction, canonicalizePair } from '../../src/research/contradictions.js';

function freshStorage() {
  const dbPath = path.join(os.tmpdir(), `brief-claims-${Date.now()}-${Math.random()}.db`);
  return { storage: new SqliteStorageDriver({ dbPath }), dbPath };
}

function cleanup(storage, dbPath) {
  storage.close();
  fs.rmSync(dbPath, { force: true });
  fs.rmSync(`${dbPath}-wal`, { force: true });
  fs.rmSync(`${dbPath}-shm`, { force: true });
}

function seedResearchProject(storage) {
  const opportunityId = crypto.randomUUID();
  storage.run(
    `INSERT INTO opportunities (id, title, source, discovered_at, status, opportunity_proposition)
     VALUES (?, 'x', 'rss', ?, 'HANDED_TO_RESEARCH', ?)`,
    [opportunityId, new Date().toISOString(), JSON.stringify({ core_question: 'q' })]
  );
  const researchProjectId = crypto.randomUUID();
  storage.run(
    `INSERT INTO research_projects (id, opportunity_id, status, created_at) VALUES (?, ?, 'RESEARCH_COMPLETE', ?)`,
    [researchProjectId, opportunityId, new Date().toISOString()]
  );
  return researchProjectId;
}

function insertClaim(storage, researchProjectId, { claim, claimType, evidenceStatus }) {
  const id = crypto.randomUUID();
  storage.run(
    `INSERT INTO claims (id, research_project_id, claim, claim_type, evidence_status, is_load_bearing, created_at)
     VALUES (?, ?, ?, ?, ?, 1, ?)`,
    [id, researchProjectId, claim, claimType, evidenceStatus, new Date().toISOString()]
  );
  return id;
}

test('selectEligibleKeyClaims includes only VERIFIED FACT/INFERENCE claims (D2, D12)', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const rpId = seedResearchProject(storage);

  const verifiedFact = insertClaim(storage, rpId, { claim: 'a', claimType: 'FACT', evidenceStatus: 'VERIFIED' });
  insertClaim(storage, rpId, { claim: 'b', claimType: 'OPINION', evidenceStatus: 'VERIFIED' });
  insertClaim(storage, rpId, { claim: 'c', claimType: 'FACT', evidenceStatus: 'PARTIALLY_SUPPORTED' });
  insertClaim(storage, rpId, { claim: 'd', claimType: 'FACT', evidenceStatus: 'UNSUPPORTED' });
  insertClaim(storage, rpId, { claim: 'e', claimType: 'FACT', evidenceStatus: 'CONTESTED' });
  const verifiedInference = insertClaim(storage, rpId, { claim: 'f', claimType: 'INFERENCE', evidenceStatus: 'VERIFIED' });

  const eligible = selectEligibleKeyClaims(storage, rpId).map((c) => c.id).sort();
  assert.deepEqual(eligible, [verifiedFact, verifiedInference].sort());

  cleanup(storage, dbPath);
});

test('selectEligibleKeyClaims excludes a claim with an unresolved contradiction (D3), but does not exclude the rest of the project', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const rpId = seedResearchProject(storage);

  const contestedA = insertClaim(storage, rpId, { claim: 'a', claimType: 'FACT', evidenceStatus: 'VERIFIED' });
  const contestedB = insertClaim(storage, rpId, { claim: 'b', claimType: 'FACT', evidenceStatus: 'VERIFIED' });
  const clean = insertClaim(storage, rpId, { claim: 'c', claimType: 'FACT', evidenceStatus: 'VERIFIED' });

  const [canonA, canonB] = canonicalizePair(contestedA, contestedB);
  recordContradiction(storage, { claimId: canonA, relatedClaimId: canonB });

  const eligible = selectEligibleKeyClaims(storage, rpId).map((c) => c.id);
  assert.ok(!eligible.includes(contestedA));
  assert.ok(!eligible.includes(contestedB));
  assert.ok(eligible.includes(clean));

  cleanup(storage, dbPath);
});

test('validateKeyClaimIds accepts a subset of eligible ids', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const rpId = seedResearchProject(storage);
  const id1 = insertClaim(storage, rpId, { claim: 'a', claimType: 'FACT', evidenceStatus: 'VERIFIED' });
  insertClaim(storage, rpId, { claim: 'b', claimType: 'FACT', evidenceStatus: 'VERIFIED' });

  const result = validateKeyClaimIds(storage, rpId, [id1]);
  assert.equal(result.valid, true);

  cleanup(storage, dbPath);
});

test('validateKeyClaimIds rejects an empty array (D10)', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const rpId = seedResearchProject(storage);
  const result = validateKeyClaimIds(storage, rpId, []);
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'EMPTY_KEY_CLAIMS');
  cleanup(storage, dbPath);
});

test('validateKeyClaimIds rejects an invented/unknown claim id (D9)', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const rpId = seedResearchProject(storage);
  insertClaim(storage, rpId, { claim: 'a', claimType: 'FACT', evidenceStatus: 'VERIFIED' });

  const result = validateKeyClaimIds(storage, rpId, [crypto.randomUUID()]);
  assert.equal(result.valid, false);
  assert.match(result.reason, /INELIGIBLE_OR_UNKNOWN_CLAIM_ID/);

  cleanup(storage, dbPath);
});

test('validateKeyClaimIds rejects a claim id belonging to a different Research project', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const rpId = seedResearchProject(storage);
  const otherRpId = seedResearchProject(storage);
  const foreignClaimId = insertClaim(storage, otherRpId, { claim: 'a', claimType: 'FACT', evidenceStatus: 'VERIFIED' });

  const result = validateKeyClaimIds(storage, rpId, [foreignClaimId]);
  assert.equal(result.valid, false);
  assert.match(result.reason, /INELIGIBLE_OR_UNKNOWN_CLAIM_ID/);

  cleanup(storage, dbPath);
});

test('validateKeyClaimIds rejects a non-VERIFIED claim id even if it exists on this project', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const rpId = seedResearchProject(storage);
  const unsupported = insertClaim(storage, rpId, { claim: 'a', claimType: 'FACT', evidenceStatus: 'UNSUPPORTED' });

  const result = validateKeyClaimIds(storage, rpId, [unsupported]);
  assert.equal(result.valid, false);

  cleanup(storage, dbPath);
});

test('validateKeyClaimIds rejects duplicate ids', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const rpId = seedResearchProject(storage);
  const id1 = insertClaim(storage, rpId, { claim: 'a', claimType: 'FACT', evidenceStatus: 'VERIFIED' });

  const result = validateKeyClaimIds(storage, rpId, [id1, id1]);
  assert.equal(result.valid, false);
  assert.match(result.reason, /DUPLICATE_CLAIM_ID/);

  cleanup(storage, dbPath);
});