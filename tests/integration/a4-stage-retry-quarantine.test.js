import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import childProcess, { execFileSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import Database from 'better-sqlite3';
import { SqliteStorageDriver } from '../../src/storage/SqliteStorageDriver.js';
import { LLMRouter } from '../../src/providers/llm/router.js';
import { AssetSourceProvider } from '../../src/providers/asset/AssetSourceProvider.js';
import { AssetProvenanceRepository } from '../../src/state/AssetProvenance.js';
import { createBrief } from '../../src/brief/pipeline.js';
import { createScript } from '../../src/script/pipeline.js';
import { runFactCheck } from '../../src/fact-check/pipeline.js';
import { runOriginalityCheck } from '../../src/originality/pipeline.js';
import { runQualityGate } from '../../src/quality-gate/pipeline.js';
import { runAssetProvisioning } from '../../src/asset-provisioning/pipeline.js';
import { runMediaProduction } from '../../src/media/pipeline.js';
import { runAutonomousOperation } from '../../src/autonomous/runner.js';
import {
  selectEligibleResearch, selectEligibleBriefs, selectEligibleScripts, selectEligibleFactChecks,
  selectEligibleOriginalityChecks, selectEligibleQualityGates, selectEligibleAssetProvisioning,
  selectEligibleMediaProductions, selectEligibleRightsVerification
} from '../../src/autonomous/workSelection.js';
import {
  STAGE_RETRY_CAP, RETRY_STAGE, isQuarantined, recordFailedAttempt, reactivateQuarantined, QuarantineReactivationError,
  FAILURE_NATURE, assessRetryEligibility, recordFailedAttemptIfRetryable
} from '../../src/state/StageRetryPolicy.js';
import briefPolicy from '../../config/brief_policy.json' with { type: 'json' };
import scriptPolicy from '../../config/script_policy.json' with { type: 'json' };

// A4 Slice 2: bounded retry/quarantine wired into the seven authorized A4
// stages (Brief, Script, Fact-check, Originality, Quality Gate, Asset
// Provisioning, Media Production). Stage behaviour is exercised through the
// REAL stage pipelines and the REAL runner wherever practical; only external
// dependencies (LLM router, asset provider, espeak-ng, ffprobe) are stubbed.

const nowISO = () => new Date().toISOString();
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), `a4-${p}-`));

async function withStorage(fn) {
  const dbPath = path.join(os.tmpdir(), `a4-${Date.now()}-${Math.random()}.db`);
  const storage = new SqliteStorageDriver({ dbPath });
  await storage.migrate();
  const dirs = [];
  const mk = (p) => { const d = tmp(p); dirs.push(d); return d; };
  try {
    await fn(storage, mk);
  } finally {
    storage.close();
    for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, ...dirs]) fs.rmSync(p, { recursive: true, force: true });
  }
}

const retryRows = (storage) => storage.all('SELECT * FROM stage_retry_state ORDER BY stage');
const retryRow = (storage, stage, subjectId) =>
  storage.get('SELECT * FROM stage_retry_state WHERE stage = ? AND subject_id = ?', [stage, subjectId]);
const decisions = (storage, subjectId, decision) =>
  storage.all('SELECT * FROM decision_log WHERE subject_id = ? AND decision = ?', [subjectId, decision]);

// ------------------------------------------------------------------ seeding

function seedOpportunity(storage, { proposition = null, status = 'DISCOVERED' } = {}) {
  const id = crypto.randomUUID();
  storage.run(
    `INSERT INTO opportunities (id, title, description, source, discovered_at, status, opportunity_proposition)
     VALUES (?, 'Test opportunity', 'A description', 'rss', ?, ?, ?)`,
    [id, nowISO(), status, proposition]
  );
  return id;
}

function seedResearchProject(storage, { status = 'RESEARCH_COMPLETE' } = {}) {
  const opportunityId = seedOpportunity(storage, {
    proposition: JSON.stringify({ core_question: 'Did the launch cause a measurable increase?' }),
    status: 'HANDED_TO_RESEARCH'
  });
  const researchProjectId = crypto.randomUUID();
  storage.run(
    'INSERT INTO research_projects (id, opportunity_id, status, created_at) VALUES (?, ?, ?, ?)',
    [researchProjectId, opportunityId, status, nowISO()]
  );
  const claimId = crypto.randomUUID();
  storage.run(
    `INSERT INTO claims (id, research_project_id, claim, claim_type, evidence_status, is_load_bearing, created_at)
     VALUES (?, ?, 'Acme reported $1B revenue.', 'FACT', 'VERIFIED', 1, ?)`,
    [claimId, researchProjectId, nowISO()]
  );
  return { researchProjectId, opportunityId, claimId };
}

function garbageRouter(counter = { calls: 0 }) {
  const registry = {
    stub: () => ({
      id: 'stub', isPaid: false,
      async healthCheck() { return true; },
      async complete() {
        counter.calls += 1;
        return { text: 'this is not json', model: 'stub', requestId: null, inputTokens: 1, outputTokens: 1, estimatedCost: 0, isPaid: false };
      }
    })
  };
  return new LLMRouter({ priority: ['stub'], allowPaidProviders: false, registry });
}

function routerReturning(text) {
  const registry = {
    stub: () => ({
      id: 'stub', isPaid: false,
      async healthCheck() { return true; },
      async complete() { return { text, model: 'stub', requestId: null, inputTokens: 1, outputTokens: 1, estimatedCost: 0, isPaid: false }; }
    })
  };
  return new LLMRouter({ priority: ['stub'], allowPaidProviders: false, registry });
}

/** A content_brief + content_version (+ optional script / production) in an arbitrary lifecycle state. */
function seedContent(storage, {
  state, body = 'Body text.', claimLinks = '[]', withScript = true, visualIdeas = 'A quiet forest path',
  production = false, keyClaims = '[]'
} = {}) {
  const opportunityId = seedOpportunity(storage);
  const contentBriefId = crypto.randomUUID();
  storage.run(
    `INSERT INTO content_briefs
      (id, opportunity_id, working_title, core_question, target_audience, viewer_promise,
       hook, angle, narrative_structure, key_claims, counterpoints, original_insights, visual_ideas,
       monetization_opportunities, risk_assessment, created_at)
     VALUES (?, ?, 'T', 'Q', 'A', 'P', 'H', 'Angle', 'Structure', ?, 'C', 'I', ?, 'M', 'R', ?)`,
    [contentBriefId, opportunityId, keyClaims, visualIdeas, nowISO()]
  );
  let scriptId = null;
  if (withScript) {
    scriptId = crypto.randomUUID();
    storage.run(
      'INSERT INTO scripts (id, content_brief_id, version, body, claim_links, created_at) VALUES (?, ?, 1, ?, ?, ?)',
      [scriptId, contentBriefId, body, claimLinks, nowISO()]
    );
  }
  const contentVersionId = crypto.randomUUID();
  storage.run(
    'INSERT INTO content_versions (id, content_brief_id, script_id, state, created_at) VALUES (?, ?, ?, ?, ?)',
    [contentVersionId, contentBriefId, scriptId, state, nowISO()]
  );
  let productionId = null;
  if (production) {
    productionId = crypto.randomUUID();
    storage.run(
      `INSERT INTO productions (id, content_version_id, script_id, artifact_type, artifact_path, artifact_checksum, manifest_json, created_at)
       VALUES (?, ?, ?, 'production_manifest_v1', '/tmp/manifest.json', 'deadbeef', '{}', ?)`,
      [productionId, contentVersionId, scriptId, nowISO()]
    );
  }
  return { contentBriefId, contentVersionId, scriptId, productionId };
}

const structuredBody = JSON.stringify({
  hook: 'Did you know octopuses have three hearts?',
  narrative: 'A short story about cephalopods',
  sections: [{ heading: 'The hearts', content: 'Two pump blood to the gills, one to the body.', claim_ids: ['c1'] }],
  counterpoints: 'Some sources dispute the exact figures.',
  conclusion: 'Nature is strange.',
  call_to_action: null
});

function makeImage(dir, name = 'a.png') {
  const location = path.join(dir, name);
  execFileSync('ffmpeg', ['-f', 'lavfi', '-i', 'color=c=blue:s=64x64:d=1', '-frames:v', '1', '-y', location], { stdio: ['ignore', 'pipe', 'pipe'] });
  return location;
}

function attachAsset(storage, contentVersionId, location, { verificationStatus = 'VERIFIED', checksum = null } = {}) {
  const repo = new AssetProvenanceRepository(storage);
  const assetId = repo.recordAsset({ assetType: 'image', location, verificationStatus, checksum });
  repo.recordUsage({ assetId, contentVersionId, usageContext: 'b-roll' });
  return assetId;
}

