import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { SqliteStorageDriver } from '../../src/storage/SqliteStorageDriver.js';
import { SystemRunRecorder } from '../../src/state/SystemRun.js';
import { LLMRouter } from '../../src/providers/llm/router.js';
import { RssSource } from '../../src/providers/opportunity/RssSource.js';
import { runDiscoveryPipeline } from '../../src/discovery/pipeline.js';
import { ResearchSourceProvider } from '../../src/research/ResearchSourceProvider.js';
import { runResearchProject } from '../../src/research/pipeline.js';
import researchPolicy from '../../config/research_policy.json' with { type: 'json' };
import discoveryPolicy from '../../config/discovery_policy.json' with { type: 'json' };
import scoringWeights from '../../config/scoring_weights.json' with { type: 'json' };

function freshStorage() {
  const dbPath = path.join(os.tmpdir(), `research-e2e-${Date.now()}-${Math.random()}.db`);
  return { storage: new SqliteStorageDriver({ dbPath }), dbPath };
}

function cleanup(storage, dbPath) {
  storage.close();
  fs.rmSync(dbPath, { force: true });
  fs.rmSync(`${dbPath}-wal`, { force: true });
  fs.rmSync(`${dbPath}-shm`, { force: true });
}

// Simulates exactly what Discovery's real pipeline.js persists (D-01/D-02):
// status='HANDED_TO_RESEARCH' and opportunity_proposition JSON carrying
// core_question_type. Research must consume these as-is, never regenerate them.
function seedHandedOffOpportunity(storage, { coreQuestionType }) {
  const id = crypto.randomUUID();
  const proposition = {
    subject: 'Test subject', target_audience: 'Test audience', audience_problem: 'Test problem',
    core_question: 'Did the product launch cause a measurable sales increase, and how did the public react?',
    gap: 'g', angle: 'a', differentiation: 'd', commercial_relevance: 'c',
    core_question_type: coreQuestionType
  };
  storage.run(
    `INSERT INTO opportunities (id, title, source, discovered_at, status, opportunity_proposition)
     VALUES (?, 'Test opportunity', 'rss', ?, 'HANDED_TO_RESEARCH', ?)`,
    [id, new Date().toISOString(), JSON.stringify(proposition)]
  );
  return id;
}

class SingleSourceProvider extends ResearchSourceProvider {
  constructor(urls) {
    super();
    this.urls = urls;
  }
  get id() { return 'single-source-stub'; }
  async healthCheck() { return true; }
  async discoverCandidates() {
    return { candidates: this.urls.map((url, i) => ({ url, title: `t${i}`, snippet: 's' })) };
  }
}

function fakeFetch(bodyByUrl) {
  return async (url) => ({
    ok: true, status: 200,
    headers: { get: () => 'text/html' },
    text: async () => bodyByUrl[url] || '<html><body>No content</body></html>'
  });
}

function claimRouter(claimsToReturn) {
  const registry = {
    'research-stub': () => ({
      id: 'research-stub', isPaid: false,
      async healthCheck() { return true; },
      async complete() {
        return { text: JSON.stringify(claimsToReturn), model: 'research-stub', requestId: null, inputTokens: 1, outputTokens: 1, estimatedCost: 0, isPaid: false };
      }
    })
  };
  return new LLMRouter({ priority: ['research-stub'], allowPaidProviders: false, registry });
}

test('FACTUAL: a single primary_authoritative-sourced, load-bearing FACT claim reaches RESEARCH_COMPLETE', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const opportunityId = seedHandedOffOpportunity(storage, { coreQuestionType: 'FACTUAL' });

  const url = 'https://acme.com/press-release';
  const provider = new SingleSourceProvider([url]);
  const llmRouter = claimRouter([{ claim: 'Acme reported $1B in Q3 revenue.', claim_type: 'FACT', is_load_bearing: true }]);

  const result = await runResearchProject({
    storage, opportunityId, sourceProvider: provider, llmRouter, policy: researchPolicy,
    classification: { authoritativeDomains: ['acme.com'] },
    fetchImpl: fakeFetch({ [url]: '<html><body>Acme reported one billion dollars in Q3 revenue.</body></html>' })
  });

  assert.equal(result.project.status, 'RESEARCH_COMPLETE');
  assert.equal(result.claims.length, 1);
  assert.equal(result.claims[0].evidence_status, 'VERIFIED');

  cleanup(storage, dbPath);
});

