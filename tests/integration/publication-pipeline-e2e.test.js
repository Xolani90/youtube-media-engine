import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { SqliteStorageDriver } from '../../src/storage/SqliteStorageDriver.js';
import { runProduction } from '../../src/production/pipeline.js';
import { runMediaProduction } from '../../src/media/pipeline.js';
import { runPublication } from '../../src/publication/pipeline.js';
import { PublicationProvider } from '../../src/publication/PublicationProvider.js';
import { PUBLICATION_RESULT_STATUS } from '../../src/publication/constants.js';
import { AssetProvenanceRepository } from '../../src/state/AssetProvenance.js';
import { config } from '../../src/config/index.js';
import { passGate2, recordVerification } from '../helpers/gate2.js';

function freshStorage() {
  const dbPath = path.join(os.tmpdir(), `pub-e2e-${Date.now()}-${Math.random()}.db`);
  return { storage: new SqliteStorageDriver({ dbPath }), dbPath };
}

function freshDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
}

function cleanup(storage, dbPath, ...dirs) {
  storage.close();
  fs.rmSync(dbPath, { force: true });
  fs.rmSync(`${dbPath}-wal`, { force: true });
  fs.rmSync(`${dbPath}-shm`, { force: true });
  for (const d of dirs) {
    if (d) fs.rmSync(d, { recursive: true, force: true });
  }
}

function nowISO() {
  return new Date().toISOString();
}

function seedResearchProject(storage) {
  const opportunityId = crypto.randomUUID();
  storage.run(
    `INSERT INTO opportunities (id, title, source, discovered_at, status) VALUES (?, 'Test opportunity', 'rss', ?, 'DISCOVERED')`,
    [opportunityId, nowISO()]
  );
  return { opportunityId };
}

function seedBrief(storage, opportunityId) {
  const id = crypto.randomUUID();
  storage.run(
    `INSERT INTO content_briefs
      (id, opportunity_id, working_title, core_question, target_audience, viewer_promise,
       hook, angle, narrative_structure, key_claims, counterpoints, original_insights, visual_ideas,
       monetization_opportunities, risk_assessment, created_at)
     VALUES (?, ?, 'Publication E2E Title', 'Q', 'A', 'A concise promise', 'H', 'Angle', 'Structure', '[]', 'C', 'I', 'V', 'M', 'R', ?)`,
    [id, opportunityId, nowISO()]
  );
  return id;
}

function seedContentVersion(storage) {
  const { opportunityId } = seedResearchProject(storage);
  const contentBriefId = seedBrief(storage, opportunityId);
  const scriptId = crypto.randomUUID();
  storage.run(
    `INSERT INTO scripts (id, content_brief_id, version, body, claim_links, created_at)
     VALUES (?, ?, 1, 'This is a short narration script for the publication end to end test.', '[]', ?)`,
    [scriptId, contentBriefId, nowISO()]
  );
  const contentVersionId = crypto.randomUUID();
  storage.run(
    `INSERT INTO content_versions (id, content_brief_id, script_id, state, created_at) VALUES (?, ?, ?, 'PRODUCTION_READY', ?)`,
    [contentVersionId, contentBriefId, scriptId, nowISO()]
  );
  return { contentBriefId, scriptId, contentVersionId };
}

function seedVisualAsset(storage, contentVersionId, location, verificationStatus = 'VERIFIED') {
  const repo = new AssetProvenanceRepository(storage);
  const assetId = repo.recordAsset({ assetType: 'image', location, verificationStatus });
  repo.recordUsage({ assetId, contentVersionId, usageContext: 'b-roll' });
  return assetId;
}

function makeFixtureImage(dir, name, color) {
  const location = path.join(dir, name);
  execFileSync('ffmpeg', ['-f', 'lavfi', '-i', `color=c=${color}:s=64x64:d=1`, '-frames:v', '1', '-y', location], {
    stdio: ['ignore', 'pipe', 'pipe']
  });
  return location;
}

class MockYouTube extends PublicationProvider {
  constructor(result) {
    super();
    this.result = result;
    this.calls = [];
  }
  get id() {
    return 'youtube';
  }
  async publish(request) {
    this.calls.push(request);
    return this.result;
  }
}

function withLiveAuthorized(actions, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pub-e2e-auth-'));
  const filePath = path.join(dir, 'authorized.json');
  fs.writeFileSync(filePath, JSON.stringify(actions));
  const originalPath = config.authorizedExternalActionsPath;
  const originalMode = config.runMode;
  const originalAutonomous = config.autonomousEnabled;
  config.authorizedExternalActionsPath = filePath;
  config.runMode = 'LIVE';
  config.autonomousEnabled = true;
  return Promise.resolve(fn(filePath)).finally(() => {
    config.authorizedExternalActionsPath = originalPath;
    config.runMode = originalMode;
    config.autonomousEnabled = originalAutonomous;
    fs.rmSync(dir, { recursive: true, force: true });
  });
}

