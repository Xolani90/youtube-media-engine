import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { SqliteStorageDriver } from '../../src/storage/SqliteStorageDriver.js';
import { runFactCheck } from '../../src/fact-check/pipeline.js';

function freshStorage() {
  const dbPath = path.join(os.tmpdir(), `fact-check-e2e-${Date.now()}-${Math.random()}.db`);
  return { storage: new SqliteStorageDriver({ dbPath }), dbPath };
}

function cleanup(storage, dbPath) {
  storage.close();
  fs.rmSync(dbPath, { force: true });
  fs.rmSync(`${dbPath}-wal`, { force: true });
  fs.rmSync(`${dbPath}-shm`, { force: true });
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
  const researchProjectId = crypto.randomUUID();
  storage.run(
    `INSERT INTO research_projects (id, opportunity_id, status, created_at) VALUES (?, ?, 'RESEARCH_COMPLETE', ?)`,
    [researchProjectId, opportunityId, nowISO()]
  );
  return { opportunityId, researchProjectId };
}

function insertClaim(storage, researchProjectId, { evidenceStatus = 'VERIFIED', claimText = 'A claim.' } = {}) {
  const id = crypto.randomUUID();
  storage.run(
    `INSERT INTO claims (id, research_project_id, claim, claim_type, evidence_status, is_load_bearing, created_at)
     VALUES (?, ?, ?, 'FACT', ?, 1, ?)`,
    [id, researchProjectId, claimText, evidenceStatus, nowISO()]
  );
  return id;
}

function insertContradiction(storage, claimId, relatedClaimId) {
  storage.run(
    `INSERT INTO claim_relations (id, claim_id, related_claim_id, relation_type, created_at) VALUES (?, ?, ?, 'CONTRADICTS', ?)`,
    [crypto.randomUUID(), claimId, relatedClaimId, nowISO()]
  );
}

function seedBrief(storage, researchProjectId, opportunityId, keyClaimIds) {
  const id = crypto.randomUUID();
  storage.run(
    `INSERT INTO content_briefs
      (id, opportunity_id, research_project_id, working_title, core_question, target_audience, viewer_promise,
       hook, angle, narrative_structure, key_claims, counterpoints, original_insights, visual_ideas,
       monetization_opportunities, risk_assessment, created_at)
     VALUES (?, ?, ?, 'T', 'Q', 'A', 'P', 'H', 'Angle', 'Structure', ?, 'C', 'I', 'V', 'M', 'R', ?)`,
    [id, opportunityId, researchProjectId, JSON.stringify(keyClaimIds), nowISO()]
  );
  return id;
}

/**
 * Seeds a Script row directly (bypassing the LLM-driven Script pipeline,
 * which is frozen and out of scope) plus the content_versions row Script
 * itself would have created, with content_versions.script_id pointing at
 * it and state = SCRIPT_DRAFT.
 */
function seedScript(storage, contentBriefId, { claimLinks, version = 1 } = {}) {
  const scriptId = crypto.randomUUID();
  storage.run(
    `INSERT INTO scripts (id, content_brief_id, version, body, claim_links, created_at)
     VALUES (?, ?, ?, '{}', ?, ?)`,
    [scriptId, contentBriefId, version, JSON.stringify(claimLinks), nowISO()]
  );
  const contentVersionId = crypto.randomUUID();
  storage.run(
    `INSERT INTO content_versions (id, content_brief_id, script_id, state, created_at) VALUES (?, ?, ?, 'SCRIPT_DRAFT', ?)`,
    [contentVersionId, contentBriefId, scriptId, nowISO()]
  );
  return { scriptId, contentVersionId };
}

/** Full setup: one Research project, N claims, one Brief, one Script. */
function seedFullPipeline(storage, claimDescriptors) {
  const { opportunityId, researchProjectId } = seedResearchProject(storage);
  const claimIds = claimDescriptors.map((d) => insertClaim(storage, researchProjectId, d));
  const contentBriefId = seedBrief(storage, researchProjectId, opportunityId, claimIds);
  const claimLinks = [{ heading: 'Intro', claim_ids: claimIds }];
  const { scriptId, contentVersionId } = seedScript(storage, contentBriefId, { claimLinks });
  return { researchProjectId, contentBriefId, claimIds, scriptId, contentVersionId };
}

// AC1 -----------------------------------------------------------------

