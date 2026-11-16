import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { SqliteStorageDriver } from '../../src/storage/SqliteStorageDriver.js';
import { LLMRouter } from '../../src/providers/llm/router.js';
import { createBrief } from '../../src/brief/pipeline.js';
import { setTraceSink } from '../../src/diagnostics/trace.js';
import { BRIEF_STAGE } from '../../src/brief/constants.js';
import briefPolicy from '../../config/brief_policy.json' with { type: 'json' };

function freshStorage() {
  const dbPath = path.join(os.tmpdir(), `brief-e2e-${Date.now()}-${Math.random()}.db`);
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

function wellFormedFields(keyClaims, overrides = {}) {
  return {
    working_title: 'Title', target_audience: 'Audience', viewer_promise: 'Promise', hook: 'Hook',
    angle: 'Angle', narrative_structure: 'Structure', counterpoints: 'Counterpoints',
    original_insights: 'Insights', visual_ideas: 'Visuals', monetization_opportunities: 'Monetization',
    risk_assessment: 'Risk', key_claims: keyClaims,
    ...overrides
  };
}

function routerReturning(textOrFn) {
  const registry = {
    'brief-stub': () => ({
      id: 'brief-stub', isPaid: false,
      async healthCheck() { return true; },
      async complete() {
        const text = typeof textOrFn === 'function' ? textOrFn() : textOrFn;
        return { text, model: 'brief-stub', requestId: null, inputTokens: 1, outputTokens: 1, estimatedCost: 0, isPaid: false };
      }
    })
  };
  return new LLMRouter({ priority: ['brief-stub'], allowPaidProviders: false, registry });
}


for (const state of ['SCRIPT_DRAFT', 'FACT_CHECK', 'QUALITY_GATE', 'PRODUCTION_READY', 'PRODUCED', 'PUBLISHED']) {
  test(`Brief regeneration is refused once content_version is in ${state}; Brief text is unchanged`, async () => {
    const { storage, dbPath } = freshStorage();
    await storage.migrate();
    const { researchProjectId } = seedResearchProject(storage);
    const claimId = insertClaim(storage, researchProjectId, { claim: 'Acme reported $1B revenue.' });
    const first = await createBrief({ storage, researchProjectId, llmRouter: routerReturning(JSON.stringify(wellFormedFields([claimId], { visual_ideas: 'approved visuals' }))), policy: briefPolicy });
    storage.run('UPDATE content_versions SET state = ? WHERE content_brief_id = ?', [state, first.brief.id]);
    let calls = 0;
    const router = routerReturning(() => { calls++; return JSON.stringify(wellFormedFields([claimId], { visual_ideas: 'unreviewed visuals' })); });

    const r = await createBrief({ storage, researchProjectId, llmRouter: router, policy: briefPolicy, regenerate: true });

    assert.equal(r.rejected, true);
    assert.equal(r.reason, 'BRIEF_REGENERATION_NOT_ALLOWED_AFTER_BRIEF_CREATED');
    assert.equal(calls, 0);
    assert.equal(storage.get('SELECT visual_ideas FROM content_briefs WHERE id = ?', [first.brief.id]).visual_ideas, 'approved visuals');
    cleanup(storage, dbPath);
  });
}

test('Brief regeneration is still allowed while the content_version is in BRIEF_CREATED', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const { researchProjectId } = seedResearchProject(storage);
  const claimId = insertClaim(storage, researchProjectId, { claim: 'Acme reported $1B revenue.' });
  await createBrief({ storage, researchProjectId, llmRouter: routerReturning(JSON.stringify(wellFormedFields([claimId]))), policy: briefPolicy });
  const r = await createBrief({ storage, researchProjectId, llmRouter: routerReturning(JSON.stringify(wellFormedFields([claimId], { hook: 'v2' }))), policy: briefPolicy, regenerate: true });
  assert.equal(r.regenerated, true);
  cleanup(storage, dbPath);
});


