import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
const fileURLToPathSelf = fileURLToPath(import.meta.url);
import { SqliteStorageDriver } from '../../src/storage/SqliteStorageDriver.js';
import { runProduction } from '../../src/production/pipeline.js';
import { runMediaProduction } from '../../src/media/pipeline.js';
import { AssetProvenanceRepository } from '../../src/state/AssetProvenance.js';
import { sha256File } from '../../src/media/artifactStore.js';

function freshStorage() {
  const dbPath = path.join(os.tmpdir(), `media-e2e-${Date.now()}-${Math.random()}.db`);
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
     VALUES (?, ?, 'T', 'Q', 'A', 'P', 'H', 'Angle', 'Structure', '[]', 'C', 'I', 'V', 'M', 'R', ?)`,
    [id, opportunityId, nowISO()]
  );
  return id;
}

function seedContentVersion(storage, { state = 'PRODUCTION_READY', body = 'This is a short narration script for the test video.' } = {}) {
  const { opportunityId } = seedResearchProject(storage);
  const contentBriefId = seedBrief(storage, opportunityId);
  const scriptId = crypto.randomUUID();
  storage.run(
    `INSERT INTO scripts (id, content_brief_id, version, body, claim_links, created_at)
     VALUES (?, ?, 1, ?, '[]', ?)`,
    [scriptId, contentBriefId, body, nowISO()]
  );
  const contentVersionId = crypto.randomUUID();
  storage.run(
    `INSERT INTO content_versions (id, content_brief_id, script_id, state, created_at) VALUES (?, ?, ?, ?, ?)`,
    [contentVersionId, contentBriefId, scriptId, state, nowISO()]
  );
  return { contentBriefId, scriptId, contentVersionId };
}

/** Creates a real on-disk PNG fixture (via FFmpeg) so the renderer has actual visual asset files to consume, not just DB rows. */
function makeFixtureImage(dir, name, color) {
  const location = path.join(dir, name);
  execFileSync('ffmpeg', ['-f', 'lavfi', '-i', `color=c=${color}:s=64x64:d=1`, '-frames:v', '1', '-y', location], {
    stdio: ['ignore', 'pipe', 'pipe']
  });
  return location;
}

function seedVisualAsset(storage, contentVersionId, location, verificationStatus = 'VERIFIED') {
  const repo = new AssetProvenanceRepository(storage);
  const assetId = repo.recordAsset({ assetType: 'image', location, verificationStatus });
  repo.recordUsage({ assetId, contentVersionId, usageContext: 'b-roll' });
  return assetId;
}


// --- ASR (whisper.cpp) wiring in Media Production ---------------------
// Real narration (espeak-ng) is required by these tests, exactly as the
// existing media e2e tests require it. The whisper.cpp executable here is a
// stand-in used ONLY to exercise the pipeline wiring; it is not an
// acceptance proof (see scripts/prove-asr-whisper-cpp.js for that).

const hasEspeak = spawnSync('espeak-ng', ['--version']).status === 0;
const skip = !hasEspeak && 'espeak-ng not installed';
// The success test uses a #!/bin/sh stand-in for the whisper.cpp CLI, which Windows cannot execute.
const posixSkip = process.platform === 'win32' && 'requires a POSIX shell for the whisper.cpp stand-in';

function makeStandInWhisper(dir) {
  const bin = path.join(dir, 'stand-in-whisper');
  const json = JSON.stringify({ result: { language: 'en' }, transcription: [{ offsets: { from: 0, to: 1000 }, text: ' Stand in.' }] });
  fs.writeFileSync(bin, `#!/bin/sh\nPREFIX=""\nwhile [ $# -gt 0 ]; do if [ "$1" = "-of" ]; then PREFIX="$2"; fi; shift; done\nprintf '%s' '${json}' > "$PREFIX.json"\n`, { mode: 0o755 });
  const model = path.join(dir, 'ggml-stand-in.bin');
  fs.writeFileSync(model, 'm');
  return { bin, model };
}

async function setup() {
  const { storage, dbPath } = freshStorage();
  const productionArtifactsDir = freshDir('asr-prod');
  const mediaArtifactsDir = freshDir('asr-media');
  const assetsDir = freshDir('asr-assets');
  await storage.migrate();
  const { contentBriefId, contentVersionId } = seedContentVersion(storage);
  seedVisualAsset(storage, contentVersionId, makeFixtureImage(assetsDir, 'a.png', 'blue'));
  assert.equal(runProduction({ storage, contentBriefId, artifactsDir: productionArtifactsDir }).outcome, 'PRODUCED');
  return { storage, dbPath, contentBriefId, contentVersionId, mediaArtifactsDir, dirs: [productionArtifactsDir, mediaArtifactsDir, assetsDir] };
}

