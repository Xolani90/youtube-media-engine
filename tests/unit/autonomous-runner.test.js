import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { SqliteStorageDriver } from '../../src/storage/SqliteStorageDriver.js';
import { config } from '../../src/config/index.js';
import { runAutonomousOperation } from '../../src/autonomous/runner.js';
import {
  selectEligibleResearch,
  selectEligibleBriefs,
  selectEligibleScripts,
  selectEligibleFactChecks,
  selectEligibleOriginalityChecks,
  selectEligibleQualityGates,
  selectEligibleProductions,
  selectEligibleMediaProductions,
  selectEligiblePublications
} from '../../src/autonomous/workSelection.js';
import { runPublication } from '../../src/publication/pipeline.js';
import { PublicationProvider } from '../../src/publication/PublicationProvider.js';
import { PUBLICATION_RESULT_STATUS } from '../../src/publication/constants.js';

function freshStorage() {
  const dbPath = path.join(os.tmpdir(), `autonomous-runner-${Date.now()}-${Math.random()}.db`);
  return { storage: new SqliteStorageDriver({ dbPath }), dbPath };
}

function cleanup(storage, dbPath, ...files) {
  storage.close();
  fs.rmSync(dbPath, { force: true });
  fs.rmSync(`${dbPath}-wal`, { force: true });
  fs.rmSync(`${dbPath}-shm`, { force: true });
  for (const f of files) fs.rmSync(f, { force: true });
}

function nowISO() {
  return new Date().toISOString();
}

function insertOpportunity(storage, { status = 'DISCOVERED' } = {}) {
  const id = crypto.randomUUID();
  storage.run(
    `INSERT INTO opportunities (id, title, source, discovered_at, status) VALUES (?, 'T', 'rss', ?, ?)`,
    [id, nowISO(), status]
  );
  return id;
}

function insertResearchProject(storage, opportunityId, { status = 'RESEARCHING' } = {}) {
  const id = crypto.randomUUID();
  storage.run(
    `INSERT INTO research_projects (id, opportunity_id, status, created_at) VALUES (?, ?, ?, ?)`,
    [id, opportunityId, status, nowISO()]
  );
  return id;
}

function insertContentBrief(storage, opportunityId, { researchProjectId = null } = {}) {
  const id = crypto.randomUUID();
  storage.run(
    `INSERT INTO content_briefs (id, opportunity_id, research_project_id, working_title, created_at) VALUES (?, ?, ?, 'T', ?)`,
    [id, opportunityId, researchProjectId, nowISO()]
  );
  return id;
}

function insertScript(storage, contentBriefId) {
  const id = crypto.randomUUID();
  storage.run(
    `INSERT INTO scripts (id, content_brief_id, version, body, claim_links, created_at) VALUES (?, ?, 1, 'Body.', '[]', ?)`,
    [id, contentBriefId, nowISO()]
  );
  return id;
}

function insertContentVersion(storage, contentBriefId, scriptId, state) {
  const id = crypto.randomUUID();
  storage.run(
    `INSERT INTO content_versions (id, content_brief_id, script_id, state, created_at) VALUES (?, ?, ?, ?, ?)`,
    [id, contentBriefId, scriptId, state, nowISO()]
  );
  return id;
}

function insertMediaArtifact(storage, contentVersionId, mediaFilePath) {
  const productionId = crypto.randomUUID();
  storage.run(
    `INSERT INTO productions (id, content_version_id, script_id, artifact_type, artifact_path, artifact_checksum, manifest_json, created_at)
     VALUES (?, ?, (SELECT script_id FROM content_versions WHERE id = ?), 'production_manifest_v1', '/tmp/x', 'deadbeef', '{}', ?)`,
    [productionId, contentVersionId, contentVersionId, nowISO()]
  );
  const mediaArtifactId = crypto.randomUUID();
  storage.run(
    `INSERT INTO media_artifacts
      (id, production_id, content_version_id, render_spec_json, render_spec_checksum,
       narration_path, narration_duration_seconds, artifact_path, artifact_checksum,
       duration_seconds, width, height, video_codec, audio_codec, created_at)
     VALUES (?, ?, ?, '{}', 'chk', '/tmp/n.wav', 5.0, ?, 'chk2', 5.0, 1280, 720, 'h264', 'aac', ?)`,
    [mediaArtifactId, productionId, contentVersionId, mediaFilePath, nowISO()]
  );
  return mediaArtifactId;
}

