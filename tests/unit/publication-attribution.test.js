import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  buildDescriptionWithAttribution, collectRequiredAttributions, normalizeDescription,
  InvalidPublicationMetadataError, DESCRIPTION_MAX_LENGTH, ATTRIBUTION_HEADER
} from '../../src/publication/metadataValidation.js';
import { buildPublicationRequest } from '../../src/publication/PublicationRequest.js';
import { SqliteStorageDriver } from '../../src/storage/SqliteStorageDriver.js';
import { runPublication } from '../../src/publication/pipeline.js';
import { PublicationProvider } from '../../src/publication/PublicationProvider.js';
import { PUBLICATION_RESULT_STATUS } from '../../src/publication/constants.js';
import { AssetProvenanceRepository } from '../../src/state/AssetProvenance.js';
import { config } from '../../src/config/index.js';
import { passGate2, runGate2, recordVerification } from '../helpers/gate2.js';

// Mandatory asset attribution in the final publication description.
// Part 1: pure assembly. Part 2: buildPublicationRequest. Part 3: the REAL
// runPublication() pipeline over persisted assets/asset_usages, asserting the
// exact description that reaches the (mock) adapter.

const A = (id, required, text) => ({ id, attribution_required: required, attribution_text: text, verification_status: 'VERIFIED' });

// --- Part 1: pure assembly -------------------------------------------------

test('A. no asset requires attribution: description is exactly the existing normalizeDescription() result', () => {
  assert.equal(buildDescriptionWithAttribution('Promise', []), 'Promise');
  assert.equal(buildDescriptionWithAttribution('Promise', undefined), 'Promise');
  assert.equal(buildDescriptionWithAttribution('Promise', [A('a1', 0, 'ignored credit'), A('a2', 0, null)]), 'Promise');
  assert.equal(buildDescriptionWithAttribution('', []), '');
  const over = 'D'.repeat(DESCRIPTION_MAX_LENGTH + 5); // legacy path unchanged
  assert.equal(buildDescriptionWithAttribution(over, []), normalizeDescription(over));
});

test('B. single required credit is appended after the viewer promise', () => {
  const d = buildDescriptionWithAttribution('Promise', [A('a1', 1, 'Photo by Jane Doe on Pexels (https://www.pexels.com/photo/1/)')]);
  assert.equal(d, `Promise\n\n${ATTRIBUTION_HEADER}\nPhoto by Jane Doe on Pexels (https://www.pexels.com/photo/1/)`);
});

test('B. empty viewer promise: description is just the credit block', () => {
  assert.equal(buildDescriptionWithAttribution('', [A('a1', 1, 'Credit One')]), `${ATTRIBUTION_HEADER}\nCredit One`);
});

test('C. every mandatory credit is included', () => {
  const d = buildDescriptionWithAttribution('P', [A('a1', 1, 'Credit B'), A('a2', 1, 'Credit A'), A('a3', 1, 'Credit C')]);
  for (const c of ['Credit A', 'Credit B', 'Credit C']) assert.ok(d.includes(c), c);
});

test('D. mixed assets: only assets whose metadata requires attribution are credited', () => {
  const d = buildDescriptionWithAttribution('P', [A('a1', 0, 'Not required'), A('a2', 1, 'Required'), A('a3', 0, null), A('a4', true, 'Also required')]);
  assert.ok(d.includes('Required') && d.includes('Also required'));
  assert.ok(!d.includes('Not required'));
});

test('E. ordering is deterministic and independent of input order; only identical credits are deduplicated', () => {
  const set = [A('a1', 1, 'Zed'), A('a2', 1, 'Alpha by X'), A('a3', 1, 'Alpha by Y'), A('a4', 1, '  Zed  '), A('a5', 1, 'Alpha by X')];
  const first = buildDescriptionWithAttribution('P', set);
  assert.equal(buildDescriptionWithAttribution('P', [...set].reverse()), first);
  assert.equal(buildDescriptionWithAttribution('P', [...set].sort(() => 0.5 - Math.random())), first);
  assert.deepEqual(collectRequiredAttributions(set), ['Alpha by X', 'Alpha by Y', 'Zed']);
  assert.ok(first.includes('Alpha by X') && first.includes('Alpha by Y'), 'distinct credits are never merged');
});

for (const [label, text] of [['null', null], ['undefined', undefined], ['empty', ''], ['whitespace only', '  \n\t '], ['non-string', 42], ['contains <', 'Photo <b>x</b>'], ['control char', 'Photo\u0000by x']]) {
  test(`F. required attribution that is ${label} blocks with an actionable asset-specific reason`, () => {
    assert.throws(
      () => buildDescriptionWithAttribution('P', [A('good', 1, 'Fine'), A('bad-asset', 1, text)]),
      (e) => e instanceof InvalidPublicationMetadataError && /^asset_bad-asset_required_attribution_(missing|unusable)$/.test(e.message)
    );
  });
}