// Concurrency: the state is changed WHILE the (mocked) LLM is generating, i.e. after the pre-generation guard
// has already passed and before the transaction runs. The in-transaction re-check must then return the same
// structured rejection as the pre-generation guard, and the SQLite rollback must leave the Brief untouched.
for (const state of ['SCRIPT_DRAFT', 'FACT_CHECK', 'QUALITY_GATE', 'PUBLISHED']) {
  test(`Brief regeneration that races into ${state} during generation returns a structured rejection; Brief is unchanged`, async () => {
    const { storage, dbPath } = freshStorage();
    await storage.migrate();
    const { researchProjectId } = seedResearchProject(storage);
    const claimId = insertClaim(storage, researchProjectId, { claim: 'Acme reported $1B revenue.' });
    const first = await createBrief({ storage, researchProjectId, llmRouter: routerReturning(JSON.stringify(wellFormedFields([claimId], { visual_ideas: 'approved visuals' }))), policy: briefPolicy });
    const before = storage.get('SELECT * FROM content_briefs WHERE id = ?', [first.brief.id]);
    let calls = 0;
    const router = routerReturning(() => {
      calls++;
      // Deterministic interleaving: the content_version leaves BRIEF_CREATED while generation is in flight.
      storage.run('UPDATE content_versions SET state = ? WHERE content_brief_id = ?', [state, first.brief.id]);
      return JSON.stringify(wellFormedFields([claimId], { visual_ideas: 'unreviewed visuals' }));
    });

    const r = await createBrief({ storage, researchProjectId, llmRouter: router, policy: briefPolicy, regenerate: true });

    assert.equal(calls, 1, 'the pre-generation guard passed, so generation really ran once');
    assert.equal(r.rejected, true);
    assert.equal(r.reason, 'BRIEF_REGENERATION_NOT_ALLOWED_AFTER_BRIEF_CREATED');
    assert.equal(r.created, false);
    assert.equal(r.regenerated, false);
    assert.deepEqual(storage.get('SELECT * FROM content_briefs WHERE id = ?', [first.brief.id]), before, 'Brief row must be byte-for-byte unchanged');
    assert.equal(storage.get('SELECT state FROM content_versions WHERE content_brief_id = ?', [first.brief.id]).state, state);
    assert.equal(storage.all('SELECT id FROM content_briefs WHERE research_project_id = ?', [researchProjectId]).length, 1);
    const log = storage.all('SELECT * FROM decision_log WHERE subject_id = ? AND decision = ?', [researchProjectId, 'REJECTED']);
    assert.equal(log.length, 1, 'exactly one rejection decision is logged (the transaction-level guard, outside the rolled-back transaction)');
    assert.equal(log[0].reason, 'BRIEF_REGENERATION_NOT_ALLOWED_AFTER_BRIEF_CREATED');
    assert.equal(log[0].stage, BRIEF_STAGE.ELIGIBILITY_CHECK);
    assert.equal(log[0].subject_type, 'research_project');
    cleanup(storage, dbPath);
  });
}

test('Brief regeneration: an unrelated error inside the transaction is NOT converted to a rejection, and rolls back', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const { researchProjectId } = seedResearchProject(storage);
  const claimId = insertClaim(storage, researchProjectId, { claim: 'Acme reported $1B revenue.' });
  const first = await createBrief({ storage, researchProjectId, llmRouter: routerReturning(JSON.stringify(wellFormedFields([claimId], { visual_ideas: 'approved visuals' }))), policy: briefPolicy });
  const before = storage.get('SELECT * FROM content_briefs WHERE id = ?', [first.brief.id]);
  const realRun = storage.run.bind(storage);
  storage.run = (sql, params) => {
    if (String(sql).includes('UPDATE content_briefs SET')) throw new Error('simulated unrelated storage failure');
    return realRun(sql, params);
  };

  await assert.rejects(
    createBrief({ storage, researchProjectId, llmRouter: routerReturning(JSON.stringify(wellFormedFields([claimId], { visual_ideas: 'new' }))), policy: briefPolicy, regenerate: true }),
    /simulated unrelated storage failure/
  );

  storage.run = realRun;
  assert.deepEqual(storage.get('SELECT * FROM content_briefs WHERE id = ?', [first.brief.id]), before);
  cleanup(storage, dbPath);
});


