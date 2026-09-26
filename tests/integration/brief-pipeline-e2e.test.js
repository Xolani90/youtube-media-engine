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

test('AC1: RESEARCH_COMPLETE + eligible claims -> Brief created, BRIEF_CREATED transition recorded', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const { researchProjectId, opportunityId } = seedResearchProject(storage);
  const claimId = insertClaim(storage, researchProjectId, { claim: 'Acme reported $1B revenue.' });
  const router = routerReturning(JSON.stringify(wellFormedFields([claimId])));

  const result = await createBrief({ storage, researchProjectId, llmRouter: router, policy: briefPolicy });

  assert.equal(result.rejected, false);
  assert.equal(result.created, true);
  assert.equal(result.brief.research_project_id, researchProjectId);
  assert.equal(result.brief.opportunity_id, opportunityId);
  assert.deepEqual(JSON.parse(result.brief.key_claims), [claimId]);

  const versions = storage.all('SELECT * FROM content_versions WHERE content_brief_id = ?', [result.brief.id]);
  assert.equal(versions.length, 1);
  assert.equal(versions[0].state, 'BRIEF_CREATED');

  cleanup(storage, dbPath);
});

test('AC2: INSUFFICIENT_EVIDENCE -> rejected, no Brief row created (D1)', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const { researchProjectId } = seedResearchProject(storage, { status: 'INSUFFICIENT_EVIDENCE' });
  const router = routerReturning('should never be called');

  const result = await createBrief({ storage, researchProjectId, llmRouter: router, policy: briefPolicy });

  assert.equal(result.rejected, true);
  assert.match(result.reason, /INSUFFICIENT_EVIDENCE/);
  assert.equal(storage.all('SELECT * FROM content_briefs WHERE research_project_id = ?', [researchProjectId]).length, 0);

  cleanup(storage, dbPath);
});

test('AC3: FAILED -> rejected, no Brief row created (D1)', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const { researchProjectId } = seedResearchProject(storage, { status: 'FAILED' });
  const router = routerReturning('should never be called');

  const result = await createBrief({ storage, researchProjectId, llmRouter: router, policy: briefPolicy });

  assert.equal(result.rejected, true);
  assert.match(result.reason, /FAILED/);
  assert.equal(storage.all('SELECT * FROM content_briefs WHERE research_project_id = ?', [researchProjectId]).length, 0);

  cleanup(storage, dbPath);
});

test('AC4: zero eligible key claims -> rejected, no Brief row created (D10)', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const { researchProjectId } = seedResearchProject(storage);
  insertClaim(storage, researchProjectId, { claim: 'Opinion only.', claimType: 'OPINION' });
  insertClaim(storage, researchProjectId, { claim: 'Unsupported fact.', evidenceStatus: 'UNSUPPORTED' });
  const router = routerReturning('should never be called');

  const result = await createBrief({ storage, researchProjectId, llmRouter: router, policy: briefPolicy });

  assert.equal(result.rejected, true);
  assert.equal(result.reason, 'NO_ELIGIBLE_KEY_CLAIMS');
  assert.equal(storage.all('SELECT * FROM content_briefs WHERE research_project_id = ?', [researchProjectId]).length, 0);

  cleanup(storage, dbPath);
});