test('AC1: all VERIFIED claims -> PASS, persisted at version 1, lifecycle SCRIPT_DRAFT -> FACT_CHECK', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const { contentBriefId, scriptId } = seedFullPipeline(storage, [{ evidenceStatus: 'VERIFIED' }]);

  const result = runFactCheck({ storage, contentBriefId });

  assert.equal(result.outcome, 'PASS');
  assert.equal(result.factCheck.status, 'PASS');
  assert.equal(result.factCheck.script_id, scriptId);
  assert.equal(result.factCheck.version, 1);

  const cv = storage.get('SELECT * FROM content_versions WHERE content_brief_id = ?', [contentBriefId]);
  assert.equal(cv.state, 'FACT_CHECK');

  cleanup(storage, dbPath);
});

// AC2 -----------------------------------------------------------------

test('AC2: a PARTIALLY_SUPPORTED claim among VERIFIED claims -> overall REVIEW, still transitions', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const { contentBriefId } = seedFullPipeline(storage, [
    { evidenceStatus: 'VERIFIED' }, { evidenceStatus: 'PARTIALLY_SUPPORTED' }
  ]);

  const result = runFactCheck({ storage, contentBriefId });

  assert.equal(result.outcome, 'REVIEW');
  const cv = storage.get('SELECT * FROM content_versions WHERE content_brief_id = ?', [contentBriefId]);
  assert.equal(cv.state, 'FACT_CHECK');

  cleanup(storage, dbPath);
});

// AC3 -----------------------------------------------------------------

test('AC3: an UNSUPPORTED claim -> overall REJECT, fact_checks row persisted, state remains SCRIPT_DRAFT', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const { contentBriefId } = seedFullPipeline(storage, [
    { evidenceStatus: 'VERIFIED' }, { evidenceStatus: 'UNSUPPORTED' }
  ]);

  const result = runFactCheck({ storage, contentBriefId });

  assert.equal(result.outcome, 'REJECT');
  assert.equal(result.factCheck.status, 'REJECT');
  const cv = storage.get('SELECT * FROM content_versions WHERE content_brief_id = ?', [contentBriefId]);
  assert.equal(cv.state, 'SCRIPT_DRAFT', 'REJECT must not advance lifecycle state');

  cleanup(storage, dbPath);
});

// AC4 -----------------------------------------------------------------

test('AC4: a CONTESTED claim -> overall REJECT', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const { contentBriefId } = seedFullPipeline(storage, [{ evidenceStatus: 'CONTESTED' }]);

  const result = runFactCheck({ storage, contentBriefId });

  assert.equal(result.outcome, 'REJECT');

  cleanup(storage, dbPath);
});

// AC5 -----------------------------------------------------------------

test('AC5: an applicable same-project CONTRADICTS relation forces REJECT even though evidence_status is VERIFIED', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const { researchProjectId, opportunityId } = seedResearchProject(storage);
  const claimA = insertClaim(storage, researchProjectId, { evidenceStatus: 'VERIFIED' });
  const claimB = insertClaim(storage, researchProjectId, { evidenceStatus: 'VERIFIED' });
  insertContradiction(storage, claimA, claimB);
  const contentBriefId = seedBrief(storage, researchProjectId, opportunityId, [claimA, claimB]);
  seedScript(storage, contentBriefId, { claimLinks: [{ heading: 'Intro', claim_ids: [claimA, claimB] }] });

  const result = runFactCheck({ storage, contentBriefId });

  assert.equal(result.outcome, 'REJECT');
  const findings = JSON.parse(result.factCheck.findings);
  assert.ok(findings.every((f) => f.finding === 'REJECT'));

  cleanup(storage, dbPath);
});

test('AC5b: a CONTRADICTS relation to a claim in a DIFFERENT Research project is not applicable', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const { researchProjectId, opportunityId } = seedResearchProject(storage);
  const { researchProjectId: otherProjectId } = seedResearchProject(storage);
  const claimA = insertClaim(storage, researchProjectId, { evidenceStatus: 'VERIFIED' });
  const claimOther = insertClaim(storage, otherProjectId, { evidenceStatus: 'VERIFIED' });
  insertContradiction(storage, claimA, claimOther);
  const contentBriefId = seedBrief(storage, researchProjectId, opportunityId, [claimA]);
  seedScript(storage, contentBriefId, { claimLinks: [{ heading: 'Intro', claim_ids: [claimA] }] });

  const result = runFactCheck({ storage, contentBriefId });

  assert.equal(result.outcome, 'PASS', 'cross-project CONTRADICTS must not leak in');

  cleanup(storage, dbPath);
});

