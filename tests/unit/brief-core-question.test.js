import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { SqliteStorageDriver } from '../../src/storage/SqliteStorageDriver.js';
import { resolveAuthoritativeCoreQuestion, coreQuestionMatches } from '../../src/brief/coreQuestion.js';

function freshStorage() {
  const dbPath = path.join(os.tmpdir(), `brief-core-question-${Date.now()}-${Math.random()}.db`);
  return { storage: new SqliteStorageDriver({ dbPath }), dbPath };
}

function cleanup(storage, dbPath) {
  storage.close();
  fs.rmSync(dbPath, { force: true });
  fs.rmSync(`${dbPath}-wal`, { force: true });
  fs.rmSync(`${dbPath}-shm`, { force: true });
}

function seedOpportunityAndResearchProject(storage, { coreQuestion }) {
  const opportunityId = crypto.randomUUID();
  storage.run(
    `INSERT INTO opportunities (id, title, source, discovered_at, status, opportunity_proposition)
     VALUES (?, 'Test opportunity', 'rss', ?, 'HANDED_TO_RESEARCH', ?)`,
    [opportunityId, new Date().toISOString(), JSON.stringify({ core_question: coreQuestion })]
  );
  const researchProjectId = crypto.randomUUID();
  storage.run(
    `INSERT INTO research_projects (id, opportunity_id, status, created_at)
     VALUES (?, ?, 'RESEARCH_COMPLETE', ?)`,
    [researchProjectId, opportunityId, new Date().toISOString()]
  );
  return { opportunityId, researchProjectId };
}

test('D14: deterministic join resolution, end to end', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const { researchProjectId } = seedOpportunityAndResearchProject(storage, {
    coreQuestion: '  Did the launch   cause a measurable increase?  '
  });

  const result = resolveAuthoritativeCoreQuestion(storage, researchProjectId);
  assert.equal(result.ok, true);
  // Whitespace-level normalization only (trim + collapse internal runs) —
  // no semantic rewriting.
  assert.equal(result.coreQuestion, 'Did the launch cause a measurable increase?');

  cleanup(storage, dbPath);
});

test('D14: missing core_question in the opportunity_proposition is reported, not silently accepted', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const opportunityId = crypto.randomUUID();
  storage.run(
    `INSERT INTO opportunities (id, title, source, discovered_at, status, opportunity_proposition)
     VALUES (?, 'x', 'rss', ?, 'HANDED_TO_RESEARCH', ?)`,
    [opportunityId, new Date().toISOString(), JSON.stringify({ subject: 'no core_question field' })]
  );
  const researchProjectId = crypto.randomUUID();
  storage.run(
    `INSERT INTO research_projects (id, opportunity_id, status, created_at) VALUES (?, ?, 'RESEARCH_COMPLETE', ?)`,
    [researchProjectId, opportunityId, new Date().toISOString()]
  );

  const result = resolveAuthoritativeCoreQuestion(storage, researchProjectId);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'MISSING_CORE_QUESTION');

  cleanup(storage, dbPath);
});

test('D14: unknown Research project id is reported', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const result = resolveAuthoritativeCoreQuestion(storage, crypto.randomUUID());
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'RESEARCH_PROJECT_NOT_FOUND');
  cleanup(storage, dbPath);
});

test('coreQuestionMatches normalizes whitespace only, no semantic comparison', () => {
  assert.equal(coreQuestionMatches('  Did it   work?  ', 'Did it work?'), true);
  assert.equal(coreQuestionMatches('Did it succeed?', 'Did it work?'), false);
});