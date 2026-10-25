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

// Regression: a Research run whose discovery yields ZERO candidates must leave a
// durable, sanitized record of WHY (provider failure vs genuinely empty vs thrown),
// in both decision_log and the SOURCES_PERSISTED checkpoint, without changing any
// research outcome, state vocabulary, retry behaviour, or gate. Isolated tmp DB,
// stub providers, stub LLM, injected fetch: no network and no model call.

function setup() {
  const dbPath = path.join(os.tmpdir(), `research-discovery-diag-${Date.now()}-${Math.random()}.db`);
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

const SECRET = 'SUPERSECRET-DO-NOT-PERSIST';
class ScriptedProvider extends ResearchSourceProvider {
  constructor(result) { super(); this.result = result; this.calls = 0; }
  get id() { return 'scripted-stub'; }
  async healthCheck() { return true; }
  async discoverCandidates() {
    this.calls += 1;
    if (this.result instanceof Error) throw this.result;
    return this.result;
  }
}

const ok = (text) => ({ model: 'm', requestId: null, inputTokens: 1, outputTokens: 1, estimatedCost: 0, isPaid: false, finishReason: 'STOP', text });
function routerWith(behaviour) {
  const state = { calls: 0 };
  const registry = { stub: () => ({ id: 'stub', isPaid: false, async healthCheck() { return true; }, async complete({ prompt }) { state.calls += 1; return behaviour(prompt); } }) };
  const router = new LLMRouter({ priority: ['stub'], allowPaidProviders: false, registry });
  router.state = state;
  return router;
}
const noNetwork = async () => { throw new Error('test must not touch the network'); };
const pageFetch = async () => ({ ok: true, status: 200, headers: { get: () => 'text/html' }, text: async () => '<html><body>An independent report covering the product topic in some detail. MARKER</body></html>' });
const run = (storage, oppId, provider, llm = routerWith(() => ok('[]')), extra = {}) =>
  runResearchProject({ storage, opportunityId: oppId, sourceProvider: provider, llmRouter: llm, policy: researchPolicy, fetchImpl: noNetwork, ...extra });

const rows = (storage, where, params = []) => storage.all(`SELECT * FROM decision_log WHERE ${where} ORDER BY rowid`, params);
const noCandidateRows = (storage) => rows(storage, "stage = 'SOURCE_DISCOVERY' AND decision = 'NO_CANDIDATES'");
const sourcesCheckpoint = (storage) => JSON.parse(storage.get("SELECT payload FROM research_checkpoints WHERE checkpoint = 'SOURCES_PERSISTED'").payload);
const everythingPersisted = (storage) => JSON.stringify([
  storage.all('SELECT * FROM decision_log'), storage.all('SELECT * FROM research_checkpoints'), storage.all('SELECT * FROM research_projects')
]);

test('zero candidates WITH a provider failure: the diagnostic is recorded in decision_log and the checkpoint; the research outcome is unchanged', async () => {
  const { storage, dbPath } = setup();
  try {
    await storage.migrate();
    const oppId = seed(storage);
    const provider = new ScriptedProvider({ candidates: [], failures: [{ error: `Tavily HTTP 401: invalid key. GET https://api.example/search?api_key=${SECRET}&q=x#frag` }] });
    const llm = routerWith(() => ok('[]'));
    const result = await run(storage, oppId, provider, llm);

    // Outcome is exactly what unmodified code produced (verified against the baseline before this change).
    assert.equal(result.project.status, 'INSUFFICIENT_EVIDENCE');
    assert.equal(result.stopReason, 'NO_LOAD_BEARING_CLAIMS');
    assert.equal(llm.state.calls, 0);
    assert.equal(provider.calls, 1, 'discovery is not retried or repeated by diagnostics');

    const found = noCandidateRows(storage);
    assert.equal(found.length, 1);
    const row = found[0];
    assert.equal(row.subject_type, 'research_project');
    assert.equal(row.subject_id, result.project.id);
    assert.equal(row.resulting_state, null, 'no new state value is introduced');
    assert.equal(row.provider, 'scripted-stub');
    assert.match(row.reason, /^provider_reported_failure \(failures=1\): Tavily HTTP 401/);
    const snapshot = JSON.parse(row.config_snapshot).discovery;
    assert.equal(snapshot.outcome, 'provider_reported_failure');
    assert.equal(snapshot.candidateCount, 0);
    assert.equal(snapshot.failureCount, 1);
    assert.match(snapshot.failures[0].error, /Tavily HTTP 401/);

    const cp = sourcesCheckpoint(storage);
    assert.deepEqual(cp.discovery, snapshot, 'checkpoint preserves the same diagnostic');
    // Legacy checkpoint fields are untouched.
    assert.deepEqual(cp.sourceIds, []);
    assert.equal(cp.attemptsUsed, 0);
    assert.equal(cp.candidatesConsidered, 0);
    assert.equal(cp.candidatesExhausted, true);

    // Nothing credential-shaped, nor the URL query/fragment, reached ANY persisted table.
    const all = everythingPersisted(storage);
    assert.ok(!all.includes(SECRET));
    assert.ok(!all.includes('api_key='));
    assert.ok(!all.includes('#frag'));
  } finally { cleanup(storage, dbPath); }
});

test('zero candidates, genuinely empty result: recorded as empty_result with no failures (distinguishable from a provider failure)', async () => {
  const { storage, dbPath } = setup();
  try {
    await storage.migrate();
    const oppId = seed(storage);
    const result = await run(storage, oppId, new ScriptedProvider({ candidates: [], failures: [] }));
    assert.equal(result.project.status, 'INSUFFICIENT_EVIDENCE');
    const found = noCandidateRows(storage);
    assert.equal(found.length, 1);
    assert.equal(found[0].reason, 'empty_result (failures=0)');
    assert.equal(JSON.parse(found[0].config_snapshot).discovery.outcome, 'empty_result');
    assert.equal(sourcesCheckpoint(storage).discovery.outcome, 'empty_result');
  } finally { cleanup(storage, dbPath); }
});

test('malformed provider output (non-array failures, zero candidates): recorded as malformed, research does not fail because of it', async () => {
  const { storage, dbPath } = setup();
  try {
    await storage.migrate();
    const oppId = seed(storage);
    const result = await run(storage, oppId, new ScriptedProvider({ candidates: [], failures: 'boom' }));
    assert.equal(result.project.status, 'INSUFFICIENT_EVIDENCE');
    const snapshot = JSON.parse(noCandidateRows(storage)[0].config_snapshot).discovery;
    assert.equal(snapshot.outcome, 'malformed_provider_response');
    assert.deepEqual(snapshot.malformed, ['failures']);
  } finally { cleanup(storage, dbPath); }
});

test('thrown provider error: the existing FAILED path is unchanged in outcome, its persisted reason is now sanitized, and no NO_CANDIDATES row or checkpoint is written', async () => {
  const { storage, dbPath } = setup();
  try {
    await storage.migrate();
    const oppId = seed(storage);
    const result = await run(storage, oppId, new ScriptedProvider(new Error(`socket closed for https://h.example/search?key=${SECRET}&q=1`)));
    assert.equal(result.project.status, 'FAILED');
    assert.equal(result.stopReason, 'SOURCE_DISCOVERY_FAILED');
    const failed = rows(storage, "stage = 'SOURCE_DISCOVERY' AND decision = 'FAILED'");
    assert.equal(failed.length, 1);
    assert.equal(failed[0].resulting_state, 'FAILED');
    assert.match(failed[0].reason, /^socket closed for h\.example\/search$/);
    assert.equal(noCandidateRows(storage).length, 0);
    assert.equal(storage.get('SELECT COUNT(*) AS n FROM research_checkpoints').n, 0);
    assert.ok(!everythingPersisted(storage).includes(SECRET));
  } finally { cleanup(storage, dbPath); }
});

test('control: when candidates exist there is NO NO_CANDIDATES row, and the checkpoint records candidates_returned', async () => {
  const { storage, dbPath } = setup();
  try {
    await storage.migrate();
    const oppId = seed(storage);
    const provider = new ScriptedProvider({ candidates: [{ url: 'https://publisher-one.com/a', title: 't', snippet: 's' }] });
    const result = await run(storage, oppId, provider, routerWith(() => ok('[]')), { fetchImpl: pageFetch });
    assert.ok(['INSUFFICIENT_EVIDENCE', 'RESEARCH_COMPLETE'].includes(result.project.status));
    assert.equal(noCandidateRows(storage).length, 0);
    const cp = sourcesCheckpoint(storage);
    assert.equal(cp.discovery.outcome, 'candidates_returned');
    assert.equal(cp.discovery.candidateCount, 1);
    assert.equal(cp.candidatesConsidered, 1);
  } finally { cleanup(storage, dbPath); }
});

test('re-running a terminal zero-candidate project is idempotent: no duplicate NO_CANDIDATES row, provider not called again', async () => {
  const { storage, dbPath } = setup();
  try {
    await storage.migrate();
    const oppId = seed(storage);
    const provider = new ScriptedProvider({ candidates: [], failures: [{ error: 'HTTP 503' }] });
    await run(storage, oppId, provider);
    const second = await run(storage, oppId, provider);
    assert.equal(second.alreadyTerminal, true);
    assert.equal(provider.calls, 1);
    assert.equal(noCandidateRows(storage).length, 1);
  } finally { cleanup(storage, dbPath); }
});

test('resume: a checkpoint written BEFORE this field existed (no `discovery` key) still resumes; resumption writes no NO_CANDIDATES row and does not rediscover', async () => {
  const { storage, dbPath } = setup();
  try {
    await storage.migrate();
    const oppId = seed(storage);
    const provider = new ScriptedProvider({ candidates: [{ url: 'https://publisher-one.com/a', title: 't', snippet: 's' }] });
    const httpError = Object.assign(new Error('HTTP 503'), { status: 503 });
    let failNext = true;
    const llm = routerWith(() => { if (failNext) throw httpError; return ok('[]'); });
    const first = await run(storage, oppId, provider, llm, { fetchImpl: pageFetch });
    assert.equal(first.stopReason, 'RESEARCH_TRANSIENT_FAILURE');
    assert.equal(provider.calls, 1);

    // Simulate a pre-change checkpoint: remove the optional field.
    const before = sourcesCheckpoint(storage);
    delete before.discovery;
    storage.run("UPDATE research_checkpoints SET payload = ? WHERE checkpoint = 'SOURCES_PERSISTED'", [JSON.stringify(before)]);

    failNext = false;
    const second = await run(storage, oppId, provider, llm, { fetchImpl: pageFetch });
    assert.notEqual(second.stopReason, 'RESEARCH_TRANSIENT_FAILURE');
    assert.equal(provider.calls, 1, 'resume never rediscovers');
    assert.equal(noCandidateRows(storage).length, 0);
    assert.equal('discovery' in sourcesCheckpoint(storage), false, 'the old checkpoint is read, not rewritten');
  } finally { cleanup(storage, dbPath); }
});

test('a failure while writing the diagnostic row cannot fail research: outcome and checkpoint are identical to the un-instrumented run', async () => {
  const { storage, dbPath } = setup();
  try {
    await storage.migrate();
    const oppId = seed(storage);
    // Fail only the NO_CANDIDATES insert, before any SQL executes.
    const faulty = new Proxy(storage, {
      get(target, prop) {
        const value = target[prop];
        if (prop !== 'run') return typeof value === 'function' ? value.bind(target) : value;
        return (sql, params = []) => {
          if (Array.isArray(params) && params.includes('NO_CANDIDATES')) throw new Error('simulated audit-write failure');
          return target.run(sql, params);
        };
      }
    });
    const result = await run(faulty, oppId, new ScriptedProvider({ candidates: [], failures: [{ error: 'HTTP 503' }] }));
    assert.equal(result.project.status, 'INSUFFICIENT_EVIDENCE');
    assert.equal(result.stopReason, 'NO_LOAD_BEARING_CLAIMS');
    assert.equal(noCandidateRows(storage).length, 0, 'the audit row was lost, research was not');
    assert.equal(sourcesCheckpoint(storage).candidatesExhausted, true, 'checkpoint still committed in the same transaction');
  } finally { cleanup(storage, dbPath); }
});
