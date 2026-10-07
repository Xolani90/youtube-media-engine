import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  tmpDbPath, removeDb, seedOpportunity, openDb, runPipeline, scriptedDetector, httpError, snapshot
} from '../helpers/contradictionCheckpointFixture.js';
import { RESEARCH_CHECKPOINT } from '../../src/research/researchCheckpoints.js';
import { classifyContradictionFailure, RESEARCH_FAILURE_NATURE as NATURE } from '../../src/research/researchFailure.js';
import { LlmWorkloadError, WORKLOAD_ERROR_CODE } from '../../src/research/llmWorkload.js';

// Pass 40: a durable CONTRADICTION_PERSISTED checkpoint, written in the SAME
// transaction as the contradiction relations and pair decision rows, so a
// recovered run never calls the detector again for a pass that already committed.

const CHILD = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'helpers', 'contradictionCheckpointCrashChild.mjs');
const C = 'CONTRADICTS';
const N = 'NO_CONTRADICTION';

async function withDb(fn) {
  const dbPath = tmpDbPath();
  const storage = openDb(dbPath);
  try {
    await storage.migrate();
    const oppId = seedOpportunity(storage);
    return await fn({ storage, dbPath, oppId });
  } finally {
    try { storage.close(); } catch { /* may already be closed */ }
    removeDb(dbPath);
  }
}
const n = (storage, sql, params = []) => storage.get(sql, params).n;
const checkpoints = (storage) => storage.all('SELECT checkpoint FROM research_checkpoints ORDER BY checkpoint').map((r) => r.checkpoint);
const cpRow = (storage) => storage.get("SELECT payload FROM research_checkpoints WHERE checkpoint = 'CONTRADICTION_PERSISTED'");
const pairRows = (storage) => n(storage, "SELECT COUNT(*) n FROM decision_log WHERE stage = 'CONTRADICTION_CHECK' AND subject_type = 'claim'");

// ---------------------------------------------------------------- schema

test('migration 0030 permits CONTRADICTION_PERSISTED and keeps every existing checkpoint value and constraint', async () => {
  await withDb(async ({ storage, oppId }) => {
    const ins = (cp, id = cp) => storage.run(
      'INSERT INTO research_checkpoints (id, research_project_id, checkpoint, payload, created_at) VALUES (?, ?, ?, ?, ?)',
      [id, 'p1', cp, '{}', 'now']
    );
    storage.run("INSERT INTO research_projects (id, opportunity_id, status, created_at) VALUES ('p1', ?, 'RESEARCHING', 'now')", [oppId]);
    for (const cp of ['SOURCES_PERSISTED', 'EXTRACTION_PERSISTED', 'EXPANSION_PERSISTED', 'CONTRADICTION_PERSISTED']) ins(cp);
    assert.throws(() => ins('SOURCES_PERSISTED', 'dup'), /UNIQUE/, 'one row per (project, checkpoint)');
    assert.throws(() => ins('NOPE'), /CHECK/, 'unknown checkpoint values are still refused');
    assert.throws(() => storage.run(
      "INSERT INTO research_checkpoints (id, research_project_id, checkpoint, payload, created_at) VALUES ('fk', 'missing', 'SOURCES_PERSISTED', '{}', 'now')"
    ), /FOREIGN KEY/, 'foreign key to research_projects retained');
  });
});

test('classifyContradictionFailure: local workload budget never skips a pair (UNCLASSIFIED), provider failures keep their nature', () => {
  assert.equal(classifyContradictionFailure(new LlmWorkloadError(WORKLOAD_ERROR_CODE.BUDGET_EXHAUSTED, 'x')), NATURE.UNCLASSIFIED);
  assert.equal(classifyContradictionFailure(httpError(503)), NATURE.TRANSIENT);
  assert.equal(classifyContradictionFailure(httpError(401)), NATURE.INFRASTRUCTURE);
  assert.equal(classifyContradictionFailure(new Error('boom')), NATURE.UNCLASSIFIED);
});

