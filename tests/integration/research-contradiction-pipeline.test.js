import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { SqliteStorageDriver } from '../../src/storage/SqliteStorageDriver.js';
import { LLMRouter } from '../../src/providers/llm/router.js';
import { ResearchSourceProvider } from '../../src/research/ResearchSourceProvider.js';
import { runResearchProject } from '../../src/research/pipeline.js';
import { CONTRADICTION_RESULT } from '../../src/research/constants.js';
import researchPolicy from '../../config/research_policy.json' with { type: 'json' };

function freshStorage() {
  const dbPath = path.join(os.tmpdir(), `research-contradiction-pipeline-${Date.now()}-${Math.random()}.db`);
  return { storage: new SqliteStorageDriver({ dbPath }), dbPath };
}

function cleanup(storage, dbPath) {
  storage.close();
  fs.rmSync(dbPath, { force: true });
  fs.rmSync(`${dbPath}-wal`, { force: true });
  fs.rmSync(`${dbPath}-shm`, { force: true });
}

function seedHandedOffOpportunity(storage) {
  const id = crypto.randomUUID();
  const proposition = {
    subject: 'Test subject', target_audience: 'Test audience', audience_problem: 'Test problem',
    core_question: 'Did policy X take effect, and what were its effects?',
    gap: 'g', angle: 'a', differentiation: 'd', commercial_relevance: 'c',
    core_question_type: 'FACTUAL'
  };
  storage.run(
    `INSERT INTO opportunities (id, title, source, discovered_at, status, opportunity_proposition)
     VALUES (?, 'Test opportunity', 'rss', ?, 'HANDED_TO_RESEARCH', ?)`,
    [id, new Date().toISOString(), JSON.stringify(proposition)]
  );
  return id;
}

class TwoSourceProvider extends ResearchSourceProvider {
  constructor(urls) {
    super();
    this.urls = urls;
  }
  get id() { return 'two-source-stub'; }
  async healthCheck() { return true; }
  async discoverCandidates() {
    return { candidates: this.urls.map((url, i) => ({ url, title: `t${i}`, snippet: 's' })) };
  }
}

function fakeFetch(bodyByUrl) {
  return async (url) => ({
    ok: true, status: 200,
    headers: { get: () => 'text/html' },
    text: async () => bodyByUrl[url] || '<html><body>content</body></html>'
  });
}

// Returns a different claim payload per successive call, so two distinct
// sources yield two distinct persisted claims (unlike a single fixed
// response, which would collapse to one claim via the pipeline's
// normalized-text dedup).
function sequentialClaimRouter(payloadsInOrder) {
  let call = 0;
  const registry = {
    'seq-stub': () => ({
      id: 'seq-stub', isPaid: false,
      async healthCheck() { return true; },
      async complete() {
        const payload = payloadsInOrder[Math.min(call, payloadsInOrder.length - 1)];
        call += 1;
        return { text: JSON.stringify(payload), model: 'seq-stub', requestId: null, inputTokens: 1, outputTokens: 1, estimatedCost: 0, isPaid: false };
      }
    })
  };
  return new LLMRouter({ priority: ['seq-stub'], allowPaidProviders: false, registry });
}

const TWO_URLS = ['https://acme.com/a', 'https://acme.com/b'];
function twoSourceFetch() {
  return fakeFetch({ [TWO_URLS[0]]: '<html><body>content a</body></html>', [TWO_URLS[1]]: '<html><body>content b</body></html>' });
}

async function runWithTwoFactClaims(storage, opportunityId, detectContradiction) {
  const provider = new TwoSourceProvider(TWO_URLS);
  const llmRouter = sequentialClaimRouter([
    [{ claim: 'Policy X took effect in 2024.', claim_type: 'FACT', is_load_bearing: true }],
    [{ claim: 'Policy X did not take effect in 2024.', claim_type: 'FACT', is_load_bearing: true }]
  ]);
  return runResearchProject({
    storage, opportunityId, sourceProvider: provider, llmRouter, policy: researchPolicy,
    classification: { authoritativeDomains: ['acme.com'] },
    fetchImpl: twoSourceFetch(),
    detectContradiction
  });
}

test('no detectContradiction supplied -> logged NOT_CHECKED, project proceeds normally', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const opportunityId = seedHandedOffOpportunity(storage);

  const result = await runWithTwoFactClaims(storage, opportunityId, undefined);

  assert.equal(result.claims.length, 2);
  const decisions = storage.all(`SELECT * FROM decision_log WHERE stage = 'CONTRADICTION_CHECK'`);
  assert.ok(decisions.some((d) => d.decision === 'NOT_CHECKED' && d.reason === 'detector_not_configured'));
  cleanup(storage, dbPath);
});

test('CONTRADICTS result: relation persisted, both claims CONTESTED, decision log distinguishes it from NOT_CHECKED', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const opportunityId = seedHandedOffOpportunity(storage);

  const result = await runWithTwoFactClaims(storage, opportunityId, async () => CONTRADICTION_RESULT.CONTRADICTS);

  assert.equal(result.claims.length, 2);
  assert.ok(result.claims.every((c) => c.evidence_status === 'CONTESTED'));

  const relations = storage.all('SELECT * FROM claim_relations');
  assert.equal(relations.length, 1);
  assert.equal(relations[0].relation_type, 'CONTRADICTS');

  const decisions = storage.all(`SELECT * FROM decision_log WHERE stage = 'CONTRADICTION_CHECK'`);
  assert.ok(decisions.some((d) => d.decision === 'CONTRADICTS'));
  assert.ok(!decisions.some((d) => d.decision === 'NOT_CHECKED'));
  cleanup(storage, dbPath);
});