test('diagnostic trace: each deterministic pre-generation rejection emits a brief.rejected trace event with gate/reason (observability-only)', async () => {
  const lines = [];
  const previousSink = setTraceSink((line) => lines.push(line));
  const previousEnv = process.env.DIAGNOSTIC_TRACE;
  process.env.DIAGNOSTIC_TRACE = 'true';

  try {
    // Gate: RESEARCH_ELIGIBILITY
    {
      const { storage, dbPath } = freshStorage();
      await storage.migrate();
      const { researchProjectId } = seedResearchProject(storage, { status: 'INSUFFICIENT_EVIDENCE' });
      const router = routerReturning('should never be called');
      const result = await createBrief({ storage, researchProjectId, llmRouter: router, policy: briefPolicy });
      assert.equal(result.rejected, true);
      const line = lines.find((l) => l.includes('brief.rejected') && l.includes(researchProjectId));
      assert.ok(line, 'expected a brief.rejected trace event for the RESEARCH_ELIGIBILITY gate');
      assert.match(line, /gate=RESEARCH_ELIGIBILITY/);
      assert.match(line, /reason=INELIGIBLE_RESEARCH_STATUS_INSUFFICIENT_EVIDENCE/);
      cleanup(storage, dbPath);
    }

    // Gate: KEY_CLAIMS
    {
      const { storage, dbPath } = freshStorage();
      await storage.migrate();
      const { researchProjectId } = seedResearchProject(storage);
      insertClaim(storage, researchProjectId, { claim: 'Opinion only.', claimType: 'OPINION' });
      const router = routerReturning('should never be called');
      const result = await createBrief({ storage, researchProjectId, llmRouter: router, policy: briefPolicy });
      assert.equal(result.rejected, true);
      const line = lines.find((l) => l.includes('brief.rejected') && l.includes(researchProjectId));
      assert.ok(line, 'expected a brief.rejected trace event for the KEY_CLAIMS gate');
      assert.match(line, /gate=KEY_CLAIMS/);
      assert.match(line, /reason=NO_ELIGIBLE_KEY_CLAIMS/);
      assert.match(line, /eligibleClaims=0/);
      cleanup(storage, dbPath);
    }
  } finally {
    if (previousEnv === undefined) delete process.env.DIAGNOSTIC_TRACE;
    else process.env.DIAGNOSTIC_TRACE = previousEnv;
    setTraceSink(previousSink);
  }
});

test('AC5: an LLM-proposed invalid/unknown claim id is never persisted -> bounded retry then rejection (D9)', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const { researchProjectId } = seedResearchProject(storage);
  insertClaim(storage, researchProjectId, { claim: 'Acme reported $1B revenue.' });
  // Always proposes a fabricated claim id, never one of the real eligible ids.
  const router = routerReturning(() => JSON.stringify(wellFormedFields([crypto.randomUUID()])));

  const result = await createBrief({ storage, researchProjectId, llmRouter: router, policy: briefPolicy });

  assert.equal(result.rejected, true);
  assert.match(result.reason, /GENERATION_RETRY_EXHAUSTED/);
  assert.equal(result.attemptsUsed, briefPolicy.generation.max_attempts);
  assert.equal(storage.all('SELECT * FROM content_briefs WHERE research_project_id = ?', [researchProjectId]).length, 0);

  cleanup(storage, dbPath);
});

test('AC9: core_question is copied deterministically, independent of anything the LLM returns (D14)', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const { researchProjectId } = seedResearchProject(storage, { coreQuestion: '  Did it   really work?  ' });
  const claimId = insertClaim(storage, researchProjectId, { claim: 'x' });
  const router = routerReturning(JSON.stringify(wellFormedFields([claimId])));

  const result = await createBrief({ storage, researchProjectId, llmRouter: router, policy: briefPolicy });

  assert.equal(result.brief.core_question, 'Did it really work?');

  cleanup(storage, dbPath);
});

test('AC10: duplicate creation without regenerate returns the existing canonical Brief unchanged (D5/D6)', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const { researchProjectId } = seedResearchProject(storage);
  const claimId = insertClaim(storage, researchProjectId, { claim: 'x' });
  const router = routerReturning(JSON.stringify(wellFormedFields([claimId])));

  const first = await createBrief({ storage, researchProjectId, llmRouter: router, policy: briefPolicy });
  const second = await createBrief({ storage, researchProjectId, llmRouter: router, policy: briefPolicy });

  assert.equal(second.created, false);
  assert.equal(second.regenerated, false);
  assert.equal(second.brief.id, first.brief.id);

  const rows = storage.all('SELECT * FROM content_briefs WHERE research_project_id = ?', [researchProjectId]);
  assert.equal(rows.length, 1);

  cleanup(storage, dbPath);
});

