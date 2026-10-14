import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { SqliteStorageDriver } from '../../src/storage/SqliteStorageDriver.js';
import { AssetProvenanceRepository } from '../../src/state/AssetProvenance.js';
import { generateCharacterBible } from '../../src/studio/characterBible.js';
import { toVisualTiming, expandToSteps } from '../../src/studio/storyboard.js';
import {
  registerStudioFrames, frameKey, sha256Hex, StudioFrameError,
  STUDIO_USAGE_CONTEXT_PREFIX
} from '../../src/studio/frameAssets.js';

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const RENDERER = { name: 'test-rasteriser', version: '0.0.1' };
const nowISO = () => new Date().toISOString();

async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-frames-'));
  const storage = new SqliteStorageDriver({ dbPath: path.join(dir, 'test.db') });
  await storage.migrate();
  const repository = new AssetProvenanceRepository(storage);
  const cvId = seedContentVersion(storage);
  const character = generateCharacterBible(1);
  const storyboard = makeStoryboard(character.id);
  return { dir, storage, repository, cvId, character, storyboard };
}
function teardown({ dir, storage }) { storage.close(); fs.rmSync(dir, { recursive: true, force: true }); }

function seedContentVersion(storage) {
  const opp = crypto.randomUUID();
  storage.run(`INSERT INTO opportunities (id, title, source, discovered_at, status) VALUES (?, 'T', 'rss', ?, 'DISCOVERED')`, [opp, nowISO()]);
  const brief = crypto.randomUUID();
  storage.run(
    `INSERT INTO content_briefs (id, opportunity_id, working_title, core_question, target_audience, viewer_promise,
       hook, angle, narrative_structure, key_claims, counterpoints, original_insights, visual_ideas,
       monetization_opportunities, risk_assessment, created_at)
     VALUES (?, ?, 'T', 'Q', 'A', 'P', 'H', 'Angle', 'Structure', '[]', 'C', 'I', 'V', 'M', 'R', ?)`,
    [brief, opp, nowISO()]
  );
  const cv = crypto.randomUUID();
  storage.run(`INSERT INTO content_versions (id, content_brief_id, state, created_at) VALUES (?, ?, 'DISCOVERED', ?)`, [cv, brief, nowISO()]);
  return cv;
}

function makeStoryboard(characterId) {
  return {
    characterId, durationSeconds: 6, fps: 10,
    beats: [
      { id: 'b1', start: 0, end: 2, shot: 'wide', pose: 'idle', purpose: 'establish' },
      { id: 'b2', start: 2, end: 3.6, shot: 'medium', pose: 'gesture', brow: 'raised', gaze: 1, purpose: 'escalate' },
      { id: 'b3', start: 3.6, end: 4, shot: 'medium', pose: 'idle', mouth: 'closed', purpose: 'pause' },
      { id: 'b4', start: 4, end: 6, shot: 'close', pose: 'idle', brow: 'smirk', mouth: 'smirk', purpose: 'punchline' }
    ]
  };
}

/** Rasteriser stand-in: writes a PNG-signature file whose bytes depend on the frame key. */
function fakeRasteriser(dir, { sameBytes = false } = {}) {
  return (state) => {
    const k = frameKey(state);
    const file = path.join(dir, `frame-${crypto.createHash('sha1').update(k).digest('hex').slice(0, 10)}.png`);
    if (!fs.existsSync(file)) fs.writeFileSync(file, Buffer.concat([PNG_SIG, Buffer.from(sameBytes ? 'same' : k)]));
    return file;
  };
}
const run = (c, over = {}) => registerStudioFrames({
  repository: c.repository, contentVersionId: c.cvId, character: c.character, storyboard: c.storyboard,
  frameFiles: fakeRasteriser(c.dir), renderer: RENDERER, ...over
});
const count = (c, t) => c.storage.get(`SELECT COUNT(*) AS n FROM ${t}`).n;
const code = (fn) => { try { fn(); } catch (e) { return e instanceof StudioFrameError ? e.code : `OTHER:${e.message}`; } return null; };

