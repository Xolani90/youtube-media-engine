import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { SqliteStorageDriver } from '../../src/storage/SqliteStorageDriver.js';
import { canonicalizePair, recordContradiction, hasUnresolvedContradiction } from '../../src/research/contradictions.js';

function setup() {
  const dbPath = path.join(os.tmpdir(), `research-contradictions-${Date.now()}-${Math.random()}.db`);
  const storage = new SqliteStorageDriver({ dbPath });
  return { storage, dbPath };
}

async function seedProjectWithClaims(storage, n = 2) {
  await storage.migrate();
  const oppId = crypto.randomUUID();
  storage.run(`INSERT INTO opportunities (id, title, source, discovered_at, status, opportunity_proposition) VALUES (?, 'x', 'rss', ?, 'HANDED_TO_RESEARCH', '{}')`,
    [oppId, new Date().toISOString()]);
  const projId = crypto.randomUUID();
  storage.run(`INSERT INTO research_projects (id, opportunity_id, status, created_at) VALUES (?, ?, 'RESEARCHING', ?)`, [projId, oppId, new Date().toISOString()]);
  const claimIds = [];
  for (let i = 0; i < n; i++) {
    const id = crypto.randomUUID();
    storage.run(`INSERT INTO claims (id, research_project_id, claim, claim_type, evidence_status, is_load_bearing, created_at) VALUES (?, ?, ?, 'FACT', 'UNSUPPORTED', 1, ?)`,
      [id, projId, `claim ${i}`, new Date().toISOString()]);
    claimIds.push(id);
  }
  return claimIds;
}

function cleanup(storage, dbPath) {
  storage.close();
  fs.rmSync(dbPath, { force: true });
  fs.rmSync(`${dbPath}-wal`, { force: true });
  fs.rmSync(`${dbPath}-shm`, { force: true });
}

test('canonicalizePair always orders the same pair identically regardless of input order', () => {
  assert.deepEqual(canonicalizePair('a', 'b'), ['a', 'b']);
  assert.deepEqual(canonicalizePair('b', 'a'), ['a', 'b']);
});

test('recordContradiction rejects a claim contradicting itself', () => {
  const { storage, dbPath } = setup();
  assert.throws(() => recordContradiction(storage, { claimId: 'x', relatedClaimId: 'x' }));
  cleanup(storage, dbPath);
});

test('recording (A,B) then (B,A) does not create a mirrored duplicate — second call is a no-op', async () => {
  const { storage, dbPath } = setup();
  const [claimA, claimB] = await seedProjectWithClaims(storage, 2);

  const first = recordContradiction(storage, { claimId: claimA, relatedClaimId: claimB });
  assert.equal(first.inserted, true);

  const mirrored = recordContradiction(storage, { claimId: claimB, relatedClaimId: claimA });
  assert.equal(mirrored.inserted, false);
  assert.equal(mirrored.reason, 'ALREADY_RECORDED');

  const rows = storage.all('SELECT * FROM claim_relations');
  assert.equal(rows.length, 1);
  cleanup(storage, dbPath);
});

test('hasUnresolvedContradiction is true for either side of a recorded relation', async () => {
  const { storage, dbPath } = setup();
  const [claimA, claimB, claimC] = await seedProjectWithClaims(storage, 3);
  recordContradiction(storage, { claimId: claimA, relatedClaimId: claimB });

  assert.equal(hasUnresolvedContradiction(storage, claimA), true);
  assert.equal(hasUnresolvedContradiction(storage, claimB), true);
  assert.equal(hasUnresolvedContradiction(storage, claimC), false);
  cleanup(storage, dbPath);
});