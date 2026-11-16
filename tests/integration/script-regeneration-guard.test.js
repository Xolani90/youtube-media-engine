import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { SqliteStorageDriver } from '../../src/storage/SqliteStorageDriver.js';
import { LLMRouter } from '../../src/providers/llm/router.js';
import { createBrief } from '../../src/brief/pipeline.js';
import { createScript } from '../../src/script/pipeline.js';
import { SCRIPT_STAGE } from '../../src/script/constants.js';
import briefPolicy from '../../config/brief_policy.json' with { type: 'json' };
import scriptPolicy from '../../config/script_policy.json' with { type: 'json' };

function freshStorage() {
  const dbPath = path.join(os.tmpdir(), `script-e2e-${Date.now()}-${Math.random()}.db`);
  return { storage: new SqliteStorageDriver({ dbPath }), dbPath };
}

function cleanup(storage, dbPath) {
  storage.close();
  fs.rmSync(dbPath, { force: true });
  fs.rmSync(`${dbPath}-wal`, { force: true });
  fs.rmSync(`${dbPath}-shm`, { force: true });
}

function seedResearchProject(storage, { status = 'RESEARCH_COMPLETE', coreQuestion = 'Did the launch cause a measurable increase?' } = {}) {
  const opportunityId = crypto.randomUUID();
  storage.run(
    `INSERT INTO opportunities (id, title, description, source, discovered_at, status, opportunity_proposition)
     VALUES (?, 'Test opportunity', 'A description', 'rss', ?, 'HANDED_TO_RESEARCH', ?)`,
    [opportunityId, new Date().toISOString(), JSON.stringify({ core_question: coreQuestion })]
  );
  const researchProjectId = crypto.randomUUID();
  storage.run(
    `INSERT INTO research_projects (id, opportunity_id, status, created_at) VALUES (?, ?, ?, ?)`,
    [researchProjectId, opportunityId, status, new Date().toISOString()]
  );
  return { opportunityId, researchProjectId };
}

function insertClaim(storage, researchProjectId, { claim, claimType = 'FACT', evidenceStatus = 'VERIFIED' }) {
  const id = crypto.randomUUID();
  storage.run(
    `INSERT INTO claims (id, research_project_id, claim, claim_type, evidence_status, is_load_bearing, created_at)
     VALUES (?, ?, ?, ?, ?, 1, ?)`,
    [id, researchProjectId, claim, claimType, evidenceStatus, new Date().toISOString()]
  );
  return id;
}

function wellFormedBriefFields(keyClaims, overrides = {}) {
  return {
    working_title: 'Title', target_audience: 'Audience', viewer_promise: 'Promise', hook: 'Hook',
    angle: 'Angle', narrative_structure: 'Structure', counterpoints: 'Counterpoints',
    original_insights: 'Insights', visual_ideas: 'Visuals', monetization_opportunities: 'Monetization',
    risk_assessment: 'Risk', key_claims: keyClaims,
    ...overrides
  };
}

function wellFormedScriptFields(claimIds, overrides = {}) {
  return {
    hook: 'Script hook', narrative: 'Narrative',
    sections: [{ heading: 'Intro', content: 'Body text', claim_ids: claimIds }],
    counterpoints: 'Counterpoints', conclusion: 'Conclusion', call_to_action: null,
    ...overrides
  };
}

function routerReturning(textOrFn) {
  const registry = {
    'stub': () => ({
      id: 'stub', isPaid: false,
      async healthCheck() { return true; },
      async complete() {
        const text = typeof textOrFn === 'function' ? textOrFn() : textOrFn;
        return { text, model: 'stub', requestId: null, inputTokens: 1, outputTokens: 1, estimatedCost: 0, isPaid: false };
      }
    })
  };
  return new LLMRouter({ priority: ['stub'], allowPaidProviders: false, registry });
}

/**
 * Sets up a fresh storage instance with a verified Research project and a
 * persisted, eligible Brief (via the real Brief pipeline, matching how
 * Script is actually reached in production), returning the ids needed to
 * drive Script tests.
 */
async function seedEligibleBrief(storage) {
  const { researchProjectId } = seedResearchProject(storage);
  const claimId = insertClaim(storage, researchProjectId, { claim: 'Acme reported $1B revenue.' });
  const briefRouter = routerReturning(JSON.stringify(wellFormedBriefFields([claimId])));
  const briefResult = await createBrief({ storage, researchProjectId, llmRouter: briefRouter, policy: briefPolicy });
  return { researchProjectId, claimId, contentBriefId: briefResult.brief.id };
}