/**
 * Builds a full opportunity -> content_brief -> script -> content_version
 * chain at a given content_versions.state. The opportunity is seeded past
 * 'HANDED_TO_RESEARCH' (an arbitrary later status) precisely so it is
 * NOT also picked up by selectEligibleResearch -- these chains already
 * have a content_brief, so re-selecting them for Research would be
 * wrong regardless.
 */
function seedChainAtState(storage, state) {
  const opportunityId = insertOpportunity(storage, { status: 'RESEARCH_HANDED_OFF_TEST_FIXTURE' });
  const contentBriefId = insertContentBrief(storage, opportunityId);
  const scriptId = insertScript(storage, contentBriefId);
  const contentVersionId = insertContentVersion(storage, contentBriefId, scriptId, state);
  return { opportunityId, contentBriefId, scriptId, contentVersionId };
}

// ---------------------------------------------------------------------
// 1. Work-selection query correctness per stage
// ---------------------------------------------------------------------

test('selectEligibleResearch: only HANDED_TO_RESEARCH opportunities without an existing research_project', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();

  const eligible = insertOpportunity(storage, { status: 'HANDED_TO_RESEARCH' });
  const wrongStatus = insertOpportunity(storage, { status: 'SCORED' });
  const alreadyResearched = insertOpportunity(storage, { status: 'HANDED_TO_RESEARCH' });
  insertResearchProject(storage, alreadyResearched, { status: 'RESEARCH_COMPLETE' });

  const result = selectEligibleResearch(storage).map((r) => r.opportunityId);
  assert.deepEqual(result.sort(), [eligible].sort());
  assert.ok(!result.includes(wrongStatus));
  assert.ok(!result.includes(alreadyResearched));

  cleanup(storage, dbPath);
});

test('selectEligibleBriefs: only RESEARCH_COMPLETE research_projects without an existing content_brief', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();

  const opp1 = insertOpportunity(storage, { status: 'HANDED_TO_RESEARCH' });
  const eligible = insertResearchProject(storage, opp1, { status: 'RESEARCH_COMPLETE' });

  const opp2 = insertOpportunity(storage, { status: 'HANDED_TO_RESEARCH' });
  const stillResearching = insertResearchProject(storage, opp2, { status: 'RESEARCHING' });

  const opp3 = insertOpportunity(storage, { status: 'HANDED_TO_RESEARCH' });
  const alreadyBriefed = insertResearchProject(storage, opp3, { status: 'RESEARCH_COMPLETE' });
  insertContentBrief(storage, opp3, { researchProjectId: alreadyBriefed });

  const result = selectEligibleBriefs(storage).map((r) => r.researchProjectId);
  assert.deepEqual(result, [eligible]);
  assert.ok(!result.includes(stillResearching));
  assert.ok(!result.includes(alreadyBriefed));

  cleanup(storage, dbPath);
});

test('per-content_versions-state work-selection queries return exactly the content_brief_id at that state, and exclude every other state', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();

  const cases = [
    ['BRIEF_CREATED', selectEligibleScripts],
    ['SCRIPT_DRAFT', selectEligibleFactChecks],
    ['FACT_CHECK', selectEligibleOriginalityChecks],
    ['ORIGINALITY_CHECK', selectEligibleQualityGates],
    ['PRODUCTION_READY', selectEligibleProductions],
    ['PRODUCED', selectEligibleMediaProductions]
  ];

  const seeded = cases.map(([state]) => ({ state, ...seedChainAtState(storage, state) }));
  // A handful of terminal/failure states and an unrelated in-progress
  // state, to prove they are excluded from every one of the queries above.
  seedChainAtState(storage, 'REJECTED');
  seedChainAtState(storage, 'BLOCKED');
  seedChainAtState(storage, 'PUBLISHED');
  seedChainAtState(storage, 'QUALITY_GATE');

  for (const [state, selectFn] of cases) {
    const expected = seeded.find((s) => s.state === state).contentBriefId;
    const result = selectFn(storage).map((r) => r.contentBriefId);
    assert.deepEqual(result, [expected], `selectFn for state ${state} returned an unexpected set`);
  }

  cleanup(storage, dbPath);
});