// Concurrency: the canonical Brief disappears between the initial lookup and the transaction. The UPDATE would
// then match zero rows; the pipeline must not report a successful regeneration (nor return an undefined brief).
test('Brief regeneration: canonical Brief removed during generation is not reported as a successful regeneration', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const { researchProjectId } = seedResearchProject(storage);
  const claimId = insertClaim(storage, researchProjectId, { claim: 'Acme reported $1B revenue.' });
  const first = await createBrief({ storage, researchProjectId, llmRouter: routerReturning(JSON.stringify(wellFormedFields([claimId]))), policy: briefPolicy });
  const router = routerReturning(() => {
    // Deterministic interleaving: the lifecycle row and the Brief vanish while generation is in flight.
    storage.run('DELETE FROM content_versions WHERE content_brief_id = ?', [first.brief.id]);
    storage.run('DELETE FROM content_briefs WHERE id = ?', [first.brief.id]);
    return JSON.stringify(wellFormedFields([claimId], { hook: 'replacement' }));
  });

  const r = await createBrief({ storage, researchProjectId, llmRouter: router, policy: briefPolicy, regenerate: true });

  assert.equal(r.rejected, true);
  assert.equal(r.reason, 'BRIEF_NOT_FOUND_DURING_REGENERATION');
  assert.equal(r.created, false);
  assert.equal(r.regenerated, false);
  assert.equal(r.brief, undefined);
  assert.equal(storage.all('SELECT id FROM content_briefs WHERE research_project_id = ?', [researchProjectId]).length, 0, 'regeneration must not resurrect or create a Brief');
  assert.equal(storage.all('SELECT id FROM content_versions WHERE content_brief_id = ?', [first.brief.id]).length, 0);
  const log = storage.all('SELECT * FROM decision_log WHERE subject_id = ? AND decision = ?', [researchProjectId, 'REJECTED']);
  assert.equal(log.length, 1);
  assert.equal(log[0].reason, 'BRIEF_NOT_FOUND_DURING_REGENERATION');
  assert.equal(log[0].stage, BRIEF_STAGE.ELIGIBILITY_CHECK);
  assert.equal(log[0].subject_type, 'research_project');
  cleanup(storage, dbPath);
});