// Deliberately bogus probe of the final video: valid duration/codecs, wrong resolution.
const BOGUS_FINAL_VIDEO_PROBE = JSON.stringify({
  format: { duration: '3.0' },
  streams: [
    { codec_type: 'video', codec_name: 'h264', width: 64, height: 64 },
    { codec_type: 'audio', codec_name: 'aac' }
  ]
});

/**
 * Makes ffprobe report BOGUS metadata for the final video only, while every
 * other process (the real ffmpeg render, the narration-duration ffprobe) runs for
 * real. It intercepts child_process.execFileSync in-process instead of putting a
 * '#!/bin/sh' ffprobe on PATH: an extensionless script is not launchable on win32
 * (PATH resolution skips it and finds the real ffprobe, so validation succeeds),
 * and there is no way to author a Windows executable in a test without a
 * compiler. syncBuiltinESMExports() propagates the replacement to src's
 * `import { execFileSync }` live bindings. Same discriminator the old shim used:
 * the final video is the only file named '.video.tmp-*'. Returns the restorer.
 */
function interceptFinalVideoProbe() {
  const original = childProcess.execFileSync;
  childProcess.execFileSync = function execFileSyncWithBogusFinalProbe(file, args, ...rest) {
    if (file === 'ffprobe' && Array.isArray(args) && args.some((a) => String(a).includes('.video.tmp-'))) {
      return Buffer.from(BOGUS_FINAL_VIDEO_PROBE);
    }
    return original.call(this, file, args, ...rest);
  };
  syncBuiltinESMExports();
  return () => { childProcess.execFileSync = original; syncBuiltinESMExports(); };
}

/** Shims for external binaries. espeak: 'ok' (3s sine wav) | 'fail'. ffprobeBogus: wrong-resolution probe for the final video only (in-process, see interceptFinalVideoProbe). */
function installShims({ espeak = 'ok', ffprobeBogus = false } = {}) {
  const binDir = tmp('bin');
  fs.writeFileSync(path.join(binDir, 'espeak-ng'), espeak === 'fail'
    ? '#!/bin/sh\necho "espeak stand-in failure" >&2\nexit 1\n'
    : '#!/bin/sh\nffmpeg -loglevel error -f lavfi -i "sine=frequency=440:duration=3" -f wav -y "$2"\n');
  fs.chmodSync(path.join(binDir, 'espeak-ng'), 0o755);
  const restoreProbe = ffprobeBogus ? interceptFinalVideoProbe() : () => {};
  const previous = process.env.PATH;
  // A failing narrator must fail on every platform, so it cannot be merely prepended:
  // on win32 an extensionless '#!/bin/sh' file is not launchable, PATH resolution skips
  // it and finds a real espeak-ng.exe installed later on PATH, which succeeds (RENDERED).
  // For 'fail' the shim dir is therefore the ONLY PATH entry: POSIX runs the stand-in
  // (exit 1); win32 cannot resolve any narrator (spawn ENOENT). Either way
  // synthesizeNarration throws -> NARRATION_FAILED. Narration is the first external
  // process runMediaProduction starts, so nothing else in that call needs PATH.
  process.env.PATH = espeak === 'fail' ? binDir : `${binDir}${path.delimiter}${previous}`;
  return () => { restoreProbe(); process.env.PATH = previous; fs.rmSync(binDir, { recursive: true, force: true }); };
}

class StubProvider extends AssetSourceProvider {
  constructor(behavior) { super(); this.behavior = behavior; this.calls = 0; }
  get id() { return 'a4-stub'; }
  async healthCheck() { return true; }
  async acquireVisualAsset() {
    this.calls += 1;
    return this.behavior(this.calls);
  }
}

/**
 * Drives one stage `CAP` times through its REAL production path and proves the
 * uniform A4 contract: attempt n recorded exactly once per invocation, the 3rd
 * quarantines, the 4th invocation is refused without accruing an attempt.
 * `invoke()` runs the stage once and returns its result.
 */
async function assertBoundedRetry(storage, { stage, subjectId, subjectType, invoke, failed, refused }) {
  for (let n = 1; n <= STAGE_RETRY_CAP; n += 1) {
    const result = await invoke();
    assert.ok(failed(result), `attempt ${n}: expected the authorized named outcome, got ${JSON.stringify(result).slice(0, 200)}`);
    assert.equal(result.attempt, n, `attempt ${n} recorded exactly once for this invocation`);
    assert.equal(result.quarantined, n === STAGE_RETRY_CAP);
    const row = retryRow(storage, stage, subjectId);
    assert.equal(row.attempt_count, n);
    assert.equal(row.cycle_number, 1);
    assert.equal(Boolean(row.quarantined_at), n === STAGE_RETRY_CAP, 'quarantine only on exhaustion (3rd attempt)');
  }
  assert.ok(isQuarantined(storage, subjectId, stage));
  const q = decisions(storage, subjectId, 'QUARANTINED');
  assert.equal(q.length, 1);
  assert.equal(q[0].subject_type, subjectType);
  assert.equal(q[0].stage, stage);

  const after = await invoke();
  assert.ok(refused(after), `4th invocation must be refused, got ${JSON.stringify(after).slice(0, 200)}`);
  assert.equal(retryRow(storage, stage, subjectId).attempt_count, STAGE_RETRY_CAP, 'a quarantined subject never accrues attempts');
  // Identity: exactly one retry row exists for the subject, under the right stage.
  const own = retryRows(storage).filter((r) => r.subject_id === subjectId);
  assert.deepEqual(own.map((r) => r.stage), [stage], 'no other stage consumed or created budget for this subject');
}

/** Drives the retry mechanism to quarantine directly (policy-level) so a stage's REAL guard/selector/reactivation paths can be exercised. */
function preQuarantine(storage, stage, subjectId) {
  for (let i = 0; i < STAGE_RETRY_CAP; i += 1) recordFailedAttempt(storage, { subjectId, stage, reason: 'preseeded' });
  assert.ok(isQuarantined(storage, subjectId, stage));
}

/**
 * Owner resolution (Slice 2): a named A4 outcome is a CLASS that MAY enter
 * bounded retry, not an automatically retryable one. Drives the stage through
 * its REAL production path more times than the cap and proves a failure that
 * is not established as transient/item-specific: still fails exactly as before
 * (existing stage contract), never records an attempt, never creates retry
 * state and never quarantines - i.e. deterministic failures do not burn budget
 * merely to repeat, and are not converted into a retry loop either.
 */
async function assertNoBudgetConsumed(storage, { stage, subjectId, invoke, failed, nature, basis, times = STAGE_RETRY_CAP + 1 }) {
  for (let n = 1; n <= times; n += 1) {
    const result = await invoke();
    assert.ok(failed(result), `invocation ${n}: expected the named outcome, got ${JSON.stringify(result).slice(0, 200)}`);
    assert.equal(result.attempt, undefined, `invocation ${n}: no A4 attempt recorded`);
    assert.equal(result.quarantined, undefined);
    assert.deepEqual(result.retryDisposition, { eligible: false, nature, basis }, `invocation ${n}: explicit disposition`);
    assert.equal(retryRow(storage, stage, subjectId), undefined, 'no retry state created');
  }
  assert.equal(isQuarantined(storage, subjectId, stage), false, 'never quarantined by a non-retryable failure');
  assert.equal(retryRows(storage).length, 0);
}

// ============================================================ migration 0017

