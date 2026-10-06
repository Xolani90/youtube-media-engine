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
import researchPolicy from '../../config/research_policy.json' with { type: 'json' };

// Fail-closed extraction at the pipeline level: a malformed / truncated /
// empty extraction must never be persisted as a zero-claim "EXTRACTED"
// success; it is recorded as EXTRACTION_FAILED (with parseOutcome and
// finishReason). The failure is isolated to that source (v0.4 S12): it
// contributes no claims and does NOT abort the project, which proceeds to the
// normal completeness evaluation. A genuine "[]" stays EXTRACTED.

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
  test(`pipeline: ${label} is recorded as EXTRACTION_FAILED (isolated, no throw), never as a zero-claim EXTRACTED success`, async () => {
    const { storage, dbPath } = setup();
    try {
      await storage.migrate();
      const opportunityId = seed(storage);
      const result = await runResearchProject({ storage, opportunityId, sourceProvider: new OneSource(), llmRouter: routerReturning(completion), policy: researchPolicy, fetchImpl: fakeFetch });
      // Isolated, not propagated: the project reaches the normal completeness
      // evaluation and the deterministic terminal status for zero claims.
      assert.equal(result.project.status, 'INSUFFICIENT_EVIDENCE');
      assert.equal(result.stopReason, 'NO_LOAD_BEARING_CLAIMS');
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

// ---- Source-level failure isolation (two or more sources) ----

class TwoSources extends ResearchSourceProvider {
  get id() { return 'two-source-stub'; }
  async healthCheck() { return true; }
  async discoverCandidates() {
    return { candidates: [
      { url: 'https://publisher-one.com/a', title: 'a', snippet: 's' },
      { url: 'https://publisher-two.com/b', title: 'b', snippet: 's' }
    ] };
  }
}
const pageFor = (marker) => `<html><body>An independent report covering the product topic in some detail. ${marker}</body></html>`;
const twoSourceFetch = async (url) => ({
  ok: true, status: 200, headers: { get: () => 'text/html' },
  text: async () => pageFor(String(url).includes('publisher-one') ? 'MARKERALPHA' : 'MARKERBETA')
});
const GOOD_CLAIM = 'Acme launched Widget in 2024.';
// Source A (MARKERALPHA) always returns malformed JSON; source B returns a
// valid one-claim extraction. Anything else (contradiction / verification
// prompts) gets a harmless non-claim reply and is handled by existing paths.
function routerBySource({ failAlpha = true, failBeta = false } = {}) {
  const registry = {
    'stub': () => ({
      id: 'stub', isPaid: false,
      async healthCheck() { return true; },
      async complete({ prompt }) {
        const base = { model: 'm', requestId: null, inputTokens: 1, outputTokens: 1, estimatedCost: 0, isPaid: false, finishReason: 'STOP' };
        const bad = { ...base, text: 'not json at all' };
        if (prompt.includes('MARKERALPHA')) return failAlpha ? bad : { ...base, text: '[]' };
        if (prompt.includes('MARKERBETA')) {
          return failBeta ? bad : { ...base, text: JSON.stringify([{ claim: GOOD_CLAIM, claim_type: 'FACT', is_load_bearing: true, identity: null }]) };
        }
        return { ...base, text: '[]' };
      }
    })
  };
  return new LLMRouter({ priority: ['stub'], allowPaidProviders: false, registry });
}
const TERMINAL = ['RESEARCH_COMPLETE', 'INSUFFICIENT_EVIDENCE', 'FAILED'];

test('pipeline: one source fails extraction, another succeeds -- project is not aborted and B is extracted normally', async () => {
  const { storage, dbPath } = setup();
  try {
    await storage.migrate();
    const opportunityId = seed(storage);
    const result = await runResearchProject({ storage, opportunityId, sourceProvider: new TwoSources(), llmRouter: routerBySource(), policy: researchPolicy, fetchImpl: twoSourceFetch });

    const srcA = storage.get("SELECT id FROM sources WHERE url LIKE '%publisher-one%'");
    const srcB = storage.get("SELECT id FROM sources WHERE url LIKE '%publisher-two%'");
    assert.ok(srcA && srcB, 'both sources persisted');

    // A: visibly failed, fail-closed, no claims, no fabricated EXTRACTED row.
    const failed = storage.all("SELECT subject_id, reason FROM decision_log WHERE decision = 'EXTRACTION_FAILED'");
    assert.equal(failed.length, 1);
    assert.equal(failed[0].subject_id, srcA.id);
    assert.equal(failed[0].reason, 'parse_failed');
    assert.equal(storage.all("SELECT 1 FROM decision_log WHERE decision = 'EXTRACTED' AND subject_id = ?", [srcA.id]).length, 0);
    assert.equal(storage.all('SELECT 1 FROM claim_sources WHERE source_id = ?', [srcA.id]).length, 0, 'no claims from source A');

    // B: extracted and persisted normally.
    assert.equal(storage.all("SELECT 1 FROM decision_log WHERE decision = 'EXTRACTED' AND subject_id = ?", [srcB.id]).length, 1);
    const claims = storage.all('SELECT id, claim FROM claims');
    assert.deepEqual(claims.map((c) => c.claim), [GOOD_CLAIM]);
    assert.equal(storage.all('SELECT 1 FROM claim_sources WHERE source_id = ? AND claim_id = ?', [srcB.id, claims[0].id]).length, 1);

    // The existing evidence/completeness path ran and produced a terminal status
    // (whatever the unchanged completeness contract yields from B's evidence).
    assert.ok(TERMINAL.includes(result.project.status), `terminal status, got ${result.project.status}`);
    assert.equal(storage.get('SELECT status FROM research_projects WHERE id = ?', [result.project.id]).status, result.project.status);
    assert.ok(storage.all("SELECT 1 FROM decision_log WHERE subject_type = 'research_project' AND subject_id = ? AND decision = ?", [result.project.id, result.project.status]).length > 0, 'completeness decision logged for the project');
    assert.ok(storage.all("SELECT 1 FROM claims WHERE evidence_status IS NOT NULL").length === 1, 'claim from B went through evidence grading');
  } finally { cleanup(storage, dbPath); }
});

test('pipeline: every source extraction fails -- no throw, EXTRACTION_FAILED per source, no claims, normal completeness status', async () => {
  const { storage, dbPath } = setup();
  try {
    await storage.migrate();
    const opportunityId = seed(storage);
    const result = await runResearchProject({ storage, opportunityId, sourceProvider: new TwoSources(), llmRouter: routerBySource({ failAlpha: true, failBeta: true }), policy: researchPolicy, fetchImpl: twoSourceFetch });
    const sources = storage.all('SELECT id FROM sources');
    assert.equal(sources.length, 2);
    const failedIds = storage.all("SELECT subject_id FROM decision_log WHERE decision = 'EXTRACTION_FAILED'").map((r) => r.subject_id).sort();
    assert.deepEqual(failedIds, sources.map((s) => s.id).sort(), 'every source has an EXTRACTION_FAILED decision');
    assert.equal(storage.all("SELECT 1 FROM decision_log WHERE decision = 'EXTRACTED'").length, 0);
    assert.equal(storage.all('SELECT 1 FROM claims').length, 0, 'no fabricated claims');
    // Existing completeness policy for zero load-bearing claims; no new status.
    assert.equal(result.project.status, 'INSUFFICIENT_EVIDENCE');
    assert.equal(result.stopReason, 'NO_LOAD_BEARING_CLAIMS');
    assert.ok(storage.all("SELECT 1 FROM decision_log WHERE decision = 'INSUFFICIENT_EVIDENCE' AND subject_type = 'research_project'").length > 0);
  } finally { cleanup(storage, dbPath); }
});
