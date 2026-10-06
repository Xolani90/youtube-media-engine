import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { SqliteStorageDriver } from '../../src/storage/SqliteStorageDriver.js';
import { LLMRouter } from '../../src/providers/llm/router.js';
import { ResearchSourceProvider } from '../../src/research/ResearchSourceProvider.js';
import { runResearchProject, buildResearchQuery } from '../../src/research/pipeline.js';
import { selectEligibleResearch } from '../../src/autonomous/workSelection.js';
import { isQuarantined, RETRY_STAGE } from '../../src/state/StageRetryPolicy.js';
import { ExtractionFailureError, EXTRACTION_PARSE_OUTCOME } from '../../src/research/claims.js';
import { LlmWorkloadError, WORKLOAD_ERROR_CODE, WORKLOAD_FAILURE } from '../../src/research/llmWorkload.js';
import {
  classifyFailureDetail, classifyProviderError, classifyExtractionFailure, failureBasis,
  RESEARCH_FAILURE_NATURE as NATURE, ISOLATE
} from '../../src/research/researchFailure.js';
import researchPolicy from '../../config/research_policy.json' with { type: 'json' };

// ADR-0039 (B4): resumable Research recovery. Provider/infrastructure failure
// must never masquerade as a completed (or INSUFFICIENT_EVIDENCE) result, and a
// retry must resume from the committed checkpoints without duplicating evidence.

function setup() {
  const dbPath = path.join(os.tmpdir(), `research-resume-${Date.now()}-${Math.random()}.db`);
  return { storage: new SqliteStorageDriver({ dbPath }), dbPath };
}
function cleanup(storage, dbPath) {
  storage.close();
  for (const s of ['', '-wal', '-shm']) fs.rmSync(`${dbPath}${s}`, { force: true });
}
function seed(storage) {
  const id = crypto.randomUUID();
  storage.run(
    `INSERT INTO opportunities (id, title, source, discovered_at, status, opportunity_proposition)
     VALUES (?, 'T', 'rss', ?, 'HANDED_TO_RESEARCH', ?)`,
    [id, new Date().toISOString(), JSON.stringify({
      subject: 'Acme Widget', target_audience: 'a', audience_problem: 'p', core_question: 'Did Acme launch Widget?',
      gap: 'g', angle: 'a', differentiation: 'd', commercial_relevance: 'c', core_question_type: 'FACTUAL'
    })]
  );
  return id;
}
const count = (storage, sql, params = []) => storage.get(sql, params).n;
const pageFor = (marker) => `<html><body>An independent report covering the product topic in some detail. ${marker}</body></html>`;
const fakeFetch = async (url) => ({
  ok: true, status: 200, headers: { get: () => 'text/html' },
  text: async () => pageFor(String(url).includes('publisher-one') ? 'MARKERALPHA' : 'MARKERBETA')
});

const INITIAL_QUERY = buildResearchQuery('Acme Widget', 'Did Acme launch Widget?');
class CountingSources extends ResearchSourceProvider {
  constructor(urls) { super(); this.urls = urls; this.calls = 0; this.queries = []; }
  get id() { return 'counting-stub'; }
  // Number of times the INITIAL acquisition discovery ran (evidence expansion uses other queries).
  get initialDiscoveries() { return this.queries.filter((q) => q === INITIAL_QUERY).length; }
  async healthCheck() { return true; }
  async discoverCandidates({ query } = {}) {
    this.calls += 1;
    this.queries.push(query);
    return { candidates: this.urls.map((url) => ({ url, title: 't', snippet: 's' })) };
  }
}

const GOOD = JSON.stringify([{ claim: 'Acme launched Widget in 2024.', claim_type: 'FACT', is_load_bearing: true, identity: null }]);
const ok = (text) => ({ model: 'm', requestId: null, inputTokens: 1, outputTokens: 1, estimatedCost: 0, isPaid: false, finishReason: 'STOP', text });

// `behaviour(prompt)` returns a completion or throws.
function routerWith(behaviour, { healthy = true } = {}) {
  const state = { calls: 0 };
  const registry = {
    stub: () => ({
      id: 'stub', isPaid: false,
      async healthCheck() { return healthy; },
      async complete({ prompt }) { state.calls += 1; return behaviour(prompt); }
    })
  };
  const router = new LLMRouter({ priority: ['stub'], allowPaidProviders: false, registry });
  router.state = state;
  return router;
}
const httpError = (status) => Object.assign(new Error(`HTTP ${status}`), { status });
const run = (storage, opportunityId, sourceProvider, llmRouter, extra = {}) =>
  runResearchProject({ storage, opportunityId, sourceProvider, llmRouter, policy: researchPolicy, fetchImpl: fakeFetch, ...extra });
