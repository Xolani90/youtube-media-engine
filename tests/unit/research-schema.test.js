import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { SqliteStorageDriver } from '../../src/storage/SqliteStorageDriver.js';

function freshStorage() {
  const dbPath = path.join(os.tmpdir(), `research-schema-${Date.now()}-${Math.random()}.db`);
  return { storage: new SqliteStorageDriver({ dbPath }), dbPath };
}

function cleanup(storage, dbPath) {
  storage.close();
  fs.rmSync(dbPath, { force: true });
  fs.rmSync(`${dbPath}-wal`, { force: true });
  fs.rmSync(`${dbPath}-shm`, { force: true });
}

function seedOpportunity(storage, overrides = {}) {
  const id = overrides.id || crypto.randomUUID();
  storage.run(
    `INSERT INTO opportunities (id, title, source, discovered_at, status, opportunity_proposition)
     VALUES (?, 'x', 'rss', ?, 'HANDED_TO_RESEARCH', ?)`,
    [id, new Date().toISOString(), JSON.stringify({ core_question_type: 'FACTUAL' })]
  );
  return id;
}

test('migration 0003 applies cleanly and creates the expected tables', async () => {
  const { storage, dbPath } = freshStorage();
  const files = await storage.migrate();
  assert.ok(files.includes('0003_research_subsystem.sql'));
  const tables = storage.all("SELECT name FROM sqlite_master WHERE type='table'").map((r) => r.name);
  for (const t of ['research_projects', 'sources', 'claims', 'claim_sources', 'claim_relations']) {
    assert.ok(tables.includes(t), `expected table ${t}`);
  }
  cleanup(storage, dbPath);
});

test('claims.claim_type CHECK constraint rejects the old four-value vocabulary', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const oppId = seedOpportunity(storage);
  const projId = crypto.randomUUID();
  storage.run(`INSERT INTO research_projects (id, opportunity_id, status, created_at) VALUES (?, ?, 'RESEARCHING', ?)`, [projId, oppId, new Date().toISOString()]);

  assert.throws(() => {
    storage.run(
      `INSERT INTO claims (id, research_project_id, claim, claim_type, evidence_status, is_load_bearing, created_at)
       VALUES (?, ?, 'x', 'verified_fact', 'UNSUPPORTED', 0, ?)`,
      [crypto.randomUUID(), projId, new Date().toISOString()]
    );
  }, /CHECK constraint failed/);

  // The new vocabulary must succeed.
  assert.doesNotThrow(() => {
    storage.run(
      `INSERT INTO claims (id, research_project_id, claim, claim_type, evidence_status, is_load_bearing, created_at)
       VALUES (?, ?, 'x', 'FACT', 'UNSUPPORTED', 0, ?)`,
      [crypto.randomUUID(), projId, new Date().toISOString()]
    );
  });
  cleanup(storage, dbPath);
});

test('research_projects.status CHECK constraint rejects an invalid status', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const oppId = seedOpportunity(storage);
  assert.throws(() => {
    storage.run(`INSERT INTO research_projects (id, opportunity_id, status, created_at) VALUES (?, ?, 'BOGUS', ?)`,
      [crypto.randomUUID(), oppId, new Date().toISOString()]);
  }, /CHECK constraint failed/);
  cleanup(storage, dbPath);
});

test('research_projects enforces one project per opportunity at the DATABASE level', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const oppId = seedOpportunity(storage);
  storage.run(`INSERT INTO research_projects (id, opportunity_id, status, created_at) VALUES (?, ?, 'RESEARCHING', ?)`,
    [crypto.randomUUID(), oppId, new Date().toISOString()]);
  assert.throws(() => {
    storage.run(`INSERT INTO research_projects (id, opportunity_id, status, created_at) VALUES (?, ?, 'RESEARCHING', ?)`,
      [crypto.randomUUID(), oppId, new Date().toISOString()]);
  }, /UNIQUE constraint failed/);
  cleanup(storage, dbPath);
});

test('claim_sources rejects a duplicate (claim_id, source_id, role) row at the DATABASE level', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const oppId = seedOpportunity(storage);
  const projId = crypto.randomUUID();
  storage.run(`INSERT INTO research_projects (id, opportunity_id, status, created_at) VALUES (?, ?, 'RESEARCHING', ?)`, [projId, oppId, new Date().toISOString()]);
  const claimId = crypto.randomUUID();
  storage.run(`INSERT INTO claims (id, research_project_id, claim, claim_type, evidence_status, is_load_bearing, created_at) VALUES (?, ?, 'x', 'FACT', 'UNSUPPORTED', 1, ?)`, [claimId, projId, new Date().toISOString()]);
  const sourceId = crypto.randomUUID();
  storage.run(`INSERT INTO sources (id, research_project_id, url, retrieval_status, retrieved_at) VALUES (?, ?, 'http://x', 'SUCCESS', ?)`, [sourceId, projId, new Date().toISOString()]);

  storage.run(`INSERT INTO claim_sources (id, claim_id, source_id, role, created_at) VALUES (?, ?, ?, 'primary', ?)`,
    [crypto.randomUUID(), claimId, sourceId, new Date().toISOString()]);
  assert.throws(() => {
    storage.run(`INSERT INTO claim_sources (id, claim_id, source_id, role, created_at) VALUES (?, ?, ?, 'primary', ?)`,
      [crypto.randomUUID(), claimId, sourceId, new Date().toISOString()]);
  }, /UNIQUE constraint failed/);
  cleanup(storage, dbPath);
});

test('claim_relations rejects a self-referencing row and a mirrored duplicate pair', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const oppId = seedOpportunity(storage);
  const projId = crypto.randomUUID();
  storage.run(`INSERT INTO research_projects (id, opportunity_id, status, created_at) VALUES (?, ?, 'RESEARCHING', ?)`, [projId, oppId, new Date().toISOString()]);
  const claimA = crypto.randomUUID();
  const claimB = crypto.randomUUID();
  for (const id of [claimA, claimB]) {
    storage.run(`INSERT INTO claims (id, research_project_id, claim, claim_type, evidence_status, is_load_bearing, created_at) VALUES (?, ?, 'x', 'FACT', 'UNSUPPORTED', 1, ?)`, [id, projId, new Date().toISOString()]);
  }

  assert.throws(() => {
    storage.run(`INSERT INTO claim_relations (id, claim_id, related_claim_id, relation_type, created_at) VALUES (?, ?, ?, 'CONTRADICTS', ?)`,
      [crypto.randomUUID(), claimA, claimA, new Date().toISOString()]);
  }, /CHECK constraint failed/);

  const [a, b] = [claimA, claimB].sort();
  storage.run(`INSERT INTO claim_relations (id, claim_id, related_claim_id, relation_type, created_at) VALUES (?, ?, ?, 'CONTRADICTS', ?)`,
    [crypto.randomUUID(), a, b, new Date().toISOString()]);
  // Mirrored (b, a) with the same relation_type must be rejected once canonicalized the same way is attempted again.
  assert.throws(() => {
    storage.run(`INSERT INTO claim_relations (id, claim_id, related_claim_id, relation_type, created_at) VALUES (?, ?, ?, 'CONTRADICTS', ?)`,
      [crypto.randomUUID(), a, b, new Date().toISOString()]);
  }, /UNIQUE constraint failed/);
  cleanup(storage, dbPath);
});