test('F. attribution_text is ignored (not validated) when the asset does not require attribution', () => {
  assert.equal(buildDescriptionWithAttribution('P', [A('a1', 0, '')]), 'P');
});

test('G. final description of exactly 5000 bytes passes; 5001 blocks', () => {
  const credit = 'Credit line';
  const fixed = Buffer.byteLength(`\n\n${ATTRIBUTION_HEADER}\n${credit}`, 'utf8');
  const exact = 'x'.repeat(DESCRIPTION_MAX_LENGTH - fixed);
  const ok = buildDescriptionWithAttribution(exact, [A('a1', 1, credit)]);
  assert.equal(Buffer.byteLength(ok, 'utf8'), DESCRIPTION_MAX_LENGTH);
  assert.throws(
    () => buildDescriptionWithAttribution(`${exact}y`, [A('a1', 1, credit)]),
    (e) => e instanceof InvalidPublicationMetadataError && /exceeds_5000_bytes_actual_5001$/.test(e.message)
  );
});

test('G. the limit is counted in UTF-8 bytes (what YouTube documents), not UTF-16 units', () => {
  const credit = 'C';
  const fixed = Buffer.byteLength(`\n\n${ATTRIBUTION_HEADER}\n${credit}`, 'utf8');
  // 'é' = 2 bytes but 1 UTF-16 unit: 2500 of them fit by length but not with the credit block.
  const promise = 'é'.repeat(Math.floor((DESCRIPTION_MAX_LENGTH - fixed) / 2) + 1);
  assert.ok(promise.length + fixed < DESCRIPTION_MAX_LENGTH, 'would pass a naive .length check');
  assert.throws(() => buildDescriptionWithAttribution(promise, [A('a1', 1, credit)]), InvalidPublicationMetadataError);
});

test('H. overflow never truncates: promise and every credit are either all present or the call throws', () => {
  const credits = [A('a1', 1, 'Credit One'), A('a2', 1, 'Credit Two')];
  const overflowing = 'p'.repeat(DESCRIPTION_MAX_LENGTH - 10);
  assert.throws(() => buildDescriptionWithAttribution(overflowing, credits), InvalidPublicationMetadataError);
  const fits = 'p'.repeat(100);
  const d = buildDescriptionWithAttribution(fits, credits);
  assert.ok(d.startsWith(fits) && d.includes('Credit One') && d.includes('Credit Two'));
});

// --- Part 2: buildPublicationRequest ----------------------------------------

function reqArgs(overrides = {}) {
  return {
    contentVersion: { id: 'cv1' }, script: { id: 's1' },
    contentBrief: { id: 'b1', working_title: 'My Video', viewer_promise: 'Promise' },
    mediaArtifact: { id: 'm1', artifact_path: '/tmp/x.mp4', artifact_checksum: 'c', duration_seconds: 5 },
    ...overrides
  };
}

test('buildPublicationRequest: no assets argument keeps the existing description; credits appear when assets are supplied', () => {
  assert.equal(buildPublicationRequest(reqArgs()).description, 'Promise');
  const r = buildPublicationRequest(reqArgs({ assets: [A('a1', 1, 'Credit One')] }));
  assert.equal(r.description, `Promise\n\n${ATTRIBUTION_HEADER}\nCredit One`);
  assert.equal(r.title, 'My Video');
  assert.equal(r.mediaChecksum, 'c', 'artifact identity fields are untouched');
});

// --- Part 3: real publication pipeline ---------------------------------------

function freshStorage() {
  const dbPath = path.join(os.tmpdir(), `pub-attr-${Date.now()}-${Math.random()}.db`);
  return { storage: new SqliteStorageDriver({ dbPath }), dbPath };
}
function cleanup(storage, dbPath, ...files) {
  storage.close();
  for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, ...files]) fs.rmSync(f, { force: true });
}
const nowISO = () => new Date().toISOString();

function withLiveAuthorized(actions, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pub-attr-auth-'));
  const filePath = path.join(dir, 'authorized.json');
  fs.writeFileSync(filePath, JSON.stringify(actions));
  const saved = [config.authorizedExternalActionsPath, config.runMode, config.autonomousEnabled];
  config.authorizedExternalActionsPath = filePath;
  config.runMode = 'LIVE';
  config.autonomousEnabled = true;
  return Promise.resolve(fn(filePath)).finally(() => {
    [config.authorizedExternalActionsPath, config.runMode, config.autonomousEnabled] = saved;
  });
}

class MockAdapter extends PublicationProvider {
  constructor(result) { super(); this._result = result; this.calls = []; }
  get id() { return 'mock'; }
  async publish(request) { this.calls.push(request); return this._result; }
}
const SUCCESS = { status: PUBLICATION_RESULT_STATUS.SUCCESS, provider: 'mock', providerItemId: 'vid1', providerUrl: 'https://youtu.be/vid1' };

