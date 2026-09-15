import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { SqliteStorageDriver } from '../../src/storage/SqliteStorageDriver.js';
import { runOriginalityCheck } from '../../src/originality/pipeline.js';
import { runFactCheck } from '../../src/fact-check/pipeline.js';

function freshStorage() {
  const dbPath = path.join(os.tmpdir(), `originality-e2e-${Date.now()}-${Math.random()}.db`);
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

/** Seeds a Script row plus its content_versions row directly, bypassing the LLM-driven Script pipeline. */
function seedScript(storage, contentBriefId, { body = 'Default script body text here.', version = 1 } = {}) {
  const scriptId = crypto.randomUUID();
  storage.run(
    `INSERT INTO scripts (id, content_brief_id, version, body, claim_links, created_at)
     VALUES (?, ?, ?, ?, '[]', ?)`,
    [scriptId, contentBriefId, version, body, nowISO()]
  );
  const contentVersionId = crypto.randomUUID();
  storage.run(
    `INSERT INTO content_versions (id, content_brief_id, script_id, state, created_at) VALUES (?, ?, ?, 'SCRIPT_DRAFT', ?)`,
    [contentVersionId, contentBriefId, scriptId, nowISO()]
  );
  return { scriptId, contentVersionId };
}

/** Adds an additional, unlinked scripts row to the corpus (no content_versions pointer). */
function seedCorpusScript(storage, contentBriefId, body, version = 99) {
  const scriptId = crypto.randomUUID();
  storage.run(
    `INSERT INTO scripts (id, content_brief_id, version, body, claim_links, created_at)
     VALUES (?, ?, ?, ?, '[]', ?)`,
    [scriptId, contentBriefId, version, body, nowISO()]
  );
  return scriptId;
}

/** Full setup through FACT_CHECK (the state Originality transitions from). */
function seedThroughFactCheck(storage, { body } = {}) {
  const { opportunityId, researchProjectId } = seedResearchProject(storage);
  const contentBriefId = seedBrief(storage, researchProjectId, opportunityId);
  const { scriptId, contentVersionId } = seedScript(storage, contentBriefId, { body });
  // No claims required to reach FACT_CHECK for this suite's purposes:
  // directly drive content_versions to FACT_CHECK the same way
  // runFactCheck would for an all-VERIFIED brief with zero claim_ids.
  storage.run('UPDATE content_versions SET state = ? WHERE id = ?', ['FACT_CHECK', contentVersionId]);
  return { contentBriefId, scriptId, contentVersionId };
}

// 1. Non-empty corpus --------------------------------------------------

test('non-empty corpus: real measurement persisted, lifecycle FACT_CHECK -> ORIGINALITY_CHECK', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const { contentBriefId: priorBriefId } = (() => {
    const { opportunityId, researchProjectId } = seedResearchProject(storage);
    const contentBriefId = seedBrief(storage, researchProjectId, opportunityId);
    return { contentBriefId };
  })();
  seedCorpusScript(storage, priorBriefId, 'A completely different prior script about gardening tips.');

  const { contentBriefId, scriptId, contentVersionId } = seedThroughFactCheck(storage, { body: 'A script about space exploration and rockets.' });

  const result = runOriginalityCheck({ storage, contentBriefId });

  assert.equal(result.outcome, 'EVALUATED');
  assert.equal(result.originalityCheck.script_id, scriptId);
  assert.equal(result.originalityCheck.content_version_id, contentVersionId);
  assert.equal(result.originalityCheck.corpus_size, 1);
  assert.equal(result.originalityCheck.corpus_definition, 'all_prior_scripts_excluding_current_script_id');
  assert.equal(result.originalityCheck.algorithm, 'jaccard_token_set');
  assert.ok(result.originalityCheck.max_similarity >= 0 && result.originalityCheck.max_similarity <= 1);

  const cv = storage.get('SELECT * FROM content_versions WHERE content_brief_id = ?', [contentBriefId]);
  assert.equal(cv.state, 'ORIGINALITY_CHECK');

  cleanup(storage, dbPath);
});

// 2. Empty corpus --------------------------------------------------------

test('empty corpus: corpus_size=0, max_similarity=null, most_similar_script_id=null, transition still occurs', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const { contentBriefId } = seedThroughFactCheck(storage, { body: 'The only script that has ever existed.' });

  const result = runOriginalityCheck({ storage, contentBriefId });

  assert.equal(result.outcome, 'EMPTY_CORPUS');
  assert.equal(result.originalityCheck.corpus_size, 0);
  assert.equal(result.originalityCheck.max_similarity, null);
  assert.equal(result.originalityCheck.most_similar_script_id, null);

  const cv = storage.get('SELECT * FROM content_versions WHERE content_brief_id = ?', [contentBriefId]);
  assert.equal(cv.state, 'ORIGINALITY_CHECK');

  cleanup(storage, dbPath);
});