test('records one UNVERIFIED asset per distinct frame with accurate checksum, origin, licence and provenance', async () => {
  const c = await setup();
  const r = run(c);
  const distinct = new Set(expandToSteps(c.storyboard).map(frameKey)).size;
  assert.equal(r.assets.length, distinct);
  assert.equal(count(c, 'assets'), distinct);
  for (const a of r.assets) {
    const row = c.repository.getAsset(a.assetId);
    assert.equal(row.verification_status, 'UNVERIFIED');
    assert.equal(row.asset_type, 'image');
    assert.equal(row.checksum, sha256Hex(fs.readFileSync(row.location)));
    assert.equal(row.origin, 'studio-frame-renderer:test-rasteriser@0.0.1');
    assert.match(row.license, /owner verification pending/);
    assert.equal(row.attribution_required, 0);
    const notes = JSON.parse(row.provenance_notes);
    assert.equal(notes.characterId, c.character.id);
    assert.equal(notes.characterSeed, 1);
    assert.deepEqual(notes.renderer, RENDERER);
    assert.equal(notes.original, true);
    assert.ok(a.frameKeys.includes(notes.frameKey));
  }
  teardown(c);
});

test('never writes VERIFIED and returns an actionable owner-verification indication', async () => {
  const c = await setup();
  const r = run(c);
  assert.equal(c.storage.get(`SELECT COUNT(*) AS n FROM assets WHERE verification_status != 'UNVERIFIED'`).n, 0);
  assert.equal(r.verification.status, 'UNVERIFIED');
  assert.equal(r.verification.ownerActionRequired, true);
  assert.deepEqual(r.verification.assetIds.slice().sort(), r.assets.map((a) => a.assetId).sort());
  assert.match(r.verification.message, /ASSET_RIGHTS_BLOCKED/);
  // the same predicate production/pipeline.js applies would block this content_version
  const attached = c.repository.getAssetsForContent(c.cvId);
  assert.ok(attached.find((a) => a.verification_status === 'DISPUTED' || a.verification_status === 'UNVERIFIED'));
  teardown(c);
});

test('usage rows: one per asset, studio context prefix, no provisioning claim, not misparsed as b-roll scene', async () => {
  const c = await setup();
  const r = run(c);
  assert.equal(count(c, 'asset_usages'), r.assets.length);
  assert.equal(r.usageIds.length, r.assets.length);
  for (const u of c.storage.all('SELECT * FROM asset_usages')) {
    assert.equal(u.content_version_id, c.cvId);
    assert.ok(u.usage_context.startsWith(`${STUDIO_USAGE_CONTEXT_PREFIX} char=${c.character.id}`));
    assert.equal(u.provisioning_claim, null);
    assert.ok(!u.usage_context.startsWith('b-roll scene'));
  }
  assert.equal(c.repository.getAssetsForContent(c.cvId).length, r.assets.length);
  teardown(c);
});

test('visual_timing: contiguous, exact total, existing segment shape, every asset_id recorded, equals pure conversion', async () => {
  const c = await setup();
  const r = run(c);
  const ids = new Set(r.assets.map((a) => a.assetId));
  let cursor = 0;
  for (const s of r.visualTiming) {
    assert.deepEqual(Object.keys(s).sort(), ['asset_id', 'asset_type', 'duration_seconds', 'location', 'start_seconds']);
    assert.equal(s.asset_type, 'image');
    assert.ok(ids.has(s.asset_id));
    assert.ok(Math.abs(s.start_seconds - cursor) < 1e-6);
    assert.ok(fs.existsSync(s.location));
    cursor = Math.round((s.start_seconds + s.duration_seconds) * 1000) / 1000;
  }
  assert.equal(cursor, 6);
  const pure = toVisualTiming(expandToSteps(c.storyboard), 10, () => ({ location: 'x' }));
  assert.equal(r.visualTiming.length, pure.length);
  assert.deepEqual(r.visualTiming.map((s) => [s.start_seconds, s.duration_seconds]), pure.map((s) => [s.start_seconds, s.duration_seconds]));
  teardown(c);
});

test('duplicate handling: identical frame bytes share one asset', async () => {
  const c = await setup();
  const r = run(c, { frameFiles: fakeRasteriser(c.dir, { sameBytes: true }) });
  assert.equal(r.assets.length, 1);
  assert.equal(count(c, 'assets'), 1);
  assert.equal(count(c, 'asset_usages'), 1);
  assert.ok(r.visualTiming.every((s) => s.asset_id === r.assets[0].assetId));
  teardown(c);
});

test('duplicate handling: re-running for the same content_version is idempotent', async () => {
  const c = await setup();
  const first = run(c);
  const second = run(c);
  assert.equal(count(c, 'assets'), first.assets.length);
  assert.equal(count(c, 'asset_usages'), first.assets.length);
  assert.ok(second.assets.every((a) => a.reused));
  assert.deepEqual(second.visualTiming, first.visualTiming);
  assert.equal(second.usageIds.length, 0);
  teardown(c);
});

