import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { SqliteStorageDriver } from '../../src/storage/SqliteStorageDriver.js';
import { runOriginalityCheck } from '../../src/originality/pipeline.js';

function freshStorage() {
  const dbPath = path.join(os.tmpdir(), `originality-adr0019-${Date.now()}-${Math.random()}.db`);
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

function seedBrief(storage, researchProjectId, opportunityId) {
  const id = crypto.randomUUID();
  storage.run(
    `INSERT INTO content_briefs
      (id, opportunity_id, research_project_id, working_title, core_question, target_audience, viewer_promise,
       hook, angle, narrative_structure, key_claims, counterpoints, original_insights, visual_ideas,
       monetization_opportunities, risk_assessment, created_at)
     VALUES (?, ?, ?, 'T', 'Q', 'A', 'P', 'H', 'Angle', 'Structure', '[]', 'C', 'I', 'V', 'M', 'R', ?)`,
    [id, opportunityId, researchProjectId, nowISO()]
  );
  return id;
}

/** Seeds a Script row plus its content_versions row directly. */
function seedScript(storage, contentBriefId, { body = 'Default script body text here.', version = 1, state = 'FACT_CHECK' } = {}) {
  const scriptId = crypto.randomUUID();
  storage.run(
    `INSERT INTO scripts (id, content_brief_id, version, body, claim_links, created_at)
     VALUES (?, ?, ?, ?, '[]', ?)`,
    [scriptId, contentBriefId, version, body, nowISO()]
  );
  const contentVersionId = crypto.randomUUID();
  storage.run(
    `INSERT INTO content_versions (id, content_brief_id, script_id, state, created_at) VALUES (?, ?, ?, ?, ?)`,
    [contentVersionId, contentBriefId, scriptId, state, nowISO()]
  );
  return { scriptId, contentVersionId };
}

function seedCorpusScript(storage, contentBriefId, body, version = 99) {
  const scriptId = crypto.randomUUID();
  storage.run(
    `INSERT INTO scripts (id, content_brief_id, version, body, claim_links, created_at)
     VALUES (?, ?, ?, ?, '[]', ?)`,
    [scriptId, contentBriefId, version, body, nowISO()]
  );
  return scriptId;
}

function structuredBody(overrides = {}) {
  return JSON.stringify({
    hook: 'A hook sentence.',
    narrative: 'A narrative paragraph.',
    sections: [
      { heading: 'First heading', content: 'First section content.', claim_ids: [] },
      { heading: 'Second heading', content: 'Second section content.', claim_ids: [] }
    ],
    counterpoints: 'Some counterpoints.',
    conclusion: 'A conclusion.',
    call_to_action: null,
    ...overrides
  });
}

function seedThroughFactCheck(storage, { body } = {}) {
  const { opportunityId, researchProjectId } = seedResearchProject(storage);
  const contentBriefId = seedBrief(storage, researchProjectId, opportunityId);
  const { scriptId, contentVersionId } = seedScript(storage, contentBriefId, { body, state: 'FACT_CHECK' });
  return { contentBriefId, scriptId, contentVersionId };
}

// T-16 — Version -------------------------------------------------------

test('T-16: new Originality result rows persist algorithm_version=v2', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const { contentBriefId } = seedThroughFactCheck(storage, { body: 'A plain legacy prose script body about volcanoes.' });

  const result = runOriginalityCheck({ storage, contentBriefId });

  assert.equal(result.originalityCheck.algorithm_version, 'v2');

  cleanup(storage, dbPath);
});

test('T-16: historical v1 rows are never rewritten by a new evaluation', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const { contentBriefId, scriptId, contentVersionId } = seedThroughFactCheck(storage, { body: 'A plain legacy prose script body about comets.' });

  // Simulate a pre-existing historical v1 row for this exact script.
  const historicalId = crypto.randomUUID();
  storage.run(
    `INSERT INTO originality_checks
      (id, content_version_id, script_id, corpus_definition, corpus_size, algorithm, algorithm_version, max_similarity, most_similar_script_id, known_limitations, created_at)
     VALUES (?, ?, ?, 'all_prior_scripts_excluding_current_script_id', 0, 'jaccard_token_set', 'v1', NULL, NULL, 'legacy', ?)`,
    [historicalId, contentVersionId, scriptId, nowISO()]
  );

  runOriginalityCheck({ storage, contentBriefId });

  const historicalRow = storage.get('SELECT * FROM originality_checks WHERE id = ?', [historicalId]);
  assert.equal(historicalRow.algorithm_version, 'v1', 'historical v1 row must remain unchanged');

  const allRows = storage.all('SELECT * FROM originality_checks WHERE script_id = ?', [scriptId]);
  assert.equal(allRows.length, 2, 'the historical row and the new v2 row must both be present (append-only)');
  const newRow = allRows.find((r) => r.id !== historicalId);
  assert.equal(newRow.algorithm_version, 'v2');

  cleanup(storage, dbPath);
});