test('migration 0017: preserves 0016 data 1:1, renames to subject_id, drops the content_versions FK, widens stages to 9', () => {
  const db = new Database(':memory:');
  const dir = 'src/db/migrations';
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  assert.equal(files.at(-1), '0017_generalize_stage_retry_identity.sql');
  db.pragma('foreign_keys = OFF');
  for (const f of files.filter((x) => x < '0017')) db.exec(fs.readFileSync(path.join(dir, f), 'utf8'));
  // Legacy rows under the 0016 shape.
  db.prepare(`INSERT INTO stage_retry_state (id, content_version_id, stage, cycle_number, attempt_count, quarantined_at, last_failure_reason, created_at, updated_at)
              VALUES ('r1', 'cv-1', 'PRODUCTION', 2, 3, '2026-01-01T00:00:00Z', 'why', 'c', 'u')`).run();
  db.prepare(`INSERT INTO stage_retry_cycle_history (id, content_version_id, stage, cycle_number, attempts_in_cycle, quarantined_at, reactivated_at, owner_reason)
              VALUES ('h1', 'cv-1', 'PRODUCTION', 1, 3, 'q', 'r', 'owner said so')`).run();
  db.exec(fs.readFileSync(path.join(dir, files.at(-1)), 'utf8'));
  db.pragma('foreign_keys = ON');

  const cols = db.prepare('PRAGMA table_info(stage_retry_state)').all().map((c) => c.name);
  assert.ok(cols.includes('subject_id'));
  assert.ok(!cols.includes('content_version_id'));
  assert.deepEqual(db.prepare('PRAGMA foreign_key_list(stage_retry_state)').all(), [], 'no FK to content_versions');
  assert.deepEqual(db.prepare('PRAGMA foreign_key_list(stage_retry_cycle_history)').all(), []);

  const row = db.prepare('SELECT * FROM stage_retry_state WHERE id = ?').get('r1');
  assert.deepEqual(
    { s: row.subject_id, st: row.stage, c: row.cycle_number, a: row.attempt_count, q: row.quarantined_at, r: row.last_failure_reason },
    { s: 'cv-1', st: 'PRODUCTION', c: 2, a: 3, q: '2026-01-01T00:00:00Z', r: 'why' }
  );
  const hist = db.prepare('SELECT * FROM stage_retry_cycle_history WHERE id = ?').get('h1');
  assert.deepEqual({ s: hist.subject_id, c: hist.cycle_number, a: hist.attempts_in_cycle, o: hist.owner_reason }, { s: 'cv-1', c: 1, a: 3, o: 'owner said so' });

  const insert = (stage, subject) => db.prepare(
    `INSERT INTO stage_retry_state (id, subject_id, stage, created_at, updated_at) VALUES (?, ?, ?, 'c', 'u')`
  ).run(crypto.randomUUID(), subject, stage);
  for (const stage of Object.values(RETRY_STAGE)) insert(stage, 'shared-subject'); // same subject id, every stage: isolated
  assert.throws(() => insert('BRIEF', 'shared-subject'), /UNIQUE/, 'UNIQUE (stage, subject_id)');
  for (const bad of ['RESEARCH', 'RIGHTS_VERIFICATION', 'NOPE']) {
    assert.throws(() => insert(bad, 'x'), /CHECK/, `${bad} is not an authorized retry stage`);
  }
  db.close();
});

test('RETRY_STAGE is exactly the 9 authorized stages: no Research, no Rights Verification', () => {
  assert.deepEqual(Object.values(RETRY_STAGE).sort(), [
    'ASSET_PROVISIONING', 'BRIEF', 'FACT_CHECK', 'MEDIA_PRODUCTION', 'ORIGINALITY',
    'PRODUCTION', 'PUBLICATION', 'QUALITY_GATE', 'SCRIPT'
  ]);
});

// ===================================================== policy identity rules

test('policy: identity is (stage, subject_id); contentVersionId alias is refused for BRIEF/SCRIPT; unknown stage refused', async () => {
  await withStorage((storage) => {
    assert.throws(() => recordFailedAttempt(storage, { contentVersionId: 'x', stage: RETRY_STAGE.BRIEF, reason: 'r' }), /not identified by a content_version_id/);
    assert.throws(() => recordFailedAttempt(storage, { contentVersionId: 'x', stage: RETRY_STAGE.SCRIPT, reason: 'r' }), /not identified by a content_version_id/);
    assert.throws(() => recordFailedAttempt(storage, { subjectId: 'x', stage: 'RESEARCH', reason: 'r' }), /unknown stage/);
    assert.throws(() => recordFailedAttempt(storage, { subjectId: 'x', stage: 'RIGHTS_VERIFICATION', reason: 'r' }), /unknown stage/);
    assert.throws(() => recordFailedAttempt(storage, { stage: RETRY_STAGE.BRIEF, reason: 'r' }), /requires a subjectId/);
    assert.throws(() => recordFailedAttempt(storage, { subjectId: 'a', contentVersionId: 'b', stage: RETRY_STAGE.FACT_CHECK, reason: 'r' }), /disagree/);
    assert.equal(retryRows(storage).length, 0, 'refused calls write nothing');
    // alias still works for content-version stages (Production/Publication call sites unchanged)
    assert.equal(recordFailedAttempt(storage, { contentVersionId: 'cv', stage: RETRY_STAGE.PRODUCTION, reason: 'r' }).attempt, 1);
    assert.equal(retryRow(storage, RETRY_STAGE.PRODUCTION, 'cv').attempt_count, 1);
  });
});

test('policy: stage isolation - the same subject id has independent budgets per stage; quarantine in one stage never leaks', async () => {
  await withStorage((storage) => {
    for (let i = 0; i < 3; i += 1) recordFailedAttempt(storage, { subjectId: 'S', stage: RETRY_STAGE.FACT_CHECK, reason: 'x' });
    assert.ok(isQuarantined(storage, 'S', RETRY_STAGE.FACT_CHECK));
    for (const other of Object.values(RETRY_STAGE).filter((s) => s !== RETRY_STAGE.FACT_CHECK)) {
      assert.equal(isQuarantined(storage, 'S', other), false, `${other} unaffected`);
      assert.equal(retryRow(storage, other, 'S'), undefined);
    }
    assert.equal(recordFailedAttempt(storage, { subjectId: 'S', stage: RETRY_STAGE.ORIGINALITY, reason: 'x' }).attempt, 1, 'fresh budget in another stage');
  });
});

test('policy: decision_log subject_type follows the stage identity (research_project / content_brief / content_version); reactivation is per stage', async () => {
  await withStorage((storage) => {
    const expected = {
      [RETRY_STAGE.BRIEF]: 'research_project', [RETRY_STAGE.SCRIPT]: 'content_brief',
      [RETRY_STAGE.FACT_CHECK]: 'content_version', [RETRY_STAGE.ORIGINALITY]: 'content_version',
      [RETRY_STAGE.QUALITY_GATE]: 'content_version', [RETRY_STAGE.ASSET_PROVISIONING]: 'content_version',
      [RETRY_STAGE.MEDIA_PRODUCTION]: 'content_version'
    };
    for (const [stage, subjectType] of Object.entries(expected)) {
      for (let i = 0; i < 3; i += 1) recordFailedAttempt(storage, { subjectId: `subj-${stage}`, stage, reason: 'x' });
      const row = decisions(storage, `subj-${stage}`, 'QUARANTINED')[0];
      assert.equal(row.subject_type, subjectType, stage);
      assert.equal(row.stage, stage);
    }
    assert.throws(() => reactivateQuarantined(storage, { subjectId: 'subj-BRIEF', stage: RETRY_STAGE.BRIEF }), QuarantineReactivationError);
    const res = reactivateQuarantined(storage, { subjectId: 'subj-BRIEF', stage: RETRY_STAGE.BRIEF, ownerAction: { actor: 'OWNER', reason: 'fixed upstream' } });
    assert.equal(res.cycle, 2);
    assert.equal(isQuarantined(storage, 'subj-BRIEF', RETRY_STAGE.BRIEF), false);
    assert.ok(isQuarantined(storage, 'subj-SCRIPT', RETRY_STAGE.SCRIPT), 'other stages stay quarantined');
    assert.throws(() => reactivateQuarantined(storage, { contentVersionId: 'subj-BRIEF', stage: RETRY_STAGE.BRIEF, ownerAction: { actor: 'OWNER', reason: 'x' } }), QuarantineReactivationError);
  });
});

// ============================================== 1. Brief: (BRIEF, research_project_id)

test('Brief: GENERATION_RETRY_EXHAUSTED is attempts 1-3 under (BRIEF, research_project_id); 3rd quarantines; 4th refused; no content_version fabricated', async () => {
  await withStorage(async (storage) => {
    const { researchProjectId } = seedResearchProject(storage);
    const llm = { calls: 0 };
    const router = garbageRouter(llm);
    await assertBoundedRetry(storage, {
      stage: RETRY_STAGE.BRIEF, subjectId: researchProjectId, subjectType: 'research_project',
      invoke: () => createBrief({ storage, researchProjectId, llmRouter: router, policy: briefPolicy }),
      failed: (r) => r.rejected === true && r.reason.startsWith('GENERATION_RETRY_EXHAUSTED'),
      refused: (r) => r.outcome === 'QUARANTINED' && r.reason === 'BRIEF_QUARANTINED'
    });
    const maxGen = briefPolicy.generation?.max_attempts ?? 3;
    assert.equal(llm.calls, maxGen * STAGE_RETRY_CAP, 'in-invocation generation loop unchanged; refused 4th invocation made no LLM call');
    assert.equal(storage.all('SELECT * FROM content_versions').length, 0, 'no content_version exists or was fabricated');
    assert.equal(storage.all('SELECT * FROM content_briefs').length, 0);
    assert.equal(storage.get('SELECT status FROM research_projects WHERE id = ?', [researchProjectId]).status, 'RESEARCH_COMPLETE', 'Research state unchanged');
  });
});