const retryRow = (storage) => storage.get("SELECT * FROM stage_retry_state WHERE stage = 'RESEARCH'");

// ------------------------------------------------------------- classification

test('classification: structured fields only; transient / infrastructure / unclassified are distinct', () => {
  for (const status of [429, 500, 502, 503, 504]) assert.equal(classifyFailureDetail({ status }), NATURE.TRANSIENT);
  for (const status of [401, 402, 403]) assert.equal(classifyFailureDetail({ status }), NATURE.INFRASTRUCTURE);
  assert.equal(classifyFailureDetail({ status: 418 }), NATURE.UNCLASSIFIED);
  assert.equal(classifyFailureDetail({ code: 'NO_USABLE_PROVIDER' }), NATURE.INFRASTRUCTURE);
  assert.equal(classifyFailureDetail({ name: 'AbortError' }), NATURE.TRANSIENT);
  assert.equal(classifyFailureDetail({ name: 'TimeoutError' }), NATURE.TRANSIENT);
  assert.equal(classifyFailureDetail({ causeCode: 'ECONNRESET' }), NATURE.TRANSIENT);
  assert.equal(classifyFailureDetail({ causeCode: 'UND_ERR_CONNECT_TIMEOUT' }), NATURE.TRANSIENT);
  assert.equal(classifyFailureDetail({ error: 'HTTP 503 rate limit' }), NATURE.UNCLASSIFIED, 'message text is never read');
  assert.equal(classifyFailureDetail(null), NATURE.UNCLASSIFIED);
});

test('classification: the most conservative nature wins across aggregated provider failures', () => {
  const agg = (...failures) => classifyProviderError(Object.assign(new Error('all failed'), { failures }));
  assert.equal(agg({ status: 503 }, { status: 429 }), NATURE.TRANSIENT);
  assert.equal(agg({ status: 503 }, { status: 401 }), NATURE.INFRASTRUCTURE);
  assert.equal(agg({ status: 503 }, { status: 418 }), NATURE.UNCLASSIFIED);
  assert.equal(agg({ code: 'EMPTY_COMPLETION' }), NATURE.UNCLASSIFIED, 'only-neutral failures never establish a transient cause');
  assert.equal(agg({ code: 'EMPTY_COMPLETION' }, { status: 503 }), NATURE.TRANSIENT);
});

test('classification: workload refusals — local budget is isolated; breaker follows its cause; unknown fails closed', () => {
  const w = (code, cls) => new LlmWorkloadError(code, 'x', cls);
  assert.equal(classifyProviderError(w(WORKLOAD_ERROR_CODE.BUDGET_EXHAUSTED)), ISOLATE);
  assert.equal(classifyProviderError(w(WORKLOAD_ERROR_CODE.BREAKER_OPEN, WORKLOAD_FAILURE.AUTH_CONFIG)), NATURE.INFRASTRUCTURE);
  assert.equal(classifyProviderError(w(WORKLOAD_ERROR_CODE.BREAKER_OPEN, WORKLOAD_FAILURE.DEPLETED_CREDITS)), NATURE.INFRASTRUCTURE);
  assert.equal(classifyProviderError(w(WORKLOAD_ERROR_CODE.BREAKER_OPEN, WORKLOAD_FAILURE.RATE_LIMIT)), NATURE.TRANSIENT);
  assert.equal(classifyProviderError(w(WORKLOAD_ERROR_CODE.BREAKER_OPEN, 'CONSECUTIVE_TRANSIENT_FAILURES')), NATURE.TRANSIENT);
  assert.equal(classifyProviderError(w(WORKLOAD_ERROR_CODE.BREAKER_OPEN, 'SOMETHING_NEW')), NATURE.UNCLASSIFIED);
});