// T-19 — Real producer/persistence path ---------------------------------

test('T-19: a real Structured Form current Script is measured via the defined five-field representation, not the raw serialized body', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const { opportunityId, researchProjectId } = seedResearchProject(storage);
  const priorBriefId = seedBrief(storage, researchProjectId, opportunityId);
  // Prior corpus script whose body, as raw JSON text, shares heavy
  // structural/field-name overlap with the structured current script but
  // whose actual prose content is unrelated.
  seedCorpusScript(storage, priorBriefId, structuredBody({
    hook: 'Totally unrelated topic about deep sea fish.',
    narrative: 'More unrelated content about deep sea fish.',
    sections: [{ heading: 'X', content: 'Deep sea fish content.', claim_ids: [] }],
    counterpoints: 'Deep sea fish counterpoints.',
    conclusion: 'Deep sea fish conclusion.'
  }));

  const { contentBriefId } = seedThroughFactCheck(storage, { body: structuredBody() });

  const result = runOriginalityCheck({ storage, contentBriefId });

  assert.equal(result.outcome, 'EVALUATED');
  assert.equal(result.originalityCheck.corpus_size, 1);
  // Distinct prose despite shared JSON field names/structure -> low similarity.
  assert.ok(result.originalityCheck.max_similarity < 0.3, `expected low similarity from shared JSON structure alone, got ${result.originalityCheck.max_similarity}`);

  cleanup(storage, dbPath);
});

test('T-01/T-19: two Structured Form scripts differing only in heading/claim_ids/CTA are measured as identical', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const { opportunityId, researchProjectId } = seedResearchProject(storage);
  const priorBriefId = seedBrief(storage, researchProjectId, opportunityId);
  seedCorpusScript(storage, priorBriefId, structuredBody({
    sections: [{ heading: 'Completely different heading', content: 'First section content.', claim_ids: ['some-claim-id'] }, { heading: 'Also different', content: 'Second section content.', claim_ids: [] }],
    call_to_action: 'Different CTA entirely.'
  }));

  const { contentBriefId } = seedThroughFactCheck(storage, { body: structuredBody() });

  const result = runOriginalityCheck({ storage, contentBriefId });

  assert.equal(result.originalityCheck.max_similarity, 1, 'heading/claim_ids/CTA differences must not affect similarity');

  cleanup(storage, dbPath);
});

// T-13 — Current-Script representation failure --------------------------

test('T-13: current Script with an invalid structured body ("{" that fails validation) produces a representation failure, not a fallback', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const { contentBriefId, contentVersionId } = seedThroughFactCheck(storage, { body: '{"narrative": "missing hook and other required fields"}' });

  const result = runOriginalityCheck({ storage, contentBriefId });

  assert.equal(result.outcome, 'STRUCTURAL_FAILURE');
  assert.equal(result.reason, 'NO_ORIGINALITY_REPRESENTATION');
  assert.equal(result.originalityCheck, null);
  assert.equal(storage.all('SELECT * FROM originality_checks').length, 0);

  const cv = storage.get('SELECT * FROM content_versions WHERE content_brief_id = ?', [contentBriefId]);
  assert.equal(cv.state, 'FACT_CHECK', 'state must remain unchanged on representation failure');

  const failureLog = storage.get(
    `SELECT * FROM decision_log WHERE subject_id = ? AND decision = 'STRUCTURAL_FAILURE' ORDER BY created_at DESC LIMIT 1`,
    [contentBriefId]
  );
  assert.equal(failureLog.reason, 'NO_ORIGINALITY_REPRESENTATION');

  cleanup(storage, dbPath);
});

test('T-13: current Script with an array-shaped body ("[") produces a representation failure', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const { contentBriefId } = seedThroughFactCheck(storage, { body: '["a", "b", "c"]' });

  const result = runOriginalityCheck({ storage, contentBriefId });

  assert.equal(result.outcome, 'STRUCTURAL_FAILURE');
  assert.equal(result.reason, 'NO_ORIGINALITY_REPRESENTATION');
  assert.equal(storage.all('SELECT * FROM originality_checks').length, 0);

  cleanup(storage, dbPath);
});

// T-14 — Corpus exclusion ------------------------------------------------

