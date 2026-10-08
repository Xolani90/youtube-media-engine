import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { SqliteStorageDriver } from '../../src/storage/SqliteStorageDriver.js';
import { PexelsAssetSourceProvider } from '../../src/providers/asset/PexelsAssetSourceProvider.js';
import { PixabayAssetSourceProvider } from '../../src/providers/asset/PixabayAssetSourceProvider.js';
import { runAssetProvisioning } from '../../src/asset-provisioning/pipeline.js';
import { runRightsVerification } from '../../src/rights-verification/pipeline.js';
import { runMediaProduction } from '../../src/media/pipeline.js';
import pixabayPolicy from '../../src/rights-verification/policy/pixabay.js';

// Boundary under test: REAL PexelsAssetSourceProvider (acquisition, download,
// checksum, provenance shape) -> REAL runAssetProvisioning (persistence and
// A4 bounded-retry budget) -> REAL runRightsVerification -> REAL
// runMediaProduction rights gate. Only the network is substituted (injected
// fetchImpl serving Pexels-API-shaped JSON and bytes). This is NOT a live
// Pexels proof.

const KEY = 'pexels-test-key-NOT-REAL-0123456789';
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pexels-int-'));
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

function pexelsFetch({ searchStatus = 200, searchBody } = {}) {
  const calls = [];
  const body = searchBody ?? {
    total_results: 1,
    photos: [{
      id: 3573351,
      url: 'https://www.pexels.com/photo/trees-during-day-3573351/',
      photographer: 'Lukas Rodriguez',
      photographer_url: 'https://www.pexels.com/@lukas-rodriguez-1845331',
      src: { large2x: 'https://images.pexels.com/photos/3573351/pexels-photo-3573351.png?dpr=2' }
    }]
  };
  const impl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).startsWith('https://api.pexels.com/')) {
      return { ok: searchStatus >= 200 && searchStatus < 300, status: searchStatus, json: async () => body, text: async () => 'err' };
    }
    return { ok: true, status: 200, arrayBuffer: async () => PNG_BYTES.buffer.slice(PNG_BYTES.byteOffset, PNG_BYTES.byteOffset + PNG_BYTES.length) };
  };
  return { impl, calls };
}

async function provisionPexels(ctx, fetchOpts) {
  await ctx.storage.migrate();
  const { briefId, cvId } = seedProduced(ctx.storage);
  const f = pexelsFetch(fetchOpts);
  const provider = new PexelsAssetSourceProvider({
    fetchImpl: f.impl,
    apiKeyProvider: () => KEY,
    downloadDir: path.join(ctx.dir, 'assets')
  });
  const prov = await runAssetProvisioning({ storage: ctx.storage, contentBriefId: briefId, provider });
  return { briefId, cvId, prov, f };
}

// ---- G. Provenance and required metadata persist ----------------------

