import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SqliteStorageDriver } from '../../src/storage/SqliteStorageDriver.js';
import { LLMRouter } from '../../src/providers/llm/router.js';
import { runDiscoveryPipeline } from '../../src/discovery/pipeline.js';
import { computeValueScore } from '../../src/discovery/scoring.js';
import { evaluateOpportunityRisk } from '../../src/discovery/riskGate.js';
import { deriveIdentity } from '../../src/autonomous/discoveryMemory.js';
import {
  createDiscoveryEvaluationStore,
  contentFingerprint,
  DISCOVERY_EVALUATION_CONTRACT_VERSION
} from '../../src/autonomous/discoveryEvaluationStore.js';
import discoveryPolicy from '../../config/discovery_policy.json' with { type: 'json' };
import scoringWeights from '../../config/scoring_weights.json' with { type: 'json' };

// ADR-0033 -- durable per-observation Discovery evaluation state.
// Real SQLite, real store, real pipeline. Only the LLM and rawFeatures are stubs.

const FEED = 'https://feed.test/rss';
const T = (iso) => () => new Date(iso);

const OBS = [
  { title: 'Solar storage breakthrough', description: 'The grid batteries reach a record capacity in the quarter.', sourceUrl: 'https://n.test/1', sourceId: 'g1' },
  { title: 'Rail freight reform passes', description: 'Lawmakers approve overhaul of cargo scheduling rules.', sourceUrl: 'https://n.test/2', sourceId: 'g2' },
  { title: 'Ocean sensor network expands', description: 'Researchers deploy hundreds of new buoys worldwide.', sourceUrl: 'https://n.test/3', sourceId: 'g3' }
].map((o) => ({ ...o, feedUrl: FEED, sourceType: 'rss', discoveredAt: '2026-03-01T00:00:00.000Z' }));

const NOVELTY = { g1: 95, g2: 70, g3: 45 };

const PROPOSITION_JSON = JSON.stringify({
  subject: 'Subject', target_audience: 'Practitioners', audience_problem: 'They need reliable information.',
  core_question: 'What does this mean in practice?', gap: 'Coverage lacks a practical view.',
  angle: 'Practical angle.', differentiation: 'Concrete workflows.', commercial_relevance: 'Measurable value.',
  core_question_type: 'FACTUAL'
});

