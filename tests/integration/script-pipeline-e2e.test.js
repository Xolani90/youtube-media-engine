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

test('AC1: eligible Brief -> Script created, BRIEF_CREATED -> SCRIPT_DRAFT transition recorded', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const { contentBriefId, claimId } = await seedEligibleBrief(storage);
  const router = routerReturning(JSON.stringify(wellFormedScriptFields([claimId])));

  const result = await createScript({ storage, contentBriefId, llmRouter: router, policy: scriptPolicy });

  assert.equal(result.rejected, false);
  assert.equal(result.created, true);
  assert.equal(result.script.content_brief_id, contentBriefId);
  assert.equal(result.script.version, 1);
  assert.deepEqual(JSON.parse(result.script.claim_links), [{ heading: 'Intro', claim_ids: [claimId] }]);

  const versions = storage.all('SELECT * FROM content_versions WHERE content_brief_id = ?', [contentBriefId]);
  assert.equal(versions.length, 1);
  assert.equal(versions[0].state, 'SCRIPT_DRAFT');
  assert.equal(versions[0].script_id, result.script.id);

  cleanup(storage, dbPath);
});

test('AC2: a missing Brief is rejected as BRIEF_NOT_FOUND, no scripts row created', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const router = routerReturning('should never be called');

  const result = await createScript({ storage, contentBriefId: crypto.randomUUID(), llmRouter: router, policy: scriptPolicy });

  assert.equal(result.rejected, true);
  assert.equal(result.reason, 'BRIEF_NOT_FOUND');
  assert.equal(storage.all('SELECT * FROM scripts').length, 0);

  cleanup(storage, dbPath);
});

test('AC3: an incomplete Brief is rejected per-field, no scripts row created', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const { researchProjectId } = seedResearchProject(storage);
  const opportunityId = storage.get('SELECT opportunity_id FROM research_projects WHERE id = ?', [researchProjectId]).opportunity_id;
  const briefId = crypto.randomUUID();
  storage.run(
    `INSERT INTO content_briefs
      (id, opportunity_id, research_project_id, working_title, core_question, target_audience, viewer_promise,
       hook, angle, narrative_structure, key_claims, counterpoints, original_insights, visual_ideas,
       monetization_opportunities, risk_assessment, created_at)
     VALUES (?, ?, ?, 'T', 'Q', 'A', 'P', '', 'Angle', 'Structure', ?, 'C', 'I', 'V', 'M', 'R', ?)`,
    [briefId, opportunityId, researchProjectId, JSON.stringify(['x']), new Date().toISOString()]
  );
  const router = routerReturning('should never be called');

  const result = await createScript({ storage, contentBriefId: briefId, llmRouter: router, policy: scriptPolicy });

  assert.equal(result.rejected, true);
  assert.equal(result.reason, 'INELIGIBLE_BRIEF_MISSING_FIELD_hook');
  assert.equal(storage.all('SELECT * FROM scripts').length, 0);

  cleanup(storage, dbPath);
});

test('AC5: an LLM-proposed invalid/unknown claim id is never persisted -> bounded retry then rejection', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const { contentBriefId } = await seedEligibleBrief(storage);
  // Always proposes a fabricated claim id, never the real eligible one.
  const router = routerReturning(() => JSON.stringify(wellFormedScriptFields([crypto.randomUUID()])));

  const result = await createScript({ storage, contentBriefId, llmRouter: router, policy: scriptPolicy });

  assert.equal(result.rejected, true);
  assert.match(result.reason, /GENERATION_RETRY_EXHAUSTED/);
  assert.equal(result.attemptsUsed, scriptPolicy.generation.max_attempts);
  assert.equal(storage.all('SELECT * FROM scripts WHERE content_brief_id = ?', [contentBriefId]).length, 0);

  cleanup(storage, dbPath);
});