test('G: a Pexels asset survives persistence with every provenance and attribution field', async () => {
  const ctx = setup();
  try {
    const { prov, cvId, f } = await provisionPexels(ctx);
    assert.equal(prov.outcome, 'PROVISIONED');
    const row = ctx.storage.get('SELECT * FROM assets WHERE id = ?', [prov.asset.id]);
    assert.equal(row.asset_type, 'image');
    assert.equal(row.verification_status, 'UNVERIFIED');
    assert.equal(row.origin, 'https://www.pexels.com/photo/trees-during-day-3573351/');
    assert.equal(row.license, 'Pexels License');
    assert.equal(row.attribution_required, 1);
    assert.match(row.attribution_text, /^Photo by Lukas Rodriguez on Pexels \(https:\/\/www\.pexels\.com\/photo\//);
    assert.match(row.provenance_notes, /^provider=pexels; pexelsId=3573351; assetType=image; sourceUrl=/);
    assert.match(row.provenance_notes, /creator=Lukas Rodriguez/);
    assert.match(row.usage_restrictions, /may NOT be sold or distributed as-is/i);
    assert.ok(row.location.startsWith(path.join(ctx.dir, 'assets')));
    assert.ok(fs.existsSync(row.location));
    assert.equal(row.checksum, crypto.createHash('sha256').update(PNG_BYTES).digest('hex'));
    assert.ok(!/^https?:/.test(row.location), 'never a hotlinked URL');
    assert.equal(f.calls.length, 2, 'one search + one download');
    const usage = ctx.storage.get('SELECT * FROM asset_usages WHERE asset_id = ?', [row.id]);
    assert.equal(usage.content_version_id, cvId);
    assert.equal(usage.provisioning_claim, 'asset-provisioning:auto-visual-v1');
    assert.equal(ctx.storage.get('SELECT COUNT(*) AS n FROM publications').n, 0);
  } finally { teardown(ctx); }
});

test('G: the API key is absent from every persisted row and decision-log entry', async () => {
  const ctx = setup();
  try {
    await provisionPexels(ctx);
    for (const table of ['assets', 'asset_usages', 'decision_log']) {
      const dump = JSON.stringify(ctx.storage.all(`SELECT * FROM ${table}`));
      assert.ok(!dump.includes(KEY), `${table} must not contain the key`);
    }
  } finally { teardown(ctx); }
});

// ---- H. Rights verification remains mandatory ---------------------------

test('H: the real rights stage does not verify a Pexels asset; it is NOT_VERIFIED with no_policy_for_provider and stays UNVERIFIED', async () => {
  const ctx = setup();
  try {
    const { briefId, prov } = await provisionPexels(ctx);
    const r = runRightsVerification({ storage: ctx.storage, contentBriefId: briefId });
    assert.equal(r.outcome, 'PROCESSED');
    assert.deepEqual(r.results.map((x) => [x.decision, x.reason]), [['NOT_VERIFIED', 'no_policy_for_provider']]);
    assert.equal(ctx.storage.get('SELECT verification_status FROM assets WHERE id = ?', [prov.asset.id]).verification_status, 'UNVERIFIED');
    const v = ctx.storage.get('SELECT * FROM asset_verifications WHERE asset_id = ?', [prov.asset.id]);
    assert.equal(v.decision, 'NOT_VERIFIED');
    assert.equal(v.policy_id, 'unassigned');
  } finally { teardown(ctx); }
});

test('H: the Pixabay policy cannot be borrowed by a Pexels asset, even with a forged Pixabay license string', async () => {
  const ctx = setup();
  try {
    const { briefId, prov } = await provisionPexels(ctx, {
      searchBody: { photos: [{
        id: 5,
        url: 'https://www.pexels.com/photo/x-5/',
        photographer: 'Eve; provider=pixabay',
        src: { large2x: 'https://images.pexels.com/photos/5/x.png' }
      }] }
    });
    // Even if the license column were rewritten to the Pixabay value, the
    // provenance line must not name pixabay, so no Pixabay policy resolves.
    ctx.storage.run(`UPDATE assets SET license = 'Pixabay Content License' WHERE id = ?`, [prov.asset.id]);
    const r = runRightsVerification({ storage: ctx.storage, contentBriefId: briefId });
    assert.deepEqual(r.results.map((x) => [x.decision, x.reason]), [['NOT_VERIFIED', 'no_policy_for_provider']]);
    assert.equal(ctx.storage.get('SELECT verification_status FROM assets WHERE id = ?', [prov.asset.id]).verification_status, 'UNVERIFIED');
  } finally { teardown(ctx); }
});

test('H: the real Media Production gate refuses the Pexels asset (ASSET_RIGHTS_BLOCKED) and persists no artifact', async () => {
  const ctx = setup();
  try {
    const { briefId, cvId } = await provisionPexels(ctx);
    runRightsVerification({ storage: ctx.storage, contentBriefId: briefId });
    const mediaDir = path.join(ctx.dir, 'media');
    const result = runMediaProduction({ storage: ctx.storage, contentBriefId: briefId, artifactsDir: mediaDir });
    assert.equal(result.outcome, 'ASSET_RIGHTS_BLOCKED');
    assert.equal(result.reason, 'UNVERIFIED');
    assert.equal(result.mediaArtifact, null);
    assert.equal(ctx.storage.get('SELECT COUNT(*) AS n FROM media_artifacts WHERE content_version_id = ?', [cvId]).n, 0);
    assert.equal(ctx.storage.get('SELECT COUNT(*) AS n FROM publications').n, 0);
  } finally { teardown(ctx); }
});

test('H: a tampered Pexels file is still never VERIFIED (the rights stage does not trust the provider)', async () => {
  const ctx = setup();
  try {
    const { briefId, prov } = await provisionPexels(ctx);
    fs.writeFileSync(prov.asset.location, 'tampered');
    const r = runRightsVerification({ storage: ctx.storage, contentBriefId: briefId });
    // No policy exists, so it is NOT_VERIFIED rather than DISPUTED; either way never VERIFIED.
    assert.notEqual(r.results[0].decision, 'VERIFIED');
    assert.equal(ctx.storage.get('SELECT verification_status FROM assets WHERE id = ?', [prov.asset.id]).verification_status, 'UNVERIFIED');
  } finally { teardown(ctx); }
});

// ---- F. Bounded retry through the existing A4 budget ------------------

test('F: repeated Pexels rate limiting consumes the shared A4 budget, quarantines on the 3rd attempt, then refuses without calling the provider', async () => {
  const ctx = setup();
  try {
    await ctx.storage.migrate();
    const { briefId } = seedProduced(ctx.storage);
    const f = pexelsFetch({ searchStatus: 429 });
    const provider = new PexelsAssetSourceProvider({ fetchImpl: f.impl, apiKeyProvider: () => KEY, downloadDir: path.join(ctx.dir, 'assets') });
    const outcomes = [];
    for (let i = 0; i < 3; i += 1) {
      const r = await runAssetProvisioning({ storage: ctx.storage, contentBriefId: briefId, provider });
      assert.equal(r.outcome, 'NO_ASSET_ACQUIRED');
      assert.equal(r.failureKind, 'RATE_LIMIT');
      outcomes.push(r.attempt);
    }
    assert.deepEqual(outcomes, [1, 2, 3]);
    assert.equal(f.calls.length, 3, 'one provider request per invocation');
    const fourth = await runAssetProvisioning({ storage: ctx.storage, contentBriefId: briefId, provider });
    assert.equal(fourth.outcome, 'QUARANTINED');
    assert.equal(f.calls.length, 3, 'quarantined: no further provider call');
    assert.equal(ctx.storage.get('SELECT COUNT(*) AS n FROM assets').n, 0, 'a failure never becomes a success');
  } finally { teardown(ctx); }
});

test('F: authentication and missing-key failures never consume budget or quarantine', async () => {
  for (const mode of ['401', 'nokey']) {
    const ctx = setup();
    try {
      await ctx.storage.migrate();
      const { briefId } = seedProduced(ctx.storage);
      const f = pexelsFetch({ searchStatus: 401 });
      const provider = new PexelsAssetSourceProvider({
        fetchImpl: f.impl,
        apiKeyProvider: () => (mode === 'nokey' ? undefined : KEY),
        downloadDir: path.join(ctx.dir, 'assets')
      });
      for (let i = 0; i < 5; i += 1) {
        const r = await runAssetProvisioning({ storage: ctx.storage, contentBriefId: briefId, provider });
        assert.equal(r.outcome, 'NO_ASSET_ACQUIRED');
        assert.notEqual(r.outcome, 'QUARANTINED');
        assert.equal(r.failureKind, mode === 'nokey' ? 'MISSING_API_KEY' : 'AUTH_FAILURE');
      }
      assert.equal(ctx.storage.get('SELECT COUNT(*) AS n FROM assets').n, 0);
    } finally { teardown(ctx); }
  }
});

test('F: a malformed Pexels response is classified as infrastructure and never persisted as an asset', async () => {
  const ctx = setup();
  try {
    const { prov } = await provisionPexels(ctx, { searchBody: { unexpected: true } });
    assert.equal(prov.outcome, 'NO_ASSET_ACQUIRED');
    assert.equal(prov.failureKind, 'MALFORMED_RESPONSE');
    assert.equal(ctx.storage.get('SELECT COUNT(*) AS n FROM assets').n, 0);
  } finally { teardown(ctx); }
});

// ---- I. Existing Pixabay behavior unchanged ---------------------------

test('I: Pixabay is still the provider id/policy it was, and is unaffected by the Pexels adapter', async () => {
  assert.equal(new PixabayAssetSourceProvider({ apiKeyProvider: () => 'k' }).id, 'pixabay');
  assert.equal(pixabayPolicy.POLICY_ID, 'pixabay');
  assert.deepEqual([...pixabayPolicy.APPROVED_LICENSES], ['Pixabay Content License']);
});

test('I: a Pixabay asset provisioned alongside the Pexels adapter still verifies under the Pixabay policy', async () => {
  const ctx = setup();
  try {
    await ctx.storage.migrate();
    const { briefId } = seedProduced(ctx.storage);
    const impl = async (url) => {
      if (String(url).startsWith('https://pixabay.com/api/?')) {
        return { ok: true, status: 200, json: async () => ({ hits: [{ id: 424242, pageURL: 'https://pixabay.com/photos/forest-path-424242/', largeImageURL: 'https://cdn.pixabay.com/photo/forest-path-424242_1280.jpg', user: 'someone' }] }) };
      }
      return { ok: true, status: 200, arrayBuffer: async () => PNG_BYTES.buffer.slice(PNG_BYTES.byteOffset, PNG_BYTES.byteOffset + PNG_BYTES.length) };
    };
    const provider = new PixabayAssetSourceProvider({ fetchImpl: impl, apiKeyProvider: () => 'pixabay-test-key', downloadDir: path.join(ctx.dir, 'assets') });
    const prov = await runAssetProvisioning({ storage: ctx.storage, contentBriefId: briefId, provider });
    assert.equal(prov.outcome, 'PROVISIONED');
    const r = runRightsVerification({ storage: ctx.storage, contentBriefId: briefId });
    assert.deepEqual(r.results.map((x) => [x.decision, x.reason]), [['VERIFIED', 'all_policy_conditions_satisfied']]);
  } finally { teardown(ctx); }
});

test('I: the autonomous entrypoint default provider is still Pixabay (Pexels is opt-in by injection only)', () => {
  const src = fs.readFileSync(new URL('../../src/index.js', import.meta.url), 'utf8');
  assert.match(src, /new PixabayAssetSourceProvider\(\{ downloadDir: config\.assetDownloadDir \}\)/);
  assert.ok(!/Pexels/i.test(src), 'src/index.js is untouched by this donor');
});