function makeEnv() {
  const calls = { proposition: 0, features: 0 };
  const llmRouter = new LLMRouter({
    priority: ['stub'], allowPaidProviders: false,
    registry: {
      stub: () => ({
        id: 'stub', isPaid: false,
        async healthCheck() { return true; },
        async complete({ prompt }) {
          if (prompt.includes('sameEvent')) return { text: '{"sameEvent": false, "distinctAngle": false}', model: 'stub-model', estimatedCost: 0, isPaid: false };
          calls.proposition++;
          return { text: PROPOSITION_JSON, model: 'stub-model', estimatedCost: 0, isPaid: false };
        }
      })
    }
  });
  const rawFeaturesFor = (overrides = {}) => (observation) => {
    calls.features++;
    if (overrides.failOn && overrides.failOn === observation.sourceId) throw new Error(`feature computation exploded on ${observation.sourceId}`);
    return {
      novelty: NOVELTY[observation.sourceId] ?? 50, competition: 10, story_potential: 90, evidence_availability: 90,
      production_difficulty: 10, audience_potential: 90, commercial_intent: 90, affiliate_potential: 90,
      lead_generation_potential: 90, product_adjacency: 90, sponsorship_potential: 90,
      policyRisk: overrides.policyRisk ?? 0, copyrightRisk: 0, repetitionRisk: 0
    };
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-store-'));
  const storage = new SqliteStorageDriver({ dbPath: path.join(dir, 't.db') });
  return { calls, llmRouter, rawFeaturesFor, storage, dir, cleanup: () => { storage.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

async function withEnv(fn) {
  const env = makeEnv();
  try {
    await env.storage.migrate();
    await fn(env);
  } finally {
    env.cleanup();
  }
}

const storeFor = (env, opts = {}) => createDiscoveryEvaluationStore({
  storage: env.storage, sourceScope: 'static-feed', now: T('2026-03-01T00:00:00.000Z'), ...opts
});

function runPipeline(env, { observations = OBS, store, rawFeatures, weights = scoringWeights, policy = discoveryPolicy, topK = 2 } = {}) {
  return runDiscoveryPipeline({
    storage: env.storage, runId: null, observations, llmRouter: env.llmRouter,
    discoveryPolicy: policy, scoringWeights: weights, alreadyProducedCorpus: [], topK,
    rawFeatures: rawFeatures ?? env.rawFeaturesFor(), evaluationStore: store
  });
}

const evalRows = (env) => env.storage.all('SELECT * FROM discovery_evaluations ORDER BY identity_key');

// ---------------------------------------------------------------------------
// Schema / store unit behavior
// ---------------------------------------------------------------------------

test('migration 0020 creates discovery_evaluations keyed by identity_key and leaves the ledger schema untouched', async () => {
  await withEnv(async (env) => {
    const cols = env.storage.all('PRAGMA table_info(discovery_evaluations)');
    assert.deepEqual(cols.map((c) => c.name),
      ['identity_key', 'content_fingerprint', 'contract_version', 'proposition', 'raw_features', 'completed_at', 'audit_metadata']);
    assert.equal(cols.find((c) => c.name === 'identity_key').pk, 1);
    const ledgerCols = env.storage.all('PRAGMA table_info(discovery_observations)').map((c) => c.name);
    assert.deepEqual(ledgerCols, ['id', 'identity_key', 'identity_kind', 'identity_scope', 'identity_value', 'first_seen_at',
      'last_seen_at', 'times_seen', 'last_evaluated_at', 'evaluation_outcome', 'opportunity_id']);
  });
});

test('content fingerprint is derived from exactly title and description', () => {
  const base = OBS[0];
  assert.equal(contentFingerprint(base), contentFingerprint({ ...base, sourceUrl: 'https://other.test/x', feedUrl: 'https://other.feed/rss', sourceId: 'zzz' }),
    'URL, feed and source id are not part of the fingerprint');
  assert.notEqual(contentFingerprint(base), contentFingerprint({ ...base, title: `${base.title}!` }));
  assert.notEqual(contentFingerprint(base), contentFingerprint({ ...base, description: `${base.description} ` }), 'exact match: no normalization of whitespace');
  assert.equal(contentFingerprint({ ...base, description: null }), contentFingerprint({ ...base, description: '' }), 'null and empty are the same evaluation input');
});

test('D. contract invalidation: a different evaluation contract version makes the record unusable', async () => {
  await withEnv(async (env) => {
    const evaluation = { proposition: JSON.parse(PROPOSITION_JSON), raw: env.rawFeaturesFor()(OBS[0]) };
    storeFor(env, { contractVersion: '1' }).commit(OBS[0], evaluation);
    assert.ok(storeFor(env, { contractVersion: '1' }).lookup(OBS[0]), 'same version is reusable');
    assert.equal(storeFor(env, { contractVersion: '2' }).lookup(OBS[0]), null, 'incompatible version is not reusable');
    assert.equal(typeof DISCOVERY_EVALUATION_CONTRACT_VERSION, 'string');
    assert.ok(DISCOVERY_EVALUATION_CONTRACT_VERSION.length > 0);
  });
});

test('reuse validity: identity, exact content, provider/model and URL rules', async () => {
  await withEnv(async (env) => {
    const store = storeFor(env);
    const evaluation = { proposition: JSON.parse(PROPOSITION_JSON), raw: env.rawFeaturesFor()(OBS[0]), audit: { proposition: { provider: 'a', model: 'm1' } } };
    assert.deepEqual(store.commit(OBS[0], evaluation), { stored: true });

    assert.ok(store.lookup(OBS[0]), 'unchanged observation is reusable');
    assert.ok(store.lookup({ ...OBS[0], sourceUrl: 'https://changed.test/url' }), 'URL change is not an invalidator');
    assert.equal(store.lookup({ ...OBS[0], title: 'Solar storage breakthrough (updated)' }), null, 'title change invalidates');
    assert.equal(store.lookup({ ...OBS[0], description: 'Different description.' }), null, 'description change invalidates');
    assert.equal(store.lookup({ ...OBS[0], sourceId: 'other-guid' }), null, 'a different identity has no record');
    assert.equal(store.lookup({ ...OBS[0], feedUrl: 'https://another.feed/rss' }), null, 'a different feed is a different identity');

    // Provider/model are audit metadata only: a record written by another provider/model is still reusable.
    store.commit(OBS[0], { ...evaluation, audit: { proposition: { provider: 'b', model: 'm2' } } });
    assert.ok(store.lookup(OBS[0]));
  });
});

test('observations without a deterministic identity are never persisted or reused', async () => {
  await withEnv(async (env) => {
    const store = createDiscoveryEvaluationStore({ storage: env.storage, sourceScope: null, now: T('2026-03-01T00:00:00.000Z') });
    const anonymous = { title: '', description: '', sourceUrl: null, sourceId: null };
    assert.deepEqual(store.commit(anonymous, { proposition: {}, raw: {} }), { stored: false });
    assert.equal(store.lookup(anonymous), null);
    assert.equal(evalRows(env).length, 0);
  });
});

test('corrupt or incomplete stored data is never reused (no repair, no defaults)', async () => {
  await withEnv(async (env) => {
    const store = storeFor(env);
    const key = deriveIdentity(OBS[0], { sourceScope: 'static-feed' }).key;
    const good = { proposition: JSON.parse(PROPOSITION_JSON), raw: env.rawFeaturesFor()(OBS[0]) };

    store.commit(OBS[0], { ...good, raw: { novelty: 10 } });
    assert.equal(store.lookup(OBS[0]), null, 'raw features missing dimensions');

    store.commit(OBS[0], good);
    assert.ok(store.lookup(OBS[0]));
    env.storage.run('UPDATE discovery_evaluations SET raw_features = ? WHERE identity_key = ?', ['{not json', key]);
    assert.equal(store.lookup(OBS[0]), null, 'unparseable raw features');

    store.commit(OBS[0], good);
    env.storage.run('UPDATE discovery_evaluations SET completed_at = ? WHERE identity_key = ?', ['not a time', key]);
    assert.equal(store.lookup(OBS[0]), null, 'unparseable completion time');
  });
});

test('cycle scope: a record is reusable only if completed strictly after the ledger last_evaluated_at', async () => {
  await withEnv(async (env) => {
    const store = storeFor(env, { now: T('2026-03-01T10:00:00.000Z') });
    const key = deriveIdentity(OBS[0], { sourceScope: 'static-feed' }).key;
    store.commit(OBS[0], { proposition: JSON.parse(PROPOSITION_JSON), raw: env.rawFeaturesFor()(OBS[0]) });

    const ledger = (evaluatedAt) => env.storage.run(
      `INSERT INTO discovery_observations (id, identity_key, identity_kind, identity_scope, identity_value, first_seen_at, last_seen_at, times_seen, last_evaluated_at, evaluation_outcome)
       VALUES ('l1', ?, 'SOURCE_ID', ?, 'g1', 'x', 'x', 1, ?, ?)
       ON CONFLICT(identity_key) DO UPDATE SET last_evaluated_at = excluded.last_evaluated_at`,
      [key, FEED, evaluatedAt, evaluatedAt ? 'SCORED_NOT_SELECTED' : 'NOT_EVALUATED']
    );

    ledger(null);
    assert.ok(store.lookup(OBS[0]), 'no evaluation boundary yet: current cycle');
    ledger('2026-03-01T09:59:59.999Z');
    assert.ok(store.lookup(OBS[0]), 'completed after the boundary: current cycle');
    ledger('2026-03-01T10:00:00.000Z');
    assert.equal(store.lookup(OBS[0]), null, 'completed AT the boundary: cycle closed');
    ledger('2026-03-01T10:00:00.001Z');
    assert.equal(store.lookup(OBS[0]), null, 'completed before the boundary: cycle closed');
    ledger('garbage');
    assert.equal(store.lookup(OBS[0]), null, 'unreadable boundary: cannot prove current cycle, never reused');
  });
});

// ---------------------------------------------------------------------------
// Pipeline behavior with the store
// ---------------------------------------------------------------------------

test('A. fresh evaluation: a missing record causes normal proposition/features evaluation and commits one durable evaluation per identity', async () => {
  await withEnv(async (env) => {
    const store = storeFor(env);
    const result = await runPipeline(env, { store });
    assert.equal(env.calls.proposition, 3);
    assert.equal(env.calls.features, 3);
    assert.equal(result.stats.scored, 3);

    const rows = evalRows(env);
    assert.equal(rows.length, 3, 'exactly one durable evaluation per evaluated identity');
    const g1 = rows.find((r) => r.identity_key === deriveIdentity(OBS[0], { sourceScope: 'static-feed' }).key);
    assert.ok(g1, 'keyed by the stable identity_key');
    assert.equal(g1.content_fingerprint, contentFingerprint(OBS[0]));
    assert.equal(g1.contract_version, DISCOVERY_EVALUATION_CONTRACT_VERSION);
    assert.deepEqual(JSON.parse(g1.proposition), JSON.parse(PROPOSITION_JSON));
    assert.deepEqual(JSON.parse(g1.raw_features), env.rawFeaturesFor()(OBS[0]), 'all raw feature values, not just a score');
    assert.ok(Number.isFinite(Date.parse(g1.completed_at)));
    assert.equal(JSON.parse(g1.audit_metadata).proposition.model, 'stub-model');
    assert.equal(env.storage.get('SELECT COUNT(*) n FROM discovery_observations').n, 0, 'nothing written to the ledger');
  });
});

test('B. valid reuse: unchanged identity and content makes no proposition and no feature call', async () => {
  await withEnv(async (env) => {
    const store = storeFor(env);
    await runPipeline(env, { store });
    const before = { ...env.calls };
    const second = await runPipeline(env, { store });
    assert.deepEqual(env.calls, before, 'no LLM proposition call and no feature call on reuse');
    assert.equal(second.stats.scored, 3);
    assert.equal(evalRows(env).length, 3);
    const reusedLogs = env.storage.all(`SELECT * FROM decision_log WHERE stage = 'PROPOSITION_GENERATION' AND decision = 'REUSED'`);
    assert.equal(reusedLogs.length, 3, 'reuse is distinguishable from fresh generation in the audit log');
    assert.ok(reusedLogs.every((r) => r.reason === 'durable_evaluation_reused' && r.provider === null));
  });
});

test('C. content invalidation: changing title or description forces a fresh evaluation of only that observation', async () => {
  await withEnv(async (env) => {
    const store = storeFor(env);
    await runPipeline(env, { store });
    const before = { ...env.calls };
    const changed = [
      { ...OBS[0], title: 'Solar storage breakthrough, revised' },
      { ...OBS[1], description: 'A rewritten description about cargo rules.' },
      OBS[2]
    ];
    await runPipeline(env, { store, observations: changed });
    assert.equal(env.calls.proposition - before.proposition, 2);
    assert.equal(env.calls.features - before.features, 2);
    const g1 = env.storage.get('SELECT * FROM discovery_evaluations WHERE identity_key = ?', [deriveIdentity(OBS[0], { sourceScope: 'static-feed' }).key]);
    assert.equal(g1.content_fingerprint, contentFingerprint(changed[0]), 'record replaced with the new content binding');
    assert.equal(evalRows(env).length, 3, 'still one record per identity');
  });
});

test('D (pipeline). a store with an incompatible contract version forces fresh evaluation', async () => {
  await withEnv(async (env) => {
    await runPipeline(env, { store: storeFor(env, { contractVersion: 'A' }) });
    const before = { ...env.calls };
    await runPipeline(env, { store: storeFor(env, { contractVersion: 'B' }) });
    assert.equal(env.calls.proposition - before.proposition, 3);
    assert.equal(env.calls.features - before.features, 3);
    assert.ok(evalRows(env).every((r) => r.contract_version === 'B'));
  });
});

test('E. score/risk reconstruction: reused raw features go through the existing score and risk functions with the CURRENT configuration', async () => {
  await withEnv(async (env) => {
    const store = storeFor(env);
    const raw = env.rawFeaturesFor({ policyRisk: 0.8 });
    const first = await runPipeline(env, { store, rawFeatures: raw, observations: [OBS[0]] });
    assert.equal(first.scoredCandidates[0].vetoed, true, 'run 1: critical policy threshold 0.75 vetoes 0.8');

    const before = { ...env.calls };
    const weights2 = { ...scoringWeights, version: '0.2', weights: { ...scoringWeights.weights, novelty: 5 } };
    const policy2 = { ...discoveryPolicy, thresholds: { ...discoveryPolicy.thresholds, risk: { ...discoveryPolicy.thresholds.risk, policy: { warning_threshold: 0.4, critical_threshold: 0.9 } } } };
    const second = await runPipeline(env, { store, rawFeatures: raw, observations: [OBS[0]], weights: weights2, policy: policy2 });
    assert.deepEqual(env.calls, before, 'reused: no LLM/feature call');

    const c = second.scoredCandidates[0];
    const storedRaw = JSON.parse(env.storage.get('SELECT raw_features FROM discovery_evaluations').raw_features);
    const expected = computeValueScore(storedRaw, { weightsConfig: weights2, normalizationConfig: policy2.normalization, discoveryPolicyVersion: policy2.version });
    assert.equal(c.overallScore, expected.overallScore, 'score recomputed with the current weights');
    assert.notEqual(c.overallScore, first.scoredCandidates[0].overallScore, 'and it differs from the run-1 score');
    assert.equal(c.breakdown.version, '0.2');
    const risk = evaluateOpportunityRisk({ policyRisk: 0.8, copyrightRisk: 0, repetitionRisk: 0 }, policy2.thresholds.risk);
    assert.equal(c.vetoed, risk.action === 'STOP_AND_ESCALATE');
    assert.equal(c.vetoed, false, 'run 2: relaxed threshold from the current configuration no longer vetoes');
    assert.equal(c.riskLevel, risk.level);
  });
});

test('F. selection equivalence: a reconstructed candidate has the same shape and selection-relevant fields as a fresh one', async () => {
  await withEnv(async (env) => {
    const strip = (cands) => cands.map(({ id, underlyingEventId, ...rest }) => {
      assert.equal(typeof id, 'string');
      assert.equal(typeof underlyingEventId, 'string');
      return rest;
    });
    const store = storeFor(env);
    const fresh = await runPipeline(env, { store });
    const reused = await runPipeline(env, { store });

    assert.deepEqual(Object.keys(fresh.scoredCandidates[0]).sort(), Object.keys(reused.scoredCandidates[0]).sort());
    assert.deepEqual(strip(reused.scoredCandidates), strip(fresh.scoredCandidates));
    assert.deepEqual(reused.selected.map((c) => c.observation.sourceId), fresh.selected.map((c) => c.observation.sourceId));
    assert.deepEqual(reused.stats, fresh.stats);
  });
});

test('no store: behavior is unchanged (no durable records, GENERATED audit rows)', async () => {
  await withEnv(async (env) => {
    await runPipeline(env, {});
    assert.equal(evalRows(env).length, 0);
    assert.equal(env.storage.get(`SELECT COUNT(*) n FROM decision_log WHERE decision = 'REUSED'`).n, 0);
    assert.equal(env.storage.get(`SELECT COUNT(*) n FROM decision_log WHERE decision = 'GENERATED'`).n, 3);
  });
});

test('G. failure before commit leaves no evaluation-complete record for that observation', async () => {
  await withEnv(async (env) => {
    const store = storeFor(env);
    await assert.rejects(runPipeline(env, { store, observations: [OBS[0]], rawFeatures: env.rawFeaturesFor({ failOn: 'g1' }) }), /exploded on g1/);
    assert.equal(evalRows(env).length, 0, 'proposition succeeded but features failed: nothing committed');

    const brokenRouter = new LLMRouter({ priority: ['down'], allowPaidProviders: false, registry: { down: () => ({ id: 'down', isPaid: false, async healthCheck() { return true; }, async complete() { throw new Error('HTTP 429'); } }) } });
    await assert.rejects(runDiscoveryPipeline({
      storage: env.storage, runId: null, observations: [OBS[0]], llmRouter: brokenRouter, discoveryPolicy, scoringWeights,
      topK: 1, rawFeatures: env.rawFeaturesFor(), evaluationStore: store
    }), /429/);
    assert.equal(evalRows(env).length, 0);
  });
});

test('an invalid proposition is not persisted (unchanged behavior: rejected this run, retried next run)', async () => {
  await withEnv(async (env) => {
    const store = storeFor(env);
    const badRouter = new LLMRouter({ priority: ['bad'], allowPaidProviders: false, registry: { bad: () => ({ id: 'bad', isPaid: false, async healthCheck() { return true; }, async complete() { return { text: 'not json', model: 'm', estimatedCost: 0, isPaid: false }; } }) } });
    const result = await runDiscoveryPipeline({
      storage: env.storage, runId: null, observations: [OBS[0]], llmRouter: badRouter, discoveryPolicy, scoringWeights,
      topK: 1, rawFeatures: env.rawFeaturesFor(), evaluationStore: store
    });
    assert.equal(result.stats.propositionRejected, 1);
    assert.equal(env.calls.features, 0);
    assert.equal(evalRows(env).length, 0);
  });
});

test('H. failure after prior commits: a later run reuses candidates 1..N-1 and resumes from the incomplete work', async () => {
  await withEnv(async (env) => {
    const store = storeFor(env);
    await assert.rejects(runPipeline(env, { store, rawFeatures: env.rawFeaturesFor({ failOn: 'g3' }) }), /exploded on g3/);
    assert.equal(evalRows(env).length, 2, 'g1 and g2 committed before g3 failed');
    const before = { ...env.calls };

    const result = await runPipeline(env, { store });
    assert.equal(env.calls.proposition - before.proposition, 1, 'only g3 needs a proposition call');
    assert.equal(env.calls.features - before.features, 1, 'only g3 needs a feature call');
    assert.equal(result.stats.scored, 3);
    assert.equal(evalRows(env).length, 3);
  });
});

test('I (pipeline). the store cannot add candidates: only the observations passed in are scored and selected', async () => {
  await withEnv(async (env) => {
    const store = storeFor(env);
    await runPipeline(env, { store });
    const before = { ...env.calls };
    const result = await runPipeline(env, { store, observations: [OBS[2]], topK: 5 });
    assert.equal(result.scoredCandidates.length, 1);
    assert.deepEqual(result.selected.map((c) => c.observation.sourceId), ['g3']);
    assert.deepEqual(env.calls, before);
    assert.equal(evalRows(env).length, 3, 'other identities keep their (unused) records; nothing is deleted');
  });
});

test('K (pipeline). resume uses the evaluation store, not decision_log', async () => {
  await withEnv(async (env) => {
    const store = storeFor(env);
    await runPipeline(env, { store });

    env.storage.run('DELETE FROM decision_log');
    const a = { ...env.calls };
    await runPipeline(env, { store });
    assert.deepEqual(env.calls, a, 'decision_log wiped: evaluations are still reused from the store');

    env.storage.run('DELETE FROM discovery_evaluations');
    const b = { ...env.calls };
    await runPipeline(env, { store });
    assert.equal(env.calls.proposition - b.proposition, 3, 'store wiped: decision_log rows alone do not enable resume');
    assert.equal(env.calls.features - b.features, 3);
  });
});