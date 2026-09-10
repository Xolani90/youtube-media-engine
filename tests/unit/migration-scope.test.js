import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteStorageDriver } from '../../src/storage/SqliteStorageDriver.js';

const REQUIRED_M0_TABLES = [
  'system_runs',
  'opportunities',
  'research_projects',
  'sources',
  'claims',
  'content_briefs',
  'scripts',
  'content_versions',
  'risk_assessments',
  'provider_calls',
  'decision_log',
  'schema_migrations'
];

const REMOVED_PREMATURE_TABLES = [
  'production_jobs',
  'publication_jobs',
  'performance_metrics',
  'learning_events'
];

test('migration creates all required M0 tables and none of the removed premature tables', async () => {
  const dbPath = path.join(os.tmpdir(), `migration-scope-${Date.now()}.db`);
  const storage = new SqliteStorageDriver({ dbPath });
  await storage.migrate();

  const tableNames = storage
    .all("SELECT name FROM sqlite_master WHERE type='table'")
    .map((r) => r.name);

  for (const t of REQUIRED_M0_TABLES) {
    assert.ok(tableNames.includes(t), `expected required M0 table "${t}" to exist`);
  }
  for (const t of REMOVED_PREMATURE_TABLES) {
    assert.ok(!tableNames.includes(t), `expected premature table "${t}" to NOT exist`);
  }

  storage.close();
  fs.rmSync(dbPath, { force: true });
  fs.rmSync(`${dbPath}-wal`, { force: true });
  fs.rmSync(`${dbPath}-shm`, { force: true });
});
