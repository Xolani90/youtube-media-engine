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
import { ExtractionFailureError } from '../../src/research/claims.js';
import researchPolicy from '../../config/research_policy.json' with { type: 'json' };

// Fail-closed extraction at the pipeline level: a malformed / truncated /
// empty extraction must never be persisted as a zero-claim "EXTRACTED"
// success; it is recorded as EXTRACTION_FAILED (with parseOutcome and
// finishReason) and the error propagates. A genuine "[]" stays EXTRACTED.

function setup() {
  const dbPath = path.join(os.tmpdir(), `extraction-fail-closed-${Date.now()}-${Math.random()}.db`);
  const storage = new SqliteStorageDriver({ dbPath });
  return { storage, dbPath };
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
class OneSource extends ResearchSourceProvider {
  get id() { return 'one-source-stub'; }
  async healthCheck() { return true; }
  async discoverCandidates() { return { candidates: [{ url: 'https://publisher-one.com/s', title: 't', snippet: 's' }] }; }
}
const fakeFetch = async () => ({
  ok: true, status: 200, headers: { get: () => 'text/html' },
  text: async () => '<html><body>An independent report covering the product topic in some detail.</body></html>'
});
function routerReturning(completion) {
  const registry = {
    'stub': () => ({
      id: 'stub', isPaid: false,
      async healthCheck() { return true; },
      async complete() { return { model: 'm', requestId: null, inputTokens: 1, outputTokens: 1, estimatedCost: 0, isPaid: false, ...completion }; }
    })
  };
  return new LLMRouter({ priority: ['stub'], allowPaidProviders: false, registry });
}

for (const [label, completion, outcome] of [
  ['truncated JSON', { text: '[{"claim":"Acme lau', finishReason: 'MAX_TOKENS' }, 'truncated'],
  ['empty content', { text: '' }, 'empty_content'],
  ['malformed JSON', { text: 'not json at all', finishReason: 'STOP' }, 'parse_failed']
]) {
  test(`pipeline: ${label} is recorded as EXTRACTION_FAILED, never as a zero-claim EXTRACTED success`, async () => {
    const { storage, dbPath } = setup();
    try {
      await storage.migrate();
      const opportunityId = seed(storage);
      await assert.rejects(
        () => runResearchProject({ storage, opportunityId, sourceProvider: new OneSource(), llmRouter: routerReturning(completion), policy: researchPolicy, fetchImpl: fakeFetch }),
        (e) => e instanceof ExtractionFailureError && e.parseOutcome === outcome
      );
      assert.equal(storage.all("SELECT 1 FROM decision_log WHERE decision = 'EXTRACTED'").length, 0, 'must not look like a successful extraction');
      const failed = storage.all("SELECT reason, config_snapshot FROM decision_log WHERE decision = 'EXTRACTION_FAILED'");
      assert.equal(failed.length, 1);
      assert.equal(failed[0].reason, outcome);
      const snap = JSON.parse(failed[0].config_snapshot);
      assert.equal(snap.parseOutcome, outcome);
      assert.equal(snap.attempts, 2);
      assert.equal(snap.finishReason, completion.finishReason ?? null);
      assert.equal(storage.all('SELECT 1 FROM claims').length, 0, 'no claims manufactured');
    } finally { cleanup(storage, dbPath); }
  });
}

test('pipeline: a legitimate "[]" is still EXTRACTED with zero claims and records parseOutcome/finishReason', async () => {
  const { storage, dbPath } = setup();
  try {
    await storage.migrate();
    const opportunityId = seed(storage);
    await runResearchProject({ storage, opportunityId, sourceProvider: new OneSource(), llmRouter: routerReturning({ text: '[]', finishReason: 'STOP' }), policy: researchPolicy, fetchImpl: fakeFetch });
    const rows = storage.all("SELECT reason, config_snapshot FROM decision_log WHERE decision = 'EXTRACTED'");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].reason, '0_claims_proposed');
    const snap = JSON.parse(rows[0].config_snapshot);
    assert.equal(snap.parseOutcome, 'parsed_zero_claims');
    assert.equal(snap.finishReason, 'STOP');
    assert.equal(snap.attempts, 1);
    assert.equal(storage.all("SELECT 1 FROM decision_log WHERE decision = 'EXTRACTION_FAILED'").length, 0);
  } finally { cleanup(storage, dbPath); }
});