test('MIXED: distinct factual + sentiment sources together reach RESEARCH_COMPLETE; factual alone would not', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const opportunityId = seedHandedOffOpportunity(storage, { coreQuestionType: 'MIXED' });

  const url = 'https://acme.com/press-release';
  const provider = new SingleSourceProvider([url]);
  const llmRouter = claimRouter([
    { claim: 'Acme reported $1B in Q3 revenue.', claim_type: 'FACT', is_load_bearing: true },
    { claim: 'Commentators called the launch a triumph.', claim_type: 'OPINION', is_load_bearing: true }
  ]);

  const result = await runResearchProject({
    storage, opportunityId, sourceProvider: provider, llmRouter, policy: researchPolicy,
    classification: { authoritativeDomains: ['acme.com'] },
    fetchImpl: fakeFetch({ [url]: '<html><body>content</body></html>' })
  });

  assert.equal(result.project.status, 'RESEARCH_COMPLETE');
  assert.equal(result.claims.length, 2);

  cleanup(storage, dbPath);
});

test('MIXED: only a factual claim (no sentiment component) does NOT reach RESEARCH_COMPLETE', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const opportunityId = seedHandedOffOpportunity(storage, { coreQuestionType: 'MIXED' });

  const url = 'https://acme.com/press-release';
  const provider = new SingleSourceProvider([url]);
  const llmRouter = claimRouter([{ claim: 'Acme reported $1B in Q3 revenue.', claim_type: 'FACT', is_load_bearing: true }]);

  const result = await runResearchProject({
    storage, opportunityId, sourceProvider: provider, llmRouter, policy: researchPolicy,
    classification: { authoritativeDomains: ['acme.com'] },
    fetchImpl: fakeFetch({ [url]: '<html><body>content</body></html>' })
  });

  assert.equal(result.project.status, 'INSUFFICIENT_EVIDENCE');
  // The single FACT claim is VERIFIED, so it also satisfies the sentiment
  // component on its own terms (v0.5 allowance) — but MIXED requires two
  // genuinely distinct claims, so this correctly fails as a distinctness
  // violation, not as "no sentiment claim was found at all".
  assert.equal(result.stopReason, 'MIXED_REQUIRES_DISTINCT_CLAIMS');

  cleanup(storage, dbPath);
});

test('zero load-bearing claims extracted -> INSUFFICIENT_EVIDENCE', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const opportunityId = seedHandedOffOpportunity(storage, { coreQuestionType: 'FACTUAL' });

  const url = 'https://acme.com/press-release';
  const provider = new SingleSourceProvider([url]);
  const llmRouter = claimRouter([{ claim: 'A minor tangential detail.', claim_type: 'FACT', is_load_bearing: false }]);

  const result = await runResearchProject({
    storage, opportunityId, sourceProvider: provider, llmRouter, policy: researchPolicy,
    classification: { authoritativeDomains: ['acme.com'] },
    fetchImpl: fakeFetch({ [url]: '<html><body>content</body></html>' })
  });

  assert.equal(result.project.status, 'INSUFFICIENT_EVIDENCE');
  assert.equal(result.stopReason, 'NO_LOAD_BEARING_CLAIMS');

  cleanup(storage, dbPath);
});

// --- Stopping-condition contract (Owner decision: max_acquisition_attempts
// is a safety/resource ceiling, not evidence acquisition completed) ---