test('selectEligiblePublications: state=PRODUCED with a media_artifacts row, excluding PRODUCED-without-media and PUBLISHED', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();

  const videoFile = path.join(os.tmpdir(), `autonomous-pub-${crypto.randomUUID()}.mp4`);
  fs.writeFileSync(videoFile, 'fake mp4 bytes');

  const withMedia = seedChainAtState(storage, 'PRODUCED');
  insertMediaArtifact(storage, withMedia.contentVersionId, videoFile);

  const withoutMedia = seedChainAtState(storage, 'PRODUCED');

  const published = seedChainAtState(storage, 'PUBLISHED');
  insertMediaArtifact(storage, published.contentVersionId, videoFile);

  const result = selectEligiblePublications(storage).map((r) => r.contentBriefId);
  assert.deepEqual(result, [withMedia.contentBriefId]);
  assert.ok(!result.includes(withoutMedia.contentBriefId));
  assert.ok(!result.includes(published.contentBriefId));

  cleanup(storage, dbPath, videoFile);
});

// ---------------------------------------------------------------------
// 2. Runner dispatches each selected item to the right stage function
// ---------------------------------------------------------------------

test('runner dispatches each eligible item to its stage function, exactly once per item, and advances state so later stages see it in the same invocation', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();

  // Only seed at the very first stage (Research) -- each mock stage
  // function below "advances" its own item to the next stage's eligible
  // condition, proving a single invocation carries an item through
  // multiple stages via repeated sweeps.
  const opportunityId = insertOpportunity(storage, { status: 'HANDED_TO_RESEARCH' });

  const calls = [];
  let researchProjectId;
  let contentBriefId;
  let scriptId;
  let contentVersionId;

  const stageFns = {
    research: async ({ opportunityId: oppId }) => {
      calls.push(['research', oppId]);
      researchProjectId = insertResearchProject(storage, oppId, { status: 'RESEARCH_COMPLETE' });
      return {};
    },
    brief: async ({ researchProjectId: rpId }) => {
      calls.push(['brief', rpId]);
      contentBriefId = insertContentBrief(storage, opportunityId, { researchProjectId: rpId });
      scriptId = insertScript(storage, contentBriefId);
      contentVersionId = insertContentVersion(storage, contentBriefId, scriptId, 'BRIEF_CREATED');
      return {};
    },
    script: async ({ contentBriefId: cbId }) => {
      calls.push(['script', cbId]);
      storage.run(`UPDATE content_versions SET state = 'SCRIPT_DRAFT' WHERE content_brief_id = ?`, [cbId]);
      return {};
    },
    'fact-check': async ({ contentBriefId: cbId }) => {
      calls.push(['fact-check', cbId]);
      storage.run(`UPDATE content_versions SET state = 'FACT_CHECK' WHERE content_brief_id = ?`, [cbId]);
      return {};
    },
    originality: async ({ contentBriefId: cbId }) => {
      calls.push(['originality', cbId]);
      storage.run(`UPDATE content_versions SET state = 'ORIGINALITY_CHECK' WHERE content_brief_id = ?`, [cbId]);
      return {};
    },
    'quality-gate': async ({ contentBriefId: cbId }) => {
      calls.push(['quality-gate', cbId]);
      // Terminal for this test -- stop advancing here.
      return {};
    }
  };

  const result = await runAutonomousOperation({
    storage,
    stageFns,
  });

  assert.deepEqual(
    calls.map((c) => c[0]),
    ['research', 'brief', 'script', 'fact-check', 'originality', 'quality-gate']
  );
  assert.equal(calls.filter((c) => c[0] === 'research').length, 1, 'research called exactly once');
  assert.equal(calls[0][1], opportunityId);
  assert.ok(researchProjectId && contentBriefId && scriptId && contentVersionId);
  // The mock quality-gate stage never advances state (deliberately, to
  // keep this test focused on dispatch order), so the item remains
  // eligible for 'quality-gate' forever -- the no_progress guard is what
  // stops the sweep, not a genuine absence of eligible work.
  assert.equal(result.stopReason, 'no_progress');
  assert.ok(result.sweeps >= 6);
  const qgCount = result.processed.find((p) => p.stage === 'quality-gate').count;
  assert.equal(qgCount, 1);

  cleanup(storage, dbPath);
});

