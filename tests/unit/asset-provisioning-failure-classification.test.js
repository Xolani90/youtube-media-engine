import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { SqliteStorageDriver } from '../../src/storage/SqliteStorageDriver.js';
import { runAssetProvisioning } from '../../src/asset-provisioning/pipeline.js';
import { AssetProvenanceRepository } from '../../src/state/AssetProvenance.js';
import { AssetSourceProvider } from '../../src/providers/asset/AssetSourceProvider.js';

function freshStorage() {
  const dbPath = path.join(os.tmpdir(), `asset-provisioning-${Date.now()}-${Math.random()}.db`);
  return { storage: new SqliteStorageDriver({ dbPath }), dbPath };
}

function tempAssetFile(content = 'fake-image-bytes') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asset-provisioning-files-'));
  const filePath = path.join(dir, 'asset.jpg');
  fs.writeFileSync(filePath, content);
  return { dir, filePath };
}

function checksumOf(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function cleanup(storage, dbPath, extraDirs = []) {
  storage.close();
  fs.rmSync(dbPath, { force: true });
  fs.rmSync(`${dbPath}-wal`, { force: true });
  fs.rmSync(`${dbPath}-shm`, { force: true });
  for (const dir of extraDirs) fs.rmSync(dir, { recursive: true, force: true });
}

function nowISO() {
  return new Date().toISOString();
}

function seedOpportunity(storage) {
  const opportunityId = crypto.randomUUID();
  storage.run(
    `INSERT INTO opportunities (id, title, source, discovered_at, status) VALUES (?, 'Test opportunity', 'rss', ?, 'DISCOVERED')`,
    [opportunityId, nowISO()]
  );
  return opportunityId;
}

function seedBrief(storage, opportunityId, { visualIdeas = 'A calm mountain lake at sunrise' } = {}) {
  const id = crypto.randomUUID();
  storage.run(
    `INSERT INTO content_briefs
      (id, opportunity_id, working_title, core_question, target_audience, viewer_promise,
       hook, angle, narrative_structure, key_claims, counterpoints, original_insights, visual_ideas,
       monetization_opportunities, risk_assessment, created_at)
     VALUES (?, ?, 'T', 'Q', 'A', 'P', 'H', 'Angle', 'Structure', '[]', 'C', 'I', ?, 'M', 'R', ?)`,
    [id, opportunityId, visualIdeas, nowISO()]
  );
  return id;
}

/** Seeds a produced content item: opportunity -> brief -> script -> content_version(PRODUCED) -> productions row. */
function seedProducedContent(storage, { visualIdeas = 'A calm mountain lake at sunrise', scriptBody = 'This is the script body. It has more than one sentence.' } = {}) {
  const opportunityId = seedOpportunity(storage);
  const contentBriefId = seedBrief(storage, opportunityId, { visualIdeas });
  const scriptId = crypto.randomUUID();
  storage.run(
    `INSERT INTO scripts (id, content_brief_id, version, body, claim_links, created_at)
     VALUES (?, ?, 1, ?, '[]', ?)`,
    [scriptId, contentBriefId, scriptBody, nowISO()]
  );
  const contentVersionId = crypto.randomUUID();
  storage.run(
    `INSERT INTO content_versions (id, content_brief_id, script_id, state, created_at) VALUES (?, ?, ?, 'PRODUCED', ?)`,
    [contentVersionId, contentBriefId, scriptId, nowISO()]
  );
  const productionId = crypto.randomUUID();
  storage.run(
    `INSERT INTO productions (id, content_version_id, script_id, artifact_type, artifact_path, artifact_checksum, manifest_json, created_at)
     VALUES (?, ?, ?, 'production_manifest_v1', '/tmp/manifest.json', 'deadbeef', '{}', ?)`,
    [productionId, contentVersionId, scriptId, nowISO()]
  );
  return { contentBriefId, scriptId, contentVersionId };
}

import { PixabayAssetSourceProvider } from '../../src/providers/asset/PixabayAssetSourceProvider.js';
import { ASSET_FAILURE_KIND, assetAcquisitionFailure } from '../../src/providers/asset/AssetSourceProvider.js';

const SECRET = 'SECRET-PIXABAY-KEY-9f8e7d6c';
const QUERY = 'A calm mountain lake at sunrise';

class FailingProvider extends AssetSourceProvider {
  constructor(resultOrFn) { super(); this._r = resultOrFn; this.calls = 0; }
  get id() { return 'pixabay'; }
  async healthCheck() { return true; }
  async acquireVisualAsset(params) { this.calls++; return typeof this._r === 'function' ? this._r(params) : this._r; }
}
const failure = (kind, extra = {}) => assetAcquisitionFailure({ kind, provider: 'pixabay', query: QUERY, ...extra });

async function setup() {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const seeded = seedProducedContent(storage);
  return { storage, dbPath, ...seeded };
}
const retryRow = (storage, cvId) => storage.get("SELECT * FROM stage_retry_state WHERE stage='ASSET_PROVISIONING' AND subject_id=?", [cvId]);
const assetCount = (storage) => storage.get('SELECT COUNT(*) AS n FROM assets').n;
const lastEvidence = (storage) => JSON.parse(storage.get("SELECT config_snapshot FROM decision_log WHERE stage='ASSET_PROVISIONING' AND decision='NO_ASSET_ACQUIRED' ORDER BY created_at DESC, rowid DESC LIMIT 1").config_snapshot);

// kind -> [nature, retry-eligible (consumes item budget)]
const EXPECT = {
  EMPTY_RESULT: ['TRANSIENT', true],
  DOWNLOAD_FAILURE: ['TRANSIENT', true],
  RATE_LIMIT: ['TRANSIENT', true],
  PROVIDER_SERVER_FAILURE: ['TRANSIENT', true],
  NETWORK_FAILURE: ['TRANSIENT', true],
  BAD_REQUEST: ['DETERMINISTIC', false],
  UNSUPPORTED_ASSET_TYPE: ['DETERMINISTIC', false],
  MISSING_API_KEY: ['INFRASTRUCTURE', false],
  AUTH_FAILURE: ['INFRASTRUCTURE', false],
  MALFORMED_RESPONSE: ['INFRASTRUCTURE', false]
};

for (const [kind, [nature, eligible]] of Object.entries(EXPECT)) {
  test(`provider failure ${kind}: classified ${nature}, ${eligible ? 'consumes' : 'does NOT consume'} item retry budget, nothing persisted`, async () => {
    const { storage, dbPath, contentBriefId, contentVersionId } = await setup();
    const provider = new FailingProvider(failure(kind, { status: 418, hitCount: 2 }));
    const r = await runAssetProvisioning({ storage, contentBriefId, provider });

    assert.equal(r.outcome, 'NO_ASSET_ACQUIRED');
    assert.equal(r.reason, kind);
    assert.equal(r.failureKind, kind);
    assert.equal(r.providerFailure.kind, kind);
    assert.equal(r.providerFailure.status, 418);
    assert.equal(r.providerFailure.hitCount, 2);
    assert.equal(r.providerFailure.query, QUERY);
    assert.equal(r.retryDisposition.nature, nature);
    assert.equal(r.retryDisposition.eligible, eligible);
    assert.equal(assetCount(storage), 0);

    const row = retryRow(storage, contentVersionId);
    if (eligible) { assert.equal(row.attempt_count, 1); assert.equal(r.attempt, 1); } else { assert.equal(row, undefined); }

    const ev = lastEvidence(storage);
    assert.equal(ev.failureKind, kind);
    assert.equal(ev.providerFailure.kind, kind);
    assert.equal(ev.evidence.nature, nature);
    cleanup(storage, dbPath);
  });
}

test('permanent failures (BAD_REQUEST, AUTH_FAILURE, MISSING_API_KEY) repeated 5x never record an attempt and never quarantine', async () => {
  for (const kind of ['BAD_REQUEST', 'AUTH_FAILURE', 'MISSING_API_KEY']) {
    const { storage, dbPath, contentBriefId, contentVersionId } = await setup();
    const provider = new FailingProvider(failure(kind));
    for (let i = 0; i < 5; i++) {
      const r = await runAssetProvisioning({ storage, contentBriefId, provider });
      assert.equal(r.outcome, 'NO_ASSET_ACQUIRED');
      assert.notEqual(r.outcome, 'QUARANTINED');
    }
    assert.equal(provider.calls, 5, 'content is not quarantined, so the provider is still consulted');
    assert.equal(retryRow(storage, contentVersionId), undefined);
    cleanup(storage, dbPath);
  }
});

test('genuine repeated transient failures still quarantine on the 3rd attempt (cap unchanged), then refuse without a provider call', async () => {
  for (const kind of ['EMPTY_RESULT', 'RATE_LIMIT', 'PROVIDER_SERVER_FAILURE', 'NETWORK_FAILURE', 'DOWNLOAD_FAILURE']) {
    const { storage, dbPath, contentBriefId, contentVersionId } = await setup();
    const provider = new FailingProvider(failure(kind));
    const a1 = await runAssetProvisioning({ storage, contentBriefId, provider });
    const a2 = await runAssetProvisioning({ storage, contentBriefId, provider });
    const a3 = await runAssetProvisioning({ storage, contentBriefId, provider });
    assert.deepEqual([a1.attempt, a2.attempt, a3.attempt], [1, 2, 3]);
    assert.equal(a3.quarantined, true);
    assert.ok(retryRow(storage, contentVersionId).quarantined_at);
    const a4 = await runAssetProvisioning({ storage, contentBriefId, provider });
    assert.equal(a4.outcome, 'QUARANTINED');
    assert.equal(provider.calls, 3);
    cleanup(storage, dbPath);
  }
});

test('legacy bare null is still an unclassified TRANSIENT "no asset" (PROVIDER_RETURNED_NULL), unchanged', async () => {
  const { storage, dbPath, contentBriefId } = await setup();
  const r = await runAssetProvisioning({ storage, contentBriefId, provider: new FailingProvider(null) });
  assert.equal(r.outcome, 'NO_ASSET_ACQUIRED');
  assert.equal(r.failureKind, 'PROVIDER_RETURNED_NULL');
  assert.equal(r.retryDisposition.nature, 'TRANSIENT');
  assert.equal(r.attempt, 1);
  cleanup(storage, dbPath);
});

test('an unrecognized failure kind fails closed: INFRASTRUCTURE, no budget, no quarantine', async () => {
  const { storage, dbPath, contentBriefId, contentVersionId } = await setup();
  const r = await runAssetProvisioning({ storage, contentBriefId, provider: new FailingProvider({ failure: { kind: 'SOMETHING_NEW' } }) });
  assert.equal(r.outcome, 'NO_ASSET_ACQUIRED');
  assert.equal(r.retryDisposition.nature, 'INFRASTRUCTURE');
  assert.equal(r.retryDisposition.eligible, false);
  assert.equal(retryRow(storage, contentVersionId), undefined);
  cleanup(storage, dbPath);
});

test('secrets in a provider failure are redacted before reaching the result or decision_log', async () => {
  const { storage, dbPath, contentBriefId } = await setup();
  const raw = { failure: { kind: 'NETWORK_FAILURE', provider: 'pixabay', query: QUERY, status: null, hitCount: null, retryable: true, cause: `GET https://pixabay.com/api/?key=${SECRET}&q=x failed`, providerMessage: `key=${SECRET}` } };
  const r = await runAssetProvisioning({ storage, contentBriefId, provider: new FailingProvider(raw) });
  assert.equal(JSON.stringify(r).includes(SECRET), false);
  const rows = storage.all('SELECT * FROM decision_log');
  assert.equal(JSON.stringify(rows).includes(SECRET), false);
  assert.match(r.providerFailure.cause, /\[REDACTED\]/);
  cleanup(storage, dbPath);
});

test('end to end with the real PixabayAssetSourceProvider (mocked fetch): HTTP 400 and 401 are not "no asset" and never quarantine', async () => {
  for (const status of [400, 401]) {
    const { storage, dbPath, contentBriefId, contentVersionId } = await setup();
    const provider = new PixabayAssetSourceProvider({
      fetchImpl: async () => ({ ok: false, status, text: async () => `[ERROR ${status}] key=${SECRET}`, json: async () => ({}) }),
      apiKeyProvider: () => SECRET
    });
    const r = await runAssetProvisioning({ storage, contentBriefId, provider });
    assert.equal(r.failureKind, status === 400 ? 'BAD_REQUEST' : 'AUTH_FAILURE');
    assert.equal(r.providerFailure.status, status);
    assert.equal(r.retryDisposition.eligible, false);
    assert.equal(retryRow(storage, contentVersionId), undefined);
    assert.equal(JSON.stringify(storage.all('SELECT * FROM decision_log')).includes(SECRET), false);
    cleanup(storage, dbPath);
  }
});

test('end to end with the real PixabayAssetSourceProvider (mocked fetch): zero hits is EMPTY_RESULT and still consumes budget as before', async () => {
  const { storage, dbPath, contentBriefId } = await setup();
  const provider = new PixabayAssetSourceProvider({ fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ total: 0, hits: [] }) }), apiKeyProvider: () => SECRET });
  const r = await runAssetProvisioning({ storage, contentBriefId, provider });
  assert.equal(r.failureKind, 'EMPTY_RESULT');
  assert.equal(r.providerFailure.hitCount, 0);
  assert.equal(r.retryDisposition.eligible, true);
  assert.equal(r.attempt, 1);
  cleanup(storage, dbPath);
});