test('STOPPING CONDITION: source cap reached with candidates remaining still reaches RESEARCH_COMPLETE', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const opportunityId = seedHandedOffOpportunity(storage, { coreQuestionType: 'FACTUAL' });

  // 3 candidates offered, but the source cap is 1 — acquisition stops after
  // the first, with 2 candidates never visited. This must still count as a
  // legitimate stop (the source cap was reached), independent of
  // candidatesExhausted being false.
  const urls = ['https://acme.com/a', 'https://acme.com/b', 'https://acme.com/c'];
  const provider = new SingleSourceProvider(urls);
  const llmRouter = claimRouter([{ claim: 'Acme reported $1B in Q3 revenue.', claim_type: 'FACT', is_load_bearing: true }]);
  const policy = { ...researchPolicy, acquisition: { ...researchPolicy.acquisition, max_sources_per_research_project: 1 } };

  const result = await runResearchProject({
    storage, opportunityId, sourceProvider: provider, llmRouter, policy,
    classification: { authoritativeDomains: ['acme.com'] },
    fetchImpl: fakeFetch({ [urls[0]]: '<html><body>Acme reported one billion dollars in Q3 revenue.</body></html>' })
  });

  assert.equal(result.project.status, 'RESEARCH_COMPLETE');
  assert.equal(result.stopReason, 'COMPLETENESS_CRITERIA_MET');
  assert.equal(result.sources.length, 1, 'acquisition must have stopped at the source cap, not visited the other 2 candidates');

  cleanup(storage, dbPath);
});

test('STOPPING CONDITION: max_acquisition_attempts reached with candidates remaining and source cap not reached does NOT reach RESEARCH_COMPLETE', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const opportunityId = seedHandedOffOpportunity(storage, { coreQuestionType: 'FACTUAL' });

  // 5 candidates offered, source cap is a generous 8 (never reached). The
  // first candidate succeeds (1 attempt) producing a VERIFIED load-bearing
  // FACT claim, satisfying every other completeness requirement on its
  // own. The second candidate then fails every retry (3 attempts: 1 +
  // max_retries_per_source=2), bringing attemptsUsed to 4 — exactly
  // max_acquisition_attempts. The loop then breaks with 3 of the 5
  // candidates never visited: candidatesExhausted=false, source cap not
  // reached. This must NOT be treated as a legitimate stop.
  const urls = ['https://acme.com/a', 'https://acme.com/b', 'https://acme.com/c', 'https://acme.com/d', 'https://acme.com/e'];
  const provider = new SingleSourceProvider(urls);
  const llmRouter = claimRouter([{ claim: 'Acme reported $1B in Q3 revenue.', claim_type: 'FACT', is_load_bearing: true }]);
  const policy = { ...researchPolicy, acquisition: { ...researchPolicy.acquisition, max_acquisition_attempts: 4 } };

  const fetchImpl = async (url) => {
    if (url === urls[0]) {
      return { ok: true, status: 200, headers: { get: () => 'text/html' }, text: async () => '<html><body>Acme reported one billion dollars in Q3 revenue.</body></html>' };
    }
    return { ok: false, status: 500, headers: { get: () => 'text/html' }, text: async () => '' };
  };

  const result = await runResearchProject({
    storage, opportunityId, sourceProvider: provider, llmRouter, policy,
    classification: { authoritativeDomains: ['acme.com'] },
    fetchImpl
  });

  assert.equal(result.project.status, 'INSUFFICIENT_EVIDENCE');
  assert.equal(result.stopReason, 'STOPPING_CONDITION_NOT_MET');
  assert.equal(result.sources.length, 2, 'only 2 of 5 candidates should have been visited before the attempt cap fired');

  cleanup(storage, dbPath);
});

test('rejects an opportunity that has not actually been handed to Research', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const id = crypto.randomUUID();
  storage.run(`INSERT INTO opportunities (id, title, source, discovered_at, status, opportunity_proposition) VALUES (?, 'x', 'rss', ?, 'SCORED', '{}')`,
    [id, new Date().toISOString()]);

  const provider = new SingleSourceProvider([]);
  const llmRouter = claimRouter([]);
  await assert.rejects(
    () => runResearchProject({ storage, opportunityId: id, sourceProvider: provider, llmRouter, policy: researchPolicy }),
    /HANDED_TO_RESEARCH/
  );
  cleanup(storage, dbPath);
});