// Regression: regeneration must not swap the script out from under a content_version that has already
// moved past SCRIPT_DRAFT. Fact-check, originality and Quality Gate results are bound to the old script_id,
// so repointing content_versions.script_id would let an unchecked script reach Production.
for (const state of ['FACT_CHECK', 'ORIGINALITY_CHECK', 'QUALITY_GATE', 'PRODUCTION_READY', 'PRODUCED', 'FINAL_COMPLIANCE', 'PUBLISHED']) {
  test(`regeneration is refused once content_version is in ${state}; current script pointer is unchanged`, async () => {
    const { storage, dbPath } = freshStorage();
    await storage.migrate();
    const { contentBriefId, claimId } = await seedEligibleBrief(storage);
    const first = await createScript({ storage, contentBriefId, llmRouter: routerReturning(JSON.stringify(wellFormedScriptFields([claimId], { hook: 'approved' }))), policy: scriptPolicy });
    storage.run('UPDATE content_versions SET state = ? WHERE content_brief_id = ?', [state, contentBriefId]);
    let calls = 0;
    const router = routerReturning(() => { calls++; return JSON.stringify(wellFormedScriptFields([claimId], { hook: 'unreviewed replacement' })); });

    const result = await createScript({ storage, contentBriefId, llmRouter: router, policy: scriptPolicy, regenerate: true });

    assert.equal(result.rejected, true);
    assert.equal(result.reason, 'REGENERATION_NOT_ALLOWED_AFTER_SCRIPT_DRAFT');
    assert.equal(calls, 0, 'no LLM call may be spent on a refused regeneration');
    const cv = storage.get('SELECT * FROM content_versions WHERE content_brief_id = ?', [contentBriefId]);
    assert.equal(cv.script_id, first.script.id);
    assert.equal(cv.state, state);
    assert.equal(storage.all('SELECT id FROM scripts WHERE content_brief_id = ?', [contentBriefId]).length, 1);
    cleanup(storage, dbPath);
  });
}

test('regeneration is still allowed while the content_version is in SCRIPT_DRAFT', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const { contentBriefId, claimId } = await seedEligibleBrief(storage);
  await createScript({ storage, contentBriefId, llmRouter: routerReturning(JSON.stringify(wellFormedScriptFields([claimId]))), policy: scriptPolicy });
  const r = await createScript({ storage, contentBriefId, llmRouter: routerReturning(JSON.stringify(wellFormedScriptFields([claimId], { hook: 'v2' }))), policy: scriptPolicy, regenerate: true });
  assert.equal(r.regenerated, true);
  assert.equal(r.script.version, 2);
  cleanup(storage, dbPath);
});


// Concurrency: the state is changed WHILE the (mocked) LLM is generating, i.e. after the pre-generation guard
// has already passed and before the transaction runs. The in-transaction re-check must then return the same
// structured rejection as the pre-generation guard, and the SQLite rollback must leave the Script data untouched.
for (const state of ['FACT_CHECK', 'ORIGINALITY_CHECK', 'QUALITY_GATE', 'PUBLISHED']) {
  test(`Script regeneration that races into ${state} during generation returns a structured rejection; Script data is unchanged`, async () => {
    const { storage, dbPath } = freshStorage();
    await storage.migrate();
    const { contentBriefId, claimId } = await seedEligibleBrief(storage);
    const first = await createScript({ storage, contentBriefId, llmRouter: routerReturning(JSON.stringify(wellFormedScriptFields([claimId], { hook: 'approved' }))), policy: scriptPolicy });
    const scriptBefore = storage.get('SELECT * FROM scripts WHERE id = ?', [first.script.id]);
    let calls = 0;
    const router = routerReturning(() => {
      calls++;
      // Deterministic interleaving: the content_version leaves SCRIPT_DRAFT while generation is in flight.
      storage.run('UPDATE content_versions SET state = ? WHERE content_brief_id = ?', [state, contentBriefId]);
      return JSON.stringify(wellFormedScriptFields([claimId], { hook: 'unreviewed replacement' }));
    });

    const result = await createScript({ storage, contentBriefId, llmRouter: router, policy: scriptPolicy, regenerate: true });

    assert.equal(calls, 1, 'the pre-generation guard passed, so generation really ran once');
    assert.equal(result.rejected, true);
    assert.equal(result.reason, 'REGENERATION_NOT_ALLOWED_AFTER_SCRIPT_DRAFT');
    assert.equal(result.created, false);
    assert.equal(result.regenerated, false);
    const cv = storage.get('SELECT * FROM content_versions WHERE content_brief_id = ?', [contentBriefId]);
    assert.equal(cv.script_id, first.script.id, 'script pointer must not move');
    assert.equal(cv.state, state);
    assert.equal(storage.all('SELECT id FROM scripts WHERE content_brief_id = ?', [contentBriefId]).length, 1, 'no new script row may survive the rollback');
    assert.deepEqual(storage.get('SELECT * FROM scripts WHERE id = ?', [first.script.id]), scriptBefore);
    const log = storage.all('SELECT * FROM decision_log WHERE subject_id = ? AND decision = ?', [contentBriefId, 'REJECTED']);
    assert.equal(log.length, 1, 'exactly one rejection decision is logged (the transaction-level guard, outside the rolled-back transaction)');
    assert.equal(log[0].reason, 'REGENERATION_NOT_ALLOWED_AFTER_SCRIPT_DRAFT');
    assert.equal(log[0].stage, SCRIPT_STAGE.ELIGIBILITY_CHECK);
    assert.equal(log[0].subject_type, 'content_brief');
    cleanup(storage, dbPath);
  });
}