test('end to end with the real PixabayAssetSourceProvider (mocked fetch): a valid hit still provisions normally', async () => {
  const { storage, dbPath, contentBriefId } = await setup();
  const downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pix-e2e-'));
  const hit = { id: 7, pageURL: 'https://pixabay.com/photos/lake-7/', largeImageURL: 'https://pixabay.com/get/lake_1280.jpg', user: 'u' };
  const provider = new PixabayAssetSourceProvider({
    downloadDir,
    apiKeyProvider: () => SECRET,
    fetchImpl: async (url) => url.startsWith('https://pixabay.com/api/')
      ? { ok: true, status: 200, json: async () => ({ total: 1, hits: [hit] }) }
      : { ok: true, status: 200, arrayBuffer: async () => Uint8Array.from(Buffer.from('jpeg-bytes')).buffer }
  });
  const r = await runAssetProvisioning({ storage, contentBriefId, provider });
  assert.equal(r.outcome, 'PROVISIONED');
  assert.equal(r.asset.verification_status, 'UNVERIFIED');
  assert.equal(assetCount(storage), 1);
  assert.equal(storage.get("SELECT COUNT(*) AS n FROM stage_retry_state WHERE stage='ASSET_PROVISIONING'").n, 0);
  cleanup(storage, dbPath, [downloadDir]);
});