test('AC6/AC7: retry exhaustion on malformed output leaves no partial Script and no lifecycle transition', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const { contentBriefId } = await seedEligibleBrief(storage);
  const router = routerReturning('not valid json at all');

  const result = await createScript({ storage, contentBriefId, llmRouter: router, policy: scriptPolicy });

  assert.equal(result.rejected, true);
  assert.equal(result.attemptsUsed, scriptPolicy.generation.max_attempts);
  assert.equal(storage.all('SELECT * FROM scripts WHERE content_brief_id = ?', [contentBriefId]).length, 0);

  const versions = storage.all('SELECT * FROM content_versions WHERE content_brief_id = ?', [contentBriefId]);
  assert.equal(versions.length, 1);
  assert.equal(versions[0].script_id, null);
  assert.equal(versions[0].state, 'BRIEF_CREATED', 'lifecycle state must remain unchanged on Script generation failure');

  cleanup(storage, dbPath);
});

test('AC8: duplicate creation without regenerate returns the existing Script unchanged, no second LLM call', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const { contentBriefId, claimId } = await seedEligibleBrief(storage);
  let calls = 0;
  const registry = {
    'counting-stub': () => ({
      id: 'counting-stub', isPaid: false,
      async healthCheck() { return true; },
      async complete() {
        calls++;
        return { text: JSON.stringify(wellFormedScriptFields([claimId])), model: 'counting-stub', requestId: null, inputTokens: 1, outputTokens: 1, estimatedCost: 0, isPaid: false };
      }
    })
  };
  const router = new LLMRouter({ priority: ['counting-stub'], allowPaidProviders: false, registry });

  const first = await createScript({ storage, contentBriefId, llmRouter: router, policy: scriptPolicy });
  const second = await createScript({ storage, contentBriefId, llmRouter: router, policy: scriptPolicy });

  assert.equal(second.created, false);
  assert.equal(second.regenerated, false);
  assert.equal(second.script.id, first.script.id);
  assert.equal(calls, 1);

  cleanup(storage, dbPath);
});

test('AC9: explicit regeneration appends a new version, preserves the prior row, does not duplicate the lifecycle transition', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const { contentBriefId, claimId } = await seedEligibleBrief(storage);
  const routerV1 = routerReturning(JSON.stringify(wellFormedScriptFields([claimId], { hook: 'Hook v1' })));
  const routerV2 = routerReturning(JSON.stringify(wellFormedScriptFields([claimId], { hook: 'Hook v2' })));

  const first = await createScript({ storage, contentBriefId, llmRouter: routerV1, policy: scriptPolicy });
  const second = await createScript({ storage, contentBriefId, llmRouter: routerV2, policy: scriptPolicy, regenerate: true });

  assert.equal(second.regenerated, true);
  assert.equal(second.script.version, 2);
  assert.notEqual(second.script.id, first.script.id);

  const rows = storage.all('SELECT * FROM scripts WHERE content_brief_id = ? ORDER BY version', [contentBriefId]);
  assert.equal(rows.length, 2);
  assert.equal(JSON.parse(rows[0].body).hook, 'Hook v1');
  assert.equal(JSON.parse(rows[1].body).hook, 'Hook v2');

  const versions = storage.all('SELECT * FROM content_versions WHERE content_brief_id = ?', [contentBriefId]);
  assert.equal(versions.length, 1, 'regeneration must not create a second lifecycle/content_version row');
  assert.equal(versions[0].script_id, second.script.id, 'current-version pointer must advance to the newest script row');

  cleanup(storage, dbPath);
});

test('AC10: invented claim id is rejected against this Brief\'s own key_claims (not a broader pool)', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const { contentBriefId } = await seedEligibleBrief(storage);
  const router = routerReturning(JSON.stringify(wellFormedScriptFields(['totally-invented-id'])));

  const result = await createScript({ storage, contentBriefId, llmRouter: router, policy: scriptPolicy });

  assert.equal(result.rejected, true);
  assert.match(result.reason, /GENERATION_RETRY_EXHAUSTED_INVALID_CLAIM_REFERENCE/);

  cleanup(storage, dbPath);
});

test('CTA policy: disallowed CTA is rejected at validation, never silently dropped or persisted', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const { contentBriefId, claimId } = await seedEligibleBrief(storage);
  const router = routerReturning(JSON.stringify(wellFormedScriptFields([claimId], { call_to_action: 'Subscribe now!' })));

  const result = await createScript({ storage, contentBriefId, llmRouter: router, policy: scriptPolicy });

  assert.equal(result.rejected, true);
  assert.match(result.reason, /CALL_TO_ACTION_NOT_PERMITTED/);
  assert.equal(storage.all('SELECT * FROM scripts WHERE content_brief_id = ?', [contentBriefId]).length, 0);

  cleanup(storage, dbPath);
});