// ---------------------------------------------------------------- A: fresh run

test('A. fresh run: relations, pair decisions and the checkpoint all persist', async () => {
  await withDb(async ({ storage, oppId }) => {
    const detector = scriptedDetector([C, N, N]);
    const result = await runPipeline(storage, oppId, detector);
    assert.equal(detector.calls, 3);
    assert.notEqual(result.project.status, 'RESEARCHING');
    assert.equal(n(storage, 'SELECT COUNT(*) n FROM claim_relations'), 1);
    assert.equal(pairRows(storage), 3);
    assert.ok(checkpoints(storage).includes(RESEARCH_CHECKPOINT.CONTRADICTION_PERSISTED));
    assert.deepEqual(JSON.parse(cpRow(storage).payload), { pairsChecked: 3, contradicts: true, uncertain: false });
    // Existing checkpoints are unchanged.
    assert.ok(checkpoints(storage).includes('SOURCES_PERSISTED') && checkpoints(storage).includes('EXTRACTION_PERSISTED'));
  });
});

test('no checkpoint is written when no detector is configured (nothing was checked)', async () => {
  await withDb(async ({ storage, oppId }) => {
    await runPipeline(storage, oppId, undefined);
    assert.ok(!checkpoints(storage).includes('CONTRADICTION_PERSISTED'));
  });
});

// ---------------------------------------------------------------- B: transient failure

test('B. transient detector failure: nothing persisted, no checkpoint, one RESEARCH attempt, then a clean retry completes', async () => {
  await withDb(async ({ storage, oppId }) => {
    const first = await runPipeline(storage, oppId, scriptedDetector([C, N, httpError(503)]));
    assert.equal(first.stopReason, 'RESEARCH_TRANSIENT_FAILURE');
    assert.deepEqual(first.attemptFailure, { nature: 'TRANSIENT', basis: 'contradiction:503' });
    assert.equal(first.project.status, 'RESEARCHING');
    assert.equal(n(storage, 'SELECT COUNT(*) n FROM claim_relations'), 0);
    assert.equal(pairRows(storage), 0, 'no pair decision rows (only the RESEARCH_ATTEMPT_FAILED row is logged)');
    assert.deepEqual(checkpoints(storage), ['EXTRACTION_PERSISTED', 'SOURCES_PERSISTED']);
    assert.equal(storage.get("SELECT attempt_count AS a FROM stage_retry_state WHERE stage = 'RESEARCH'").a, 1);

    const detector = scriptedDetector([N, N, C]);
    const second = await runPipeline(storage, oppId, detector);
    assert.equal(detector.calls, 3);
    assert.notEqual(second.project.status, 'RESEARCHING');
    assert.ok(checkpoints(storage).includes('CONTRADICTION_PERSISTED'));
    assert.equal(n(storage, 'SELECT COUNT(*) n FROM claim_relations'), 1);
  });
});

test('B. infrastructure detector failure: nothing persisted, no checkpoint, no attempt consumed; unknown error fails closed without a checkpoint', async () => {
  await withDb(async ({ storage, oppId }) => {
    const infra = await runPipeline(storage, oppId, scriptedDetector([N, httpError(401)]));
    assert.equal(infra.stopReason, 'RESEARCH_INFRASTRUCTURE_FAILURE');
    assert.equal(infra.project.status, 'RESEARCHING');
    assert.equal(n(storage, "SELECT COUNT(*) n FROM stage_retry_state WHERE stage = 'RESEARCH'"), 0);
    assert.ok(!checkpoints(storage).includes('CONTRADICTION_PERSISTED'));
    assert.equal(n(storage, "SELECT COUNT(*) n FROM decision_log WHERE stage = 'CONTRADICTION_CHECK' AND subject_type = 'claim'"), 0);

    const unknown = await runPipeline(storage, oppId, scriptedDetector([C, new Error('boom')]));
    assert.equal(unknown.project.status, 'FAILED');
    assert.equal(unknown.stopReason, 'CONTRADICTION_CHECK_FAILED');
    assert.ok(!checkpoints(storage).includes('CONTRADICTION_PERSISTED'));
  });
});