test('AC11: explicit regeneration replaces the canonical Brief in place (same id, new content), and does not duplicate the lifecycle transition', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const { researchProjectId } = seedResearchProject(storage);
  const claimId = insertClaim(storage, researchProjectId, { claim: 'x' });
  const routerV1 = routerReturning(JSON.stringify(wellFormedFields([claimId], { working_title: 'Version 1' })));
  const routerV2 = routerReturning(JSON.stringify(wellFormedFields([claimId], { working_title: 'Version 2' })));

  const first = await createBrief({ storage, researchProjectId, llmRouter: routerV1, policy: briefPolicy });
  const second = await createBrief({ storage, researchProjectId, llmRouter: routerV2, policy: briefPolicy, regenerate: true });

  assert.equal(second.regenerated, true);
  assert.equal(second.brief.id, first.brief.id);
  assert.equal(second.brief.working_title, 'Version 2');

  const rows = storage.all('SELECT * FROM content_briefs WHERE research_project_id = ?', [researchProjectId]);
  assert.equal(rows.length, 1);
  const versions = storage.all('SELECT * FROM content_versions WHERE content_brief_id = ?', [first.brief.id]);
  assert.equal(versions.length, 1, 'regeneration must not create a second lifecycle/content_version row');

  cleanup(storage, dbPath);
});

test('AC12/AC13/AC15: bounded retry exhaustion on malformed LLM output leaves no partial Brief and no lifecycle transition', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const { researchProjectId } = seedResearchProject(storage);
  insertClaim(storage, researchProjectId, { claim: 'x' });
  const router = routerReturning('not valid json at all');

  const result = await createBrief({ storage, researchProjectId, llmRouter: router, policy: briefPolicy });

  assert.equal(result.rejected, true);
  assert.equal(result.attemptsUsed, briefPolicy.generation.max_attempts);
  assert.equal(storage.all('SELECT * FROM content_briefs WHERE research_project_id = ?', [researchProjectId]).length, 0);
  assert.equal(storage.all('SELECT * FROM content_versions').length, 0);

  const rp = storage.get('SELECT * FROM research_projects WHERE id = ?', [researchProjectId]);
  assert.equal(rp.status, 'RESEARCH_COMPLETE', 'Research project status must remain unchanged on Brief generation failure');

  cleanup(storage, dbPath);
});

test('AC16: key_claims persists live claim ids, not a snapshot of claim text (D9)', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const { researchProjectId } = seedResearchProject(storage);
  const claimId = insertClaim(storage, researchProjectId, { claim: 'Original claim text.' });
  const router = routerReturning(JSON.stringify(wellFormedFields([claimId])));

  const result = await createBrief({ storage, researchProjectId, llmRouter: router, policy: briefPolicy });
  const persistedIds = JSON.parse(result.brief.key_claims);
  assert.deepEqual(persistedIds, [claimId]);

  // Mutating the underlying claim's text does not require touching the Brief
  // (v1 explicitly does not snapshot claim text) — the Brief's key_claims
  // array still references the same live claim id.
  storage.run('UPDATE claims SET claim = ? WHERE id = ?', ['Edited claim text.', claimId]);
  const stillReferenced = storage.get('SELECT * FROM claims WHERE id = ?', [claimId]);
  assert.equal(stillReferenced.claim, 'Edited claim text.');
  assert.deepEqual(JSON.parse(result.brief.key_claims), [claimId]);

  cleanup(storage, dbPath);
});

test('decision_log records the Brief-specific audit stages', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const { researchProjectId } = seedResearchProject(storage);
  const claimId = insertClaim(storage, researchProjectId, { claim: 'x' });
  const router = routerReturning(JSON.stringify(wellFormedFields([claimId])));

  const result = await createBrief({ storage, researchProjectId, llmRouter: router, policy: briefPolicy });

  const stages = storage.all(
    'SELECT DISTINCT stage FROM decision_log WHERE subject_id = ? OR subject_id = ?',
    [researchProjectId, result.brief.id]
  ).map((r) => r.stage);

  for (const expected of ['BRIEF_ELIGIBILITY_CHECK', 'BRIEF_CORE_QUESTION_RESOLUTION' /* only logged on failure */, 'BRIEF_KEY_CLAIM_ELIGIBILITY', 'BRIEF_GENERATION', 'BRIEF_PERSISTED']) {
    if (expected === 'BRIEF_CORE_QUESTION_RESOLUTION') continue; // success path does not log this stage (only failure does)
    assert.ok(stages.includes(expected), `expected stage ${expected} in decision_log, got ${stages.join(', ')}`);
  }

  cleanup(storage, dbPath);
});