test('T-14: an invalid corpus Script is excluded — cannot affect similarity, cannot become the maximum, not counted in corpus_size', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const { opportunityId, researchProjectId } = seedResearchProject(storage);
  const priorBriefId = seedBrief(storage, researchProjectId, opportunityId);

  // One invalid corpus row (malformed JSON) and one eligible, unrelated row.
  // Distinct versions: both rows belong to the same contentBriefId, and
  // scripts.(content_brief_id, version) is UNIQUE.
  seedCorpusScript(storage, priorBriefId, '{"broken', 1);
  const eligibleId = seedCorpusScript(storage, priorBriefId, 'Some eligible unrelated legacy prose about mountains.', 2);

  const { contentBriefId } = seedThroughFactCheck(storage, { body: 'A totally different current legacy prose script about oceans.' });

  const result = runOriginalityCheck({ storage, contentBriefId });

  assert.equal(result.outcome, 'EVALUATED');
  assert.equal(result.originalityCheck.corpus_size, 1, 'the invalid corpus row must not be counted');
  assert.notEqual(result.originalityCheck.most_similar_script_id, null);
  assert.equal(result.originalityCheck.most_similar_script_id, eligibleId, 'the invalid row must never be selected as most-similar');

  cleanup(storage, dbPath);
});

// T-15 — Empty corpus (all rows excluded) --------------------------------

test('T-15: if every corpus row is excluded (no valid representation), the empty-corpus outcome is produced', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const { opportunityId, researchProjectId } = seedResearchProject(storage);
  const priorBriefId = seedBrief(storage, researchProjectId, opportunityId);

  // Distinct versions: all three rows belong to the same contentBriefId,
  // and scripts.(content_brief_id, version) is UNIQUE.
  seedCorpusScript(storage, priorBriefId, '["array", "shaped", "body"]', 1);
  seedCorpusScript(storage, priorBriefId, '{"still": "invalid"}', 2);
  seedCorpusScript(storage, priorBriefId, '   ', 3);

  const { contentBriefId } = seedThroughFactCheck(storage, { body: 'A valid legacy prose current script.' });

  const result = runOriginalityCheck({ storage, contentBriefId });

  assert.equal(result.outcome, 'EMPTY_CORPUS');
  assert.equal(result.originalityCheck.corpus_size, 0);
  assert.equal(result.originalityCheck.max_similarity, null);
  assert.equal(result.originalityCheck.most_similar_script_id, null);

  cleanup(storage, dbPath);
});

// T-17 — Append-only ------------------------------------------------------

test('T-17: existing Originality rows are never updated or rewritten by a later evaluation', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const { contentBriefId } = seedThroughFactCheck(storage, { body: 'A script measured more than once.' });

  const first = runOriginalityCheck({ storage, contentBriefId });
  const second = runOriginalityCheck({ storage, contentBriefId });

  assert.notEqual(first.originalityCheck.id, second.originalityCheck.id);
  const firstRowStillPresent = storage.get('SELECT * FROM originality_checks WHERE id = ?', [first.originalityCheck.id]);
  assert.ok(firstRowStillPresent, 'the first result row must still exist, unmodified');
  assert.equal(firstRowStillPresent.max_similarity, first.originalityCheck.max_similarity);

  cleanup(storage, dbPath);
});

// T-18 — Deterministic tie behavior with exclusions mixed in -------------

test('T-18: deterministic ordering/tie behavior is preserved among eligible rows when an invalid row sits between them (by id)', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const { opportunityId, researchProjectId } = seedResearchProject(storage);
  const priorBriefId = seedBrief(storage, researchProjectId, opportunityId);

  // Explicit, lexicographically ordered ids so `ORDER BY id ASC` gives a
  // known, controlled sequence: eligible (a-...), excluded (b-...),
  // eligible (c-...). The corpus query itself is untouched by this ADR;
  // only which of these rows are eligible changes.
  const firstEligibleId = 'a-first-eligible';
  const excludedId = 'b-excluded-invalid';
  const secondEligibleId = 'c-second-eligible';
  storage.run(
    `INSERT INTO scripts (id, content_brief_id, version, body, claim_links, created_at) VALUES (?, ?, 1, ?, '[]', ?)`,
    [firstEligibleId, priorBriefId, 'Identical tie candidate text right here.', nowISO()]
  );
  storage.run(
    `INSERT INTO scripts (id, content_brief_id, version, body, claim_links, created_at) VALUES (?, ?, 2, ?, '[]', ?)`,
    [excludedId, priorBriefId, '{"invalid": true', nowISO()]
  );
  storage.run(
    `INSERT INTO scripts (id, content_brief_id, version, body, claim_links, created_at) VALUES (?, ?, 3, ?, '[]', ?)`,
    [secondEligibleId, priorBriefId, 'Identical tie candidate text right here.', nowISO()]
  );

  const { contentBriefId } = seedThroughFactCheck(storage, { body: 'Identical tie candidate text right here.' });

  const result = runOriginalityCheck({ storage, contentBriefId });

  assert.equal(result.originalityCheck.corpus_size, 2);
  assert.equal(result.originalityCheck.max_similarity, 1);
  assert.equal(result.originalityCheck.most_similar_script_id, firstEligibleId, 'first eligible row encountered by id order at the max similarity must win the tie, skipping the excluded row in between');

  cleanup(storage, dbPath);
});
