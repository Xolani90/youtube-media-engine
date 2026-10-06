import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { SqliteStorageDriver } from '../../src/storage/SqliteStorageDriver.js';
import { runProduction } from '../../src/production/pipeline.js';
import { runMediaProduction, runShortFormProduction } from '../../src/media/pipeline.js';
import { runPublication } from '../../src/publication/pipeline.js';
import { resolveMediaForPublication } from '../../src/publication/eligibility.js';
import { PublicationProvider } from '../../src/publication/PublicationProvider.js';
import { PUBLICATION_RESULT_STATUS } from '../../src/publication/constants.js';
import { AssetProvenanceRepository } from '../../src/state/AssetProvenance.js';
import { selectEligibleFinalCompliance, selectEligiblePublications } from '../../src/autonomous/workSelection.js';
import { config } from '../../src/config/index.js';
import { passGate2, recordVerification } from '../helpers/gate2.js';
import { checkPersistedStateIntegrity } from '../../scripts/check-persisted-state-integrity.js';

/**
 * Two-invocation regression for the unattended-runner persistence boundary.
 *
 * Models what .github/workflows/scheduled-run.yml does between two GitHub-hosted
 * runners, WITHOUT GitHub: Invocation 1 renders real media into a workspace and
 * "saves" (WAL checkpoint + copy of the exact three cached paths); the workspace
 * is then destroyed; Invocation 2 recreates it, "restores" to the SAME absolute
 * paths (actions/cache restores absolute paths, and the runner workspace path is
 * identical across runs of one repository) and proves the persisted item is
 * still usable by the next stages. No real YouTube upload: the adapter is a mock.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CHECK_SCRIPT = path.join(REPO_ROOT, 'scripts', 'check-persisted-state-integrity.js');
const nowISO = () => new Date().toISOString();

// ---- workspace layout, mirroring the workflow's SQLITE_PATH / MEDIA_ARTIFACTS_DIR / ASSET_DOWNLOAD_DIR ----

function layout(root) {
  const work = path.join(root, 'work');
  return {
    work,
    db: path.join(work, 'data', 'media-engine.db'),
    media: path.join(work, 'data', 'media_artifacts'),
    assets: path.join(work, 'data', 'asset_downloads'),
    manifests: path.join(work, 'data', 'artifacts') // NOT persisted (no later stage reads it)
  };
}

function prepareDirs(l) {
  // == the workflow's "Prepare run-state directories" step
  fs.mkdirSync(path.dirname(l.db), { recursive: true });
  fs.mkdirSync(l.media, { recursive: true });
  fs.mkdirSync(l.assets, { recursive: true });
}

/** == the workflow's WAL checkpoint step followed by cache save of exactly SQLITE_PATH + MEDIA + ASSETS. */
function saveRunState(l, cacheDir) {
  const db = new Database(l.db, { fileMustExist: true });
  try {
    const [r] = db.pragma('wal_checkpoint(TRUNCATE)');
    assert.equal(r.busy, 0, 'WAL checkpoint must complete before saving');
  } finally {
    db.close();
  }
  fs.rmSync(cacheDir, { recursive: true, force: true });
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.copyFileSync(l.db, path.join(cacheDir, 'db'));
  fs.cpSync(l.media, path.join(cacheDir, 'media'), { recursive: true });
  fs.cpSync(l.assets, path.join(cacheDir, 'assets'), { recursive: true });
}

/** == a fresh runner: nothing from the old workspace survives; only the cache entry is restored. */
function freshRunnerRestore(root, l, cacheDir, { restoreFiles = true } = {}) {
  fs.rmSync(l.work, { recursive: true, force: true });
  prepareDirs(l);
  fs.copyFileSync(path.join(cacheDir, 'db'), l.db);
  if (restoreFiles) {
    fs.cpSync(path.join(cacheDir, 'media'), l.media, { recursive: true });
    fs.cpSync(path.join(cacheDir, 'assets'), l.assets, { recursive: true });
  }
}