test('Brief/Script: A4 attempts are SEPARATE from the stage\'s internal generation attempts - the internal cap is unchanged, never counted, never reset', async () => {
  await withStorage(async (storage) => {
    const { researchProjectId } = seedResearchProject(storage);
    const briefLlm = { calls: 0 };
    const cap = briefPolicy.generation?.max_attempts ?? 3;
    for (let n = 1; n <= STAGE_RETRY_CAP; n += 1) {
      const r = await createBrief({ storage, researchProjectId, llmRouter: garbageRouter(briefLlm), policy: briefPolicy });
      assert.equal(r.attemptsUsed, cap, 'internal generation loop still runs its own full cap on every A4 attempt');
      assert.equal(r.attempt, n, 'A4 counts the exhausted invocation once, not the internal generations');
      assert.deepEqual(r.retryDisposition, { eligible: true, nature: 'TRANSIENT', basis: 'generation_exhausted_output_failed_validation' });
    }
    assert.equal(briefLlm.calls, cap * STAGE_RETRY_CAP, 'worst case = 3 A4 attempts x internal cap (Owner-accepted)');
    // a smaller internal cap is honoured and does not change the A4 cap
    const small = { ...briefPolicy, generation: { ...(briefPolicy.generation ?? {}), max_attempts: 1 } };
    const other = seedResearchProject(storage);
    const smallLlm = { calls: 0 };
    for (let n = 1; n <= STAGE_RETRY_CAP; n += 1) {
      const r = await createBrief({ storage, researchProjectId: other.researchProjectId, llmRouter: garbageRouter(smallLlm), policy: small });
      assert.equal(r.attemptsUsed, 1);
      assert.equal(r.attempt, n);
    }
    assert.equal(smallLlm.calls, STAGE_RETRY_CAP);
    assert.ok(isQuarantined(storage, other.researchProjectId, RETRY_STAGE.BRIEF));

    const { contentBriefId } = await seedRealBrief(storage);
    const scriptLlm = { calls: 0 };
    const scriptCap = scriptPolicy.generation?.max_attempts ?? 3;
    for (let n = 1; n <= STAGE_RETRY_CAP; n += 1) {
      const r = await createScript({ storage, contentBriefId, llmRouter: garbageRouter(scriptLlm), policy: scriptPolicy });
      assert.equal(r.attemptsUsed, scriptCap);
      assert.equal(r.attempt, n);
    }
    assert.equal(scriptLlm.calls, scriptCap * STAGE_RETRY_CAP);
  });
});

test('Brief: quarantine is per research project and per stage; selection excludes only that project from the Brief selector', async () => {
  await withStorage(async (storage) => {
    const a = seedResearchProject(storage);
    const b = seedResearchProject(storage);
    for (let i = 0; i < 3; i += 1) recordFailedAttempt(storage, { subjectId: a.researchProjectId, stage: RETRY_STAGE.BRIEF, reason: 'x' });
    assert.deepEqual(selectEligibleBriefs(storage).map((i) => i.researchProjectId), [b.researchProjectId]);
    // a quarantine recorded under ANOTHER stage for the same id does not hide it
    for (let i = 0; i < 3; i += 1) recordFailedAttempt(storage, { subjectId: b.researchProjectId, stage: RETRY_STAGE.SCRIPT, reason: 'x' });
    assert.deepEqual(selectEligibleBriefs(storage).map((i) => i.researchProjectId), [b.researchProjectId]);
  });
});

test('Brief: excluded outcomes (ineligible research, existing brief) never enter A4', async () => {
  await withStorage(async (storage) => {
    const { researchProjectId } = seedResearchProject(storage, { status: 'FAILED' });
    const r = await createBrief({ storage, researchProjectId, llmRouter: garbageRouter(), policy: briefPolicy });
    assert.equal(r.rejected, true);
    assert.match(r.reason, /FAILED/);
    assert.equal(r.attempt, undefined);
    const ok = seedResearchProject(storage);
    const good = await createBrief({
      storage, researchProjectId: ok.researchProjectId, policy: briefPolicy,
      llmRouter: routerReturning(JSON.stringify({
        working_title: 'T', target_audience: 'A', viewer_promise: 'P', hook: 'H', angle: 'An', narrative_structure: 'S',
        counterpoints: 'C', original_insights: 'I', visual_ideas: 'V', monetization_opportunities: 'M', risk_assessment: 'R',
        key_claims: [ok.claimId]
      }))
    });
    assert.equal(good.created, true);
    assert.equal(retryRows(storage).length, 0, 'ineligible and successful Brief runs wrote no retry state');
  });
});

// ============================================== 2. Script: (SCRIPT, content_brief_id)

async function seedRealBrief(storage) {
  const { researchProjectId, claimId } = seedResearchProject(storage);
  const res = await createBrief({
    storage, researchProjectId, policy: briefPolicy,
    llmRouter: routerReturning(JSON.stringify({
      working_title: 'T', target_audience: 'A', viewer_promise: 'P', hook: 'H', angle: 'An', narrative_structure: 'S',
      counterpoints: 'C', original_insights: 'I', visual_ideas: 'V', monetization_opportunities: 'M', risk_assessment: 'R',
      key_claims: [claimId]
    }))
  });
  const contentVersionId = storage.get('SELECT id FROM content_versions WHERE content_brief_id = ?', [res.brief.id]).id;
  return { researchProjectId, claimId, contentBriefId: res.brief.id, contentVersionId };
}

test('Script: GENERATION_RETRY_EXHAUSTED is attempts 1-3 under (SCRIPT, content_brief_id) - not the content_version id; isolated from Brief', async () => {
  await withStorage(async (storage) => {
    const { contentBriefId, contentVersionId, researchProjectId } = await seedRealBrief(storage);
    const llm = { calls: 0 };
    const router = garbageRouter(llm);
    await assertBoundedRetry(storage, {
      stage: RETRY_STAGE.SCRIPT, subjectId: contentBriefId, subjectType: 'content_brief',
      invoke: () => createScript({ storage, contentBriefId, llmRouter: router, policy: scriptPolicy }),
      failed: (r) => r.rejected === true && r.reason.startsWith('GENERATION_RETRY_EXHAUSTED'),
      refused: (r) => r.outcome === 'QUARANTINED' && r.reason === 'SCRIPT_QUARANTINED'
    });
    assert.equal(retryRow(storage, RETRY_STAGE.SCRIPT, contentVersionId), undefined, 'not keyed by content_version_id');
    assert.equal(retryRow(storage, RETRY_STAGE.BRIEF, researchProjectId), undefined, 'Brief budget untouched');
    assert.equal(storage.all('SELECT * FROM scripts').length, 0, 'no partial Script');
    assert.equal(storage.get('SELECT state FROM content_versions WHERE id = ?', [contentVersionId]).state, 'BRIEF_CREATED');
    assert.deepEqual(selectEligibleScripts(storage), [], 'quarantined item excluded from Script selection');
  });
});

test('Script: excluded outcomes (BRIEF_NOT_FOUND, successful generation) never enter A4', async () => {
  await withStorage(async (storage) => {
    const missing = await createScript({ storage, contentBriefId: 'no-such-brief', llmRouter: garbageRouter(), policy: scriptPolicy });
    assert.equal(missing.rejected, true);
    assert.equal(missing.reason, 'BRIEF_NOT_FOUND');
    assert.equal(missing.attempt, undefined);
    const { contentBriefId, claimId } = await seedRealBrief(storage);
    const ok = await createScript({
      storage, contentBriefId, policy: scriptPolicy,
      llmRouter: routerReturning(JSON.stringify({
        hook: 'h', narrative: 'n', sections: [{ heading: 'Intro', content: 'Body', claim_ids: [claimId] }],
        counterpoints: 'c', conclusion: 'k', call_to_action: null
      }))
    });
    assert.equal(ok.created, true);
    assert.equal(retryRows(storage).length, 0);
  });
});

// ============================ 3-5. Fact-check / Originality / Quality Gate: STRUCTURAL_FAILURE

