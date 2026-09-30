import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { SqliteStorageDriver } from '../../src/storage/SqliteStorageDriver.js';
import { AssetProvenanceRepository } from '../../src/state/AssetProvenance.js';
import { runAutonomousOperation } from '../../src/autonomous/runner.js';
import { runRightsVerification } from '../../src/rights-verification/pipeline.js';
import { runMediaProduction } from '../../src/media/pipeline.js';
import {
  selectEligibleRightsVerification,
  selectEligibleMediaProductions
} from '../../src/autonomous/workSelection.js';

// Regression: autonomous run 36682410614. A PRODUCED content_version with no
// attached assets was re-selected by Rights Verification (NO_ASSETS_ATTACHED)
// and Media Production (NO_VISUAL_ASSETS) on every sweep -> no_progress. Both
// stage outcomes are preserved; selection now skips the version only after the
// stage logged its own deterministic outcome AND while it still has no asset.
// Asset Provisioning's quarantine is deliberately NOT consulted (stage isolation).

const nowISO = () => new Date().toISOString();

function freshStorage() {
  const dbPath = path.join(os.tmpdir(), `prov-quarantine-${Date.now()}-${Math.random()}.db`);
  return { storage: new SqliteStorageDriver({ dbPath }), dbPath };
}
function cleanup(storage, dbPath) {
  storage.close();
  for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) fs.rmSync(f, { force: true });
}

function seedProduced(storage) {
  const oppId = crypto.randomUUID();
  storage.run(
    `INSERT INTO opportunities (id, title, source, discovered_at, status) VALUES (?, 'T', 'rss', ?, 'RESEARCH_HANDED_OFF_TEST_FIXTURE')`,
    [oppId, nowISO()]
  );
  const briefId = crypto.randomUUID();
  storage.run(
    `INSERT INTO content_briefs (id, opportunity_id, research_project_id, working_title, created_at) VALUES (?, ?, NULL, 'T', ?)`,
    [briefId, oppId, nowISO()]
  );
  const scriptId = crypto.randomUUID();
  storage.run(
    `INSERT INTO scripts (id, content_brief_id, version, body, claim_links, created_at) VALUES (?, ?, 1, 'Body.', '[]', ?)`,
    [scriptId, briefId, nowISO()]
  );
  const cvId = crypto.randomUUID();
  storage.run(
    `INSERT INTO content_versions (id, content_brief_id, script_id, state, created_at) VALUES (?, ?, ?, 'PRODUCED', ?)`,
    [cvId, briefId, scriptId, nowISO()]
  );
  storage.run(
    `INSERT INTO productions (id, content_version_id, script_id, artifact_type, artifact_path, artifact_checksum, manifest_json, created_at)
     VALUES (?, ?, ?, 'production_manifest_v1', '/tmp/x', 'deadbeef', '{}', ?)`,
    [crypto.randomUUID(), cvId, scriptId, nowISO()]
  );
  return { briefId, cvId };
}

const quarantineProvisioning = (storage, cvId) =>
  storage.run(
    `INSERT INTO stage_retry_state (id, subject_id, stage, provider, cycle_number, attempt_count, quarantined_at, created_at, updated_at)
     VALUES (?, ?, 'ASSET_PROVISIONING', '', 1, 3, ?, ?, ?)`,
    [crypto.randomUUID(), cvId, nowISO(), nowISO(), nowISO()]
  );

function attachAsset(storage, cvId, assetType) {
  const repo = new AssetProvenanceRepository(storage);
  const assetId = repo.recordAsset({ assetType, location: '/tmp/none.bin' });
  repo.recordUsage({ assetId, contentVersionId: cvId });
  return assetId;
}

const rightsIds = (s) => selectEligibleRightsVerification(s).map((i) => i.contentBriefId);
const mediaIds = (s) => selectEligibleMediaProductions(s).map((i) => i.contentBriefId);
const noAssetLogs = (s, cvId, decision) =>
  s.all(`SELECT 1 FROM decision_log WHERE subject_id = ? AND decision = ?`, [cvId, decision]).length;

const evaluateOnce = async (storage, a) => {
  const r = await runRightsVerification({ storage, contentBriefId: a.briefId });
  const m = await runMediaProduction({ storage, contentBriefId: a.briefId });
  return { r, m };
};

test('not yet evaluated: a PRODUCED item with no assets is selectable so each stage runs (and logs) once', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const a = seedProduced(storage);
  assert.deepEqual(rightsIds(storage), [a.briefId]);
  assert.deepEqual(mediaIds(storage), [a.briefId]);
  cleanup(storage, dbPath);
});