// ---------------------------------------------------------------------
// 3. Runner stops cleanly when no work remains / no infinite loop
// ---------------------------------------------------------------------

test('runner stops with stopReason no_work on a single invocation when nothing is eligible', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();

  const result = await runAutonomousOperation({ storage });

  assert.equal(result.stopReason, 'no_work');
  assert.equal(result.sweeps, 1);
  assert.ok(result.processed.every((p) => p.count === 0));

  cleanup(storage, dbPath);
});

test('runner stops with stopReason no_progress instead of looping forever when a stage function never changes eligibility', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();

  seedChainAtState(storage, 'BRIEF_CREATED');
  let scriptCalls = 0;

  const result = await runAutonomousOperation({
    storage,
    stageFns: {
      script: async () => {
        scriptCalls += 1;
        // Deliberately does NOT change content_versions.state -- the
        // item remains eligible for 'script' forever, the way a stuck
        // no-op stage call would.
        return {};
      }
    }
  });

  assert.equal(result.stopReason, 'no_progress');
  // Called once (the sweep that discovered it was still eligible after
  // no change) -- the guard must prevent a second, third, ... call, not
  // merely cap it at some arbitrary large number.
  assert.equal(scriptCalls, 1);
  assert.ok(result.sweeps <= 3, 'runner must not loop indefinitely');

  cleanup(storage, dbPath);
});

test('a stage error aborts the run and is rethrown when no onStageError handler is given', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  seedChainAtState(storage, 'BRIEF_CREATED');

  await assert.rejects(
    () =>
      runAutonomousOperation({
        storage,
        stageFns: {
          script: async () => {
            throw new Error('boom');
          }
        }
      }),
    /boom/
  );

  cleanup(storage, dbPath);
});

test('a stage error is swallowed and reported via onStageError, and the run completes', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  seedChainAtState(storage, 'BRIEF_CREATED');

  const errors = [];
  const result = await runAutonomousOperation({
    storage,
    onStageError: (stage, item, err) => errors.push({ stage, item, message: err.message }),
    stageFns: {
      script: async () => {
        throw new Error('boom');
      }
    }
  });

  assert.equal(errors.length, 1);
  assert.equal(errors[0].stage, 'script');
  assert.equal(errors[0].message, 'boom');
  // No progress was possible on that item (state never advanced), so the
  // no_progress guard still applies rather than looping.
  assert.equal(result.stopReason, 'no_progress');

  cleanup(storage, dbPath);
});

// ---------------------------------------------------------------------
// 4. Genuine two-invocation race, reusing the real runPublication
// ---------------------------------------------------------------------

class MockAdapter extends PublicationProvider {
  constructor(resultOrFn) {
    super();
    this._resultOrFn = resultOrFn;
    this.calls = [];
  }
  get id() {
    return 'mock';
  }
  async publish(request) {
    this.calls.push(request);
    return typeof this._resultOrFn === 'function' ? this._resultOrFn(request) : this._resultOrFn;
  }
}