test('classification: only PROVIDER_FAILED extraction failures leave source-level isolation', () => {
  for (const parseOutcome of [EXTRACTION_PARSE_OUTCOME.TRUNCATED, EXTRACTION_PARSE_OUTCOME.EMPTY_CONTENT, EXTRACTION_PARSE_OUTCOME.PARSE_FAILED, EXTRACTION_PARSE_OUTCOME.PARSED_NON_ARRAY]) {
    assert.equal(classifyExtractionFailure(new ExtractionFailureError({ parseOutcome, cause: httpError(503) })), ISOLATE);
  }
  const provider = (cause) => new ExtractionFailureError({ parseOutcome: EXTRACTION_PARSE_OUTCOME.PROVIDER_FAILED, cause });
  assert.equal(classifyExtractionFailure(provider(httpError(503))), NATURE.TRANSIENT);
  assert.equal(classifyExtractionFailure(provider(httpError(401))), NATURE.INFRASTRUCTURE);
  assert.equal(classifyExtractionFailure(provider(new Error('boom'))), NATURE.UNCLASSIFIED);
  assert.match(failureBasis(Object.assign(new Error('x'), { failures: [{ status: 503 }, { status: 503 }] }), 'extraction'), /^extraction:503$/);
});

test('router: structured name/causeCode are preserved and the no-provider error carries a code', async () => {
  const boom = Object.assign(new Error('socket'), { name: 'TypeError', cause: { code: 'ECONNRESET' } });
  const failing = routerWith(() => { throw boom; });
  await assert.rejects(() => failing.complete({ prompt: 'p' }), (err) => {
    assert.equal(err.failures[0].name, 'TypeError');
    assert.equal(err.failures[0].causeCode, 'ECONNRESET');
    return true;
  });
  const none = routerWith(() => ok('[]'), { healthy: false });
  await assert.rejects(() => none.complete({ prompt: 'p' }), (err) => err.code === 'NO_USABLE_PROVIDER');
});

// -------------------------------------------------------------- pipeline

test('transient provider failure: attempt abandoned (not a research outcome), one RESEARCH attempt recorded, nothing extracted', async () => {
  const { storage, dbPath } = setup();
  try {
    await storage.migrate();
    const oppId = seed(storage);
    const result = await run(storage, oppId, new CountingSources(['https://publisher-one.com/a']), routerWith(() => { throw httpError(503); }));
    assert.equal(result.project.status, 'RESEARCHING', 'never INSUFFICIENT_EVIDENCE');
    assert.equal(result.stopReason, 'RESEARCH_TRANSIENT_FAILURE');
    assert.equal(result.attempt, 1);
    assert.deepEqual(result.attemptFailure, { nature: 'TRANSIENT', basis: 'extraction:503' });
    assert.equal(retryRow(storage).attempt_count, 1);
    assert.equal(count(storage, 'SELECT COUNT(*) n FROM claims'), 0);
    assert.equal(count(storage, "SELECT COUNT(*) n FROM decision_log WHERE decision IN ('EXTRACTED','EXTRACTION_FAILED')"), 0);
    const cps = storage.all('SELECT checkpoint FROM research_checkpoints').map((r) => r.checkpoint);
    assert.deepEqual(cps, ['SOURCES_PERSISTED']);
  } finally { cleanup(storage, dbPath); }
});

test('retry resumes from SOURCES_PERSISTED: no re-acquisition, no duplicate sources, evidence extracted exactly once', async () => {
  const { storage, dbPath } = setup();
  try {
    await storage.migrate();
    const oppId = seed(storage);
    const sources = new CountingSources(['https://publisher-one.com/a', 'https://publisher-two.com/b']);
    let healthy = false;
    const router = routerWith((prompt) => {
      // Source A succeeds; source B fails transiently until "healthy" (partial failure).
      if (prompt.includes('MARKERBETA') && !healthy) throw httpError(503);
      return ok(prompt.includes('MARKERALPHA') ? GOOD : '[]');
    });
    const first = await run(storage, oppId, sources, router);
    assert.equal(first.stopReason, 'RESEARCH_TRANSIENT_FAILURE', 'partial failure fails the WHOLE attempt');
    assert.equal(count(storage, 'SELECT COUNT(*) n FROM claims'), 0, "source A's claims are not committed by a failed attempt");
    const sourcesAfterFirst = count(storage, 'SELECT COUNT(*) n FROM sources');
    assert.equal(sources.initialDiscoveries, 1);

    healthy = true;
    const second = await run(storage, oppId, sources, router);
    assert.equal(sources.initialDiscoveries, 1, 'initial discovery/acquisition not repeated');
    assert.equal(count(storage, 'SELECT COUNT(*) n FROM sources'), sourcesAfterFirst, 'no duplicate sources');
    assert.notEqual(second.project.status, 'RESEARCHING');
    assert.equal(count(storage, 'SELECT COUNT(*) n FROM claims'), 1, 'claim persisted exactly once');
    assert.equal(count(storage, "SELECT COUNT(*) n FROM decision_log WHERE decision = 'EXTRACTED'"), 2);
    const cps = storage.all('SELECT checkpoint FROM research_checkpoints ORDER BY checkpoint').map((r) => r.checkpoint);
    assert.ok(cps.includes('SOURCES_PERSISTED') && cps.includes('EXTRACTION_PERSISTED'));
  } finally { cleanup(storage, dbPath); }
});