test('research project uniqueness: running twice for the same opportunity does not create a duplicate row or redo completed work', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const opportunityId = seedHandedOffOpportunity(storage, { coreQuestionType: 'FACTUAL' });

  const url = 'https://acme.com/press-release';
  const provider = new SingleSourceProvider([url]);
  const llmRouter = claimRouter([{ claim: 'Acme reported $1B in Q3 revenue.', claim_type: 'FACT', is_load_bearing: true }]);
  const fetchImpl = fakeFetch({ [url]: '<html><body>content</body></html>' });

  const first = await runResearchProject({ storage, opportunityId, sourceProvider: provider, llmRouter, policy: researchPolicy, classification: { authoritativeDomains: ['acme.com'] }, fetchImpl });
  const second = await runResearchProject({ storage, opportunityId, sourceProvider: provider, llmRouter, policy: researchPolicy, classification: { authoritativeDomains: ['acme.com'] }, fetchImpl });

  assert.equal(second.alreadyTerminal, true);
  assert.equal(second.project.id, first.project.id);

  const rows = storage.all('SELECT * FROM research_projects WHERE opportunity_id = ?', [opportunityId]);
  assert.equal(rows.length, 1);

  cleanup(storage, dbPath);
});

// REAL HANDOFF: exercises the actual Discovery pipeline (RSS -> ... ->
// diversity/top-K persistence) and feeds its genuinely persisted opportunity
// straight into Research, rather than fabricating a HANDED_TO_RESEARCH row
// via direct SQL. This is the proof that D-01/D-02 and Research actually
// connect end-to-end through real production code paths on both sides.
test('REAL HANDOFF: an opportunity selected by the actual Discovery pipeline is consumed by the actual Research pipeline', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/rss+xml' });
    res.end(`<?xml version="1.0"?><rss version="2.0"><channel>
<item><title>AI startup launches automation tool for small business owners</title><link>https://acme.com/press-release</link><description>A new tool helps small business owners automate workflows.</description><pubDate>${new Date().toUTCString()}</pubDate><guid>g-real-handoff</guid></item>
</channel></rss>`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const runs = new SystemRunRecorder(storage);
  const { id: runId } = runs.start({ mode: 'SIMULATION' });

  const source = new RssSource({ feedUrls: [`http://127.0.0.1:${port}/feed`] });
  const { candidates } = await source.fetchCandidates();
  const observations = candidates.map((c) => source.normalize(c));

  const discoveryLlmRouter = claimRouter({
    subject: 'AI automation tool launch', target_audience: 'Small business owners',
    audience_problem: 'Unsure if the tool saves them money', core_question: 'Does the tool measurably cut costs?',
    gap: 'g', angle: 'a', differentiation: 'd', commercial_relevance: 'c', core_question_type: 'FACTUAL'
  });

  const rawFeatures = () => ({
    novelty: 80, competition: 40, story_potential: 75, evidence_availability: 70, production_difficulty: 30,
    audience_potential: 70, commercial_intent: 65, affiliate_potential: 60, lead_generation_potential: 55,
    product_adjacency: 60, sponsorship_potential: 40, policyRisk: 0.1, copyrightRisk: 0.1, repetitionRisk: 0.1
  });

  await runDiscoveryPipeline({
    storage, runId, observations, llmRouter: discoveryLlmRouter, discoveryPolicy, scoringWeights,
    alreadyProducedCorpus: [], topK: 1, rawFeatures
  });

  // Read back exactly what Discovery's real pipeline persisted — no
  // hand-constructed row.
  const persisted = storage.get('SELECT * FROM opportunities WHERE run_id = ?', [runId]);
  assert.equal(persisted.status, 'HANDED_TO_RESEARCH');
  const persistedProposition = JSON.parse(persisted.opportunity_proposition);
  assert.equal(persistedProposition.core_question_type, 'FACTUAL');

  const url = 'https://acme.com/press-release';
  const provider = new SingleSourceProvider([url]);
  const researchLlmRouter = claimRouter([{ claim: 'The tool measurably cuts costs for small businesses.', claim_type: 'FACT', is_load_bearing: true }]);

  const result = await runResearchProject({
    storage, opportunityId: persisted.id, sourceProvider: provider, llmRouter: researchLlmRouter, policy: researchPolicy,
    classification: { authoritativeDomains: ['acme.com'] },
    fetchImpl: fakeFetch({ [url]: '<html><body>The tool measurably cuts costs.</body></html>' })
  });

  assert.equal(result.project.status, 'RESEARCH_COMPLETE');
  assert.equal(result.claims.length, 1);

  server.close();
  cleanup(storage, dbPath);
});