function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  try { return fn(); } finally { for (const k of Object.keys(vars)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
}

test('ASR disabled (default): result shape unchanged, no transcript artifact', { skip }, async () => {
  const s = await setup();
  try {
    const r = withEnv({ ASR_PROVIDER: undefined }, () => runMediaProduction({ storage: s.storage, contentBriefId: s.contentBriefId, artifactsDir: s.mediaArtifactsDir }));
    assert.equal(r.outcome, 'RENDERED');
    assert.equal('asr' in r, false);
    assert.equal(fs.existsSync(path.join(s.mediaArtifactsDir, s.contentVersionId, 'transcript.json')), false);
  } finally { cleanup(s.storage, s.dbPath, ...s.dirs); }
});

test('ASR success: timestamps exposed + transcript artifact + provenance; caption timing stays text-estimated; render intact', { skip: skip || posixSkip }, async () => {
  const s = await setup();
  const w = freshDir('asr-whisper');
  try {
    const stand = makeStandInWhisper(w);
    const r = withEnv({ ASR_PROVIDER: 'whisper.cpp', WHISPER_CPP_BIN: stand.bin, WHISPER_CPP_MODEL: stand.model },
      () => runMediaProduction({ storage: s.storage, contentBriefId: s.contentBriefId, artifactsDir: s.mediaArtifactsDir }));
    assert.equal(r.outcome, 'RENDERED');
    assert.ok(fs.existsSync(r.mediaArtifact.artifact_path), 'video still rendered');
    assert.equal(r.asr.status, 'TIMESTAMPS_RECORDED');
    assert.equal(r.asr.provider, 'whisper.cpp');
    assert.equal(r.asr.timestampsSource, 'asr');
    assert.equal(r.asr.captionTimingSource, 'text-estimated');
    assert.ok(r.asr.segments.length > 0);
    assert.equal(sha256File(r.asr.transcriptPath), r.asr.transcriptChecksum);
    const t = JSON.parse(fs.readFileSync(r.asr.transcriptPath, 'utf8'));
    assert.equal(t.input_audio.sha256, sha256File(r.mediaArtifact.narration_path));
    const row = s.storage.get("SELECT reason FROM decision_log WHERE decision = 'ASR_TIMESTAMPS_RECORDED'");
    assert.ok(row.reason.includes(r.asr.transcriptChecksum));
    // render spec is unchanged in shape: captions remain the existing text-derived timing
    assert.ok(Array.isArray(JSON.parse(r.mediaArtifact.render_spec_json).captions));
  } finally { cleanup(s.storage, s.dbPath, ...s.dirs, w); }
});

test('ASR failure: controlled, recorded, never labelled as ASR; text-estimated timing + render still work', { skip }, async () => {
  const s = await setup();
  try {
    const r = withEnv({ ASR_PROVIDER: 'whisper.cpp', WHISPER_CPP_BIN: '/nonexistent/whisper-cli', WHISPER_CPP_MODEL: fileURLToPathSelf },
      () => runMediaProduction({ storage: s.storage, contentBriefId: s.contentBriefId, artifactsDir: s.mediaArtifactsDir }));
    assert.equal(r.outcome, 'RENDERED');
    assert.equal(r.asr.status, 'FAILED');
    assert.equal(r.asr.reason, 'ASR_EXECUTABLE_UNAVAILABLE');
    assert.equal(r.asr.timestampsSource, null);
    assert.equal(r.asr.captionTimingSource, 'text-estimated');
    assert.equal('segments' in r.asr, false);
    assert.equal(fs.existsSync(path.join(s.mediaArtifactsDir, s.contentVersionId, 'transcript.json')), false);
    assert.ok(s.storage.get("SELECT id FROM decision_log WHERE decision = 'ASR_FAILED'"));
    assert.equal(s.storage.get("SELECT id FROM decision_log WHERE decision = 'ASR_TIMESTAMPS_RECORDED'"), undefined);
  } finally { cleanup(s.storage, s.dbPath, ...s.dirs); }
});


// --- Caption worker: ASR timestamps drive captions (with safe fallback) ---

function makeScriptedWhisper(dir, segments) {
  const bin = path.join(dir, 'scripted-whisper');
  const json = JSON.stringify({ result: { language: 'en' }, transcription: segments.map((g) => ({ offsets: { from: g.from, to: g.to }, text: ` ${g.text}` })) });
  fs.writeFileSync(bin, `#!/bin/sh\nPREFIX=""\nwhile [ $# -gt 0 ]; do if [ "$1" = "-of" ]; then PREFIX="$2"; fi; shift; done\nprintf '%s' '${json}' > "$PREFIX.json"\n`, { mode: 0o755 });
  const model = path.join(dir, 'ggml-stand-in.bin');
  fs.writeFileSync(model, 'm');
  return { bin, model };
}

test('Captions: corresponding ASR segments become the real caption timing, consumed by render spec', { skip: skip || posixSkip }, async () => {
  const s = await setup();
  const w = freshDir('asr-caps');
  try {
    // Script body: "This is a short narration script for the test video."
    const stand = makeScriptedWhisper(w, [{ from: 300, to: 1500, text: 'This is a short narration' }, { from: 1700, to: 2500, text: 'script for the test video.' }]);
    const r = withEnv({ ASR_PROVIDER: 'whisper.cpp', WHISPER_CPP_BIN: stand.bin, WHISPER_CPP_MODEL: stand.model },
      () => runMediaProduction({ storage: s.storage, contentBriefId: s.contentBriefId, artifactsDir: s.mediaArtifactsDir }));
    assert.equal(r.outcome, 'RENDERED');
    assert.equal(r.asr.captionTimingSource, 'asr');
    const caps = JSON.parse(r.mediaArtifact.render_spec_json).captions;
    assert.deepEqual(caps.map((c) => [c.text, c.start_seconds, c.duration_seconds]),
      [['This is a short narration', 0.3, 1.2], ['script for the test video.', 1.7, 0.8]]);
    assert.equal(caps.map((c) => c.text).join(' '), 'This is a short narration script for the test video.');
    assert.ok(s.storage.get("SELECT id FROM decision_log WHERE decision = 'CAPTIONS_FROM_ASR'"));
    assert.ok(fs.existsSync(r.mediaArtifact.artifact_path), 'video rendered with ASR-timed captions');
  } finally { cleanup(s.storage, s.dbPath, ...s.dirs, w); }
});

test('Captions: ASR transcript that does not match the narration falls back to text-estimated timing', { skip: skip || posixSkip }, async () => {
  const s = await setup();
  const w = freshDir('asr-caps-mismatch');
  try {
    const stand = makeScriptedWhisper(w, [{ from: 0, to: 1000, text: 'Stand in.' }]);
    const r = withEnv({ ASR_PROVIDER: 'whisper.cpp', WHISPER_CPP_BIN: stand.bin, WHISPER_CPP_MODEL: stand.model },
      () => runMediaProduction({ storage: s.storage, contentBriefId: s.contentBriefId, artifactsDir: s.mediaArtifactsDir }));
    assert.equal(r.outcome, 'RENDERED');
    assert.equal(r.asr.status, 'TIMESTAMPS_RECORDED');
    assert.equal(r.asr.captionTimingSource, 'text-estimated');
    assert.equal(r.asr.captionFallbackReason, 'CAPTION_TEXT_MISMATCH');
    const caps = JSON.parse(r.mediaArtifact.render_spec_json).captions;
    assert.equal(caps[0].start_seconds, 0);
    assert.equal(caps.map((c) => c.text).join(' '), 'This is a short narration script for the test video.');
    assert.ok(s.storage.get("SELECT id FROM decision_log WHERE decision = 'CAPTIONS_ASR_FALLBACK'"));
    assert.equal(s.storage.get("SELECT id FROM decision_log WHERE decision = 'CAPTIONS_FROM_ASR'"), undefined);
  } finally { cleanup(s.storage, s.dbPath, ...s.dirs, w); }
});

test('Captions: ASR disabled (default) -> render spec captions identical to the text-estimated path', { skip }, async () => {
  const s = await setup();
  try {
    const r = withEnv({ ASR_PROVIDER: undefined },
      () => runMediaProduction({ storage: s.storage, contentBriefId: s.contentBriefId, artifactsDir: s.mediaArtifactsDir }));
    assert.equal(r.outcome, 'RENDERED');
    assert.equal(r.asr, undefined);
    const caps = JSON.parse(r.mediaArtifact.render_spec_json).captions;
    const spec = JSON.parse(r.mediaArtifact.render_spec_json);
    assert.equal(caps[0].start_seconds, 0);
    assert.ok(Math.abs(caps.at(-1).start_seconds + caps.at(-1).duration_seconds - spec.narration.duration_seconds) < 0.001, 'gap-free text-estimated timing spans the narration');
    assert.equal(s.storage.get("SELECT id FROM decision_log WHERE decision IN ('CAPTIONS_FROM_ASR','CAPTIONS_ASR_FALLBACK')"), undefined);
  } finally { cleanup(s.storage, s.dbPath, ...s.dirs); }
});