// ---------------------------------------------------------------- C: rollback

test('C. a failure inside the contradiction transaction rolls back results AND the checkpoint', async () => {
  await withDb(async ({ storage, oppId }) => {
    const run = storage.run.bind(storage);
    storage.run = (sql, params = []) => {
      if (/INSERT INTO research_checkpoints/.test(sql) && params.includes('CONTRADICTION_PERSISTED')) throw new Error('injected: checkpoint insert failed');
      return run(sql, params);
    };
    await assert.rejects(() => runPipeline(storage, oppId, scriptedDetector([C, N, N])), /injected/);
    assert.equal(n(storage, 'SELECT COUNT(*) n FROM claim_relations'), 0, 'relation rolled back');
    assert.equal(n(storage, "SELECT COUNT(*) n FROM decision_log WHERE stage = 'CONTRADICTION_CHECK'"), 0, 'pair decisions rolled back');
    assert.ok(!checkpoints(storage).includes('CONTRADICTION_PERSISTED'), 'checkpoint rolled back');
    assert.equal(storage.get('SELECT status FROM research_projects').status, 'RESEARCHING');
  });
});

test('C. fail-closed path is atomic too: a failure in the final project update rolls back the pair rows, the ERROR row and the FAILED row', async () => {
  await withDb(async ({ storage, oppId }) => {
    const run = storage.run.bind(storage);
    storage.run = (sql, params = []) => {
      if (/UPDATE research_projects SET status/.test(sql) && params.includes('CONTRADICTION_CHECK_FAILED')) throw new Error('injected: project update failed');
      return run(sql, params);
    };
    await assert.rejects(() => runPipeline(storage, oppId, scriptedDetector([C, new Error('boom')])), /injected/);
    assert.equal(n(storage, 'SELECT COUNT(*) n FROM claim_relations'), 0);
    assert.equal(n(storage, "SELECT COUNT(*) n FROM decision_log WHERE stage = 'CONTRADICTION_CHECK'"), 0);
    assert.equal(storage.get('SELECT status FROM research_projects').status, 'RESEARCHING');
    assert.ok(!checkpoints(storage).includes('CONTRADICTION_PERSISTED'));
  });
});

// ---------------------------------------------------------------- D: recovery skips detection

test('D. recovery after a committed contradiction pass makes ZERO detector calls and continues downstream', async () => {
  await withDb(async ({ storage, oppId }) => {
    const first = await runPipeline(storage, oppId, scriptedDetector([C, N, N]));
    // Simulate "interrupted after contradiction commit": the project is still being researched.
    storage.run("UPDATE research_projects SET status = 'RESEARCHING', stop_reason = NULL, completed_at = NULL");
    storage.run("DELETE FROM research_checkpoints WHERE checkpoint = 'EXPANSION_PERSISTED'");
    const relationsBefore = n(storage, 'SELECT COUNT(*) n FROM claim_relations');
    const pairsBefore = pairRows(storage);

    const detector = scriptedDetector([N, N, C]);
    const second = await runPipeline(storage, oppId, detector);
    assert.equal(detector.calls, 0, 'detector is never called again');
    assert.equal(n(storage, 'SELECT COUNT(*) n FROM claim_relations'), relationsBefore);
    assert.equal(pairRows(storage), pairsBefore, 'no duplicated pair decision rows');
    assert.notEqual(second.project.status, 'RESEARCHING', 'downstream grading and completeness still ran');
    assert.equal(second.project.status, first.project.status);
  });
});

// ---------------------------------------------------------------- E: real hard kill

