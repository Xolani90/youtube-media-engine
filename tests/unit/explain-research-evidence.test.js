import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { run } from '../../scripts/explain-research-evidence.js';
import { SqliteStorageDriver } from '../../src/storage/SqliteStorageDriver.js';

test('evidence explainer reads a seeded database and states why a load-bearing claim missed VERIFIED', async () => {
  const dbPath = path.join(os.tmpdir(), `evidence-explainer-${crypto.randomUUID()}.db`);
  const storage = new SqliteStorageDriver({ dbPath });
  await storage.migrate();
  const now = new Date().toISOString();
  const opportunityId = crypto.randomUUID();
  const projectId = crypto.randomUUID();
  const claimId = crypto.randomUUID();
  const sourceId = crypto.randomUUID();
  storage.run("INSERT INTO opportunities (id, title, source, discovered_at, status) VALUES (?, 'topic', 'rss', ?, 'DISCOVERED')", [opportunityId, now]);
  storage.run("INSERT INTO research_projects (id, opportunity_id, status, created_at) VALUES (?, ?, 'RESEARCHING', ?)", [projectId, opportunityId, now]);
  storage.run("INSERT INTO claims (id, research_project_id, claim, claim_type, evidence_status, is_load_bearing, created_at) VALUES (?, ?, 'claim text', 'FACT', 'PARTIALLY_SUPPORTED', 1, ?)", [claimId, projectId, now]);
  storage.run("INSERT INTO sources (id, research_project_id, url, role, quality_tier, retrieval_status, retrieved_at) VALUES (?, ?, 'https://www.example-news.test/story', 'independent_reporting', 'MEDIUM', 'SUCCESS', ?)", [sourceId, projectId, now]);
  storage.run("INSERT INTO claim_sources (id, claim_id, source_id, role, created_at) VALUES (?, ?, ?, 'primary', ?)", [crypto.randomUUID(), claimId, sourceId, now]);
  storage.close();

  const output = [];
  run(dbPath, (line) => output.push(line));
  const text = output.join('\n');
  assert.match(text, new RegExp(`claim=${claimId}`));
  assert.match(text, /NOT_VERIFIED:independent_reporting_1_of_2/);
  assert.match(text, new RegExp(`source=${sourceId} role=independent_reporting quality_tier=MEDIUM retrieval_status=SUCCESS independence_key=example-news\\.test eligible=true`));

  fs.rmSync(dbPath, { force: true });
  fs.rmSync(`${dbPath}-wal`, { force: true });
  fs.rmSync(`${dbPath}-shm`, { force: true });
});