test('policy: assessRetryEligibility - a named outcome is never automatically retryable; only explicit transient evidence with a basis is', () => {
  const T = FAILURE_NATURE.TRANSIENT;
  // approved defaults
  assert.deepEqual(assessRetryEligibility({ outcome: 'STRUCTURAL_FAILURE' }), { eligible: false, nature: 'DETERMINISTIC', basis: 'deterministic_by_default' });
  assert.deepEqual(assessRetryEligibility({ outcome: 'ASSET_CHECKSUM_MISMATCH' }), { eligible: false, nature: 'DETERMINISTIC', basis: 'deterministic_by_default' });
  // every other named outcome with no evidence: not eligible either (no transient classification is invented)
  for (const outcome of ['NARRATION_FAILED', 'RENDER_FAILED', 'VALIDATION_FAILED', 'NO_ASSET_ACQUIRED', 'INVALID_PROVIDER_RESULT', 'GENERATION_RETRY_EXHAUSTED']) {
    assert.deepEqual(assessRetryEligibility({ outcome }), { eligible: false, nature: 'UNESTABLISHED', basis: 'no_transient_evidence' }, outcome);
  }
  // explicit stage evidence decides
  assert.equal(assessRetryEligibility({ outcome: 'STRUCTURAL_FAILURE', evidence: { nature: T, basis: 'stage_established_cause' } }).eligible, true, 'default is overridable ONLY by explicit transient evidence');
  assert.equal(assessRetryEligibility({ outcome: 'ASSET_CHECKSUM_MISMATCH', evidence: { nature: T, basis: 'stage_established_cause' } }).eligible, true);
  assert.equal(assessRetryEligibility({ outcome: 'STRUCTURAL_FAILURE', evidence: { nature: T } }).eligible, false, 'transient claim without a basis is not evidence');
  assert.equal(assessRetryEligibility({ outcome: 'STRUCTURAL_FAILURE', evidence: { nature: T, basis: '  ' } }).eligible, false);
  assert.equal(assessRetryEligibility({ outcome: 'NO_ASSET_ACQUIRED', evidence: { nature: FAILURE_NATURE.DETERMINISTIC, basis: 'x' } }).eligible, false);
  assert.equal(assessRetryEligibility({ outcome: 'NO_ASSET_ACQUIRED', evidence: { nature: FAILURE_NATURE.INFRASTRUCTURE, basis: 'x' } }).eligible, false);
});

test('policy: recordFailedAttemptIfRetryable records (and quarantines) only for eligible failures, under the stage identity', async () => {
  await withStorage((storage) => {
    const transient = { nature: FAILURE_NATURE.TRANSIENT, basis: 'stage_established_cause' };
    for (let n = 1; n <= STAGE_RETRY_CAP; n += 1) {
      const r = recordFailedAttemptIfRetryable(storage, { outcome: 'STRUCTURAL_FAILURE', evidence: transient, subjectId: 'cv', stage: RETRY_STAGE.FACT_CHECK, reason: 'x' });
      assert.equal(r.retryEligible, true);
      assert.equal(r.attempt, n);
      assert.equal(r.quarantined, n === STAGE_RETRY_CAP);
    }
    assert.ok(isQuarantined(storage, 'cv', RETRY_STAGE.FACT_CHECK));
    for (const outcome of ['STRUCTURAL_FAILURE', 'ASSET_CHECKSUM_MISMATCH']) {
      const r = recordFailedAttemptIfRetryable(storage, { outcome, subjectId: 'other', stage: RETRY_STAGE.MEDIA_PRODUCTION, reason: 'x' });
      assert.equal(r.retryEligible, false);
      assert.equal(r.attempt, undefined);
    }
    assert.equal(retryRow(storage, RETRY_STAGE.MEDIA_PRODUCTION, 'other'), undefined);
  });
});

test('Fact-check: STRUCTURAL_FAILURE is deterministic by default - no budget consumed across more invocations than the cap; state and results unchanged', async () => {
  await withStorage(async (storage) => {
    const x = seedContent(storage, { state: 'SCRIPT_DRAFT', claimLinks: 'not-json' });
    await assertNoBudgetConsumed(storage, {
      stage: RETRY_STAGE.FACT_CHECK, subjectId: x.contentVersionId,
      invoke: () => runFactCheck({ storage, contentBriefId: x.contentBriefId }),
      failed: (r) => r.outcome === 'STRUCTURAL_FAILURE', nature: 'DETERMINISTIC', basis: 'deterministic_by_default'
    });
    assert.equal(decisions(storage, x.scriptId, 'STRUCTURAL_FAILURE').length, 4, 'each invocation still logged its STRUCTURAL_FAILURE exactly as before (spec §11)');
    assert.equal(storage.get('SELECT state FROM content_versions WHERE id = ?', [x.contentVersionId]).state, 'SCRIPT_DRAFT');
    assert.equal(storage.all('SELECT * FROM fact_checks').length, 0);
    assert.deepEqual(selectEligibleFactChecks(storage), [{ contentBriefId: x.contentBriefId }], 'not quarantined, so still selected exactly as before A4');
  });
});

test('Fact-check: every structural path (NO_CURRENT_SCRIPT, bad claim_links) stays logged against its original entity and consumes no budget', async () => {
  await withStorage((storage) => {
    const noScript = seedContent(storage, { state: 'SCRIPT_DRAFT', withScript: false });
    const r = runFactCheck({ storage, contentBriefId: noScript.contentBriefId });
    assert.equal(r.reason, 'NO_CURRENT_SCRIPT');
    assert.equal(r.attempt, undefined);
    assert.equal(r.retryDisposition.eligible, false);
    assert.equal(decisions(storage, noScript.contentBriefId, 'STRUCTURAL_FAILURE').length, 1, 'logged against the content_brief as before');
    const badLinks = seedContent(storage, { state: 'SCRIPT_DRAFT', claimLinks: 'not-json' });
    runFactCheck({ storage, contentBriefId: badLinks.contentBriefId });
    assert.equal(decisions(storage, badLinks.scriptId, 'STRUCTURAL_FAILURE').length, 1, 'logged against the script as before');
    assert.equal(retryRows(storage).length, 0);
  });
});

test('Originality: STRUCTURAL_FAILURE (no valid representation) is deterministic by default - no budget consumed', async () => {
  await withStorage(async (storage) => {
    const x = seedContent(storage, { state: 'FACT_CHECK', body: '' });
    await assertNoBudgetConsumed(storage, {
      stage: RETRY_STAGE.ORIGINALITY, subjectId: x.contentVersionId,
      invoke: () => runOriginalityCheck({ storage, contentBriefId: x.contentBriefId }),
      failed: (r) => r.outcome === 'STRUCTURAL_FAILURE' && r.reason === 'NO_ORIGINALITY_REPRESENTATION', nature: 'DETERMINISTIC', basis: 'deterministic_by_default'
    });
    assert.equal(storage.all('SELECT * FROM originality_checks').length, 0);
    assert.deepEqual(selectEligibleOriginalityChecks(storage), [{ contentBriefId: x.contentBriefId }]);
  });
});

test('Quality Gate: STRUCTURAL_FAILURE is deterministic by default - no budget consumed; state unchanged', async () => {
  await withStorage(async (storage) => {
    const x = seedContent(storage, { state: 'ORIGINALITY_CHECK', withScript: false });
    await assertNoBudgetConsumed(storage, {
      stage: RETRY_STAGE.QUALITY_GATE, subjectId: x.contentVersionId,
      invoke: () => runQualityGate({ storage, contentBriefId: x.contentBriefId }),
      failed: (r) => r.outcome === 'STRUCTURAL_FAILURE' && r.transitioned === false, nature: 'DETERMINISTIC', basis: 'deterministic_by_default'
    });
    assert.equal(storage.get('SELECT state FROM content_versions WHERE id = ?', [x.contentVersionId]).state, 'ORIGINALITY_CHECK');
  });
});

test('Fact-check / Originality / Quality Gate: STRUCTURAL_FAILURE with no content_version enters no retry state (nothing fabricated)', async () => {
  await withStorage((storage) => {
    for (const run of [runFactCheck, runOriginalityCheck, runQualityGate]) {
      const r = run({ storage, contentBriefId: 'no-such-brief' });
      assert.equal(r.outcome, 'STRUCTURAL_FAILURE');
      assert.equal(r.reason, 'CONTENT_VERSION_NOT_FOUND');
      assert.equal(r.attempt, undefined, 'not an A4 attempt: no identity exists');
    }
    assert.equal(retryRows(storage).length, 0);
  });
});