function crash(dbPath, oppId, mode, verdicts) {
  const res = spawnSync(process.execPath, [CHILD, dbPath, oppId, mode, verdicts.join(',')], { encoding: 'utf8' });
  // The child writes a marker immediately before killing itself, so we know the kill point was reached.
  assert.ok(fs.existsSync(`${dbPath}.killed`), `kill point never reached (status=${res.status}, signal=${res.signal}, stderr=${res.stderr})`);
  // POSIX reports SIGKILL; Windows has no signals and reports a non-zero exit status instead.
  const died = res.signal === 'SIGKILL' || (process.platform === 'win32' && res.status !== 0 && res.status !== null);
  assert.ok(died, `child must be hard-killed (status=${res.status}, signal=${res.signal})`);
}

test('E. SIGKILL before the contradiction transaction commits leaves no checkpoint and no partial rows; recovery re-runs detection', async () => {
  await withDb(async ({ storage, dbPath, oppId }) => {
    storage.close();
    crash(dbPath, oppId, 'before', [C, N, N]);
    const reopened = openDb(dbPath);
    try {
      assert.ok(!checkpoints(reopened).includes('CONTRADICTION_PERSISTED'));
      assert.equal(n(reopened, 'SELECT COUNT(*) n FROM claim_relations'), 0);
      assert.equal(n(reopened, "SELECT COUNT(*) n FROM decision_log WHERE stage = 'CONTRADICTION_CHECK'"), 0);
      const detector = scriptedDetector([C, N, N]);
      await runPipeline(reopened, oppId, detector);
      assert.equal(detector.calls, 3, 'nothing was committed, so detection runs');
      assert.ok(checkpoints(reopened).includes('CONTRADICTION_PERSISTED'));
    } finally { reopened.close(); }
  });
});

test('E. SIGKILL after the contradiction transaction commits leaves the checkpoint durable; recovery skips detection', async () => {
  await withDb(async ({ storage, dbPath, oppId }) => {
    storage.close();
    crash(dbPath, oppId, 'after', [C, N, N]);
    const reopened = openDb(dbPath);
    try {
      assert.ok(checkpoints(reopened).includes('CONTRADICTION_PERSISTED'));
      assert.equal(n(reopened, 'SELECT COUNT(*) n FROM claim_relations'), 1);
      assert.equal(reopened.get('SELECT status FROM research_projects').status, 'RESEARCHING', 'killed before grading');
      const detector = scriptedDetector([N, N, C]);
      const result = await runPipeline(reopened, oppId, detector);
      assert.equal(detector.calls, 0);
      assert.notEqual(result.project.status, 'RESEARCHING');
    } finally { reopened.close(); }
  });
});

// ---------------------------------------------------------------- F: replay equivalence

test('F. interrupted-after-commit then recovered == clean run, even when the replay detector would have disagreed', async () => {
  let clean;
  await withDb(async ({ storage, oppId }) => {
    await runPipeline(storage, oppId, scriptedDetector([C, N, N]));
    clean = snapshot(storage);
  });
  let recovered;
  await withDb(async ({ storage, dbPath, oppId }) => {
    storage.close();
    crash(dbPath, oppId, 'after', [C, N, N]);
    const reopened = openDb(dbPath);
    try {
      const detector = scriptedDetector([N, N, C]); // would produce a DIFFERENT relation set if it ever ran
      await runPipeline(reopened, oppId, detector);
      assert.equal(detector.calls, 0);
      recovered = snapshot(reopened);
    } finally { reopened.close(); }
  });
  assert.deepEqual(recovered.relations, clean.relations, 'contradiction relations');
  assert.deepEqual(recovered.contradictionDecisions, clean.contradictionDecisions, 'decision-log semantics (3 pair rows, not 6)');
  assert.deepEqual(recovered.statuses, clean.statuses, 'claim statuses');
  assert.deepEqual(recovered.grading, clean.grading, 'evidence grading');
  assert.deepEqual(recovered.project, clean.project, 'terminal research outcome');
  assert.equal(recovered.contradictionDecisions.filter((r) => r.endsWith('| CONTRADICTS')).length, 1);
});