test('stage isolation preserved: a provisioning quarantine alone never hides the item from Rights or Media', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const a = seedProduced(storage);
  quarantineProvisioning(storage, a.cvId);
  assert.deepEqual(rightsIds(storage), [a.briefId]);
  assert.deepEqual(mediaIds(storage), [a.briefId]);
  cleanup(storage, dbPath);
});

test('original outcomes preserved: real stages still return NO_ASSETS_ATTACHED / NO_VISUAL_ASSETS and log, including on direct re-invocation', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const a = seedProduced(storage);
  const first = await evaluateOnce(storage, a);
  assert.equal(first.r.outcome, 'NO_ASSETS_ATTACHED');
  assert.equal(first.m.outcome, 'NO_VISUAL_ASSETS');
  const again = await evaluateOnce(storage, a);
  assert.equal(again.r.outcome, 'NO_ASSETS_ATTACHED');
  assert.equal(again.m.outcome, 'NO_VISUAL_ASSETS');
  assert.equal(noAssetLogs(storage, a.cvId, 'NO_ASSETS_ATTACHED'), 2);
  assert.equal(noAssetLogs(storage, a.cvId, 'NO_VISUAL_ASSETS'), 2);
  cleanup(storage, dbPath);
});

test('after each stage logged its outcome and the item is still assetless: excluded from both; a healthy item alongside stays selectable', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const stuck = seedProduced(storage);
  const healthy = seedProduced(storage);
  await evaluateOnce(storage, stuck);
  assert.deepEqual(rightsIds(storage), [healthy.briefId]);
  assert.deepEqual(mediaIds(storage), [healthy.briefId]);
  cleanup(storage, dbPath);
});

test('self-heals: any attached asset re-enables Rights; a VISUAL asset re-enables Media; a non-visual asset does not', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const a = seedProduced(storage);
  await evaluateOnce(storage, a);
  assert.deepEqual([rightsIds(storage), mediaIds(storage)], [[], []]);

  attachAsset(storage, a.cvId, 'audio');
  assert.deepEqual(rightsIds(storage), [a.briefId], 'an asset now exists to verify');
  assert.deepEqual(mediaIds(storage), [], 'still no visual asset');

  attachAsset(storage, a.cvId, 'image');
  assert.deepEqual(mediaIds(storage), [a.briefId], 'visual asset attached');
  cleanup(storage, dbPath);
});

test('an item that has assets is never excluded even if an earlier outcome was logged', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const a = seedProduced(storage);
  await evaluateOnce(storage, a);
  attachAsset(storage, a.cvId, 'video_clip');
  assert.deepEqual(rightsIds(storage), [a.briefId]);
  assert.deepEqual(mediaIds(storage), [a.briefId]);
  cleanup(storage, dbPath);
});

test('runner (real stages): the assetless item is evaluated once, never re-logged across sweeps, and a later invocation is no_work', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const a = seedProduced(storage);
  quarantineProvisioning(storage, a.cvId); // the state observed in run 36682410614

  const first = await runAutonomousOperation({ storage });
  assert.notEqual(first.stopReason, 'no_progress', 'pre-fix this was no_progress (same items every sweep)');
  assert.equal(noAssetLogs(storage, a.cvId, 'NO_ASSETS_ATTACHED'), 1, 'evaluated exactly once across all sweeps');
  assert.equal(noAssetLogs(storage, a.cvId, 'NO_VISUAL_ASSETS'), 1);

  const second = await runAutonomousOperation({ storage });
  assert.equal(second.stopReason, 'no_work');
  assert.equal(noAssetLogs(storage, a.cvId, 'NO_ASSETS_ATTACHED'), 1, 'not re-processed by the second run');
  assert.equal(noAssetLogs(storage, a.cvId, 'NO_VISUAL_ASSETS'), 1);
  cleanup(storage, dbPath);
});

test('runner: genuinely eligible work is still processed while the stuck item is skipped', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const stuck = seedProduced(storage);
  const healthy = seedProduced(storage);
  await evaluateOnce(storage, stuck);

  const rightsCalls = [];
  await runAutonomousOperation({
    storage,
    stageFns: {
      'asset-provisioning': async () => ({ outcome: 'NO_ASSET_ACQUIRED' }),
      'rights-verification': async ({ contentBriefId }) => { rightsCalls.push(contentBriefId); return { outcome: 'PROCESSED' }; },
      'media-production': async () => ({ outcome: 'NO_VISUAL_ASSETS' })
    }
  });
  assert.deepEqual(rightsCalls, [healthy.briefId]);
  cleanup(storage, dbPath);
});