test('quarantine guards on the REAL Fact-check / Originality / Quality Gate paths: a quarantined subject is refused on direct invocation, per stage only', async () => {
  await withStorage((storage) => {
    const x = seedContent(storage, { state: 'SCRIPT_DRAFT', withScript: false });
    preQuarantine(storage, RETRY_STAGE.FACT_CHECK, x.contentVersionId);
    const f = runFactCheck({ storage, contentBriefId: x.contentBriefId });
    assert.equal(f.outcome, 'QUARANTINED');
    assert.equal(f.reason, 'FACT_CHECK_QUARANTINED');
    assert.equal(retryRow(storage, RETRY_STAGE.FACT_CHECK, x.contentVersionId).attempt_count, STAGE_RETRY_CAP, 'a quarantined subject never accrues attempts');
    assert.deepEqual(selectEligibleFactChecks(storage), []);
    // stage isolation: the same content_version is NOT refused by Originality / Quality Gate
    const o = runOriginalityCheck({ storage, contentBriefId: x.contentBriefId });
    const q = runQualityGate({ storage, contentBriefId: x.contentBriefId });
    assert.equal(o.outcome, 'STRUCTURAL_FAILURE');
    assert.equal(q.outcome, 'STRUCTURAL_FAILURE');
    assert.equal(retryRows(storage).filter((r) => r.subject_id === x.contentVersionId).length, 1, 'only the Fact-check row exists');

    const y = seedContent(storage, { state: 'FACT_CHECK', body: '' });
    preQuarantine(storage, RETRY_STAGE.ORIGINALITY, y.contentVersionId);
    assert.equal(runOriginalityCheck({ storage, contentBriefId: y.contentBriefId }).reason, 'ORIGINALITY_QUARANTINED');
    assert.deepEqual(selectEligibleOriginalityChecks(storage), []);

    const z = seedContent(storage, { state: 'ORIGINALITY_CHECK', withScript: false });
    preQuarantine(storage, RETRY_STAGE.QUALITY_GATE, z.contentVersionId);
    assert.equal(runQualityGate({ storage, contentBriefId: z.contentBriefId }).reason, 'QUALITY_GATE_QUARANTINED');
    assert.deepEqual(selectEligibleQualityGates(storage), []);
  });
});

test('Fact-check reactivation by the Owner starts cycle 2 and the item is selectable/runnable again', async () => {
  await withStorage((storage) => {
    const x = seedContent(storage, { state: 'SCRIPT_DRAFT', claimLinks: 'not-json' });
    preQuarantine(storage, RETRY_STAGE.FACT_CHECK, x.contentVersionId);
    assert.deepEqual(selectEligibleFactChecks(storage), []);
    reactivateQuarantined(storage, { subjectId: x.contentVersionId, stage: RETRY_STAGE.FACT_CHECK, ownerAction: { actor: 'OWNER', reason: 'repaired claim links' } });
    assert.deepEqual(selectEligibleFactChecks(storage), [{ contentBriefId: x.contentBriefId }]);
    const r = runFactCheck({ storage, contentBriefId: x.contentBriefId });
    assert.equal(r.outcome, 'STRUCTURAL_FAILURE', 'runs again (not refused)');
    assert.equal(retryRow(storage, RETRY_STAGE.FACT_CHECK, x.contentVersionId).cycle_number, 2);
    assert.equal(retryRow(storage, RETRY_STAGE.FACT_CHECK, x.contentVersionId).attempt_count, 0, 'the deterministic failure did not consume cycle-2 budget');
  });
});


// ================================= 6. Asset Provisioning: (ASSET_PROVISIONING, content_version_id)

test('Asset Provisioning: genuine provider results (null / invalid) share ONE budget under (ASSET_PROVISIONING, content_version_id); one provider call per invocation', async () => {
  await withStorage(async (storage) => {
    const x = seedContent(storage, { state: 'PRODUCED', production: true });
    const seen = [];
    // attempt 1: provider returns null; 2: invalid result; 3: null again
    const provider = new StubProvider((n) => (n === 2 ? { assetType: 'audio', location: '/nope' } : null));
    let call = 0;
    await assertBoundedRetry(storage, {
      stage: RETRY_STAGE.ASSET_PROVISIONING, subjectId: x.contentVersionId, subjectType: 'content_version',
      invoke: async () => {
        call += 1;
        const r = await runAssetProvisioning({ storage, contentBriefId: x.contentBriefId, provider });
        seen.push(r.outcome);
        if (r.attempt) assert.deepEqual(r.retryDisposition.eligible, true);
        assert.equal(provider.calls, Math.min(call, 3), 'exactly one provider call per invocation; none once quarantined');
        return r;
      },
      failed: (r) => r.outcome === 'NO_ASSET_ACQUIRED' || r.outcome === 'INVALID_PROVIDER_RESULT',
      refused: (r) => r.outcome === 'QUARANTINED'
    });
    assert.deepEqual(seen, ['NO_ASSET_ACQUIRED', 'INVALID_PROVIDER_RESULT', 'NO_ASSET_ACQUIRED', 'QUARANTINED']);
    assert.equal(storage.all('SELECT * FROM assets').length, 0, 'no asset persisted');
    assert.equal(storage.get('SELECT state FROM content_versions WHERE id = ?', [x.contentVersionId]).state, 'PRODUCED');
    assert.deepEqual(selectEligibleAssetProvisioning(storage), []);
    // stage isolation on the selector: same PRODUCED item is still selectable by Rights Verification and Media Production
    assert.deepEqual(selectEligibleRightsVerification(storage), [{ contentBriefId: x.contentBriefId }]);
    assert.deepEqual(selectEligibleMediaProductions(storage), [{ contentBriefId: x.contentBriefId }]);
  });
});

test('Asset Provisioning: a MISSING provider is a configuration failure - distinguishable from a genuine NO_ASSET_ACQUIRED and can never consume budget or quarantine', async () => {
  await withStorage(async (storage) => {
    const x = seedContent(storage, { state: 'PRODUCED', production: true });
    for (const provider of [undefined, null, {}, { acquireVisualAsset: 'not-a-function' }]) {
      for (let n = 0; n < STAGE_RETRY_CAP + 2; n += 1) {
        const r = await runAssetProvisioning({ storage, contentBriefId: x.contentBriefId, provider });
        assert.equal(r.outcome, 'NO_ASSET_ACQUIRED', 'existing stage contract preserved: no new outcome');
        assert.equal(r.reason, 'PROVIDER_NOT_CONFIGURED', 'distinguishable from a genuine provider result');
        assert.equal(r.configurationFailure, true);
        assert.equal(r.failureKind, 'PROVIDER_NOT_CONFIGURED');
        assert.equal(r.attempt, undefined);
        assert.deepEqual(r.retryDisposition, { eligible: false, nature: 'INFRASTRUCTURE', basis: 'asset_provider_not_configured' });
      }
    }
    assert.equal(retryRows(storage).length, 0, 'no retry state: item budget untouched');
    assert.equal(isQuarantined(storage, x.contentVersionId, RETRY_STAGE.ASSET_PROVISIONING), false);
    assert.deepEqual(selectEligibleAssetProvisioning(storage), [{ contentBriefId: x.contentBriefId }], 'never hidden from selection by misconfiguration');
    // structured evidence preserved for Slice 3 classification
    const log = decisions(storage, x.contentVersionId, 'NO_ASSET_ACQUIRED');
    assert.ok(log.length > 0);
    assert.equal(log[0].reason, 'provider_not_configured');
    const evidence = JSON.parse(log[0].config_snapshot);
    assert.equal(evidence.failure, 'NO_ASSET_ACQUIRED');
    assert.equal(evidence.failureKind, 'PROVIDER_NOT_CONFIGURED');
    assert.equal(evidence.configurationFailure, true);
    assert.deepEqual(evidence.evidence, { nature: 'INFRASTRUCTURE', basis: 'asset_provider_not_configured' });
  });
});

test('Asset Provisioning: a provider THROW is not a provider result - no budget consumed, error preserved as structured evidence', async () => {
  await withStorage(async (storage) => {
    const x = seedContent(storage, { state: 'PRODUCED', production: true });
    const provider = new StubProvider(() => { throw new Error('provider exploded'); });
    for (let n = 1; n <= STAGE_RETRY_CAP + 1; n += 1) {
      const r = await runAssetProvisioning({ storage, contentBriefId: x.contentBriefId, provider });
      assert.equal(r.outcome, 'NO_ASSET_ACQUIRED');
      assert.equal(r.reason, 'provider exploded');
      assert.equal(r.failureKind, 'PROVIDER_THREW');
      assert.equal(r.attempt, undefined);
      assert.equal(r.retryDisposition.eligible, false);
    }
    assert.equal(provider.calls, STAGE_RETRY_CAP + 1, 'still one call per invocation, no in-invocation retry');
    assert.equal(retryRows(storage).length, 0);
    const evidence = JSON.parse(decisions(storage, x.contentVersionId, 'NO_ASSET_ACQUIRED')[0].config_snapshot);
    assert.deepEqual(evidence.providerError, { name: 'Error', message: 'provider exploded' });
  });
});