// 3. High lexical overlap -------------------------------------------------

test('high lexical overlap: near-duplicate corpus script yields high similarity', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const { opportunityId, researchProjectId } = seedResearchProject(storage);
  const priorBriefId = seedBrief(storage, researchProjectId, opportunityId);
  const nearDupeId = seedCorpusScript(storage, priorBriefId, 'The quick brown fox jumps over the lazy dog near the river.');

  const { contentBriefId } = seedThroughFactCheck(storage, { body: 'The quick brown fox jumps over the lazy dog near the riverbank.' });

  const result = runOriginalityCheck({ storage, contentBriefId });

  assert.equal(result.originalityCheck.most_similar_script_id, nearDupeId);
  assert.ok(result.originalityCheck.max_similarity > 0.7, `expected high similarity, got ${result.originalityCheck.max_similarity}`);

  cleanup(storage, dbPath);
});

// 4. Low lexical overlap ---------------------------------------------------

test('low lexical overlap: unrelated corpus script yields low similarity', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const { opportunityId, researchProjectId } = seedResearchProject(storage);
  const priorBriefId = seedBrief(storage, researchProjectId, opportunityId);
  seedCorpusScript(storage, priorBriefId, 'Recipes for baking sourdough bread at home this weekend.');

  const { contentBriefId } = seedThroughFactCheck(storage, { body: 'Quantum computers use qubits to perform parallel calculations.' });

  const result = runOriginalityCheck({ storage, contentBriefId });

  assert.ok(result.originalityCheck.max_similarity < 0.3, `expected low similarity, got ${result.originalityCheck.max_similarity}`);

  cleanup(storage, dbPath);
});

// 5. Exact self-exclusion ---------------------------------------------------

test('self-exclusion: the current script never appears in its own corpus', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const { contentBriefId, scriptId } = seedThroughFactCheck(storage, { body: 'Only one script exists and it must not compare against itself.' });

  const result = runOriginalityCheck({ storage, contentBriefId });

  assert.equal(result.originalityCheck.corpus_size, 0);
  assert.notEqual(result.originalityCheck.most_similar_script_id, scriptId);

  cleanup(storage, dbPath);
});

// 6. Same-content-brief earlier drafts remain included ----------------------

test('same-content-brief earlier drafts remain in the corpus (not excluded)', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const { opportunityId, researchProjectId } = seedResearchProject(storage);
  const contentBriefId = seedBrief(storage, researchProjectId, opportunityId);

  // Earlier draft (version 1) of the SAME content_brief_id.
  const earlierDraftId = seedCorpusScript(storage, contentBriefId, 'Version one of the exact same script wording throughout.', 1);

  // Current script (version 2) of the same brief, near-identical wording.
  const scriptId = crypto.randomUUID();
  storage.run(
    `INSERT INTO scripts (id, content_brief_id, version, body, claim_links, created_at)
     VALUES (?, ?, 2, ?, '[]', ?)`,
    [scriptId, contentBriefId, 'Version two of the exact same script wording throughout.', nowISO()]
  );
  const contentVersionId = crypto.randomUUID();
  storage.run(
    `INSERT INTO content_versions (id, content_brief_id, script_id, state, created_at) VALUES (?, ?, ?, 'FACT_CHECK', ?)`,
    [contentVersionId, contentBriefId, scriptId, nowISO()]
  );

  const result = runOriginalityCheck({ storage, contentBriefId });

  assert.equal(result.originalityCheck.corpus_size, 1, 'the same-brief earlier draft must be counted in the corpus, not filtered out');
  assert.equal(result.originalityCheck.most_similar_script_id, earlierDraftId);
  assert.ok(result.originalityCheck.max_similarity > 0.5);

  cleanup(storage, dbPath);
});

// 7. Duplicate invocation creates a new result --------------------------

test('duplicate invocation: two explicit evaluations of the same script produce two distinct rows', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const { contentBriefId, scriptId } = seedThroughFactCheck(storage, { body: 'A script evaluated more than once over time.' });

  const first = runOriginalityCheck({ storage, contentBriefId });
  // Grow the corpus between invocations to demonstrate the two
  // measurements can legitimately differ.
  const { opportunityId, researchProjectId } = seedResearchProject(storage);
  const otherBriefId = seedBrief(storage, researchProjectId, opportunityId);
  seedCorpusScript(storage, otherBriefId, 'A script evaluated more than once over time, nearly identical.');

  const second = runOriginalityCheck({ storage, contentBriefId });

  assert.notEqual(first.originalityCheck.id, second.originalityCheck.id);
  assert.equal(first.originalityCheck.corpus_size, 0);
  assert.equal(second.originalityCheck.corpus_size, 1);

  const allRows = storage.all('SELECT * FROM originality_checks WHERE script_id = ?', [scriptId]);
  assert.equal(allRows.length, 2, 'both historical measurements must remain persisted, not overwritten');

  cleanup(storage, dbPath);
});

