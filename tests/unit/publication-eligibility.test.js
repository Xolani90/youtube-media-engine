import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { SqliteStorageDriver } from '../../src/storage/SqliteStorageDriver.js';
import { resolveMediaForPublication } from '../../src/publication/eligibility.js';
import { buildPublicationRequest } from '../../src/publication/PublicationRequest.js';

function freshStorage() {
  const dbPath = path.join(os.tmpdir(), `pub-eligibility-${Date.now()}-${Math.random()}.db`);
  return { storage: new SqliteStorageDriver({ dbPath }), dbPath };
}

function cleanup(storage, dbPath) {
  storage.close();
  fs.rmSync(dbPath, { force: true });
  fs.rmSync(`${dbPath}-wal`, { force: true });
  fs.rmSync(`${dbPath}-shm`, { force: true });
}

function nowISO() {
  return new Date().toISOString();
}

function seedBrief(storage) {
  const opportunityId = crypto.randomUUID();
  storage.run(
    `INSERT INTO opportunities (id, title, source, discovered_at, status) VALUES (?, 'T', 'rss', ?, 'DISCOVERED')`,
    [opportunityId, nowISO()]
  );
  const contentBriefId = crypto.randomUUID();
  storage.run(
    `INSERT INTO content_briefs
      (id, opportunity_id, working_title, core_question, target_audience, viewer_promise,
       hook, angle, narrative_structure, key_claims, counterpoints, original_insights, visual_ideas,
       monetization_opportunities, risk_assessment, created_at)
     VALUES (?, ?, 'Working Title', 'Q', 'A', 'You will learn X', 'H', 'Angle', 'Structure', '[]', 'C', 'I', 'V', 'M', 'R', ?)`,
    [contentBriefId, opportunityId, nowISO()]
  );
  return contentBriefId;
}

function seedContentVersion(storage, contentBriefId, { state = 'PRODUCED' } = {}) {
  const scriptId = crypto.randomUUID();
  storage.run(
    `INSERT INTO scripts (id, content_brief_id, version, body, claim_links, created_at) VALUES (?, ?, 1, 'Body.', '[]', ?)`,
    [scriptId, contentBriefId, nowISO()]
  );
  const contentVersionId = crypto.randomUUID();
  storage.run(
    `INSERT INTO content_versions (id, content_brief_id, script_id, state, created_at) VALUES (?, ?, ?, ?, ?)`,
    [contentVersionId, contentBriefId, scriptId, state, nowISO()]
  );
  return { scriptId, contentVersionId };
}

function seedProduction(storage, contentVersionId, scriptId) {
  const id = crypto.randomUUID();
  storage.run(
    `INSERT INTO productions (id, content_version_id, script_id, artifact_type, artifact_path, artifact_checksum, manifest_json, created_at)
     VALUES (?, ?, ?, 'production_manifest_v1', '/tmp/x', 'deadbeef', '{}', ?)`,
    [id, contentVersionId, scriptId, nowISO()]
  );
  return id;
}

function seedMediaArtifact(storage, productionId, contentVersionId) {
  const id = crypto.randomUUID();
  storage.run(
    `INSERT INTO media_artifacts
      (id, production_id, content_version_id, render_spec_json, render_spec_checksum,
       narration_path, narration_duration_seconds, artifact_path, artifact_checksum,
       duration_seconds, width, height, video_codec, audio_codec, created_at)
     VALUES (?, ?, ?, '{}', 'chk', '/tmp/n.wav', 5.0, '/tmp/v.mp4', 'chk2', 5.0, 1280, 720, 'h264', 'aac', ?)`,
    [id, productionId, contentVersionId, nowISO()]
  );
  return id;
}

test('NOT_YET_RENDERED: content_version resolves but no media_artifacts row exists', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const contentBriefId = seedBrief(storage);
  seedContentVersion(storage, contentBriefId);

  const result = resolveMediaForPublication(storage, contentBriefId);
  assert.equal(result.eligible, false);
  assert.equal(result.reason, 'NOT_YET_RENDERED');

  cleanup(storage, dbPath);
});

test('CONTENT_VERSION_NOT_FOUND for an unknown content brief', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const result = resolveMediaForPublication(storage, crypto.randomUUID());
  assert.equal(result.eligible, false);
  assert.equal(result.reason, 'CONTENT_VERSION_NOT_FOUND');
  cleanup(storage, dbPath);
});

test('eligible: resolves contentVersion/script/contentBrief/mediaArtifact once Media Production has rendered', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const contentBriefId = seedBrief(storage);
  const { scriptId, contentVersionId } = seedContentVersion(storage, contentBriefId);
  const productionId = seedProduction(storage, contentVersionId, scriptId);
  seedMediaArtifact(storage, productionId, contentVersionId);

  const result = resolveMediaForPublication(storage, contentBriefId);
  assert.equal(result.eligible, true);
  assert.equal(result.contentVersion.id, contentVersionId);
  assert.equal(result.script.id, scriptId);
  assert.equal(result.mediaArtifact.content_version_id, contentVersionId);

  cleanup(storage, dbPath);
});

test('buildPublicationRequest carries content model fields through verbatim, never inventing metadata', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const contentBriefId = seedBrief(storage);
  const { scriptId, contentVersionId } = seedContentVersion(storage, contentBriefId);
  const productionId = seedProduction(storage, contentVersionId, scriptId);
  const mediaArtifactId = seedMediaArtifact(storage, productionId, contentVersionId);

  const eligibility = resolveMediaForPublication(storage, contentBriefId);
  const request = buildPublicationRequest(eligibility);

  assert.equal(request.title, 'Working Title');
  assert.equal(request.description, 'You will learn X');
  assert.equal(request.contentVersionId, contentVersionId);
  assert.equal(request.mediaArtifactId, mediaArtifactId);
  assert.equal(request.mediaFilePath, '/tmp/v.mp4');
  assert.equal(request.mediaChecksum, 'chk2');
  assert.equal(request.requestedPublishAt, null);

  cleanup(storage, dbPath);
});