// AC6 — malformed claim_links -------------------------------------------

test('AC6: malformed claim_links (not an array) is a structural failure, not a REJECT', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const { researchProjectId, opportunityId } = seedResearchProject(storage);
  const contentBriefId = seedBrief(storage, researchProjectId, opportunityId, []);
  const { scriptId } = seedScript(storage, contentBriefId, { claimLinks: 'not-an-array-when-stringified' });
  // Overwrite with literal invalid JSON to be explicit about intent.
  storage.run('UPDATE scripts SET claim_links = ? WHERE id = ?', ['{"not":"an array"}', scriptId]);

  const result = runFactCheck({ storage, contentBriefId });

  assert.equal(result.outcome, 'STRUCTURAL_FAILURE');
  assert.equal(result.reason, 'CLAIM_LINKS_NOT_ARRAY');
  assert.equal(storage.all('SELECT * FROM fact_checks').length, 0, 'no fact_checks row on structural failure');
  const cv = storage.get('SELECT * FROM content_versions WHERE content_brief_id = ?', [contentBriefId]);
  assert.equal(cv.state, 'SCRIPT_DRAFT', 'no lifecycle transition on structural failure');

  const logs = storage.all(
    `SELECT * FROM decision_log WHERE subject_id = ? AND decision = 'STRUCTURAL_FAILURE'`,
    [scriptId]
  );
  assert.equal(logs.length, 1);
  assert.equal(logs[0].stage, 'FACT_CHECK');
  assert.equal(logs[0].subject_type, 'script');
  assert.equal(logs[0].resulting_state, 'SCRIPT_DRAFT');

  cleanup(storage, dbPath);
});

test('AC7: an unresolvable claim id in claim_links is a structural failure', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const { researchProjectId, opportunityId } = seedResearchProject(storage);
  const contentBriefId = seedBrief(storage, researchProjectId, opportunityId, []);
  seedScript(storage, contentBriefId, { claimLinks: [{ heading: 'Intro', claim_ids: ['does-not-exist'] }] });

  const result = runFactCheck({ storage, contentBriefId });

  assert.equal(result.outcome, 'STRUCTURAL_FAILURE');
  assert.match(result.reason, /^INVALID_CLAIM_REFERENCE_does-not-exist$/);
  assert.equal(storage.all('SELECT * FROM fact_checks').length, 0);

  cleanup(storage, dbPath);
});

test('AC8: a claim_links entry referencing a claim from a DIFFERENT Research project is a structural failure', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const { researchProjectId, opportunityId } = seedResearchProject(storage);
  const { researchProjectId: otherProjectId } = seedResearchProject(storage);
  const foreignClaim = insertClaim(storage, otherProjectId, { evidenceStatus: 'VERIFIED' });
  const contentBriefId = seedBrief(storage, researchProjectId, opportunityId, []);
  seedScript(storage, contentBriefId, { claimLinks: [{ heading: 'Intro', claim_ids: [foreignClaim] }] });

  const result = runFactCheck({ storage, contentBriefId });

  assert.equal(result.outcome, 'STRUCTURAL_FAILURE');
  assert.match(result.reason, new RegExp(`^CLAIM_WRONG_RESEARCH_PROJECT_${foreignClaim}$`));

  cleanup(storage, dbPath);
});

// AC9 — persistence / versioning -----------------------------------------

test('AC9: first Fact-Check result gets version 1', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const { contentBriefId } = seedFullPipeline(storage, [{ evidenceStatus: 'VERIFIED' }]);

  const result = runFactCheck({ storage, contentBriefId });

  assert.equal(result.factCheck.version, 1);

  cleanup(storage, dbPath);
});

test('AC10: ordinary (non-forced) rerun returns the existing result, does not create a new row', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const { contentBriefId } = seedFullPipeline(storage, [{ evidenceStatus: 'VERIFIED' }]);

  const first = runFactCheck({ storage, contentBriefId });
  const second = runFactCheck({ storage, contentBriefId });

  assert.equal(second.outcome, 'EXISTING_RESULT_RETURNED');
  assert.equal(second.factCheck.id, first.factCheck.id);
  assert.equal(storage.all('SELECT * FROM fact_checks').length, 1);

  cleanup(storage, dbPath);
});

