import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { SqliteStorageDriver } from '../../src/storage/SqliteStorageDriver.js';
import { PixabayAssetSourceProvider } from '../../src/providers/asset/PixabayAssetSourceProvider.js';
import { runAssetProvisioning } from '../../src/asset-provisioning/pipeline.js';
import { runRightsVerification } from '../../src/rights-verification/pipeline.js';

// Boundary under test: REAL PixabayAssetSourceProvider (acquisition,
// download, checksum, provenance shape) -> REAL runAssetProvisioning
// (persistence) -> REAL runRightsVerification (pixabay policy).
// Only the network is substituted (injected fetchImpl serving
// Pixabay-API-shaped JSON + bytes); this is NOT a live-Pixabay proof.

const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'real-asset-rights-'));
  const storage = new SqliteStorageDriver({ dbPath: path.join(dir, 'test.db') });
  return { dir, storage };
}

function teardown({ dir, storage }) {
  storage.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

function seedProduced(storage) {
  const now = new Date().toISOString();
  const opp = crypto.randomUUID();
  storage.run(`INSERT INTO opportunities (id, title, source, discovered_at, status) VALUES (?, 'Opp', 'rss', ?, 'DISCOVERED')`, [opp, now]);
  const briefId = crypto.randomUUID();
  storage.run(
    `INSERT INTO content_briefs
      (id, opportunity_id, working_title, core_question, target_audience, viewer_promise,
       hook, angle, narrative_structure, key_claims, counterpoints, original_insights, visual_ideas,
       monetization_opportunities, risk_assessment, created_at)
     VALUES (?, ?, 'T', 'Q', 'A', 'P', 'H', 'Angle', 'Structure', '[]', 'C', 'I', 'A quiet forest path', 'M', 'R', ?)`,
    [briefId, opp, now]
  );
  const scriptId = crypto.randomUUID();
  storage.run(`INSERT INTO scripts (id, content_brief_id, version, body, claim_links, created_at) VALUES (?, ?, 1, 'Body.', '[]', ?)`, [scriptId, briefId, now]);
  const cvId = crypto.randomUUID();
  storage.run(`INSERT INTO content_versions (id, content_brief_id, script_id, state, created_at) VALUES (?, ?, ?, 'PRODUCED', ?)`, [cvId, briefId, scriptId, now]);
  storage.run(
    `INSERT INTO productions (id, content_version_id, script_id, artifact_type, artifact_path, artifact_checksum, manifest_json, created_at)
     VALUES (?, ?, ?, 'production_manifest_v1', '/tmp/m.json', 'x', '{}', ?)`,
    [crypto.randomUUID(), cvId, scriptId, now]
  );
  return { briefId, cvId };
}

function pixabayFetch() {
  const calls = [];
  const impl = async (url) => {
    calls.push(String(url));
    const u = String(url);
    if (u.startsWith('https://pixabay.com/api/?')) {
      return {
        ok: true,
        json: async () => ({
          hits: [{
            id: 424242,
            pageURL: 'https://pixabay.com/photos/forest-path-424242/',
            largeImageURL: 'https://cdn.pixabay.com/photo/forest-path-424242_1280.jpg',
            user: 'someone'
          }]
        })
      };
    }
    return { ok: true, arrayBuffer: async () => PNG_BYTES.buffer.slice(PNG_BYTES.byteOffset, PNG_BYTES.byteOffset + PNG_BYTES.length) };
  };
  return { impl, calls };
}

async function provision(ctx) {
  const { dir, storage } = ctx;
  await storage.migrate();
  const { briefId, cvId } = seedProduced(storage);
  const f = pixabayFetch();
  const provider = new PixabayAssetSourceProvider({
    fetchImpl: f.impl,
    apiKeyProvider: () => 'test-key-not-real',
    downloadDir: path.join(dir, 'assets')
  });
  const prov = await runAssetProvisioning({ storage, contentBriefId: briefId, provider });
  return { briefId, cvId, prov, fetchCalls: f.calls };
}

test('real provider-shaped asset survives persistence with full provenance', async () => {
  const ctx = setup();
  try {
    const { prov, fetchCalls } = await provision(ctx);
    assert.equal(prov.outcome, 'PROVISIONED');
    const row = ctx.storage.get('SELECT * FROM assets WHERE id = ?', [prov.asset.id]);
    assert.equal(row.verification_status, 'UNVERIFIED');
    assert.equal(row.origin, 'https://pixabay.com/photos/forest-path-424242/');
    assert.equal(row.license, 'Pixabay Content License');
    assert.match(row.provenance_notes, /provider=pixabay; pixabayId=424242/);
    assert.ok(row.location.startsWith(path.join(ctx.dir, 'assets')));
    assert.ok(fs.existsSync(row.location));
    assert.equal(row.checksum, crypto.createHash('sha256').update(PNG_BYTES).digest('hex'));
    assert.ok(!/^https?:/.test(row.location), 'never a hotlinked URL');
    assert.equal(fetchCalls.length, 2, 'one search + one download');
  } finally { teardown(ctx); }
});

test('rights verification accepts the real-shaped asset and records the decision', async () => {
  const ctx = setup();
  try {
    const { briefId, cvId, prov } = await provision(ctx);
    const r = runRightsVerification({ storage: ctx.storage, contentBriefId: briefId });
    assert.equal(r.outcome, 'PROCESSED');
    assert.deepEqual(r.results.map((x) => [x.decision, x.reason]), [['VERIFIED', 'all_policy_conditions_satisfied']]);
    const row = ctx.storage.get('SELECT verification_status FROM assets WHERE id = ?', [prov.asset.id]);
    assert.equal(row.verification_status, 'VERIFIED');
    const v = ctx.storage.get('SELECT * FROM asset_verifications WHERE asset_id = ?', [prov.asset.id]);
    assert.equal(v.decision, 'VERIFIED');
    assert.equal(v.policy_id, 'pixabay');
    // Downstream boundary: Media Production refuses UNVERIFIED/DISPUTED
    // (src/media/pipeline.js); no such asset remains for this content.
    const unsafe = ctx.storage.all(
      `SELECT a.id FROM assets a JOIN asset_usages u ON u.asset_id = a.id
       WHERE u.content_version_id = ? AND a.verification_status IN ('UNVERIFIED','DISPUTED')`, [cvId]);
    assert.equal(unsafe.length, 0);
    // No publication side effect anywhere in this boundary.
    assert.equal(ctx.storage.get('SELECT COUNT(*) AS n FROM publications').n, 0);
  } finally { teardown(ctx); }
});

test('rights verification fails closed on missing origin', async () => {
  const ctx = setup();
  try {
    const { briefId, prov } = await provision(ctx);
    ctx.storage.run('UPDATE assets SET origin = NULL WHERE id = ?', [prov.asset.id]);
    const r = runRightsVerification({ storage: ctx.storage, contentBriefId: briefId });
    assert.equal(r.results[0].decision, 'NOT_VERIFIED');
    assert.equal(r.results[0].reason, 'missing_required_field_origin');
    assert.equal(ctx.storage.get('SELECT verification_status FROM assets WHERE id = ?', [prov.asset.id]).verification_status, 'UNVERIFIED');
  } finally { teardown(ctx); }
});

test('rights verification fails closed on unapproved license and missing checksum', async () => {
  const ctx = setup();
  try {
    const { briefId, prov } = await provision(ctx);
    ctx.storage.run(`UPDATE assets SET license = 'CC-BY-NC' WHERE id = ?`, [prov.asset.id]);
    let r = runRightsVerification({ storage: ctx.storage, contentBriefId: briefId });
    assert.equal(r.results[0].reason, 'license_not_approved');
    assert.equal(r.results[0].decision, 'NOT_VERIFIED');
  } finally { teardown(ctx); }
  const ctx2 = setup();
  try {
    const { briefId, prov } = await provision(ctx2);
    ctx2.storage.run('UPDATE assets SET checksum = NULL WHERE id = ?', [prov.asset.id]);
    const r = runRightsVerification({ storage: ctx2.storage, contentBriefId: briefId });
    assert.equal(r.results[0].reason, 'missing_required_field_checksum');
    assert.equal(ctx2.storage.get('SELECT verification_status FROM assets WHERE id = ?', [prov.asset.id]).verification_status, 'UNVERIFIED');
  } finally { teardown(ctx2); }
});

test('rights verification marks a tampered file DISPUTED', async () => {
  const ctx = setup();
  try {
    const { briefId, prov } = await provision(ctx);
    fs.writeFileSync(prov.asset.location, 'tampered');
    const r = runRightsVerification({ storage: ctx.storage, contentBriefId: briefId });
    assert.equal(r.results[0].decision, 'DISPUTED');
    assert.equal(r.results[0].reason, 'checksum_mismatch');
    assert.equal(ctx.storage.get('SELECT verification_status FROM assets WHERE id = ?', [prov.asset.id]).verification_status, 'DISPUTED');
  } finally { teardown(ctx); }
});