// Fail closed: a Brief whose lifecycle record (content_versions) is missing cannot be shown to be at BRIEF_CREATED,
// so regenerating (overwriting) it must be refused, both before generation and inside the transaction.
test('Brief regeneration is refused before generation when the lifecycle record is already missing; Brief is unchanged', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const { researchProjectId } = seedResearchProject(storage);
  const claimId = insertClaim(storage, researchProjectId, { claim: 'Acme reported $1B revenue.' });
  const first = await createBrief({ storage, researchProjectId, llmRouter: routerReturning(JSON.stringify(wellFormedFields([claimId], { visual_ideas: 'approved visuals' }))), policy: briefPolicy });
  const before = storage.get('SELECT * FROM content_briefs WHERE id = ?', [first.brief.id]);
  storage.run('DELETE FROM content_versions WHERE content_brief_id = ?', [first.brief.id]);
  let calls = 0;
  const router = routerReturning(() => { calls++; return JSON.stringify(wellFormedFields([claimId], { visual_ideas: 'unreviewed visuals' })); });

  const r = await createBrief({ storage, researchProjectId, llmRouter: router, policy: briefPolicy, regenerate: true });

  assert.equal(calls, 0, 'refused before the LLM generation callback is invoked');
  assert.equal(r.rejected, true);
  assert.equal(r.reason, 'BRIEF_REGENERATION_NOT_ALLOWED_AFTER_BRIEF_CREATED');
  assert.equal(r.created, false);
  assert.equal(r.regenerated, false);
  assert.deepEqual(storage.get('SELECT * FROM content_briefs WHERE id = ?', [first.brief.id]), before, 'Brief row must be unchanged');
  assert.equal(storage.all('SELECT id FROM content_briefs WHERE research_project_id = ?', [researchProjectId]).length, 1, 'no replacement Brief');
  assert.equal(storage.all('SELECT id FROM content_versions WHERE content_brief_id = ?', [first.brief.id]).length, 0, 'no lifecycle record is fabricated');
  const log = storage.all('SELECT * FROM decision_log WHERE subject_id = ? AND decision = ?', [researchProjectId, 'REJECTED']);
  assert.equal(log.length, 1);
  assert.equal(log[0].reason, 'BRIEF_REGENERATION_NOT_ALLOWED_AFTER_BRIEF_CREATED');
  assert.equal(log[0].stage, BRIEF_STAGE.ELIGIBILITY_CHECK);
  assert.equal(log[0].subject_type, 'research_project');
  cleanup(storage, dbPath);
});

test('Brief regeneration: lifecycle record removed during generation is refused inside the transaction; Brief is unchanged', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const { researchProjectId } = seedResearchProject(storage);
  const claimId = insertClaim(storage, researchProjectId, { claim: 'Acme reported $1B revenue.' });
  const first = await createBrief({ storage, researchProjectId, llmRouter: routerReturning(JSON.stringify(wellFormedFields([claimId], { visual_ideas: 'approved visuals' }))), policy: briefPolicy });
  const before = storage.get('SELECT * FROM content_briefs WHERE id = ?', [first.brief.id]);
  let calls = 0;
  const router = routerReturning(() => {
    calls++;
    // Deterministic interleaving: only the lifecycle record vanishes; the canonical Brief stays.
    storage.run('DELETE FROM content_versions WHERE content_brief_id = ?', [first.brief.id]);
    return JSON.stringify(wellFormedFields([claimId], { visual_ideas: 'unreviewed visuals' }));
  });

  const r = await createBrief({ storage, researchProjectId, llmRouter: router, policy: briefPolicy, regenerate: true });

  assert.equal(calls, 1, 'the pre-generation guard passed, so generation really ran once');
  assert.equal(r.rejected, true);
  assert.equal(r.reason, 'BRIEF_REGENERATION_NOT_ALLOWED_AFTER_BRIEF_CREATED');
  assert.equal(r.created, false);
  assert.equal(r.regenerated, false);
  assert.deepEqual(storage.get('SELECT * FROM content_briefs WHERE id = ?', [first.brief.id]), before, 'Brief row must be unchanged (transaction rolled back / never wrote)');
  assert.equal(storage.all('SELECT id FROM content_briefs WHERE research_project_id = ?', [researchProjectId]).length, 1, 'no replacement Brief');
  assert.equal(storage.all('SELECT id FROM content_versions WHERE content_brief_id = ?', [first.brief.id]).length, 0, 'no lifecycle record is fabricated');
  const log = storage.all('SELECT * FROM decision_log WHERE subject_id = ? AND decision = ?', [researchProjectId, 'REJECTED']);
  assert.equal(log.length, 1, 'exactly one rejection logged, by the transaction-level guard');
  assert.equal(log[0].reason, 'BRIEF_REGENERATION_NOT_ALLOWED_AFTER_BRIEF_CREATED');
  assert.equal(log[0].stage, BRIEF_STAGE.ELIGIBILITY_CHECK);
  assert.equal(log[0].subject_type, 'research_project');
  cleanup(storage, dbPath);
});