// Real-Groq compatibility fix regression: a stub router returning the
// exact Markdown-fenced JSON shape observed from a real groq-free/
// openai-gpt-oss-20b response (see scripts/diagnose-real-research-claims.js
// live evidence) must still reach RESEARCH_COMPLETE with the claim
// persisted, not INSUFFICIENT_EVIDENCE/NO_LOAD_BEARING_CLAIMS.
test('FACTUAL: a claim array wrapped in a single ```json Markdown fence (real Groq shape) still reaches RESEARCH_COMPLETE', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const opportunityId = seedHandedOffOpportunity(storage, { coreQuestionType: 'FACTUAL' });

  const url = 'https://acme.com/press-release';
  const provider = new SingleSourceProvider([url]);
  const fencedClaimsText = '```json\n' + JSON.stringify([
    { claim: 'Acme reported one billion dollars in Q3 revenue following the product launch.', claim_type: 'FACT', is_load_bearing: true }
  ]) + '\n\n```';
  const registry = {
    'fenced-research-stub': () => ({
      id: 'fenced-research-stub', isPaid: false,
      async healthCheck() { return true; },
      async complete() {
        return { text: fencedClaimsText, model: 'fenced-research-stub', requestId: null, inputTokens: 1, outputTokens: 1, estimatedCost: 0, isPaid: false };
      }
    })
  };
  const llmRouter = new LLMRouter({ priority: ['fenced-research-stub'], allowPaidProviders: false, registry });

  const result = await runResearchProject({
    storage, opportunityId, sourceProvider: provider, llmRouter, policy: researchPolicy,
    classification: { authoritativeDomains: ['acme.com'] },
    fetchImpl: fakeFetch({ [url]: '<html><body>Acme reported one billion dollars in Q3 revenue.</body></html>' })
  });

  assert.equal(result.project.status, 'RESEARCH_COMPLETE');
  assert.equal(result.claims.length, 1);
  assert.equal(result.claims[0].claim, 'Acme reported one billion dollars in Q3 revenue following the product launch.');
  assert.equal(result.claims[0].evidence_status, 'VERIFIED');

  cleanup(storage, dbPath);
});

test('decision_log records the Research-specific audit stages', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const opportunityId = seedHandedOffOpportunity(storage, { coreQuestionType: 'FACTUAL' });

  const url = 'https://acme.com/press-release';
  const provider = new SingleSourceProvider([url]);
  const llmRouter = claimRouter([{ claim: 'Acme reported $1B in Q3 revenue.', claim_type: 'FACT', is_load_bearing: true }]);

  const result = await runResearchProject({
    storage, opportunityId, sourceProvider: provider, llmRouter, policy: researchPolicy,
    classification: { authoritativeDomains: ['acme.com'] },
    fetchImpl: fakeFetch({ [url]: '<html><body>content</body></html>' })
  });

  const stages = storage.all('SELECT DISTINCT stage FROM decision_log WHERE subject_id = ? OR subject_id IN (SELECT id FROM claims WHERE research_project_id = ?) OR subject_id IN (SELECT id FROM sources WHERE research_project_id = ?)',
    [result.project.id, result.project.id, result.project.id]).map((r) => r.stage);

  for (const expected of ['RESEARCH_PROJECT_CREATED', 'SOURCE_ACQUISITION', 'SOURCE_CLASSIFICATION', 'CLAIM_EXTRACTION', 'LOAD_BEARING_CLASSIFICATION', 'EVIDENCE_GRADING', 'COMPLETENESS_CHECK']) {
    assert.ok(stages.includes(expected), `expected stage ${expected} in decision_log, got ${stages.join(', ')}`);
  }

  cleanup(storage, dbPath);
});