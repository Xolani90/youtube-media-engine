// Test helper (NOT a test: lives outside tests/unit and tests/integration, so
// it is not matched by the `npm test` globs). ADR-0032 Gate 2 evaluator/rule
// tests (GC-001 .. GC-005 and aggregation).
//
// Builds a REAL migrated SQLite database and a REAL media file on disk, then
// seeds one content_version that is fully Gate-2-passable using only the
// existing repository relationships. Tests mutate this baseline one fact at a
// time so each assertion isolates a single rule condition. Nothing here mocks
// the evaluator, and nothing inserts a gate2_compliance_records row.
//
// Existing helper reused: recordVerification() from ./gate2.js (the append-only
// asset_verifications writer GC-002 reads).

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteStorageDriver } from '../../src/storage/SqliteStorageDriver.js';
import { AssetProvenanceRepository } from '../../src/state/AssetProvenance.js';
import { recordVerification } from './gate2.js';

export { recordVerification };

export const nowISO = () => new Date().toISOString();
export const uuid = () => crypto.randomUUID();

/** Independent SHA-256 (deliberately NOT the production sha256File) so GC-001 tests are not circular. */
export const sha256Hex = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

export const MEDIA_BYTES = Buffer.from('gate2-deterministic-final-media-bytes-v1');

/** Inserts an append-only decision_log row (the shape every pipeline stage writes). */
export function addDecisionLog(storage, { subjectType, subjectId, stage, decision, reason = 'test' }) {
  const id = uuid();
  storage.run(
    `INSERT INTO decision_log (id, run_id, subject_type, subject_id, decision, reason, created_at, stage)
     VALUES (?, NULL, ?, ?, ?, ?, ?, ?)`,
    [id, subjectType, subjectId, decision, reason, nowISO(), stage]
  );
  return id;
}

export function insertOpportunity(storage) {
  const id = uuid();
  storage.run(`INSERT INTO opportunities (id, title, source, discovered_at, status) VALUES (?, 'T', 'rss', ?, 'DISCOVERED')`, [id, nowISO()]);
  return id;
}

export function insertResearchProject(storage, opportunityId = insertOpportunity(storage)) {
  const id = uuid();
  storage.run(`INSERT INTO research_projects (id, opportunity_id, status, created_at) VALUES (?, ?, 'RESEARCH_COMPLETE', ?)`, [id, opportunityId, nowISO()]);
  return id;
}

export function insertClaim(storage, researchProjectId) {
  const id = uuid();
  storage.run(
    `INSERT INTO claims (id, research_project_id, claim, claim_type, created_at) VALUES (?, ?, 'a claim', 'FACT', ?)`,
    [id, researchProjectId, nowISO()]
  );
  return id;
}

export function insertSource(storage, researchProjectId) {
  const id = uuid();
  storage.run(
    `INSERT INTO sources (id, research_project_id, url, retrieved_at) VALUES (?, ?, 'https://example.test/s', ?)`,
    [id, researchProjectId, nowISO()]
  );
  return id;
}

export function linkClaimSource(storage, claimId, sourceId, role = 'primary') {
  storage.run(`INSERT INTO claim_sources (id, claim_id, source_id, role, created_at) VALUES (?, ?, ?, ?, ?)`, [uuid(), claimId, sourceId, role, nowISO()]);
}

/** Inserts productions + media_artifacts for a content_version. The media file is NOT created here. */
function insertProductionAndMedia(storage, { contentVersionId, scriptId, artifactPath, artifactChecksum }) {
  const productionId = uuid();
  storage.run(
    `INSERT INTO productions (id, content_version_id, script_id, artifact_type, artifact_path, artifact_checksum, manifest_json, created_at)
     VALUES (?, ?, ?, 'production_manifest_v1', '/tmp/manifest.json', 'manifest-chk', '{}', ?)`,
    [productionId, contentVersionId, scriptId, nowISO()]
  );
  const mediaArtifactId = uuid();
  storage.run(
    `INSERT INTO media_artifacts
      (id, production_id, content_version_id, render_spec_json, render_spec_checksum,
       narration_path, narration_duration_seconds, artifact_path, artifact_checksum,
       duration_seconds, width, height, video_codec, audio_codec, created_at)
     VALUES (?, ?, ?, '{}', 'spec-chk', '/tmp/n.wav', 5.0, ?, ?, 5.0, 1280, 720, 'h264', 'aac', ?)`,
    [mediaArtifactId, productionId, contentVersionId, artifactPath, artifactChecksum, nowISO()]
  );
  return { productionId, mediaArtifactId };
}

/**
 * A complete PRODUCED content_version that satisfies GC-001 .. GC-005 with no
 * key_claims chain. Returns the ids plus small utilities bound to this fixture.
 */