// 8. Deterministic repeatability ------------------------------------------

test('deterministic repeatability: identical corpus snapshot yields identical similarity across separate evaluations', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const { opportunityId, researchProjectId } = seedResearchProject(storage);
  const priorBriefId = seedBrief(storage, researchProjectId, opportunityId);
  seedCorpusScript(storage, priorBriefId, 'A stable prior script whose text never changes between runs.');

  const { contentBriefId } = seedThroughFactCheck(storage, { body: 'A stable current script whose text never changes between runs.' });

  const first = runOriginalityCheck({ storage, contentBriefId });
  const second = runOriginalityCheck({ storage, contentBriefId });

  assert.equal(first.originalityCheck.max_similarity, second.originalityCheck.max_similarity);

  cleanup(storage, dbPath);
});

// 9. Missing / unresolvable current script (structural failure) ------------

test('missing current script: cannot be evaluated, no result persisted, no lifecycle side effect', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const { opportunityId, researchProjectId } = seedResearchProject(storage);
  const contentBriefId = seedBrief(storage, researchProjectId, opportunityId);
  // content_versions row with no script_id at all (mirrors NO_CURRENT_SCRIPT).
  storage.run(
    `INSERT INTO content_versions (id, content_brief_id, script_id, state, created_at) VALUES (?, ?, NULL, 'BRIEF_CREATED', ?)`,
    [crypto.randomUUID(), contentBriefId, nowISO()]
  );

  const result = runOriginalityCheck({ storage, contentBriefId });

  assert.equal(result.outcome, 'STRUCTURAL_FAILURE');
  assert.equal(result.reason, 'NO_CURRENT_SCRIPT');
  assert.equal(result.originalityCheck, null);
  assert.equal(storage.all('SELECT * FROM originality_checks').length, 0);

  const cv = storage.get('SELECT * FROM content_versions WHERE content_brief_id = ?', [contentBriefId]);
  assert.equal(cv.state, 'BRIEF_CREATED', 'state must remain unchanged on structural failure');

  cleanup(storage, dbPath);
});

// 10. Transaction atomicity --------------------------------------------

test('atomicity: a failing transaction leaves no partial Originality row or state change', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const { contentBriefId, contentVersionId } = seedThroughFactCheck(storage, { body: 'A script whose persistence will be simulated as failing.' });

  // Simulate a persistence failure using the repository's own
  // replicate-then-collide technique (see Fact-Check's AC15b/AC18):
  // insert a row that satisfies a NOT NULL/FK constraint violation
  // mid-transaction to force storage.transaction() to roll back the
  // whole unit, and confirm nothing survives.
  assert.throws(() => {
    storage.transaction(() => {
      storage.run(
        `INSERT INTO originality_checks
          (id, content_version_id, script_id, corpus_definition, corpus_size, algorithm, algorithm_version, max_similarity, most_similar_script_id, known_limitations, created_at)
         VALUES (?, ?, 'nonexistent-script-id-violates-fk', 'x', 0, 'x', 'x', NULL, NULL, 'x', ?)`,
        [crypto.randomUUID(), contentVersionId, nowISO()]
      );
      storage.run('UPDATE content_versions SET state = ? WHERE id = ?', ['ORIGINALITY_CHECK', contentVersionId]);
    });
  });

  const cv = storage.get('SELECT * FROM content_versions WHERE content_brief_id = ?', [contentBriefId]);
  assert.equal(cv.state, 'FACT_CHECK', 'state must remain FACT_CHECK; the failed transaction must not leave a partial state transition');
  assert.equal(storage.all('SELECT * FROM originality_checks WHERE content_version_id = ?', [contentVersionId]).length, 0);

  cleanup(storage, dbPath);
});

// 11. Exact content_version_id / script_id linkage --------------------

test('exact linkage: persisted result matches the exact script_id and content_version_id evaluated', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const { contentBriefId, scriptId, contentVersionId } = seedThroughFactCheck(storage, { body: 'Linkage verification script body.' });

  const result = runOriginalityCheck({ storage, contentBriefId });

  assert.equal(result.originalityCheck.script_id, scriptId);
  assert.equal(result.originalityCheck.content_version_id, contentVersionId);

  cleanup(storage, dbPath);
});