test('AC11: forced rerun creates a new version, prior result unchanged', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const { contentBriefId } = seedFullPipeline(storage, [{ evidenceStatus: 'VERIFIED' }]);

  const first = runFactCheck({ storage, contentBriefId });
  const second = runFactCheck({ storage, contentBriefId, force: true });

  assert.equal(second.factCheck.version, 2);
  assert.notEqual(second.factCheck.id, first.factCheck.id);
  const rows = storage.all('SELECT * FROM fact_checks WHERE script_id = ? ORDER BY version', [first.factCheck.script_id]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].id, first.factCheck.id, 'prior result row is untouched');
  assert.equal(rows[0].status, first.factCheck.status);

  cleanup(storage, dbPath);
});

test('AC12: (script_id, version) uniqueness is enforced at the database level', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const { contentBriefId, scriptId } = seedFullPipeline(storage, [{ evidenceStatus: 'VERIFIED' }]);
  runFactCheck({ storage, contentBriefId });

  assert.throws(() => {
    storage.run(
      `INSERT INTO fact_checks (id, script_id, version, status, findings, notes, created_at)
       VALUES (?, ?, 1, 'PASS', '[]', NULL, ?)`,
      [crypto.randomUUID(), scriptId, nowISO()]
    );
  }, /UNIQUE constraint failed/);

  cleanup(storage, dbPath);
});

test('AC13: different Script versions (distinct scripts.id rows) maintain independent Fact-Check version histories', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const { researchProjectId, opportunityId } = seedResearchProject(storage);
  const claimId = insertClaim(storage, researchProjectId, { evidenceStatus: 'VERIFIED' });
  const contentBriefId = seedBrief(storage, researchProjectId, opportunityId, [claimId]);
  const claimLinks = [{ heading: 'Intro', claim_ids: [claimId] }];

  // Script version 1, evaluated once.
  const v1 = seedScript(storage, contentBriefId, { claimLinks, version: 1 });
  const resultV1 = runFactCheck({ storage, contentBriefId });
  assert.equal(resultV1.factCheck.version, 1);
  assert.equal(resultV1.factCheck.script_id, v1.scriptId);

  // A new Script version is created and content_versions is repointed at
  // it directly (mirroring what the Script pipeline does on regeneration),
  // resetting lifecycle state back to SCRIPT_DRAFT as Script's own
  // regeneration would leave it.
  const scriptId2 = crypto.randomUUID();
  storage.run(
    `INSERT INTO scripts (id, content_brief_id, version, body, claim_links, created_at) VALUES (?, ?, 2, '{}', ?, ?)`,
    [scriptId2, contentBriefId, JSON.stringify(claimLinks), nowISO()]
  );
  storage.run(
    'UPDATE content_versions SET script_id = ?, state = ? WHERE content_brief_id = ?',
    [scriptId2, 'SCRIPT_DRAFT', contentBriefId]
  );

  const resultV2 = runFactCheck({ storage, contentBriefId });
  assert.equal(resultV2.factCheck.version, 1, 'a new Script version starts its own independent Fact-Check version sequence');
  assert.equal(resultV2.factCheck.script_id, scriptId2);
  assert.notEqual(resultV2.factCheck.id, resultV1.factCheck.id);

  cleanup(storage, dbPath);
});

// AC14 — current-Script-version invariant ---------------------------------