// ---- seeding / rendering (real production + FFmpeg path; same helpers pattern as the e2e media tests) ----

function makeFixtureImage(dir, name, color) {
  const location = path.join(dir, name);
  execFileSync('ffmpeg', ['-f', 'lavfi', '-i', `color=c=${color}:s=64x64:d=1`, '-frames:v', '1', '-y', location], {
    stdio: ['ignore', 'pipe', 'pipe']
  });
  return location;
}

function seedContentVersion(storage, body = 'This is a short narration script for the persistence boundary test.') {
  const opportunityId = crypto.randomUUID();
  storage.run(
    `INSERT INTO opportunities (id, title, source, discovered_at, status) VALUES (?, 'Persistence opportunity', 'rss', ?, 'DISCOVERED')`,
    [opportunityId, nowISO()]
  );
  const contentBriefId = crypto.randomUUID();
  storage.run(
    `INSERT INTO content_briefs
      (id, opportunity_id, working_title, core_question, target_audience, viewer_promise,
       hook, angle, narrative_structure, key_claims, counterpoints, original_insights, visual_ideas,
       monetization_opportunities, risk_assessment, created_at)
     VALUES (?, ?, 'Persistence Title', 'Q', 'A', 'A concise promise', 'H', 'Angle', 'Structure', '[]', 'C', 'I', 'V', 'M', 'R', ?)`,
    [contentBriefId, opportunityId, nowISO()]
  );
  const scriptId = crypto.randomUUID();
  storage.run(`INSERT INTO scripts (id, content_brief_id, version, body, claim_links, created_at) VALUES (?, ?, 1, ?, '[]', ?)`, [
    scriptId, contentBriefId, body, nowISO()
  ]);
  const contentVersionId = crypto.randomUUID();
  storage.run(
    `INSERT INTO content_versions (id, content_brief_id, script_id, state, created_at) VALUES (?, ?, ?, 'PRODUCTION_READY', ?)`,
    [contentVersionId, contentBriefId, scriptId, nowISO()]
  );
  return { contentBriefId, contentVersionId };
}

function seedVisualAsset(storage, contentVersionId, location, verificationStatus = 'VERIFIED') {
  const repo = new AssetProvenanceRepository(storage);
  const assetId = repo.recordAsset({ assetType: 'image', location, verificationStatus });
  repo.recordUsage({ assetId, contentVersionId, usageContext: 'b-roll' });
  return assetId;
}

/**
 * INVOCATION 1: fresh workspace and database -> real Production, Media (long-form
 * + short-form), rights verification records and a real Gate 2 PASS -> state saved.
 */
async function invocation1(l, cacheDir) {
  prepareDirs(l);
  const storage = new SqliteStorageDriver({ dbPath: l.db });
  await storage.migrate();
  const { contentBriefId, contentVersionId } = seedContentVersion(storage);
  const assetA = seedVisualAsset(storage, contentVersionId, makeFixtureImage(l.assets, 'a.png', 'blue'));
  const assetB = seedVisualAsset(storage, contentVersionId, makeFixtureImage(l.assets, 'b.png', 'red'));

  assert.equal(runProduction({ storage, contentBriefId, artifactsDir: l.manifests }).outcome, 'PRODUCED');
  const longForm = runMediaProduction({ storage, contentBriefId, artifactsDir: l.media });
  assert.equal(longForm.outcome, 'RENDERED');
  const shortForm = runShortFormProduction({ storage, contentBriefId, artifactsDir: l.media });
  assert.equal(shortForm.outcome, 'RENDERED');
  recordVerification(storage, assetA, 'VERIFIED');
  recordVerification(storage, assetB, 'VERIFIED');
  passGate2(storage, contentVersionId);
  assert.equal(storage.get('SELECT state FROM content_versions WHERE id = ?', [contentVersionId]).state, 'FINAL_COMPLIANCE');

  const persisted = {
    contentBriefId,
    contentVersionId,
    longFormPath: longForm.mediaArtifact.artifact_path,
    shortFormPath: shortForm.mediaArtifact.artifact_path,
    narrationPath: longForm.mediaArtifact.narration_path,
    longFormBytes: fs.statSync(longForm.mediaArtifact.artifact_path).size,
    shortFormBytes: fs.statSync(shortForm.mediaArtifact.artifact_path).size,
    narrationBytes: fs.statSync(longForm.mediaArtifact.narration_path).size
  };
  storage.close();
  saveRunState(l, cacheDir);
  return persisted;
}