// 12. Fact-Check regression isolation --------------------------------

test('regression isolation: Fact-Check behavior is unaffected by the Originality stage existing', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const { opportunityId, researchProjectId } = seedResearchProject(storage);
  const claimId = crypto.randomUUID();
  storage.run(
    `INSERT INTO claims (id, research_project_id, claim, claim_type, evidence_status, is_load_bearing, created_at)
     VALUES (?, ?, 'A claim.', 'FACT', 'VERIFIED', 1, ?)`,
    [claimId, researchProjectId, nowISO()]
  );
  const contentBriefId = crypto.randomUUID();
  storage.run(
    `INSERT INTO content_briefs
      (id, opportunity_id, research_project_id, working_title, core_question, target_audience, viewer_promise,
       hook, angle, narrative_structure, key_claims, counterpoints, original_insights, visual_ideas,
       monetization_opportunities, risk_assessment, created_at)
     VALUES (?, ?, ?, 'T', 'Q', 'A', 'P', 'H', 'Angle', 'Structure', ?, 'C', 'I', 'V', 'M', 'R', ?)`,
    [contentBriefId, opportunityId, researchProjectId, JSON.stringify([claimId]), nowISO()]
  );
  const scriptId = crypto.randomUUID();
  storage.run(
    `INSERT INTO scripts (id, content_brief_id, version, body, claim_links, created_at)
     VALUES (?, ?, 1, '{}', ?, ?)`,
    [scriptId, contentBriefId, JSON.stringify([{ heading: 'Intro', claim_ids: [claimId] }]), nowISO()]
  );
  storage.run(
    `INSERT INTO content_versions (id, content_brief_id, script_id, state, created_at) VALUES (?, ?, ?, 'SCRIPT_DRAFT', ?)`,
    [crypto.randomUUID(), contentBriefId, scriptId, nowISO()]
  );

  const result = runFactCheck({ storage, contentBriefId });

  assert.equal(result.outcome, 'PASS');
  const cv = storage.get('SELECT * FROM content_versions WHERE content_brief_id = ?', [contentBriefId]);
  assert.equal(cv.state, 'FACT_CHECK', 'Fact-Check must still transition SCRIPT_DRAFT -> FACT_CHECK exactly as before');

  cleanup(storage, dbPath);
});

// 13. No automatic orchestrator invocation --------------------------

test('no automatic invocation: reaching FACT_CHECK via runFactCheck does not itself create an Originality result', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const { opportunityId, researchProjectId } = seedResearchProject(storage);
  const claimId = crypto.randomUUID();
  storage.run(
    `INSERT INTO claims (id, research_project_id, claim, claim_type, evidence_status, is_load_bearing, created_at)
     VALUES (?, ?, 'A claim.', 'FACT', 'VERIFIED', 1, ?)`,
    [claimId, researchProjectId, nowISO()]
  );
  const contentBriefId = crypto.randomUUID();
  storage.run(
    `INSERT INTO content_briefs
      (id, opportunity_id, research_project_id, working_title, core_question, target_audience, viewer_promise,
       hook, angle, narrative_structure, key_claims, counterpoints, original_insights, visual_ideas,
       monetization_opportunities, risk_assessment, created_at)
     VALUES (?, ?, ?, 'T', 'Q', 'A', 'P', 'H', 'Angle', 'Structure', ?, 'C', 'I', 'V', 'M', 'R', ?)`,
    [contentBriefId, opportunityId, researchProjectId, JSON.stringify([claimId]), nowISO()]
  );
  const scriptId = crypto.randomUUID();
  storage.run(
    `INSERT INTO scripts (id, content_brief_id, version, body, claim_links, created_at)
     VALUES (?, ?, 1, '{}', ?, ?)`,
    [scriptId, contentBriefId, JSON.stringify([{ heading: 'Intro', claim_ids: [claimId] }]), nowISO()]
  );
  storage.run(
    `INSERT INTO content_versions (id, content_brief_id, script_id, state, created_at) VALUES (?, ?, ?, 'SCRIPT_DRAFT', ?)`,
    [crypto.randomUUID(), contentBriefId, scriptId, nowISO()]
  );

  runFactCheck({ storage, contentBriefId });

  const cv = storage.get('SELECT * FROM content_versions WHERE content_brief_id = ?', [contentBriefId]);
  assert.equal(cv.state, 'FACT_CHECK', 'no automatic advancement past FACT_CHECK occurs');
  assert.equal(storage.all('SELECT * FROM originality_checks').length, 0, 'Originality must never run unless explicitly invoked');

  cleanup(storage, dbPath);
});