function seedContent(storage, { mediaFilePath, viewerPromise = 'Promise' }) {
  const opportunityId = crypto.randomUUID();
  storage.run(`INSERT INTO opportunities (id, title, source, discovered_at, status) VALUES (?, 'T', 'rss', ?, 'DISCOVERED')`, [opportunityId, nowISO()]);
  const contentBriefId = crypto.randomUUID();
  storage.run(
    `INSERT INTO content_briefs
      (id, opportunity_id, working_title, core_question, target_audience, viewer_promise,
       hook, angle, narrative_structure, key_claims, counterpoints, original_insights, visual_ideas,
       monetization_opportunities, risk_assessment, created_at)
     VALUES (?, ?, 'My Video', 'Q', 'A', ?, 'H', 'Angle', 'Structure', '[]', 'C', 'I', 'V', 'M', 'R', ?)`,
    [contentBriefId, opportunityId, viewerPromise, nowISO()]
  );
  const scriptId = crypto.randomUUID();
  storage.run(`INSERT INTO scripts (id, content_brief_id, version, body, claim_links, created_at) VALUES (?, ?, 1, 'Body.', '[]', ?)`, [scriptId, contentBriefId, nowISO()]);
  const contentVersionId = crypto.randomUUID();
  storage.run(`INSERT INTO content_versions (id, content_brief_id, script_id, state, created_at) VALUES (?, ?, ?, 'PRODUCED', ?)`, [contentVersionId, contentBriefId, scriptId, nowISO()]);
  const productionId = crypto.randomUUID();
  storage.run(
    `INSERT INTO productions (id, content_version_id, script_id, artifact_type, artifact_path, artifact_checksum, manifest_json, created_at)
     VALUES (?, ?, ?, 'production_manifest_v1', '/tmp/x', 'deadbeef', '{}', ?)`,
    [productionId, contentVersionId, scriptId, nowISO()]
  );
  storage.run(
    `INSERT INTO media_artifacts
      (id, production_id, content_version_id, render_spec_json, render_spec_checksum,
       narration_path, narration_duration_seconds, artifact_path, artifact_checksum,
       duration_seconds, width, height, video_codec, audio_codec, created_at)
     VALUES (?, ?, ?, '{}', 'chk', '/tmp/n.wav', 5.0, ?, 'chk2', 5.0, 1280, 720, 'h264', 'aac', ?)`,
    [crypto.randomUUID(), productionId, contentVersionId, mediaFilePath, nowISO()]
  );
  passGate2(storage, contentVersionId);
  return { contentBriefId, contentVersionId };
}

/** Persists an asset + usage through the real repository; re-runs Gate 2 when requested (asset set changes the evidence). */
function seedAsset(storage, contentVersionId, { status = 'VERIFIED', attributionRequired = false, attributionText = null } = {}) {
  const repo = new AssetProvenanceRepository(storage);
  const assetId = repo.recordAsset({ assetType: 'image', location: `/tmp/${crypto.randomUUID()}.png`, verificationStatus: status, attributionRequired, attributionText });
  repo.recordUsage({ assetId, contentVersionId, usageContext: 'b-roll' });
  if (status === 'VERIFIED' || status === 'DISPUTED') recordVerification(storage, assetId, status);
  return assetId;
}

async function publishWith({ assets = [], viewerPromise = 'Promise', rerunGate2 = true, authorized = true }) {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const videoFile = path.join(os.tmpdir(), `pub-attr-video-${crypto.randomUUID()}.mp4`);
  fs.writeFileSync(videoFile, 'fake mp4 bytes');
  const { contentBriefId, contentVersionId } = seedContent(storage, { mediaFilePath: videoFile, viewerPromise });
  for (const a of assets) seedAsset(storage, contentVersionId, a);
  if (assets.length && rerunGate2) assert.equal(runGate2(storage, contentVersionId).decision, 'PASS');
  const adapter = new MockAdapter(SUCCESS);
  const run = () => runPublication({ storage, contentBriefId, provider: 'mock', adapter });
  const result = authorized ? await withLiveAuthorized([`publish:mock:${contentVersionId}`], run) : await run();
  const rows = storage.all('SELECT * FROM publications WHERE content_version_id = ?', [contentVersionId]);
  cleanup(storage, dbPath, videoFile);
  return { result, adapter, rows };
}

test('K. pipeline, no attribution required: adapter receives the unchanged viewer promise', async () => {
  const { result, adapter } = await publishWith({ assets: [{ attributionRequired: false }] });
  assert.equal(result.outcome, 'PUBLISHED');
  assert.equal(adapter.calls[0].description, 'Promise');
});