test('end-to-end: PRODUCED -> real rendered media artifact -> D-C2 authorized publish -> confirmed PUBLISHED', async () => {
  const { storage, dbPath } = freshStorage();
  const productionArtifactsDir = freshDir('pub-e2e-production');
  const mediaArtifactsDir = freshDir('pub-e2e-media');
  const assetsDir = freshDir('pub-e2e-assets');
  await storage.migrate();

  const { contentBriefId, contentVersionId } = seedContentVersion(storage);
  const imgA = makeFixtureImage(assetsDir, 'a.png', 'blue');
  const imgB = makeFixtureImage(assetsDir, 'b.png', 'red');
  const assetA = seedVisualAsset(storage, contentVersionId, imgA);
  const assetB = seedVisualAsset(storage, contentVersionId, imgB);

  const productionResult = runProduction({ storage, contentBriefId, artifactsDir: productionArtifactsDir });
  assert.equal(productionResult.outcome, 'PRODUCED');

  const mediaResult = runMediaProduction({ storage, contentBriefId, artifactsDir: mediaArtifactsDir });
  assert.equal(mediaResult.outcome, 'RENDERED');

  // ADR-0032: a PRODUCED item cannot be published directly. Gate 2 is enforced at the
  // publication boundary before authorization, the PENDING claim and the provider.
  const producedAdapter = new MockYouTube({ status: PUBLICATION_RESULT_STATUS.SUCCESS, provider: 'youtube', providerItemId: 'SHOULD_NOT_BE_USED', providerUrl: 'x' });
  const gate2Refused = await runPublication({ storage, contentBriefId, provider: 'youtube', adapter: producedAdapter });
  assert.equal(gate2Refused.outcome, 'GATE2_NOT_AUTHORIZING');
  assert.equal(producedAdapter.calls.length, 0);
  assert.equal(storage.get('SELECT COUNT(*) AS n FROM publications WHERE content_version_id = ?', [contentVersionId]).n, 0);
  assert.equal(storage.get('SELECT state FROM content_versions WHERE id = ?', [contentVersionId]).state, 'PRODUCED');

  // Legitimate final-compliance step (real evaluator/persistence): PRODUCED -> FINAL_COMPLIANCE.
  // It never publishes.
  // Gate 2 GC-002 reads the append-only asset_verifications history (what rights verification persists).
  recordVerification(storage, assetA, 'VERIFIED');
  recordVerification(storage, assetB, 'VERIFIED');
  passGate2(storage, contentVersionId);
  assert.equal(storage.get('SELECT state FROM content_versions WHERE id = ?', [contentVersionId]).state, 'FINAL_COMPLIANCE');
  assert.equal(storage.get('SELECT COUNT(*) AS n FROM publications WHERE content_version_id = ?', [contentVersionId]).n, 0);

  // Gate 2 now passes, so the publication boundary reaches D-C2 authorization: not yet authorized
  // (SIMULATION default in this test process) -> denied, no upload attempted.
  const preAuthAdapter = new MockYouTube({ status: PUBLICATION_RESULT_STATUS.SUCCESS, provider: 'youtube', providerItemId: 'SHOULD_NOT_BE_USED', providerUrl: 'x' });
  const denied = await runPublication({ storage, contentBriefId, provider: 'youtube', adapter: preAuthAdapter });
  assert.equal(denied.outcome, 'AUTHORIZATION_DENIED');
  assert.equal(preAuthAdapter.calls.length, 0);

  // content_version is still FINAL_COMPLIANCE, unaffected by the denied attempt.
  let cv = storage.get('SELECT * FROM content_versions WHERE id = ?', [contentVersionId]);
  assert.equal(cv.state, 'FINAL_COMPLIANCE');

  const published = await withLiveAuthorized([`publish:youtube:${contentVersionId}`], async () => {
    const adapter = new MockYouTube({ status: PUBLICATION_RESULT_STATUS.SUCCESS, provider: 'youtube', providerItemId: 'REAL_VIDEO_ID', providerUrl: 'https://youtu.be/REAL_VIDEO_ID' });
    const result = await runPublication({ storage, contentBriefId, provider: 'youtube', adapter });
    assert.equal(adapter.calls.length, 1);
    // The request the core built and handed to the adapter is provider-neutral
    // and carries the real rendered artifact through, unmodified.
    assert.equal(adapter.calls[0].mediaFilePath, mediaResult.mediaArtifact.artifact_path);
    assert.equal(adapter.calls[0].title, 'Publication E2E Title');
    return result;
  });

  assert.equal(published.outcome, 'PUBLISHED');
  assert.equal(published.publication.provider_item_id, 'REAL_VIDEO_ID');

  cv = storage.get('SELECT * FROM content_versions WHERE id = ?', [contentVersionId]);
  assert.equal(cv.state, 'PUBLISHED');

  // Idempotent: invoking again (even if somehow re-authorized) never re-uploads.
  await withLiveAuthorized([`publish:youtube:${contentVersionId}`], async () => {
    const adapter2 = new MockYouTube({ status: PUBLICATION_RESULT_STATUS.SUCCESS, provider: 'youtube', providerItemId: 'DUPLICATE', providerUrl: 'x' });
    const again = await runPublication({ storage, contentBriefId, provider: 'youtube', adapter: adapter2 });
    assert.equal(again.outcome, 'ALREADY_PUBLISHED');
    assert.equal(adapter2.calls.length, 0);
  });

  cleanup(storage, dbPath, productionArtifactsDir, mediaArtifactsDir, assetsDir);
});
