import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { SqliteStorageDriver } from '../../src/storage/SqliteStorageDriver.js';
import { createBrief } from '../../src/brief/pipeline.js';
import { recordContradiction } from '../../src/research/contradictions.js';
import { runAutonomousOperation } from '../../src/autonomous/runner.js';
import { selectEligibleBriefs } from '../../src/autonomous/workSelection.js';

// Regression: autonomous run 36657720158. RESEARCH_COMPLETE projects with zero
// Brief-eligible key claims were rejected NO_ELIGIBLE_KEY_CLAIMS on every sweep
// and every run (no A4 attempt/quarantine, no state change), ending in
// no_progress. The gate is preserved; selection now excludes them while they
// stay claimless.

function freshStorage() {
  const dbPath = path.join(os.tmpdir(), `brief-kc-selection-${Date.now()}-${Math.random()}.db`);
  return { storage: new SqliteStorageDriver({ dbPath }), dbPath };
}

function cleanup(storage, dbPath) {
  storage.close();
  for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) fs.rmSync(f, { force: true });
}

function seedProject(storage) {
  const opportunityId = crypto.randomUUID();
  storage.run(
    `INSERT INTO opportunities (id, title, source, discovered_at, status, opportunity_proposition)
     VALUES (?, 'x', 'rss', ?, 'RESEARCH_HANDED_OFF_TEST_FIXTURE', ?)`,
    [opportunityId, new Date().toISOString(), JSON.stringify({ core_question: 'q' })]
  );
  const id = crypto.randomUUID();
  storage.run(
    `INSERT INTO research_projects (id, opportunity_id, status, created_at) VALUES (?, ?, 'RESEARCH_COMPLETE', ?)`,
    [id, opportunityId, new Date().toISOString()]
  );
  return id;
}

function addClaim(storage, projectId, claimType, evidenceStatus) {
  const id = crypto.randomUUID();
  storage.run(
    `INSERT INTO claims (id, research_project_id, claim, claim_type, evidence_status, is_load_bearing, created_at)
     VALUES (?, ?, 'c', ?, ?, 1, ?)`,
    [id, projectId, claimType, evidenceStatus, new Date().toISOString()]
  );
  return id;
}

const ids = (storage) => selectEligibleBriefs(storage).map((i) => i.researchProjectId);
const keyClaimRejections = (storage, projectId) =>
  storage.all(
    `SELECT 1 FROM decision_log WHERE stage = 'BRIEF_KEY_CLAIM_ELIGIBILITY' AND decision = 'REJECTED'
     AND reason = 'NO_ELIGIBLE_KEY_CLAIMS' AND subject_id = ?`,
    [projectId]
  ).length;

test('gate preserved: no VERIFIED FACT/INFERENCE claim still yields NO_ELIGIBLE_KEY_CLAIMS on direct createBrief', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const p = seedProject(storage);
  addClaim(storage, p, 'OPINION', 'VERIFIED');
  addClaim(storage, p, 'FACT', 'PARTIALLY_SUPPORTED');
  const contested = addClaim(storage, p, 'FACT', 'VERIFIED');
  const other = addClaim(storage, p, 'FACT', 'VERIFIED');
  recordContradiction(storage, { claimId: contested, relatedClaimId: other });

  const r = await createBrief({ storage, researchProjectId: p, llmRouter: null, policy: {} });
  // contested+other are both contradiction participants -> none eligible
  assert.equal(r.rejected, true);
  assert.equal(r.reason, 'NO_ELIGIBLE_KEY_CLAIMS');
  assert.equal(keyClaimRejections(storage, p), 1);
  // repeated direct invocation still re-validates and still rejects
  const again = await createBrief({ storage, researchProjectId: p, llmRouter: null, policy: {} });
  assert.equal(again.reason, 'NO_ELIGIBLE_KEY_CLAIMS');
  cleanup(storage, dbPath);
});

test('selection: evaluated once (gate runs and logs), then excluded while still claimless', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const p = seedProject(storage);
  addClaim(storage, p, 'OPINION', 'VERIFIED');

  assert.deepEqual(ids(storage), [p], 'not yet evaluated -> selectable so the gate runs');
  await createBrief({ storage, researchProjectId: p, llmRouter: null, policy: {} });
  assert.deepEqual(ids(storage), [], 'deterministically rejected -> no longer selected');
  cleanup(storage, dbPath);
});

test('selection: genuinely eligible Brief work stays selectable next to an excluded item', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const bad = seedProject(storage);
  const good = seedProject(storage);
  addClaim(storage, good, 'FACT', 'VERIFIED');
  await createBrief({ storage, researchProjectId: bad, llmRouter: null, policy: {} });

  assert.deepEqual(ids(storage), [good]);
  cleanup(storage, dbPath);
});

test('selection: exclusion self-heals if a key claim later becomes eligible', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const p = seedProject(storage);
  const claim = addClaim(storage, p, 'FACT', 'PARTIALLY_SUPPORTED');
  await createBrief({ storage, researchProjectId: p, llmRouter: null, policy: {} });
  assert.deepEqual(ids(storage), []);

  storage.run(`UPDATE claims SET evidence_status = 'VERIFIED' WHERE id = ?`, [claim]);
  assert.deepEqual(ids(storage), [p], 'now has an eligible key claim -> selectable again');
  cleanup(storage, dbPath);
});

test('runner: claimless projects are evaluated once, then the next invocation terminates with no_work (no repeated selection)', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const bad = [seedProject(storage), seedProject(storage), seedProject(storage)];
  for (const p of bad) addClaim(storage, p, 'OPINION', 'VERIFIED');

  const first = await runAutonomousOperation({ storage });
  assert.equal(first.processed.find((x) => x.stage === 'brief').count, 3, 'each evaluated exactly once, not once per sweep');
  for (const p of bad) assert.equal(keyClaimRejections(storage, p), 1, 'one rejection per project across all sweeps');

  const second = await runAutonomousOperation({ storage });
  assert.equal(second.stopReason, 'no_work');
  assert.equal((second.processed.find((x) => x.stage === 'brief')?.count ?? 0), 0);
  for (const p of bad) assert.equal(keyClaimRejections(storage, p), 1, 'not re-processed by the second run');
  cleanup(storage, dbPath);
});

test('runner: an eligible Brief is still attempted while excluded projects are not', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const bad = seedProject(storage);
  await createBrief({ storage, researchProjectId: bad, llmRouter: null, policy: {} });
  const good = seedProject(storage);
  addClaim(storage, good, 'FACT', 'VERIFIED');

  const called = [];
  await runAutonomousOperation({
    storage,
    stageFns: {
      brief: async ({ researchProjectId }) => {
        called.push(researchProjectId);
        return { rejected: true, reason: 'STUB' };
      }
    }
  });
  assert.deepEqual(called, [good]);
  cleanup(storage, dbPath);
});