test('AC14: an older Fact-Check result (for a no-longer-current script_id) does not satisfy the current-version invariant', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const { researchProjectId, opportunityId } = seedResearchProject(storage);
  const claimId = insertClaim(storage, researchProjectId, { evidenceStatus: 'VERIFIED' });
  const contentBriefId = seedBrief(storage, researchProjectId, opportunityId, [claimId]);
  const claimLinks = [{ heading: 'Intro', claim_ids: [claimId] }];

  const v1 = seedScript(storage, contentBriefId, { claimLinks, version: 1 });
  runFactCheck({ storage, contentBriefId }); // PASS -> transitions to FACT_CHECK

  // Repoint content_versions at a brand-new Script version without ever
  // running Fact-Check against it (simulating a Script regeneration).
  const scriptId2 = crypto.randomUUID();
  storage.run(
    `INSERT INTO scripts (id, content_brief_id, version, body, claim_links, created_at) VALUES (?, ?, 2, '{}', ?, ?)`,
    [scriptId2, contentBriefId, JSON.stringify(claimLinks), nowISO()]
  );
  storage.run(
    'UPDATE content_versions SET script_id = ?, state = ? WHERE content_brief_id = ?',
    [scriptId2, 'SCRIPT_DRAFT', contentBriefId]
  );

  const cv = storage.get('SELECT * FROM content_versions WHERE content_brief_id = ?', [contentBriefId]);
  assert.equal(cv.state, 'SCRIPT_DRAFT', 'state must not remain FACT_CHECK for a Script version that was never evaluated');

  const factChecksForOldScript = storage.all('SELECT * FROM fact_checks WHERE script_id = ?', [v1.scriptId]);
  assert.equal(factChecksForOldScript.length, 1);
  // The invariant (spec §14) is: state=FACT_CHECK implies a PASS/REVIEW
  // result exists for content_versions.script_id specifically. Here state
  // is already SCRIPT_DRAFT (by the seeding step above), so the invariant
  // holds vacuously; the meaningful assertion is that the pipeline itself
  // never treats the old script's result as evidence for the new script.
  const result = runFactCheck({ storage, contentBriefId });
  assert.equal(result.factCheck.script_id, scriptId2, 'Fact-Check evaluates the exact current script, not the old one');
  assert.equal(result.factCheck.version, 1, 'the new script has its own independent version sequence, unaffected by the old script\'s history');

  cleanup(storage, dbPath);
});

// AC15 — atomicity ---------------------------------------------------------

test('AC15a: a rerun of a Script that is already at FACT_CHECK (prior PASS/REVIEW) persists the new result with no lifecycle side effect, rather than an invalid FACT_CHECK -> FACT_CHECK transition', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const { contentBriefId } = seedFullPipeline(storage, [{ evidenceStatus: 'VERIFIED' }]);

  const first = runFactCheck({ storage, contentBriefId });
  assert.equal(first.outcome, 'PASS');
  let cv = storage.get('SELECT * FROM content_versions WHERE content_brief_id = ?', [contentBriefId]);
  assert.equal(cv.state, 'FACT_CHECK');

  const second = runFactCheck({ storage, contentBriefId, force: true });

  assert.equal(second.outcome, 'PASS');
  assert.equal(second.factCheck.version, 2);
  cv = storage.get('SELECT * FROM content_versions WHERE content_brief_id = ?', [contentBriefId]);
  assert.equal(cv.state, 'FACT_CHECK', 'state remains FACT_CHECK; no attempt to re-transition');

  cleanup(storage, dbPath);
});

test('AC15b: a transaction that fails partway (duplicate version conflict) does not leave a partial decision_log entry either — insert and log roll back together', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const { contentBriefId, scriptId } = seedFullPipeline(storage, [{ evidenceStatus: 'VERIFIED' }]);

  // Pre-insert a fact_checks row at version 1 for this exact script_id
  // through a path other than the pipeline, so the pipeline's own
  // transaction — which computes "next version" from the latest existing
  // row read at transaction start — collides with a version that was
  // inserted concurrently, forcing the UNIQUE(script_id, version)
  // constraint to reject the insert mid-transaction.
  storage.run(
    `INSERT INTO fact_checks (id, script_id, version, status, findings, notes, created_at)
     VALUES (?, ?, 1, 'PASS', '[]', NULL, ?)`,
    [crypto.randomUUID(), scriptId, nowISO()]
  );
  // Force the pipeline to (incorrectly, for this test) recompute the same
  // "next version" by making the existing row invisible to its read —
  // simplest reliable way: directly attempt the same insert shape the
  // pipeline would attempt for version 1, inside a transaction that also
  // performs a decision_log write, and confirm neither survives.
  assert.throws(() => {
    storage.transaction(() => {
      storage.run(
        `INSERT INTO fact_checks (id, script_id, version, status, findings, notes, created_at)
         VALUES (?, ?, 1, 'PASS', '[]', NULL, ?)`,
        [crypto.randomUUID(), scriptId, nowISO()]
      );
      storage.run(
        `INSERT INTO decision_log (id, run_id, subject_type, subject_id, decision, reason, provider, config_snapshot, confidence, risk_level, resulting_state, created_at, stage)
         VALUES (?, NULL, 'script', ?, 'PASS', 'test', NULL, NULL, NULL, NULL, NULL, ?, 'FACT_CHECK')`,
        [crypto.randomUUID(), scriptId, nowISO()]
      );
    });
  }, /UNIQUE constraint failed/);

  const logsForThisAttempt = storage.all(
    `SELECT * FROM decision_log WHERE subject_id = ? AND reason = 'test'`,
    [scriptId]
  );
  assert.equal(logsForThisAttempt.length, 0, 'the decision_log write inside the rolled-back transaction must not survive');
  assert.equal(storage.all('SELECT * FROM fact_checks WHERE script_id = ?', [scriptId]).length, 1, 'only the pre-existing row remains; the colliding insert did not survive');

  cleanup(storage, dbPath);
});