export async function createGate2Fixture({ workingTitle = 'A Real Final Title', viewerPromise = 'You will understand the topic', keyClaims = '[]' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate2-rules-'));
  const storage = new SqliteStorageDriver({ dbPath: path.join(dir, 'test.db') });
  await storage.migrate();

  const mediaPath = path.join(dir, 'final.mp4');
  fs.writeFileSync(mediaPath, MEDIA_BYTES);

  const opportunityId = insertOpportunity(storage);
  const researchProjectId = insertResearchProject(storage, opportunityId);

  const contentBriefId = uuid();
  storage.run(
    `INSERT INTO content_briefs
      (id, opportunity_id, research_project_id, working_title, viewer_promise, key_claims, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [contentBriefId, opportunityId, researchProjectId, workingTitle, viewerPromise, keyClaims, nowISO()]
  );

  const scriptId = uuid();
  storage.run(`INSERT INTO scripts (id, content_brief_id, version, body, claim_links, created_at) VALUES (?, ?, 1, 'Body.', '[]', ?)`, [scriptId, contentBriefId, nowISO()]);

  const contentVersionId = uuid();
  storage.run(`INSERT INTO content_versions (id, content_brief_id, script_id, state, created_at) VALUES (?, ?, ?, 'PRODUCED', ?)`, [contentVersionId, contentBriefId, scriptId, nowISO()]);

  const { productionId, mediaArtifactId } = insertProductionAndMedia(storage, {
    contentVersionId, scriptId, artifactPath: mediaPath, artifactChecksum: sha256Hex(MEDIA_BYTES)
  });

  // GC-005 baseline evidence: exactly one ACCEPTED generation row per lineage step.
  const scriptGenerationId = addDecisionLog(storage, { subjectType: 'content_brief', subjectId: contentBriefId, stage: 'SCRIPT_GENERATION', decision: 'ACCEPTED' });
  const briefGenerationId = addDecisionLog(storage, { subjectType: 'research_project', subjectId: researchProjectId, stage: 'BRIEF_GENERATION', decision: 'ACCEPTED' });

  const assetRepo = new AssetProvenanceRepository(storage);

  return {
    storage, dir, mediaPath,
    opportunityId, researchProjectId, contentBriefId, scriptId, contentVersionId,
    productionId, mediaArtifactId, scriptGenerationId, briefGenerationId,

    /** Attaches a new asset to this content_version; `cache` is the MUTABLE assets.verification_status. */
    addAsset(cache = 'UNVERIFIED') {
      const assetId = assetRepo.recordAsset({ assetType: 'image', location: `/tmp/${uuid()}.png`, verificationStatus: cache });
      assetRepo.recordUsage({ assetId, contentVersionId, usageContext: 'b-roll' });
      return assetId;
    },

    /** A second, fully separate brief/script/content_version (for "not applicable to THIS content_version" cases). */
    addOtherContentVersion() {
      const briefId = uuid();
      storage.run(`INSERT INTO content_briefs (id, opportunity_id, working_title, viewer_promise, created_at) VALUES (?, ?, 'Other', 'Other', ?)`, [briefId, opportunityId, nowISO()]);
      const otherScriptId = uuid();
      storage.run(`INSERT INTO scripts (id, content_brief_id, version, body, claim_links, created_at) VALUES (?, ?, 1, 'Other.', '[]', ?)`, [otherScriptId, briefId, nowISO()]);
      const otherContentVersionId = uuid();
      storage.run(`INSERT INTO content_versions (id, content_brief_id, script_id, state, created_at) VALUES (?, ?, ?, 'PRODUCED', ?)`, [otherContentVersionId, briefId, otherScriptId, nowISO()]);
      const other = insertProductionAndMedia(storage, {
        contentVersionId: otherContentVersionId, scriptId: otherScriptId, artifactPath: path.join(dir, 'other.mp4'), artifactChecksum: 'other-chk'
      });
      return { briefId, scriptId: otherScriptId, contentVersionId: otherContentVersionId, ...other };
    },

    /** A second script row (e.g. a regenerated version) for the same brief. */
    addScript(version) {
      const id = uuid();
      storage.run(`INSERT INTO scripts (id, content_brief_id, version, body, claim_links, created_at) VALUES (?, ?, ?, 'Regenerated.', '[]', ?)`, [id, contentBriefId, version, nowISO()]);
      return id;
    },

    cleanup() {
      try { storage.close(); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    }
  };
}

/** Runs fn(fixture) and always cleans up. */
export async function withGate2Fixture(fn, options) {
  const fx = await createGate2Fixture(options);
  try {
    return await fn(fx);
  } finally {
    fx.cleanup();
  }
}

/** Row counts for every table: proves an operation was read-only. */
export function tableCounts(storage) {
  const names = storage.all(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).map((r) => r.name);
  return Object.fromEntries(names.map((n) => [n, storage.get(`SELECT COUNT(*) AS c FROM "${n}"`).c]));
}