test('CTA policy: persistence force-nulls call_to_action as defense-in-depth when the policy allows a valid CTA but the caller flips policy off between attempts is not applicable; direct allowed case persists the CTA', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const { contentBriefId, claimId } = await seedEligibleBrief(storage);
  const router = routerReturning(JSON.stringify(wellFormedScriptFields([claimId], { call_to_action: 'Subscribe now!' })));
  const allowingPolicy = { ...scriptPolicy, allow_call_to_action: true };

  const result = await createScript({ storage, contentBriefId, llmRouter: router, policy: allowingPolicy });

  assert.equal(result.rejected, false);
  assert.equal(JSON.parse(result.script.body).call_to_action, 'Subscribe now!');

  cleanup(storage, dbPath);
});

test('F1 regression 1/5: sequential regeneration produces versions 1, 2, 3', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const { contentBriefId, claimId } = await seedEligibleBrief(storage);
  const router = routerReturning(() => JSON.stringify(wellFormedScriptFields([claimId])));

  const r1 = await createScript({ storage, contentBriefId, llmRouter: router, policy: scriptPolicy });
  const r2 = await createScript({ storage, contentBriefId, llmRouter: router, policy: scriptPolicy, regenerate: true });
  const r3 = await createScript({ storage, contentBriefId, llmRouter: router, policy: scriptPolicy, regenerate: true });

  assert.deepEqual([r1.script.version, r2.script.version, r3.script.version], [1, 2, 3]);

  cleanup(storage, dbPath);
});

test('F1 regression 2/5: (content_brief_id, version) uniqueness is enforced at the database level', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const { contentBriefId } = await seedEligibleBrief(storage);

  assert.throws(() => {
    storage.run(
      `INSERT INTO scripts (id, content_brief_id, version, body, claim_links, created_at) VALUES (?, ?, 1, '{}', '[]', ?)`,
      [crypto.randomUUID(), contentBriefId, new Date().toISOString()]
    );
    storage.run(
      `INSERT INTO scripts (id, content_brief_id, version, body, claim_links, created_at) VALUES (?, ?, 1, '{}', '[]', ?)`,
      [crypto.randomUUID(), contentBriefId, new Date().toISOString()]
    );
  }, /UNIQUE constraint failed/);

  cleanup(storage, dbPath);
});

test('F1 regression 3/5: overlapping regeneration attempts cannot both persist the same version number', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const { contentBriefId, claimId } = await seedEligibleBrief(storage);

  // First version, sequential, to establish a baseline to regenerate from.
  const seedRouter = routerReturning(JSON.stringify(wellFormedScriptFields([claimId])));
  await createScript({ storage, contentBriefId, llmRouter: seedRouter, policy: scriptPolicy });

  // Two "concurrent" regenerate calls: both start, both pass the
  // idempotency read, both begin generation (an await boundary), and only
  // then both attempt to persist. This exercises exactly the interleaving
  // window the original F1 defect lived in: version allocation must be
  // computed inside the same transaction as the insert, not from a read
  // taken before the awaited generation step.
  let released;
  const gate = new Promise((resolve) => { released = resolve; });
  let generationsStarted = 0;

  const registry = {
    'race-stub': () => ({
      id: 'race-stub', isPaid: false,
      async healthCheck() { return true; },
      async complete() {
        generationsStarted++;
        if (generationsStarted === 1) {
          // First caller waits for the second caller to also start
          // generating before either one proceeds to persist.
          await gate;
        } else {
          // Second caller has started; release the first caller now that
          // both are mid-flight.
          released();
        }
        return { text: JSON.stringify(wellFormedScriptFields([claimId])), model: 'race-stub', requestId: null, inputTokens: 1, outputTokens: 1, estimatedCost: 0, isPaid: false };
      }
    })
  };
  const raceRouter = new LLMRouter({ priority: ['race-stub'], allowPaidProviders: false, registry });

  const [resultA, resultB] = await Promise.all([
    createScript({ storage, contentBriefId, llmRouter: raceRouter, policy: scriptPolicy, regenerate: true }),
    createScript({ storage, contentBriefId, llmRouter: raceRouter, policy: scriptPolicy, regenerate: true })
  ]);

  assert.equal(resultA.rejected, false);
  assert.equal(resultB.rejected, false);

  const rows = storage.all('SELECT * FROM scripts WHERE content_brief_id = ? ORDER BY version', [contentBriefId]);
  const versions = rows.map((r) => r.version);
  assert.equal(versions.length, 3, 'baseline (v1) + two successful regenerations (v2, v3)');
  assert.deepEqual(versions, [...new Set(versions)], 'no duplicate version numbers were persisted');
  assert.deepEqual(versions.sort((a, b) => a - b), [1, 2, 3]);

  cleanup(storage, dbPath);
});