test('NO_CONTRADICTION result: no relation persisted, project still reaches a terminal, non-FAILED status', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const opportunityId = seedHandedOffOpportunity(storage);

  const result = await runWithTwoFactClaims(storage, opportunityId, async () => CONTRADICTION_RESULT.NO_CONTRADICTION);

  const relations = storage.all('SELECT * FROM claim_relations');
  assert.equal(relations.length, 0);
  assert.notEqual(result.project.status, 'FAILED');
  cleanup(storage, dbPath);
});

test('UNCERTAIN result: no relation persisted and UNCERTAIN is logged distinctly (never silently downgraded)', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const opportunityId = seedHandedOffOpportunity(storage);

  const result = await runWithTwoFactClaims(storage, opportunityId, async () => CONTRADICTION_RESULT.UNCERTAIN);

  const relations = storage.all('SELECT * FROM claim_relations');
  assert.equal(relations.length, 0);
  const decisions = storage.all(`SELECT * FROM decision_log WHERE stage = 'CONTRADICTION_CHECK'`);
  assert.ok(decisions.some((d) => d.decision === 'UNCERTAIN'));
  assert.notEqual(result.project.status, 'FAILED');
  cleanup(storage, dbPath);
});

test('ERROR result (explicit): Research does not proceed as though checking succeeded — project FAILS, evidence grading never runs', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const opportunityId = seedHandedOffOpportunity(storage);

  const result = await runWithTwoFactClaims(storage, opportunityId, async () => CONTRADICTION_RESULT.ERROR);

  assert.equal(result.project.status, 'FAILED');
  assert.equal(result.stopReason, 'CONTRADICTION_CHECK_FAILED');
  // Evidence grading never ran for this project's claims.
  const claims = storage.all('SELECT * FROM claims WHERE research_project_id = ?', [result.project.id]);
  assert.ok(claims.every((c) => c.evidence_status === 'UNSUPPORTED'));

  const decisions = storage.all(`SELECT * FROM decision_log WHERE stage = 'CONTRADICTION_CHECK'`);
  assert.ok(decisions.some((d) => d.decision === 'ERROR'));
  assert.ok(!decisions.some((d) => d.decision === 'NO_CONTRADICTION'));
  cleanup(storage, dbPath);
});

test('thrown/rejected detector call is treated identically to an explicit ERROR result (fail-closed)', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const opportunityId = seedHandedOffOpportunity(storage);

  const result = await runWithTwoFactClaims(storage, opportunityId, async () => { throw new Error('provider unavailable'); });

  assert.equal(result.project.status, 'FAILED');
  assert.equal(result.stopReason, 'CONTRADICTION_CHECK_FAILED');
  const decisions = storage.all(`SELECT * FROM decision_log WHERE stage = 'CONTRADICTION_CHECK'`);
  const errorDecision = decisions.find((d) => d.decision === 'ERROR');
  assert.ok(errorDecision);
  assert.match(errorDecision.reason, /provider unavailable/);
  cleanup(storage, dbPath);
});

test('eligibility: a non-load-bearing FACT claim is excluded from the pair set (detector never called for it)', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const opportunityId = seedHandedOffOpportunity(storage);

  const provider = new TwoSourceProvider(TWO_URLS);
  const llmRouter = sequentialClaimRouter([
    [{ claim: 'Policy X took effect in 2024.', claim_type: 'FACT', is_load_bearing: true }],
    [{ claim: 'Some commentators noted the timing.', claim_type: 'FACT', is_load_bearing: false }]
  ]);

  let detectorCalls = 0;
  const result = await runResearchProject({
    storage, opportunityId, sourceProvider: provider, llmRouter, policy: researchPolicy,
    classification: { authoritativeDomains: ['acme.com'] },
    fetchImpl: twoSourceFetch(),
    detectContradiction: async () => { detectorCalls += 1; return CONTRADICTION_RESULT.NO_CONTRADICTION; }
  });

  assert.equal(result.claims.length, 2);
  assert.equal(detectorCalls, 0);
  const decisions = storage.all(`SELECT * FROM decision_log WHERE stage = 'CONTRADICTION_CHECK'`);
  assert.ok(decisions.some((d) => d.decision === 'NOT_CHECKED' && d.reason === 'insufficient_eligible_claim_pairs'));
  cleanup(storage, dbPath);
});

test('eligibility: INFERENCE and OPINION claims are excluded even when load-bearing', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const opportunityId = seedHandedOffOpportunity(storage);

  const provider = new TwoSourceProvider(TWO_URLS);
  const llmRouter = sequentialClaimRouter([
    [{ claim: 'Policy X will likely reduce costs.', claim_type: 'INFERENCE', is_load_bearing: true }],
    [{ claim: 'Policy X was a bad idea.', claim_type: 'OPINION', is_load_bearing: true }]
  ]);

  let detectorCalls = 0;
  await runResearchProject({
    storage, opportunityId, sourceProvider: provider, llmRouter, policy: researchPolicy,
    classification: { authoritativeDomains: ['acme.com'] },
    fetchImpl: twoSourceFetch(),
    detectContradiction: async () => { detectorCalls += 1; return CONTRADICTION_RESULT.NO_CONTRADICTION; }
  });

  assert.equal(detectorCalls, 0);
  cleanup(storage, dbPath);
});