function ffprobeStreams(file) {
  return JSON.parse(
    execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', file], { stdio: ['ignore', 'pipe', 'pipe'] }).toString()
  ).streams;
}

class MockShorts extends PublicationProvider {
  constructor() {
    super();
    this.calls = [];
  }
  get id() {
    return 'youtube_shorts';
  }
  async publish(request) {
    this.calls.push(request);
    return { status: PUBLICATION_RESULT_STATUS.SUCCESS, provider: 'youtube_shorts', providerItemId: 'MOCK_SHORT_ID', providerUrl: 'https://example.invalid/MOCK_SHORT_ID' };
  }
}

/** Temp per-item authorization fixture + LIVE for the duration of fn (the same mechanism the existing publication tests use). The repo's own authorization file is never touched. */
async function withLiveAuthorized(actions, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'persist-auth-'));
  const filePath = path.join(dir, 'authorized.json');
  fs.writeFileSync(filePath, JSON.stringify(actions));
  const saved = { p: config.authorizedExternalActionsPath, m: config.runMode, a: config.autonomousEnabled };
  config.authorizedExternalActionsPath = filePath;
  config.runMode = 'LIVE';
  config.autonomousEnabled = true;
  try {
    return await fn();
  } finally {
    config.authorizedExternalActionsPath = saved.p;
    config.runMode = saved.m;
    config.autonomousEnabled = saved.a;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function cli(args) {
  return spawnSync(process.execPath, [CHECK_SCRIPT, ...args], { encoding: 'utf8' });
}

// ---- one real render, shared by the scenarios below (each restores a pristine copy before mutating) ----

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'persist-state-'));
const cacheDir = path.join(root, 'cache');
const L = layout(root);
let P; // persisted facts from invocation 1

test.before(async () => {
  P = await invocation1(L, cacheDir);
});

test.after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function restorePristine(opts) {
  freshRunnerRestore(root, L, cacheDir, opts);
}

// ---- THE KEY ASSERTION: Run 1 render -> persistence boundary -> fresh Run 2 -> same artifact available ----