test('F1 regression 4/5: the current-version pointer remains valid after overlapping regeneration', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const { contentBriefId, claimId } = await seedEligibleBrief(storage);
  const router = routerReturning(() => JSON.stringify(wellFormedScriptFields([claimId])));

  await createScript({ storage, contentBriefId, llmRouter: router, policy: scriptPolicy });
  await Promise.all([
    createScript({ storage, contentBriefId, llmRouter: router, policy: scriptPolicy, regenerate: true }),
    createScript({ storage, contentBriefId, llmRouter: router, policy: scriptPolicy, regenerate: true })
  ]);

  const versions = storage.all('SELECT * FROM content_versions WHERE content_brief_id = ?', [contentBriefId]);
  assert.equal(versions.length, 1, 'still exactly one lifecycle row for this Brief');
  const pointedScript = storage.get('SELECT * FROM scripts WHERE id = ?', [versions[0].script_id]);
  assert.ok(pointedScript, 'content_versions.script_id must point at a script row that actually exists');
  const maxVersion = storage.get('SELECT MAX(version) as v FROM scripts WHERE content_brief_id = ?', [contentBriefId]).v;
  assert.equal(pointedScript.version, maxVersion, 'the pointer must reference the highest (current) version');

  cleanup(storage, dbPath);
});

test('F1 regression 5/5: a failed regeneration attempt does not corrupt the previously valid Script state', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const { contentBriefId, claimId } = await seedEligibleBrief(storage);
  const goodRouter = routerReturning(JSON.stringify(wellFormedScriptFields([claimId], { hook: 'Good hook' })));
  const first = await createScript({ storage, contentBriefId, llmRouter: goodRouter, policy: scriptPolicy });

  const badRouter = routerReturning('not valid json at all');
  const failed = await createScript({ storage, contentBriefId, llmRouter: badRouter, policy: scriptPolicy, regenerate: true });

  assert.equal(failed.rejected, true);

  const rows = storage.all('SELECT * FROM scripts WHERE content_brief_id = ?', [contentBriefId]);
  assert.equal(rows.length, 1, 'no new row from the failed regeneration');
  assert.equal(rows[0].id, first.script.id);
  assert.equal(JSON.parse(rows[0].body).hook, 'Good hook', 'the prior valid Script row is untouched');

  const versions = storage.all('SELECT * FROM content_versions WHERE content_brief_id = ?', [contentBriefId]);
  assert.equal(versions[0].script_id, first.script.id, 'pointer still references the last valid version');

  cleanup(storage, dbPath);
});

test('decision_log records the Script-specific audit stages', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const { contentBriefId, claimId } = await seedEligibleBrief(storage);
  const router = routerReturning(JSON.stringify(wellFormedScriptFields([claimId])));

  const result = await createScript({ storage, contentBriefId, llmRouter: router, policy: scriptPolicy });

  const stages = storage.all(
    'SELECT DISTINCT stage FROM decision_log WHERE subject_id = ? OR subject_id = ?',
    [contentBriefId, result.script.id]
  ).map((r) => r.stage);

  for (const expected of ['SCRIPT_ELIGIBILITY_CHECK', 'SCRIPT_GENERATION', 'SCRIPT_PERSISTED']) {
    assert.ok(stages.includes(expected), `expected stage ${expected} in decision_log, got ${stages.join(', ')}`);
  }

  cleanup(storage, dbPath);
});