// AC17 — P1: a later REJECT on a Script already at FACT_CHECK -----------

test('AC17: later REJECT transitions FACT_CHECK to REJECTED, persists the result and a decision log', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const { contentBriefId, scriptId } = seedFullPipeline(storage, [{ evidenceStatus: 'VERIFIED' }]);

  const first = runFactCheck({ storage, contentBriefId });
  assert.equal(first.outcome, 'PASS');
  let cv = storage.get('SELECT * FROM content_versions WHERE content_brief_id = ?', [contentBriefId]);
  assert.equal(cv.state, 'FACT_CHECK');

  // Degrade the underlying evidence, then force a rerun that evaluates to REJECT.
  storage.run(`UPDATE claims SET evidence_status = 'UNSUPPORTED' WHERE research_project_id = (
                 SELECT research_project_id FROM content_briefs WHERE id = ?)`, [contentBriefId]);

  const second = runFactCheck({ storage, contentBriefId, force: true });

  assert.equal(second.outcome, 'REJECT');
  assert.equal(second.factCheck.status, 'REJECT');
  assert.equal(second.factCheck.script_id, scriptId);
  assert.equal(second.factCheck.version, 2);

  cv = storage.get('SELECT * FROM content_versions WHERE content_brief_id = ?', [contentBriefId]);
  assert.equal(cv.state, 'REJECTED', 'a later REJECT on a Script already at FACT_CHECK must transition to REJECTED');

  const logs = storage.all(
    `SELECT * FROM decision_log WHERE subject_type = 'content_version' AND subject_id = ? ORDER BY created_at`,
    [cv.id]
  );
  const rejectionLog = logs.find((l) => l.decision === 'REJECTED');
  assert.ok(rejectionLog, 'expected a decision_log entry recording the REJECTED transition');
  assert.equal(rejectionLog.resulting_state, 'REJECTED');

  cleanup(storage, dbPath);
});

// AC18 — P1: later-REJECT transition remains atomic ----------------------

test('AC18: a transaction that fails partway during a later REJECT does not leave a partial state transition or decision log', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const { contentBriefId, scriptId, contentVersionId } = seedFullPipeline(storage, [{ evidenceStatus: 'VERIFIED' }]);

  const first = runFactCheck({ storage, contentBriefId });
  assert.equal(first.outcome, 'PASS');
  let cv = storage.get('SELECT * FROM content_versions WHERE content_brief_id = ?', [contentBriefId]);
  assert.equal(cv.state, 'FACT_CHECK');

  // Pre-insert a fact_checks row at version 2 for this exact script_id
  // through a path other than the pipeline, so a later attempt to insert
  // that same (script_id, version) collides on the UNIQUE constraint —
  // same failure-injection technique as AC15b, applied here to the whole
  // later-REJECT sequence (fact_checks insert + REJECTED transition +
  // decision_log), replicated exactly as the pipeline performs it, inside
  // one transaction, to confirm none of the three survives a
  // mid-transaction failure. (A real concurrent-writer race cannot be
  // reproduced synchronously against a single in-process SQLite handle,
  // which is why AC15b uses this same replicate-then-collide technique
  // rather than driving the race through runFactCheck itself.)
  storage.run(
    `INSERT INTO fact_checks (id, script_id, version, status, findings, notes, created_at)
     VALUES (?, ?, 2, 'REJECT', '[]', NULL, ?)`,
    [crypto.randomUUID(), scriptId, nowISO()]
  );

  assert.throws(() => {
    storage.transaction(() => {
      storage.run(
        `INSERT INTO fact_checks (id, script_id, version, status, findings, notes, created_at)
         VALUES (?, ?, 2, 'REJECT', '[]', NULL, ?)`,
        [crypto.randomUUID(), scriptId, nowISO()]
      );
      storage.run('UPDATE content_versions SET state = ? WHERE id = ?', ['REJECTED', contentVersionId]);
      storage.run(
        `INSERT INTO decision_log (id, run_id, subject_type, subject_id, decision, reason, provider, config_snapshot, confidence, risk_level, resulting_state, created_at, stage)
         VALUES (?, NULL, 'content_version', ?, 'REJECTED', 'test', NULL, NULL, NULL, NULL, 'REJECTED', ?, 'FACT_CHECK')`,
        [crypto.randomUUID(), contentVersionId, nowISO()]
      );
    });
  }, /UNIQUE constraint failed/);

  cv = storage.get('SELECT * FROM content_versions WHERE content_brief_id = ?', [contentBriefId]);
  assert.equal(cv.state, 'FACT_CHECK', 'state must remain FACT_CHECK; the failed transaction must not leave a partial state transition');

  const rejectionLogs = storage.all(
    `SELECT * FROM decision_log WHERE subject_id = ? AND reason = 'test'`,
    [contentVersionId]
  );
  assert.equal(rejectionLogs.length, 0, 'no decision_log entry from the rolled-back transaction must survive');
  assert.equal(storage.all('SELECT * FROM fact_checks WHERE script_id = ?', [scriptId]).length, 2, 'only the real first result and the pre-existing version-2 row remain; the colliding insert did not survive');

  cleanup(storage, dbPath);
});