test('K. pipeline, single required credit reaches the adapter description', async () => {
  const { result, adapter } = await publishWith({ assets: [{ attributionRequired: true, attributionText: 'Photo by Jane Doe on Pexels' }] });
  assert.equal(result.outcome, 'PUBLISHED');
  assert.equal(adapter.calls[0].description, `Promise\n\n${ATTRIBUTION_HEADER}\nPhoto by Jane Doe on Pexels`);
});

test('K. pipeline, multiple + mixed assets: only required credits, deterministic order', async () => {
  const assets = [
    { attributionRequired: true, attributionText: 'Zed on Pexels' },
    { attributionRequired: false, attributionText: 'Never shown' },
    { attributionRequired: true, attributionText: 'Alpha on Pexels' },
    { attributionRequired: true, attributionText: 'Zed on Pexels' },
    { attributionRequired: false }
  ];
  const { result, adapter } = await publishWith({ assets });
  assert.equal(result.outcome, 'PUBLISHED');
  assert.equal(adapter.calls[0].description, `Promise\n\n${ATTRIBUTION_HEADER}\nAlpha on Pexels\nZed on Pexels`);
});

for (const [label, text] of [['missing', null], ['empty', '   ']]) {
  test(`F/K. pipeline: ${label} mandatory attribution blocks publication (STRUCTURAL_FAILURE), adapter never called, nothing claimed`, async () => {
    const { result, adapter, rows } = await publishWith({ assets: [{ attributionRequired: true, attributionText: text }] });
    assert.equal(result.outcome, 'STRUCTURAL_FAILURE');
    assert.match(result.reason, /^asset_[0-9a-f-]+_required_attribution_missing$/);
    assert.equal(adapter.calls.length, 0);
    assert.equal(rows.length, 0, 'no publications row, not even PENDING');
  });
}

test('G/H/K. pipeline: description over 5000 bytes with credits blocks; nothing is truncated or sent', async () => {
  const { result, adapter, rows } = await publishWith({
    viewerPromise: 'p'.repeat(DESCRIPTION_MAX_LENGTH - 5),
    assets: [{ attributionRequired: true, attributionText: 'Photo by Jane Doe on Pexels' }]
  });
  assert.equal(result.outcome, 'STRUCTURAL_FAILURE');
  assert.match(result.reason, /^description_with_required_attribution_exceeds_5000_bytes_actual_\d+$/);
  assert.equal(adapter.calls.length, 0);
  assert.equal(rows.length, 0);
});

test('G/K. pipeline: description of exactly 5000 bytes with credits is published intact', async () => {
  const credit = 'Photo by Jane Doe on Pexels';
  const fixed = Buffer.byteLength(`\n\n${ATTRIBUTION_HEADER}\n${credit}`, 'utf8');
  const { result, adapter } = await publishWith({
    viewerPromise: 'p'.repeat(DESCRIPTION_MAX_LENGTH - fixed),
    assets: [{ attributionRequired: true, attributionText: credit }]
  });
  assert.equal(result.outcome, 'PUBLISHED');
  assert.equal(Buffer.byteLength(adapter.calls[0].description, 'utf8'), DESCRIPTION_MAX_LENGTH);
  assert.ok(adapter.calls[0].description.endsWith(credit));
});

for (const status of ['UNVERIFIED', 'DISPUTED']) {
  test(`I. ${status} asset with valid attribution is still blocked by the rights gate (ASSET_RIGHTS_BLOCKED), not by attribution`, async () => {
    const { result, adapter, rows } = await publishWith({
      assets: [{ status, attributionRequired: true, attributionText: 'Photo by Jane Doe on Pexels' }], rerunGate2: false
    });
    assert.equal(result.outcome, 'ASSET_RIGHTS_BLOCKED');
    assert.equal(result.reason, status);
    assert.equal(adapter.calls.length, 0);
    assert.equal(rows.length, 0);
  });
}

test('J. valid credits grant no authority: SIMULATION default still yields AUTHORIZATION_DENIED, adapter never called', async () => {
  const { result, adapter, rows } = await publishWith({
    assets: [{ attributionRequired: true, attributionText: 'Photo by Jane Doe on Pexels' }], authorized: false
  });
  assert.equal(result.outcome, 'AUTHORIZATION_DENIED');
  assert.equal(adapter.calls.length, 0);
  assert.equal(rows.length, 0);
});

test('J. Gate 2 is unchanged: an asset attached after the PASS makes it stale (GATE2_NOT_AUTHORIZING) regardless of credits', async () => {
  const { result, adapter } = await publishWith({
    assets: [{ attributionRequired: true, attributionText: 'Photo by Jane Doe on Pexels' }], rerunGate2: false
  });
  assert.equal(result.outcome, 'GATE2_NOT_AUTHORIZING');
  assert.equal(adapter.calls.length, 0);
});