test('Script regeneration: an unrelated error inside the transaction is NOT converted to a rejection, and rolls back', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const { contentBriefId, claimId } = await seedEligibleBrief(storage);
  const first = await createScript({ storage, contentBriefId, llmRouter: routerReturning(JSON.stringify(wellFormedScriptFields([claimId], { hook: 'approved' }))), policy: scriptPolicy });
  const realRun = storage.run.bind(storage);
  storage.run = (sql, params) => {
    if (String(sql).includes('INSERT INTO scripts')) throw new Error('simulated unrelated storage failure');
    return realRun(sql, params);
  };

  await assert.rejects(
    createScript({ storage, contentBriefId, llmRouter: routerReturning(JSON.stringify(wellFormedScriptFields([claimId], { hook: 'v2' }))), policy: scriptPolicy, regenerate: true }),
    /simulated unrelated storage failure/
  );

  storage.run = realRun;
  const cv = storage.get('SELECT * FROM content_versions WHERE content_brief_id = ?', [contentBriefId]);
  assert.equal(cv.script_id, first.script.id);
  assert.equal(storage.all('SELECT id FROM scripts WHERE content_brief_id = ?', [contentBriefId]).length, 1);
  cleanup(storage, dbPath);
});


// Concurrency: the Script that existed at the initial lookup becomes unavailable during generation while the
// content_version advances past SCRIPT_DRAFT. The transaction-level guard must still treat the call as a
// regeneration (keyed on the request, not on what the transaction can still see) and refuse it.
test('Script regeneration: existing Script removed and state advanced during generation returns the structured rejection', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const { contentBriefId, claimId } = await seedEligibleBrief(storage);
  const first = await createScript({ storage, contentBriefId, llmRouter: routerReturning(JSON.stringify(wellFormedScriptFields([claimId], { hook: 'approved' }))), policy: scriptPolicy });
  let calls = 0;
  const router = routerReturning(() => {
    calls++;
    // Deterministic interleaving: pointer cleared, state advanced, Script row gone, all while generation is in flight.
    storage.run('UPDATE content_versions SET script_id = NULL, state = ? WHERE content_brief_id = ?', ['FACT_CHECK', contentBriefId]);
    storage.run('DELETE FROM scripts WHERE id = ?', [first.script.id]);
    return JSON.stringify(wellFormedScriptFields([claimId], { hook: 'unreviewed replacement' }));
  });

  const result = await createScript({ storage, contentBriefId, llmRouter: router, policy: scriptPolicy, regenerate: true });

  assert.equal(calls, 1);
  assert.equal(result.rejected, true);
  assert.equal(result.reason, 'REGENERATION_NOT_ALLOWED_AFTER_SCRIPT_DRAFT');
  assert.equal(result.created, false);
  assert.equal(result.regenerated, false);
  assert.equal(storage.all('SELECT id FROM scripts WHERE content_brief_id = ?', [contentBriefId]).length, 0, 'no replacement Script row may survive');
  const cv = storage.get('SELECT * FROM content_versions WHERE content_brief_id = ?', [contentBriefId]);
  assert.equal(cv.state, 'FACT_CHECK', 'state must not be moved back or rewritten');
  assert.equal(cv.script_id, null, 'pointer must not be overwritten with a new script id');
  const log = storage.all('SELECT * FROM decision_log WHERE subject_id = ? AND decision = ?', [contentBriefId, 'REJECTED']);
  assert.equal(log.length, 1);
  assert.equal(log[0].reason, 'REGENERATION_NOT_ALLOWED_AFTER_SCRIPT_DRAFT');
  assert.equal(log[0].stage, SCRIPT_STAGE.ELIGIBILITY_CHECK);
  assert.equal(log[0].subject_type, 'content_brief');
  cleanup(storage, dbPath);
});

// Guard against over-blocking: passing regenerate:true when no Script exists (before or during the call) is a
// first creation, not a regeneration, and must still succeed from BRIEF_CREATED.
test('Script first creation with regenerate:true (no existing Script) is still allowed', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const { contentBriefId, claimId } = await seedEligibleBrief(storage);
  const r = await createScript({ storage, contentBriefId, llmRouter: routerReturning(JSON.stringify(wellFormedScriptFields([claimId]))), policy: scriptPolicy, regenerate: true });
  assert.equal(r.rejected, false);
  assert.equal(r.created, true);
  const cv = storage.get('SELECT * FROM content_versions WHERE content_brief_id = ?', [contentBriefId]);
  assert.equal(cv.state, 'SCRIPT_DRAFT');
  assert.equal(cv.script_id, r.script.id);
  cleanup(storage, dbPath);
});