test('two concurrent runner invocations against the same DB file cannot both invoke the Publication provider for the same item', async () => {
  const dbPath = path.join(os.tmpdir(), `autonomous-race-${Date.now()}-${Math.random()}.db`);
  const storageA = new SqliteStorageDriver({ dbPath });
  await storageA.migrate();
  const storageB = new SqliteStorageDriver({ dbPath });

  const videoFile = path.join(os.tmpdir(), `autonomous-race-${crypto.randomUUID()}.mp4`);
  fs.writeFileSync(videoFile, 'fake mp4 bytes');

  const seeded = seedChainAtState(storageA, 'PRODUCED');
  insertMediaArtifact(storageA, seeded.contentVersionId, videoFile);

  const adapterA = new MockAdapter({ status: PUBLICATION_RESULT_STATUS.SUCCESS, provider: 'mock', providerItemId: 'vidA', providerUrl: 'https://x/vidA' });
  const adapterB = new MockAdapter({ status: PUBLICATION_RESULT_STATUS.SUCCESS, provider: 'mock', providerItemId: 'vidB', providerUrl: 'https://x/vidB' });

  const originalPath = config.authorizedExternalActionsPath;
  const originalMode = config.runMode;
  const originalAutonomous = config.autonomousEnabled;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomous-race-auth-'));
  const authPath = path.join(dir, 'authorized.json');
  fs.writeFileSync(authPath, JSON.stringify([`publish:mock:${seeded.contentVersionId}`]));
  config.authorizedExternalActionsPath = authPath;
  config.runMode = 'LIVE';
  config.autonomousEnabled = true;

  try {
    const [resultA, resultB] = await Promise.all([
      runAutonomousOperation({
        storage: storageA,
        publication: { provider: 'mock', adapter: adapterA }
      }),
      runAutonomousOperation({
        storage: storageB,
        publication: { provider: 'mock', adapter: adapterB }
      })
    ]);

    assert.ok(resultA && resultB);
    const totalProviderCalls = adapterA.calls.length + adapterB.calls.length;
    assert.equal(totalProviderCalls, 1, 'the provider must be invoked exactly once across both concurrent invocations');

    const rows = storageA.all('SELECT * FROM publications WHERE content_version_id = ?', [seeded.contentVersionId]);
    assert.equal(rows.length, 1, 'the UNIQUE(content_version_id, provider) index must still hold: exactly one publications row');
    assert.equal(rows[0].status, 'PUBLISHED');
  } finally {
    config.authorizedExternalActionsPath = originalPath;
    config.runMode = originalMode;
    config.autonomousEnabled = originalAutonomous;
  }

  storageA.close();
  storageB.close();
  fs.rmSync(dbPath, { force: true });
  fs.rmSync(`${dbPath}-wal`, { force: true });
  fs.rmSync(`${dbPath}-shm`, { force: true });
  fs.rmSync(videoFile, { force: true });
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------
// 5. Crash-simulation: interrupted PENDING publication is never
//    silently re-published by a second runner invocation.
// ---------------------------------------------------------------------

test('crash simulation: a runner invocation after an interrupted publication attempt does not silently resume it as a fresh publish', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();

  const videoFile = path.join(os.tmpdir(), `autonomous-crash-${crypto.randomUUID()}.mp4`);
  fs.writeFileSync(videoFile, 'fake mp4 bytes');
  const seeded = seedChainAtState(storage, 'PRODUCED');
  insertMediaArtifact(storage, seeded.contentVersionId, videoFile);

  // Simulate a process killed mid-publish: a PENDING publications row
  // with no terminal outcome, matching real interruption (checkpoint
  // §12) -- content_versions.state is still PRODUCED.
  const mediaArtifactRow = storage.get('SELECT id FROM media_artifacts WHERE content_version_id = ?', [seeded.contentVersionId]);
  storage.run(
    `INSERT INTO publications (id, content_version_id, media_artifact_id, provider, status, request_json, attempt_count, created_at, updated_at)
     VALUES (?, ?, ?, 'mock', 'PENDING', '{}', 1, ?, ?)`,
    [crypto.randomUUID(), seeded.contentVersionId, mediaArtifactRow.id, nowISO(), nowISO()]
  );

  const adapter = new MockAdapter({ status: PUBLICATION_RESULT_STATUS.SUCCESS, provider: 'mock', providerItemId: 'vid1', providerUrl: 'https://x/vid1' });

  const originalPath = config.authorizedExternalActionsPath;
  const originalMode = config.runMode;
  const originalAutonomous = config.autonomousEnabled;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomous-crash-auth-'));
  const authPath = path.join(dir, 'authorized.json');
  fs.writeFileSync(authPath, JSON.stringify([`publish:mock:${seeded.contentVersionId}`]));
  config.authorizedExternalActionsPath = authPath;
  config.runMode = 'LIVE';
  config.autonomousEnabled = true;

  try {
    await runAutonomousOperation({
      storage,
      publication: { provider: 'mock', adapter }
    });
  } finally {
    config.authorizedExternalActionsPath = originalPath;
    config.runMode = originalMode;
    config.autonomousEnabled = originalAutonomous;
  }

  // The provider must never be called against an interrupted PENDING
  // row -- Publication v1 maps it to AMBIGUOUS, never blindly resumed
  // (checkpoint §4/§12), so the runner reaching it produces no new
  // provider call and no duplicate row.
  assert.equal(adapter.calls.length, 0);
  const rows = storage.all('SELECT * FROM publications WHERE content_version_id = ?', [seeded.contentVersionId]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'AMBIGUOUS');
  const cv = storage.get('SELECT * FROM content_versions WHERE id = ?', [seeded.contentVersionId]);
  assert.equal(cv.state, 'PRODUCED');

  cleanup(storage, dbPath, videoFile);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------
// 6. Explicit non-authorization test
// ---------------------------------------------------------------------

test('with authorized_external_actions.json empty, the runner reaching Publication for a genuinely eligible item is still refused, never bypassed', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();

  const videoFile = path.join(os.tmpdir(), `autonomous-noauth-${crypto.randomUUID()}.mp4`);
  fs.writeFileSync(videoFile, 'fake mp4 bytes');
  const seeded = seedChainAtState(storage, 'PRODUCED');
  insertMediaArtifact(storage, seeded.contentVersionId, videoFile);

  const adapter = new MockAdapter({ status: PUBLICATION_RESULT_STATUS.SUCCESS, provider: 'mock', providerItemId: 'vid1', providerUrl: 'https://x/vid1' });

  const originalPath = config.authorizedExternalActionsPath;
  const originalMode = config.runMode;
  const originalAutonomous = config.autonomousEnabled;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomous-noauth-'));
  const authPath = path.join(dir, 'authorized.json');
  fs.writeFileSync(authPath, JSON.stringify([])); // empty -- matches config/authorized_external_actions.json's real default
  config.authorizedExternalActionsPath = authPath;
  config.runMode = 'LIVE';
  config.autonomousEnabled = true;

  let result;
  try {
    result = await runAutonomousOperation({
      storage,
      publication: { provider: 'mock', adapter }
    });
  } finally {
    config.authorizedExternalActionsPath = originalPath;
    config.runMode = originalMode;
    config.autonomousEnabled = originalAutonomous;
  }

  assert.equal(adapter.calls.length, 0, 'the provider must never be called when the action is not authorized');
  const rows = storage.all('SELECT * FROM publications WHERE content_version_id = ?', [seeded.contentVersionId]);
  assert.equal(rows.length, 0, 'no publications row is created for a denied attempt');
  const cv = storage.get('SELECT * FROM content_versions WHERE id = ?', [seeded.contentVersionId]);
  assert.equal(cv.state, 'PRODUCED', 'content_versions.state is never advanced past PRODUCED without a confirmed publish');
  // Publication is reached (it is the only eligible item) but its own
  // AUTHORIZATION_DENIED outcome does not throw -- runPublication
  // returns it as a normal outcome -- so the sweep completes cleanly.
  assert.equal(result.stopReason, 'no_progress');
  assert.equal(result.processed.find((p) => p.stage === 'publication').count, 1);

  cleanup(storage, dbPath, videoFile);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------
// 6. D-C2 mode propagation (FIND-DC2-MODE-001): a SIMULATION
//    autonomous run must never reach the Publication provider merely
//    because process-global config.runMode happens to be LIVE.
// ---------------------------------------------------------------------

test('D-C2: a SIMULATION autonomous run does not reach the Publication provider even though process-global config.runMode is LIVE and the action is authorized', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();

  const videoFile = path.join(os.tmpdir(), `autonomous-dc2-${crypto.randomUUID()}.mp4`);
  fs.writeFileSync(videoFile, 'fake mp4 bytes');
  const seeded = seedChainAtState(storage, 'PRODUCED');
  insertMediaArtifact(storage, seeded.contentVersionId, videoFile);

  const adapter = new MockAdapter({ status: PUBLICATION_RESULT_STATUS.SUCCESS, provider: 'mock', providerItemId: 'vid1', providerUrl: 'https://x/vid1' });

  const originalPath = config.authorizedExternalActionsPath;
  const originalMode = config.runMode;
  const originalAutonomous = config.autonomousEnabled;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomous-dc2-auth-'));
  const authPath = path.join(dir, 'authorized.json');
  // The exact action is authorized -- this test isolates the mode
  // propagation defect from authorization-file denial (already covered
  // by the preceding test).
  fs.writeFileSync(authPath, JSON.stringify([`publish:mock:${seeded.contentVersionId}`]));
  config.authorizedExternalActionsPath = authPath;
  // The confused-deputy condition: process-global config says LIVE...
  config.runMode = 'LIVE';
  config.autonomousEnabled = true;

  let result;
  try {
    // ...but THIS run is explicitly started as SIMULATION. Per
    // ADR-0008 §3.3, SIMULATION is absolute and must deny the external
    // action regardless of config.runMode.
    result = await runAutonomousOperation({
      storage,
      mode: 'SIMULATION',
      publication: { provider: 'mock', adapter }
    });
  } finally {
    config.authorizedExternalActionsPath = originalPath;
    config.runMode = originalMode;
    config.autonomousEnabled = originalAutonomous;
  }

  // A. the run is actually SIMULATION (persisted + returned).
  assert.equal(result.mode, 'SIMULATION');
  const runRow = storage.get('SELECT mode FROM system_runs WHERE id = ?', [result.runId]);
  assert.equal(runRow.mode, 'SIMULATION');

  // D + E. Publication was genuinely reached (it is the only eligible
  // item, and it is reached exactly once) but the provider was NEVER
  // called -- this is the critical security assertion.
  assert.equal(result.processed.find((p) => p.stage === 'publication').count, 1);
  assert.equal(adapter.calls.length, 0, 'provider.publish() must not be called for a SIMULATION run');

  // F. No publications row reaches PUBLISHED (in fact none is created
  // at all -- the D-C2 check runs before the durable claim/insert).
  const rows = storage.all('SELECT * FROM publications WHERE content_version_id = ?', [seeded.contentVersionId]);
  assert.equal(rows.length, 0, 'no publications row is created when D-C2 denies the action');
  const cv = storage.get('SELECT * FROM content_versions WHERE id = ?', [seeded.contentVersionId]);
  assert.equal(cv.state, 'PRODUCED', 'content_versions.state must never advance to PUBLISHED under SIMULATION');

  // G. The rejection is specifically the D-C2 mode invariant (not a
  // missing-authorization or autonomous-disabled denial, both of which
  // are covered by other tests and would produce a different message).
  const decisions = storage.all(
    `SELECT * FROM decision_log WHERE run_id = ? AND subject_id = ? AND decision = 'AUTHORIZATION_DENIED'`,
    [result.runId, seeded.contentVersionId]
  );
  assert.equal(decisions.length, 1);
  assert.match(decisions[0].reason, /run mode is SIMULATION, not LIVE/);

  assert.equal(result.stopReason, 'no_progress');

  cleanup(storage, dbPath, videoFile);
  fs.rmSync(dir, { recursive: true, force: true });
});