test('infrastructure failures (401/402/403) and no-usable-provider never consume retry budget and never become INSUFFICIENT_EVIDENCE', async () => {
  for (const [label, router, basisRe] of [
    ['401', routerWith(() => { throw httpError(401); }), /^extraction:401$/],
    ['402', routerWith(() => { throw httpError(402); }), /^extraction:402$/],
    ['403', routerWith(() => { throw httpError(403); }), /^extraction:403$/],
    ['no usable provider', routerWith(() => ok('[]'), { healthy: false }), /^extraction:NO_USABLE_PROVIDER$/]
  ]) {
    const { storage, dbPath } = setup();
    try {
      await storage.migrate();
      const oppId = seed(storage);
      const result = await run(storage, oppId, new CountingSources(['https://publisher-one.com/a']), router);
      assert.equal(result.project.status, 'RESEARCHING', label);
      assert.equal(result.stopReason, 'RESEARCH_INFRASTRUCTURE_FAILURE', label);
      assert.equal(result.attempt, undefined, `${label}: no attempt recorded`);
      assert.equal(result.retryDisposition.eligible, false, label);
      assert.match(result.attemptFailure.basis, basisRe, label);
      assert.equal(retryRow(storage), undefined, `${label}: no stage_retry_state row`);
      assert.equal(count(storage, "SELECT COUNT(*) n FROM decision_log WHERE decision = 'EXTRACTION_FAILED'"), 0, `${label}: not swallowed per source`);
    } finally { cleanup(storage, dbPath); }
  }
});

test('unclassified provider failure fails closed: no attempt, no retry, project FAILED (existing status, new stop reason only)', async () => {
  const { storage, dbPath } = setup();
  try {
    await storage.migrate();
    const oppId = seed(storage);
    const result = await run(storage, oppId, new CountingSources(['https://publisher-one.com/a']), routerWith(() => { throw new Error('mystery'); }));
    assert.equal(result.project.status, 'FAILED');
    assert.equal(result.stopReason, 'RESEARCH_UNCLASSIFIED_FAILURE');
    assert.equal(retryRow(storage), undefined);
    assert.equal(selectEligibleResearch(storage).length, 0, 'a failed-closed project is never re-selected');
  } finally { cleanup(storage, dbPath); }
});

test('source-level isolation is preserved for genuinely non-transient output conditions', async () => {
  const { storage, dbPath } = setup();
  try {
    await storage.migrate();
    const oppId = seed(storage);
    const result = await run(storage, oppId, new CountingSources(['https://publisher-one.com/a']), routerWith(() => ok('not json at all')));
    assert.equal(result.project.status, 'INSUFFICIENT_EVIDENCE');
    assert.equal(count(storage, "SELECT COUNT(*) n FROM decision_log WHERE decision = 'EXTRACTION_FAILED'"), 1);
    assert.equal(retryRow(storage), undefined);
  } finally { cleanup(storage, dbPath); }
});

test('bounded: three transient attempts quarantine the project; it is then refused and not selected', async () => {
  const { storage, dbPath } = setup();
  try {
    await storage.migrate();
    const oppId = seed(storage);
    const sources = new CountingSources(['https://publisher-one.com/a']);
    const router = routerWith(() => { throw httpError(429); });
    for (let i = 1; i <= 3; i += 1) {
      const r = await run(storage, oppId, sources, router);
      assert.equal(r.attempt, i);
      assert.equal(selectEligibleResearch(storage).length, i < 3 ? 1 : 0, `selectable after attempt ${i}`);
    }
    const project = storage.get('SELECT id FROM research_projects');
    assert.ok(isQuarantined(storage, project.id, RETRY_STAGE.RESEARCH));
    const callsBefore = router.state.calls;
    const refused = await run(storage, oppId, sources, router);
    assert.equal(refused.quarantined, true);
    assert.equal(router.state.calls, callsBefore, 'a quarantined project makes no provider call');
  } finally { cleanup(storage, dbPath); }
});