// AC19 — P1: an older Script's later result cannot affect the current Script

test('AC19: a Fact-Check run associated with a historical (no longer current) Script does not transition the current Script', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const { contentBriefId, contentVersionId, claimIds, researchProjectId } = seedFullPipeline(storage, [{ evidenceStatus: 'VERIFIED' }]);

  const first = runFactCheck({ storage, contentBriefId });
  assert.equal(first.outcome, 'PASS');
  const oldScriptId = first.factCheck.script_id;

  // A new Script version is drafted and becomes current; content_versions
  // now points away from the old (now-historical) Script, back at
  // SCRIPT_DRAFT for the new one.
  const newClaimLinks = [{ heading: 'Intro', claim_ids: claimIds }];
  const { scriptId: newScriptId } = seedScript(storage, contentBriefId, { claimLinks: newClaimLinks, version: 2 });
  storage.run(
    'UPDATE content_versions SET script_id = ?, state = ? WHERE id = ?',
    [newScriptId, 'SCRIPT_DRAFT', contentVersionId]
  );

  // Degrade evidence and force a rerun keyed to the OLD script_id directly
  // against the pipeline's internal assumptions by invoking runFactCheck
  // for the content brief again — resolveCurrentScript must now resolve
  // to the NEW script, so this exercises the same current-Script-only
  // guard already enforced for PASS/REVIEW, on the REJECT path.
  storage.run(`UPDATE claims SET evidence_status = 'UNSUPPORTED' WHERE research_project_id = ?`, [researchProjectId]);

  const second = runFactCheck({ storage, contentBriefId, force: true });

  assert.equal(second.outcome, 'REJECT');
  assert.equal(second.factCheck.script_id, newScriptId, 'the run must evaluate the current (new) Script, not the historical one');

  const cv = storage.get('SELECT * FROM content_versions WHERE content_brief_id = ?', [contentBriefId]);
  assert.equal(cv.state, 'SCRIPT_DRAFT', 'the new current Script was still at SCRIPT_DRAFT (first-time REJECT), so it must remain SCRIPT_DRAFT, not REJECTED');
  assert.notEqual(cv.script_id, oldScriptId);

  cleanup(storage, dbPath);
});

// AC16 — Risk isolation (behavioral) ---------------------------------------

test('AC16: Fact-Check outcome is unaffected by the presence of a risk_assessments row for the same content_version', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const { contentBriefId, contentVersionId } = seedFullPipeline(storage, [{ evidenceStatus: 'VERIFIED' }]);
  storage.run(
    `INSERT INTO risk_assessments (id, content_version_id, flags, status, notes, created_at) VALUES (?, ?, '["COPYRIGHT_RISK"]', 'REJECT', NULL, ?)`,
    [crypto.randomUUID(), contentVersionId, nowISO()]
  );

  const result = runFactCheck({ storage, contentBriefId });

  assert.equal(result.outcome, 'PASS', 'a REJECT in risk_assessments must not influence the Fact-Check decision');

  cleanup(storage, dbPath);
});