test('Asset Provisioning: excluded outcomes (NOT_YET_PRODUCED, NO_VISUAL_CONTEXT, ALREADY_PROVISIONED, PROVISIONED) never enter A4', async () => {
  await withStorage(async (storage, mk) => {
    const provider = new StubProvider(() => null);
    const early = seedContent(storage, { state: 'PRODUCTION_READY' });
    const r1 = await runAssetProvisioning({ storage, contentBriefId: early.contentBriefId, provider });
    assert.equal(r1.outcome, 'NOT_YET_PRODUCED');

    const noCtx = seedContent(storage, { state: 'PRODUCED', production: true, visualIdeas: ' ', body: '' });
    const r2 = await runAssetProvisioning({ storage, contentBriefId: noCtx.contentBriefId, provider });
    assert.equal(r2.outcome, 'NO_VISUAL_CONTEXT');

    const ok = seedContent(storage, { state: 'PRODUCED', production: true });
    const file = path.join(mk('asset'), 'f.jpg');
    fs.writeFileSync(file, 'bytes');
    const good = new StubProvider(() => ({ assetType: 'image', location: file, origin: 'stub', license: 'L', verificationStatus: 'UNVERIFIED' }));
    assert.equal((await runAssetProvisioning({ storage, contentBriefId: ok.contentBriefId, provider: good })).outcome, 'PROVISIONED');
    assert.equal((await runAssetProvisioning({ storage, contentBriefId: ok.contentBriefId, provider: good })).outcome, 'ALREADY_PROVISIONED');

    assert.equal(provider.calls, 0);
    assert.equal(retryRows(storage).length, 0);
  });
});

// ================================= 7. Media Production: (MEDIA_PRODUCTION, content_version_id)

function mediaSeed(storage, mk, { body = structuredBody, withImage = true, checksum = null, verificationStatus = 'VERIFIED', production = true } = {}) {
  const x = seedContent(storage, { state: 'PRODUCED', body, production });
  const assetsDir = mk('assets');
  const image = withImage ? makeImage(assetsDir) : path.join(assetsDir, 'never-existed.png');
  attachAsset(storage, x.contentVersionId, image, { verificationStatus, checksum });
  return { ...x, image, artifactsDir: mk('media') };
}

test('Media: ASSET_CHECKSUM_MISMATCH is deterministic by default - checked once per invocation, never retried, NO budget consumed', async () => {
  await withStorage(async (storage, mk) => {
    const x = mediaSeed(storage, mk, { checksum: 'deadbeef'.repeat(8) });
    const before = fs.statSync(x.image).mtimeMs;
    await assertNoBudgetConsumed(storage, {
      stage: RETRY_STAGE.MEDIA_PRODUCTION, subjectId: x.contentVersionId,
      invoke: () => runMediaProduction({ storage, contentBriefId: x.contentBriefId, artifactsDir: x.artifactsDir }),
      failed: (r) => r.outcome === 'ASSET_CHECKSUM_MISMATCH', nature: 'DETERMINISTIC', basis: 'deterministic_by_default'
    });
    assert.equal(decisions(storage, x.contentVersionId, 'ASSET_CHECKSUM_MISMATCH').length, STAGE_RETRY_CAP + 1, 'exactly one check per invocation - no in-invocation retry loop');
    assert.equal(fs.statSync(x.image).mtimeMs, before, 'asset file untouched');
    assert.equal(storage.all('SELECT * FROM media_artifacts').length, 0);
    assert.deepEqual(selectEligibleMediaProductions(storage), [{ contentBriefId: x.contentBriefId }], 'not quarantined, selected exactly as before A4');
  });
});

test('Media: quarantine guard on the REAL path - a quarantined content version is refused before any narration/render work; per stage only', async () => {
  await withStorage(async (storage, mk) => {
    const x = mediaSeed(storage, mk, { checksum: 'deadbeef'.repeat(8) });
    preQuarantine(storage, RETRY_STAGE.MEDIA_PRODUCTION, x.contentVersionId);
    const r = runMediaProduction({ storage, contentBriefId: x.contentBriefId, artifactsDir: x.artifactsDir });
    assert.equal(r.outcome, 'QUARANTINED');
    assert.equal(r.reason, 'MEDIA_PRODUCTION_QUARANTINED');
    assert.equal(decisions(storage, x.contentVersionId, 'ASSET_CHECKSUM_MISMATCH').length, 0, 'refused before the checksum check');
    assert.equal(retryRow(storage, RETRY_STAGE.MEDIA_PRODUCTION, x.contentVersionId).attempt_count, STAGE_RETRY_CAP);
    assert.deepEqual(selectEligibleMediaProductions(storage), []);
    assert.deepEqual(selectEligibleAssetProvisioning(storage), [{ contentBriefId: x.contentBriefId }], 'Asset Provisioning unaffected');
  });
});

test('Media: RENDER_FAILED (missing asset file) has no transient evidence - logged and returned as before, no budget consumed', async () => {
  await withStorage((storage, mk) => {
    const x = mediaSeed(storage, mk, { withImage: false });
    const r = runMediaProduction({ storage, contentBriefId: x.contentBriefId, artifactsDir: x.artifactsDir });
    assert.equal(r.outcome, 'RENDER_FAILED');
    assert.match(r.reason, /^missing_asset_file_/);
    assert.equal(r.attempt, undefined);
    assert.deepEqual(r.retryDisposition, { eligible: false, nature: 'UNESTABLISHED', basis: 'no_transient_evidence' });
    assert.equal(decisions(storage, x.contentVersionId, 'RENDER_FAILED').length, 1);
    assert.equal(retryRows(storage).length, 0);
  });
});

test('Media: NARRATION_FAILED via script-body contract violation is deterministic (same stored body every run) - no budget consumed', async () => {
  await withStorage((storage, mk) => {
    const x = mediaSeed(storage, mk, { body: '{"hook":"truncated' });
    for (let n = 0; n <= STAGE_RETRY_CAP; n += 1) {
      const r = runMediaProduction({ storage, contentBriefId: x.contentBriefId, artifactsDir: x.artifactsDir });
      assert.equal(r.outcome, 'NARRATION_FAILED');
      assert.equal(r.reason, 'SCRIPT_BODY_MALFORMED_JSON');
      assert.equal(r.attempt, undefined);
      assert.deepEqual(r.retryDisposition, { eligible: false, nature: 'DETERMINISTIC', basis: 'script_body_contract_violation_SCRIPT_BODY_MALFORMED_JSON' });
    }
    assert.equal(retryRows(storage).length, 0);
  });
});

test('Media: NARRATION_FAILED (failing narrator) and VALIDATION_FAILED (real render, bogus probe) keep their stage contract; no transient evidence, so no budget consumed', async () => {
  await withStorage((storage, mk) => {
    const a = mediaSeed(storage, mk);
    let restore = installShims({ espeak: 'fail' });
    try {
      const r = runMediaProduction({ storage, contentBriefId: a.contentBriefId, artifactsDir: a.artifactsDir });
      assert.equal(r.outcome, 'NARRATION_FAILED');
      assert.equal(r.attempt, undefined);
      assert.equal(r.retryDisposition.eligible, false);
    } finally { restore(); }

    const b = mediaSeed(storage, mk);
    restore = installShims({ espeak: 'ok', ffprobeBogus: true });
    try {
      const r = runMediaProduction({ storage, contentBriefId: b.contentBriefId, artifactsDir: b.artifactsDir });
      assert.equal(r.outcome, 'VALIDATION_FAILED');
      assert.match(r.reason, /^UNEXPECTED_RESOLUTION_/);
      assert.equal(r.attempt, undefined);
      assert.equal(r.retryDisposition.eligible, false);
      assert.equal(r.mediaArtifact, null);
      assert.equal(storage.all('SELECT * FROM media_artifacts WHERE content_version_id = ?', [b.contentVersionId]).length, 0, 'invalid artifact never persisted');
    } finally { restore(); }
    assert.equal(decisions(storage, a.contentVersionId, 'NARRATION_FAILED').length, 1);
    assert.equal(decisions(storage, b.contentVersionId, 'VALIDATION_FAILED').length, 1);
    assert.equal(retryRows(storage).length, 0);
  });
});

test('Media: a successful render records nothing and stays out of A4', async () => {
  await withStorage((storage, mk) => {
    const x = mediaSeed(storage, mk);
    const restore = installShims({ espeak: 'ok' });
    try {
      const r = runMediaProduction({ storage, contentBriefId: x.contentBriefId, artifactsDir: x.artifactsDir });
      assert.equal(r.outcome, 'RENDERED');
      assert.equal(r.attempt, undefined);
    } finally { restore(); }
    assert.equal(retryRows(storage).length, 0);
  });
});

test('Media: excluded outcomes (NOT_YET_PRODUCED, ASSET_RIGHTS_BLOCKED, NO_VISUAL_ASSETS, STRUCTURAL_FAILURE) never enter A4', async () => {
  await withStorage((storage, mk) => {
    const early = seedContent(storage, { state: 'PRODUCED', production: false });
    assert.equal(runMediaProduction({ storage, contentBriefId: early.contentBriefId, artifactsDir: mk('m') }).outcome, 'NOT_YET_PRODUCED');

    const blocked = mediaSeed(storage, mk, { verificationStatus: 'UNVERIFIED' });
    assert.equal(runMediaProduction({ storage, contentBriefId: blocked.contentBriefId, artifactsDir: blocked.artifactsDir }).outcome, 'ASSET_RIGHTS_BLOCKED');

    const noAssets = seedContent(storage, { state: 'PRODUCED', production: true });
    assert.equal(runMediaProduction({ storage, contentBriefId: noAssets.contentBriefId, artifactsDir: mk('m') }).outcome, 'NO_VISUAL_ASSETS');

    const missing = runMediaProduction({ storage, contentBriefId: 'no-such-brief', artifactsDir: mk('m') });
    assert.equal(missing.outcome, 'STRUCTURAL_FAILURE');
    assert.equal(missing.attempt, undefined);
    assert.equal(retryRows(storage).length, 0);
  });
});