test('a second content_version gets its own asset/usage rows (no cross-version collapse)', async () => {
  const c = await setup();
  run(c);
  const cv2 = seedContentVersion(c.storage);
  const r2 = run(c, { contentVersionId: cv2 });
  assert.ok(r2.assets.every((a) => !a.reused));
  assert.equal(c.repository.getAssetsForContent(cv2).length, r2.assets.length);
  teardown(c);
});

test('error cases are typed and write nothing', async () => {
  const c = await setup();
  const rasteriser = fakeRasteriser(c.dir);
  const badBible = { ...c.character, voice: { ...c.character.voice, provider: 'x' } };
  const badSb = { ...c.storyboard, beats: [{ ...c.storyboard.beats[0], purpose: '' }] };
  const cases = {
    BIBLE_INVALID: () => run(c, { character: badBible }),
    STORYBOARD_INVALID: () => run(c, { storyboard: badSb }),
    CHARACTER_MISMATCH: () => run(c, { storyboard: { ...c.storyboard, characterId: 'char_other' } }),
    CONTENT_VERSION_NOT_FOUND: () => run(c, { contentVersionId: 'nope' }),
    CONTENT_VERSION_REQUIRED: () => run(c, { contentVersionId: '' }),
    RENDERER_IDENTITY_REQUIRED: () => run(c, { renderer: { name: 'x' } }),
    FRAME_FILES_REQUIRED: () => run(c, { frameFiles: null }),
    REPOSITORY_INVALID: () => run(c, { repository: {} }),
    FRAME_PATH_NOT_ABSOLUTE: () => run(c, { frameFiles: () => 'rel/a.png' }),
    FRAME_NOT_PNG: () => run(c, { frameFiles: (s) => { const f = rasteriser(s).replace('.png', '.jpg'); fs.writeFileSync(f, PNG_SIG); return f; } }),
    FRAME_UNREADABLE: () => run(c, { frameFiles: () => path.join(c.dir, 'missing.png') }),
    FRAME_PATH_INVALID: () => run(c, { frameFiles: () => '' })
  };
  for (const [expected, fn] of Object.entries(cases)) assert.equal(code(fn), expected, expected);
  const bad = path.join(c.dir, 'bad.png'); fs.writeFileSync(bad, Buffer.from('not a png at all'));
  assert.equal(code(() => run(c, { frameFiles: () => bad })), 'FRAME_NOT_PNG');
  assert.equal(count(c, 'assets'), 0);
  assert.equal(count(c, 'asset_usages'), 0);
  teardown(c);
});

test('a frame failing partway through reading writes nothing', async () => {
  const c = await setup();
  const rasteriser = fakeRasteriser(c.dir);
  let n = 0;
  const flaky = (s) => { if (++n === 3) throw new Error('rasteriser crashed'); return rasteriser(s); };
  assert.equal(code(() => run(c, { frameFiles: flaky })), 'OTHER:rasteriser crashed');
  assert.equal(count(c, 'assets'), 0);
  teardown(c);
});

test('write phase is atomic: a repository failure mid-way rolls back every row', async () => {
  const c = await setup();
  let calls = 0;
  const orig = c.repository.recordUsage.bind(c.repository);
  c.repository.recordUsage = (a) => { if (++calls === 2) throw new Error('disk full'); return orig(a); };
  assert.equal(code(() => run(c)), 'OTHER:disk full');
  assert.equal(count(c, 'assets'), 0);
  assert.equal(count(c, 'asset_usages'), 0);
  teardown(c);
});

test('does not alter schema, migrations or unrelated tables, and imports no rendering library', async () => {
  const c = await setup();
  const schema = () => c.storage.all(`SELECT name, sql FROM sqlite_master ORDER BY name`);
  const before = { schema: schema(), mig: count(c, 'schema_migrations'), src: count(c, 'sources'), prod: count(c, 'productions'), pubs: count(c, 'publications'), cv: c.storage.get('SELECT state FROM content_versions WHERE id = ?', [c.cvId]).state };
  run(c);
  assert.deepEqual(schema(), before.schema);
  assert.equal(count(c, 'schema_migrations'), before.mig);
  assert.equal(count(c, 'sources'), before.src);
  assert.equal(count(c, 'productions'), before.prod);
  assert.equal(count(c, 'publications'), before.pubs);
  assert.equal(c.storage.get('SELECT state FROM content_versions WHERE id = ?', [c.cvId]).state, before.cv);
  const src = fs.readFileSync(new URL('../../src/studio/frameAssets.js', import.meta.url), 'utf8');
  assert.ok(!/from ['"](sharp|@napi-rs\/canvas|canvas)['"]/.test(src));
  teardown(c);
});