test('two invocations: rendered artifact survives a fresh runner; next stages select it and publication does NOT hit ARTIFACT_MISSING', async () => {
  // The old workspace is really gone before anything is restored.
  fs.rmSync(L.work, { recursive: true, force: true });
  assert.equal(fs.existsSync(P.longFormPath), false, 'precondition: the original files are gone (fresh runner)');
  assert.equal(fs.existsSync(L.db), false);

  restorePristine();

  const report = checkPersistedStateIntegrity({ dbPath: L.db });
  assert.deepEqual(report.violations, []);
  assert.equal(report.ok, true);
  assert.ok(report.counts.mediaArtifacts === 1 && report.counts.shortFormArtifacts === 1);

  const storage = new SqliteStorageDriver({ dbPath: L.db });
  await storage.migrate();
  try {
    // Persisted item is selectable by the next-stage selectors.
    assert.deepEqual(selectEligibleFinalCompliance(storage), [{ contentBriefId: P.contentBriefId }]);
    assert.deepEqual(selectEligiblePublications(storage, 'youtube_shorts'), [{ contentBriefId: P.contentBriefId }]);

    // The artifact exists at the SAME persisted path, byte-for-byte sized, and ffprobe succeeds.
    const media = storage.get('SELECT * FROM media_artifacts WHERE content_version_id = ?', [P.contentVersionId]);
    const short = storage.get('SELECT * FROM short_form_media_artifacts WHERE content_version_id = ?', [P.contentVersionId]);
    assert.equal(media.artifact_path, P.longFormPath);
    assert.equal(short.artifact_path, P.shortFormPath);
    assert.equal(fs.statSync(P.longFormPath).size, P.longFormBytes);
    assert.equal(fs.statSync(P.shortFormPath).size, P.shortFormBytes);
    assert.equal(fs.statSync(P.narrationPath).size, P.narrationBytes);
    assert.ok(ffprobeStreams(P.longFormPath).some((s) => s.codec_type === 'video'));
    const shortVideo = ffprobeStreams(P.shortFormPath).find((s) => s.codec_type === 'video');
    assert.equal(shortVideo.width, 1080);
    assert.equal(shortVideo.height, 1920);

    // Publication-time media eligibility resolves the short-form file.
    const eligibility = resolveMediaForPublication(storage, P.contentBriefId, { target: 'SHORT_FORM' });
    assert.equal(eligibility.eligible, true);
    assert.equal(eligibility.mediaArtifact.artifact_path, P.shortFormPath);

    // Real publication path (Gate 2 re-hashes the restored file; media-existence check passes) -- mock adapter, no network.
    const adapter = new MockShorts();
    const result = await withLiveAuthorized([`publish:youtube_shorts:${P.contentVersionId}`], () =>
      runPublication({ storage, contentBriefId: P.contentBriefId, provider: 'youtube_shorts', adapter })
    );
    assert.notEqual(result.outcome, 'ARTIFACT_MISSING');
    assert.equal(result.outcome, 'PUBLISHED');
    assert.equal(adapter.calls.length, 1);
    assert.equal(adapter.calls[0].mediaFilePath, P.shortFormPath);
    assert.ok(fs.existsSync(adapter.calls[0].mediaFilePath));
  } finally {
    storage.close();
  }
});

test('CONTROL (the original defect): restoring ONLY the SQLite file -> integrity check flags it and publication reports ARTIFACT_MISSING', async () => {
  restorePristine({ restoreFiles: false });

  const report = checkPersistedStateIntegrity({ dbPath: L.db });
  assert.equal(report.ok, false);
  const codes = report.violations.map((v) => v.code).sort();
  assert.ok(codes.includes('MEDIA_FILE_MISSING'), codes.join(','));
  assert.ok(codes.includes('SHORT_FORM_FILE_MISSING'), codes.join(','));

  const storage = new SqliteStorageDriver({ dbPath: L.db });
  await storage.migrate();
  try {
    const adapter = new MockShorts();
    const result = await runPublication({ storage, contentBriefId: P.contentBriefId, provider: 'youtube_shorts', adapter });
    assert.equal(result.outcome, 'ARTIFACT_MISSING');
    assert.equal(adapter.calls.length, 0);
  } finally {
    storage.close();
  }
});

// ---- negative cases: SQLite says the artifact exists, the filesystem disagrees ----

test('negative: media_artifacts row exists but the file is missing -> detected (library + CLI exit 1), never re-rendered or fabricated', async () => {
  restorePristine();
  fs.rmSync(P.longFormPath);

  const report = checkPersistedStateIntegrity({ dbPath: L.db });
  assert.equal(report.ok, false);
  const v = report.violations.find((x) => x.code === 'MEDIA_FILE_MISSING');
  assert.ok(v, JSON.stringify(report.violations));
  assert.equal(v.path, P.longFormPath);

  const run = cli(['--db', L.db]);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /VIOLATION MEDIA_FILE_MISSING/);
  assert.match(run.stderr, /FAILED/);

  // --report-only never fails the step.
  assert.equal(cli(['--db', L.db, '--report-only']).status, 0);

  // The check is read-only: the file is still absent and the row untouched.
  assert.equal(fs.existsSync(P.longFormPath), false);
  const db = new Database(L.db, { readonly: true });
  try {
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM media_artifacts').get().n, 1);
  } finally {
    db.close();
  }
});