test('selector: resumable projects need a SOURCES_PERSISTED checkpoint (or no sources at all); pre-checkpoint partial state is never selected', async () => {
  const { storage, dbPath } = setup();
  try {
    await storage.migrate();
    const oppId = seed(storage);
    assert.deepEqual(selectEligibleResearch(storage), [{ opportunityId: oppId }]);
    await run(storage, oppId, new CountingSources(['https://publisher-one.com/a']), routerWith(() => { throw httpError(503); }));
    const project = storage.get('SELECT id FROM research_projects');
    assert.deepEqual(selectEligibleResearch(storage), [{ opportunityId: oppId }], 'same item shape as a fresh item');
    storage.run('DELETE FROM research_checkpoints WHERE research_project_id = ?', [project.id]);
    assert.equal(selectEligibleResearch(storage).length, 0, 'sources without a checkpoint: not resumable');
    await assert.rejects(() => run(storage, oppId, new CountingSources(['https://publisher-one.com/a']), routerWith(() => ok('[]'))), /refusing to re-acquire/);
  } finally { cleanup(storage, dbPath); }
});

test('atomicity: a failure while persisting extraction rolls back the whole phase; the retry then commits it exactly once', async () => {
  const { storage, dbPath } = setup();
  try {
    await storage.migrate();
    const oppId = seed(storage);
    const sources = new CountingSources(['https://publisher-one.com/a']);
    const router = routerWith(() => ok(GOOD));
    const realRun = storage.run.bind(storage);
    let armed = true;
    storage.run = (sql, params) => {
      if (armed && /INSERT INTO research_checkpoints/.test(sql) && params?.[2] === 'EXTRACTION_PERSISTED') {
        armed = false;
        throw new Error('simulated hard interruption');
      }
      return realRun(sql, params);
    };
    await assert.rejects(() => run(storage, oppId, sources, router), /simulated hard interruption/);
    assert.equal(count(storage, 'SELECT COUNT(*) n FROM claims'), 0);
    assert.equal(count(storage, 'SELECT COUNT(*) n FROM claim_sources'), 0);
    assert.equal(count(storage, "SELECT COUNT(*) n FROM decision_log WHERE stage = 'CLAIM_EXTRACTION'"), 0, 'decision rows rolled back too');
    assert.equal(count(storage, "SELECT COUNT(*) n FROM research_checkpoints WHERE checkpoint = 'EXTRACTION_PERSISTED'"), 0);

    const second = await run(storage, oppId, sources, router);
    assert.notEqual(second.project.status, 'RESEARCHING');
    assert.equal(count(storage, 'SELECT COUNT(*) n FROM claims'), 1);
    assert.equal(count(storage, "SELECT COUNT(*) n FROM research_checkpoints WHERE checkpoint = 'EXTRACTION_PERSISTED'"), 1);
    assert.equal(sources.initialDiscoveries, 1);
  } finally { cleanup(storage, dbPath); }
});

// ---- Expansion: EXPANSION_PERSISTED carries the exact expansion budget state

class ExpandingSources extends ResearchSourceProvider {
  constructor() { super(); this.calls = 0; }
  get id() { return 'expanding-stub'; }
  async healthCheck() { return true; }
  async discoverCandidates() {
    this.calls += 1;
    return { candidates: [{ url: this.calls === 1 ? 'https://publisher-one.com/a' : 'https://publisher-two.com/b', title: 't', snippet: 's' }] };
  }
}