// ======================================================= runner pacing (ADR-0023 rule)

/** Research stub: `count` opportunities; opportunity #j is "researched" (a non-completing research_project row) on its (j+1)th call, so eligibility changes every sweep and forces many sweeps. */
function backgroundResearch(storage, count) {
  const opps = Array.from({ length: count }, () => seedOpportunity(storage, { status: 'HANDED_TO_RESEARCH' }));
  const index = new Map(opps.map((id, i) => [id, i]));
  const calls = new Map();
  const research = ({ opportunityId }) => {
    const n = (calls.get(opportunityId) ?? 0) + 1;
    calls.set(opportunityId, n);
    if (n >= index.get(opportunityId) + 1) {
      storage.run('INSERT INTO research_projects (id, opportunity_id, status, created_at) VALUES (?, ?, ?, ?)',
        [crypto.randomUUID(), opportunityId, 'INSUFFICIENT_EVIDENCE', nowISO()]);
    }
    return {};
  };
  return { research };
}

test('runner: a deterministic Fact-check failure records no attempt, so it never consumes the pacing slot or the budget - behaviour is exactly as before A4', async () => {
  await withStorage(async (storage) => {
    const x = seedContent(storage, { state: 'SCRIPT_DRAFT', claimLinks: 'not-json' });
    const calls = [];
    for (let run = 0; run < STAGE_RETRY_CAP + 1; run += 1) {
      await runAutonomousOperation({
        storage, mode: 'SIMULATION',
        stageFns: {
          research: backgroundResearch(storage, 4).research,
          'fact-check': (a) => { calls.push(a.contentBriefId); return runFactCheck(a); }
        }
      });
    }
    assert.ok(calls.length > STAGE_RETRY_CAP, `re-evaluated every sweep as before A4 (called ${calls.length}x)`);
    assert.equal(retryRows(storage).length, 0);
    assert.equal(isQuarantined(storage, x.contentVersionId, RETRY_STAGE.FACT_CHECK), false, 'never quarantined by a deterministic failure');
  });
});

test('runner: an isolated failing Fact-check item stops via the existing no_progress guard - 2 sweeps, no retry state', async () => {
  await withStorage(async (storage) => {
    const x = seedContent(storage, { state: 'SCRIPT_DRAFT', claimLinks: 'not-json' });
    const r = await runAutonomousOperation({ storage, mode: 'SIMULATION' });
    assert.equal(r.sweeps, 2);
    assert.equal(r.stopReason, 'no_progress');
    assert.equal(retryRow(storage, RETRY_STAGE.FACT_CHECK, x.contentVersionId), undefined);
  });
});

test('runner: a quarantined Fact-check subject is not selected, so no call is made (guard + selector)', async () => {
  await withStorage(async (storage) => {
    const x = seedContent(storage, { state: 'SCRIPT_DRAFT', claimLinks: 'not-json' });
    preQuarantine(storage, RETRY_STAGE.FACT_CHECK, x.contentVersionId);
    const calls = [];
    await runAutonomousOperation({ storage, mode: 'SIMULATION', stageFns: { 'fact-check': (a) => { calls.push(a); return runFactCheck(a); } } });
    assert.equal(calls.length, 0);
    assert.equal(retryRow(storage, RETRY_STAGE.FACT_CHECK, x.contentVersionId).attempt_count, STAGE_RETRY_CAP);
  });
});

test('runner: a MISSING asset provider (misconfigured runner) never consumes budget or quarantines, however many invocations run', async () => {
  await withStorage(async (storage) => {
    const x = seedContent(storage, { state: 'PRODUCED', production: true });
    const results = [];
    for (let run = 0; run < STAGE_RETRY_CAP + 2; run += 1) {
      await runAutonomousOperation({
        storage, mode: 'SIMULATION', // no assetProvisioning.provider configured
        onStageError: (stage, item, err) => { throw err; },
        stageFns: {
          'asset-provisioning': async (a) => { const r = await runAssetProvisioning(a); results.push(r); return r; },
          'rights-verification': () => ({}),
          'media-production': () => ({})
        }
      });
    }
    assert.ok(results.length >= STAGE_RETRY_CAP + 2);
    assert.ok(results.every((r) => r.reason === 'PROVIDER_NOT_CONFIGURED' && r.configurationFailure === true && r.attempt === undefined));
    assert.equal(retryRows(storage).length, 0);
    assert.equal(isQuarantined(storage, x.contentVersionId, RETRY_STAGE.ASSET_PROVISIONING), false);
    assert.deepEqual(selectEligibleAssetProvisioning(storage), [{ contentBriefId: x.contentBriefId }]);
  });
});

test('runner pacing: Brief items are keyed by research project - two independent failing projects each get their own single attempt per invocation', async () => {
  await withStorage(async (storage) => {
    const a = seedResearchProject(storage);
    const b = seedResearchProject(storage);
    const llm = { calls: 0 };
    const run = () => runAutonomousOperation({
      storage, mode: 'SIMULATION', llmRouter: garbageRouter(llm), briefPolicy,
      stageFns: { research: backgroundResearch(storage, 4).research }
    });
    const r1 = await run();
    assert.ok(r1.sweeps >= 5);
    const maxGen = briefPolicy.generation?.max_attempts ?? 3;
    assert.equal(retryRow(storage, RETRY_STAGE.BRIEF, a.researchProjectId).attempt_count, 1);
    assert.equal(retryRow(storage, RETRY_STAGE.BRIEF, b.researchProjectId).attempt_count, 1);
    assert.equal(llm.calls, 2 * maxGen, 'one generation cycle per project for the whole invocation');
    await run();
    await run();
    assert.ok(isQuarantined(storage, a.researchProjectId, RETRY_STAGE.BRIEF));
    assert.ok(isQuarantined(storage, b.researchProjectId, RETRY_STAGE.BRIEF));
    const before = llm.calls;
    await run();
    assert.equal(llm.calls, before, 'no generation once both are quarantined');
    assert.deepEqual(selectEligibleBriefs(storage), []);
    assert.equal(selectEligibleResearch(storage).length >= 0, true);
  });
});

test('runner pacing: Asset Provisioning gets ONE attempt per invocation; attempts 2/3 on later invocations; quarantine', async () => {
  await withStorage(async (storage) => {
    const x = seedContent(storage, { state: 'PRODUCED', production: true });
    const provider = new StubProvider(() => null);
    const run = () => runAutonomousOperation({
      storage, mode: 'SIMULATION', assetProvisioning: { provider },
      stageFns: {
        research: backgroundResearch(storage, 4).research,
        'rights-verification': () => ({}),
        'media-production': () => ({})
      }
    });
    const r1 = await run();
    assert.ok(r1.sweeps >= 5);
    assert.equal(provider.calls, 1, 'one provider call in the whole invocation');
    await run();
    await run();
    assert.equal(provider.calls, 3);
    assert.ok(isQuarantined(storage, x.contentVersionId, RETRY_STAGE.ASSET_PROVISIONING));
    await run();
    assert.equal(provider.calls, 3, 'no 4th attempt');
    assert.equal(retryRow(storage, RETRY_STAGE.ASSET_PROVISIONING, x.contentVersionId).attempt_count, 3);
  });
});

test('runner pacing: an outcome that recorded no attempt (excluded outcome) does not consume the slot', async () => {
  await withStorage(async (storage) => {
    const x = seedContent(storage, { state: 'PRODUCED', production: true });
    const calls = [];
    // A stage returning NO_VISUAL_CONTEXT-like/other outcomes with no `attempt` must be re-evaluated each sweep, as before.
    await runAutonomousOperation({
      storage, mode: 'SIMULATION',
      stageFns: {
        research: backgroundResearch(storage, 3).research,
        'asset-provisioning': (a) => { calls.push(a.contentBriefId); return { outcome: 'NO_ASSET_ACQUIRED' }; },
        'rights-verification': () => ({}),
        'media-production': () => ({})
      }
    });
    assert.ok(calls.length >= 4, `not paced without a recorded attempt (called ${calls.length}x)`);
    assert.equal(retryRows(storage).length, 0);
    assert.ok(x);
  });
});