test('negative: zero-byte artifact and checksum-mismatching (truncated) artifact are divergences', () => {
  restorePristine();
  fs.writeFileSync(P.longFormPath, '');
  let report = checkPersistedStateIntegrity({ dbPath: L.db });
  assert.ok(report.violations.some((x) => x.code === 'MEDIA_FILE_EMPTY'), JSON.stringify(report.violations));

  restorePristine();
  fs.truncateSync(P.shortFormPath, Math.floor(P.shortFormBytes / 2));
  report = checkPersistedStateIntegrity({ dbPath: L.db });
  assert.ok(report.violations.some((x) => x.code === 'SHORT_FORM_CHECKSUM_MISMATCH'), JSON.stringify(report.violations));
});

// ---- what must NOT fail (scope of "required") ----

test('not required: missing thumbnail (regenerated at publication), deleted assets of an already-rendered item, and unpersisted production manifests are fine', () => {
  restorePristine();
  // Assets of an item that already rendered are no longer read by any stage.
  fs.rmSync(L.assets, { recursive: true, force: true });
  fs.mkdirSync(L.assets, { recursive: true });
  // Production manifests (data/artifacts) were never in the cache and are absent on the fresh runner.
  assert.equal(fs.existsSync(L.manifests), false);
  let report = checkPersistedStateIntegrity({ dbPath: L.db });
  assert.deepEqual(report.violations, []);

  // A recorded thumbnail whose file is gone is only a warning (ensureThumbnailArtifact regenerates it).
  const db = new Database(L.db);
  try {
    db.prepare('UPDATE media_artifacts SET thumbnail_path = ?').run(path.join(L.media, 'gone-thumbnail.png'));
  } finally {
    db.close();
  }
  report = checkPersistedStateIntegrity({ dbPath: L.db });
  assert.deepEqual(report.violations, []);
  assert.deepEqual(report.warnings.map((w) => w.code), ['THUMBNAIL_FILE_NOT_OK']);
  assert.equal(cli(['--db', L.db]).status, 0);
});

test('narration is required only until the short-form derivative exists', async () => {
  restorePristine();
  fs.rmSync(P.narrationPath);
  // short-form row exists -> narration no longer needed
  assert.deepEqual(checkPersistedStateIntegrity({ dbPath: L.db }).violations, []);

  // Without the short-form row the narration IS the source of a future render.
  const db = new Database(L.db);
  try {
    db.prepare('DELETE FROM short_form_media_artifacts').run();
  } finally {
    db.close();
  }
  const report = checkPersistedStateIntegrity({ dbPath: L.db });
  assert.ok(report.violations.some((x) => x.code === 'NARRATION_FILE_MISSING'), JSON.stringify(report.violations));
});

test('assets of a PRODUCED item with no media artifact yet must be restorable; DISPUTED assets and URIs are ignored', async () => {
  restorePristine();
  const storage = new SqliteStorageDriver({ dbPath: L.db });
  await storage.migrate();
  try {
    const { contentVersionId } = seedContentVersion(storage, 'Second item, not rendered yet.');
    storage.run(`UPDATE content_versions SET state = 'PRODUCED' WHERE id = ?`, [contentVersionId]);
    const present = makeFixtureImage(L.assets, 'pending-ok.png', 'green');
    seedVisualAsset(storage, contentVersionId, present);
    assert.deepEqual(checkPersistedStateIntegrity({ dbPath: L.db }).violations, []);

    const gone = path.join(L.assets, 'pending-gone.png');
    seedVisualAsset(storage, contentVersionId, gone); // row points at a file that was never restored
    seedVisualAsset(storage, contentVersionId, path.join(L.assets, 'disputed-gone.png'), 'DISPUTED');
    seedVisualAsset(storage, contentVersionId, 'https://example.invalid/remote.png');
    const report = checkPersistedStateIntegrity({ dbPath: L.db });
    assert.equal(report.violations.length, 1, JSON.stringify(report.violations));
    assert.equal(report.violations[0].code, 'ASSET_FILE_MISSING');
    assert.equal(report.violations[0].path, gone);
  } finally {
    storage.close();
  }
});