test('EXPANSION_PERSISTED: exact budget state; a crash after expansion resumes without re-extracting, re-discovering or re-acquiring', async () => {
  const { storage, dbPath } = setup();
  try {
    await storage.migrate();
    const oppId = seed(storage);
    const policy = { ...researchPolicy, acquisition: { ...researchPolicy.acquisition, max_sources_per_research_project: 3, max_acquisition_attempts: 6 } };
    const sources = new ExpandingSources();
    const router = routerWith(() => ok(GOOD));
    const verifier = async () => ({ callsUsed: 0 });
    const first = await runResearchProject({ storage, opportunityId: oppId, sourceProvider: sources, llmRouter: router, policy, fetchImpl: fakeFetch, evidenceVerifier: verifier });
    assert.notEqual(first.project.status, 'RESEARCHING');
    const cp = storage.get("SELECT payload FROM research_checkpoints WHERE checkpoint = 'EXPANSION_PERSISTED'");
    assert.ok(cp, 'expansion happened and was checkpointed');
    const payload = JSON.parse(cp.payload);
    const claim = storage.get('SELECT id FROM claims');
    assert.equal(payload.topFactClaimId, claim.id);
    assert.ok(Number.isInteger(payload.expansionAttemptsUsed) && payload.expansionAttemptsUsed >= 1);
    assert.ok(Number.isInteger(payload.callsRemaining));
    assert.equal(payload.expansionSourceIds.length, count(storage, 'SELECT COUNT(*) n FROM sources') - 1);

    // Simulate a hard interruption after the expansion commit, before the terminal update.
    const before = { sources: count(storage, 'SELECT COUNT(*) n FROM sources'), claims: count(storage, 'SELECT COUNT(*) n FROM claims'), llm: router.state.calls, disc: sources.calls };
    storage.run("UPDATE research_projects SET status = 'RESEARCHING', stop_reason = NULL, completed_at = NULL");
    const resumed = await runResearchProject({ storage, opportunityId: oppId, sourceProvider: sources, llmRouter: router, policy, fetchImpl: fakeFetch, evidenceVerifier: verifier });
    assert.notEqual(resumed.project.status, 'RESEARCHING');
    assert.equal(sources.calls, before.disc, 'no re-discovery (initial or expansion)');
    assert.equal(router.state.calls, before.llm, 'no re-extraction');
    assert.equal(count(storage, 'SELECT COUNT(*) n FROM sources'), before.sources, 'no duplicate sources');
    assert.equal(count(storage, 'SELECT COUNT(*) n FROM claims'), before.claims);
    assert.equal(count(storage, 'SELECT COUNT(*) n FROM research_checkpoints'), 3, 'each checkpoint exists exactly once');
    assert.equal(resumed.project.status, first.project.status, 'same deterministic outcome');
  } finally { cleanup(storage, dbPath); }
});

// ------------------------------------------------------------------- runner

import { runAutonomousOperation } from '../../src/autonomous/runner.js';

test('runner: a transient failure consumes that item only; independent items are each attempted once; no in-invocation retry', async () => {
  const { storage, dbPath } = setup();
  try {
    await storage.migrate();
    const oppA = seed(storage);
    const oppB = seed(storage);
    const sources = new CountingSources(['https://publisher-one.com/a']);
    const router = routerWith(() => { throw httpError(503); });
    const out = await runAutonomousOperation({
      storage, llmRouter: router, researchPolicy,
      research: { sourceProvider: sources, fetchImpl: fakeFetch }
    });
    assert.equal(out.processed.find((p) => p.stage === 'research').count, 2, 'each of the two items attempted exactly once');
    assert.equal(count(storage, "SELECT COUNT(*) n FROM stage_retry_state WHERE stage = 'RESEARCH' AND attempt_count = 1"), 2);
    assert.equal(out.stopReason, 'no_progress');
    // The next invocation resumes both from their checkpoints (no re-acquisition).
    const before = sources.initialDiscoveries;
    await runAutonomousOperation({ storage, llmRouter: router, researchPolicy, research: { sourceProvider: sources, fetchImpl: fakeFetch } });
    assert.equal(sources.initialDiscoveries, before);
    assert.equal(count(storage, "SELECT COUNT(*) n FROM stage_retry_state WHERE stage = 'RESEARCH' AND attempt_count = 2"), 2);
    assert.ok(oppA && oppB);
  } finally { cleanup(storage, dbPath); }
});

test('runner: an infrastructure failure records no attempt and is not retried within the invocation', async () => {
  const { storage, dbPath } = setup();
  try {
    await storage.migrate();
    seed(storage);
    const router = routerWith(() => { throw httpError(401); });
    const out = await runAutonomousOperation({
      storage, llmRouter: router, researchPolicy,
      research: { sourceProvider: new CountingSources(['https://publisher-one.com/a']), fetchImpl: fakeFetch }
    });
    assert.equal(out.processed.find((p) => p.stage === 'research').count, 1);
    assert.equal(count(storage, "SELECT COUNT(*) n FROM stage_retry_state WHERE stage = 'RESEARCH'"), 0);
    assert.equal(storage.get('SELECT status FROM research_projects').status, 'RESEARCHING');
    assert.equal(storage.get('SELECT status FROM system_runs').status, 'FAILED', 'work attempted, none succeeded');
  } finally { cleanup(storage, dbPath); }
});