test('a run that produced nothing is healthy: empty migrated DB, missing directories -> OK (exit 0); missing DB -> exit 2', async () => {
  const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'persist-empty-'));
  try {
    const dbPath = path.join(emptyRoot, 'media-engine.db');
    const storage = new SqliteStorageDriver({ dbPath });
    await storage.migrate();
    storage.close();
    const report = checkPersistedStateIntegrity({ dbPath });
    assert.equal(report.ok, true);
    assert.equal(report.counts.filesChecked, 0);
    const ok = cli(['--db', dbPath]);
    assert.equal(ok.status, 0);
    assert.match(ok.stdout, /OK: persisted database state and filesystem artifacts agree/);

    const missing = cli(['--db', path.join(emptyRoot, 'nope.db')]);
    assert.equal(missing.status, 2);
    assert.equal(cli(['--db', path.join(emptyRoot, 'nope.db'), '--report-only']).status, 0);
  } finally {
    fs.rmSync(emptyRoot, { recursive: true, force: true });
  }
});

// ---- the workflow itself: static guard rails on the persistence boundary and the safe operating mode ----

test('workflow: one cache boundary for DB + media + assets, save gated on checkpoint AND integrity, safe mode and guards unchanged', () => {
  const yml = fs.readFileSync(path.join(REPO_ROOT, '.github', 'workflows', 'scheduled-run.yml'), 'utf8');

  // Safe operating mode is untouched.
  assert.match(yml, /RUN_MODE: SIMULATION/);
  assert.match(yml, /AUTONOMOUS_ENABLED: 'false'/);
  assert.doesNotMatch(yml, /RUN_MODE: LIVE/);
  assert.match(yml, /concurrency:\s*\n\s*group: autonomous-scheduled-run\s*\n\s*cancel-in-progress: false/);

  // Existing key strategy preserved.
  assert.match(yml, /key: media-engine-sqlite-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/);
  assert.match(yml, /restore-keys: \|\s*\n\s*media-engine-sqlite-\s*\n/);

  // The same three paths are restored and saved.
  const pathBlocks = [...yml.matchAll(/path: \|\n((?:\s+\$\{\{ env\.\w+ \}\}\n)+)/g)].map((m) => m[1].trim().split(/\s*\n\s*/));
  assert.equal(pathBlocks.length, 2, 'restore and save each declare a multi-path block');
  const expected = ['${{ env.SQLITE_PATH }}', '${{ env.MEDIA_ARTIFACTS_DIR }}', '${{ env.ASSET_DOWNLOAD_DIR }}'];
  assert.deepEqual(pathBlocks[0], expected);
  assert.deepEqual(pathBlocks[1], expected);

  // Nothing sensitive/bulky is cached.
  for (const bad of ['.env', 'node_modules', '*.log', 'secrets.']) {
    for (const block of pathBlocks) assert.ok(!block.join('\n').includes(bad), `${bad} must not be cached`);
  }

  // WAL checkpoint + always() semantics preserved; save requires checkpoint AND integrity.
  assert.match(yml, /wal_checkpoint\(TRUNCATE\)/);
  assert.match(
    yml,
    /if: always\(\) && steps\.sqlite_checkpoint\.outputs\.saveable == 'true' && steps\.state_integrity\.outputs\.consistent == 'true'/
  );
  assert.match(yml, /id: state_integrity\n\s+if: always\(\) && steps\.sqlite_checkpoint\.outputs\.saveable == 'true'/);
  assert.match(yml, /node scripts\/check-persisted-state-integrity\.js\n/);

  // Application exit-code handling preserved.
  assert.match(yml, /Exit code 3 \(ADR-0024 refusal\) and 0 are treated as success/);
  assert.match(yml, /exit "\$code"/);

  // Authorization file is still empty.
  assert.equal(fs.readFileSync(path.join(REPO_ROOT, 'config', 'authorized_external_actions.json'), 'utf8').trim(), '[]');
});
