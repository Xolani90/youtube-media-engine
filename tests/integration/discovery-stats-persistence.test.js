// PR A: the Discovery admission-funnel stats (runDiscoveryPipeline().stats)
// must be durably queryable from system_runs.ceiling_summary.discoveryStats,
// for completed runs AND for runs that fail after those stats were computed.
//
// Every persisted value below is read back through a FRESH SqliteStorageDriver
// opened on the db file after the producing storage was closed -- i.e. from
// the database, never from the in-memory result or console output.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SqliteStorageDriver } from '../../src/storage/SqliteStorageDriver.js';
import { LLMRouter } from '../../src/providers/llm/router.js';
import { OpportunitySource } from '../../src/providers/opportunity/OpportunitySource.js';
import { ResearchSourceProvider } from '../../src/research/ResearchSourceProvider.js';
import { runAutonomousEntrypoint } from '../../src/index.js';
import { runAutonomousOperation } from '../../src/autonomous/runner.js';
import { SystemRunRecorder } from '../../src/state/SystemRun.js';

class SingleCandidateSource extends OpportunitySource {
  get id() {
    return 'single-candidate-stub';
  }
  async healthCheck() {
    return true;
  }
  async fetchCandidates() {
    return { candidates: [{ raw: true }], failures: [] };
  }
  normalize() {
    return {
      title: 'Deterministic Stats Persistence Opportunity',
      description: 'A deterministic opportunity for discovery stats persistence testing.',
      source: 'stats-persistence-test',
      sourceUrl: 'https://example.test/stats-persistence',
      discoveredAt: new Date().toISOString()
    };
  }
}

class NoCandidatesSourceProvider extends ResearchSourceProvider {
  get id() {
    return 'no-candidates-stub';
  }
  async healthCheck() {
    return true;
  }
  async discoverCandidates() {
    return { candidates: [], failures: [] };
  }
}

function rawFeaturesStub() {
  return {
    novelty: 90,
    competition: 10,
    story_potential: 90,
    evidence_availability: 90,
    production_difficulty: 10,
    audience_potential: 90,
    commercial_intent: 90,
    affiliate_potential: 90,
    lead_generation_potential: 90,
    product_adjacency: 90,
    sponsorship_potential: 90,
    policyRisk: 0,
    copyrightRisk: 0,
    repetitionRisk: 0
  };
}

function stubRegistry() {
  return {
    'stats-stub': () => ({
      id: 'stats-stub',
      isPaid: false,
      async healthCheck() {
        return true;
      },
      async complete(request) {
        if (request.prompt.includes('same event')) {
          return { text: JSON.stringify({ sameEvent: false, confidence: 0.99, reason: 'Deterministic test response.' }) };
        }
        return {
          text: JSON.stringify({
            subject: 'Deterministic Stats Persistence Opportunity',
            target_audience: 'Small business owners',
            audience_problem: 'They need reliable workflow automation information.',
            core_question: 'What does this automation opportunity mean for small businesses?',
            gap: 'Existing coverage lacks a focused practical explanation.',
            angle: 'Explain the opportunity through practical small-business use cases.',
            differentiation: 'Focus on concrete workflows rather than generic AI commentary.',
            commercial_relevance: 'Automation tools can create measurable business value.',
            core_question_type: 'FACTUAL'
          })
        };
      }
    })
  };
}

function newDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-engine-stats-persist-'));
  return { dir, dbPath: path.join(dir, 'test.db') };
}

function newRouter() {
  return new LLMRouter({ priority: ['stats-stub'], allowPaidProviders: false, registry: stubRegistry() });
}

function baseDeps(storage, { topK = 1, ...extra } = {}) {
  return {
    storage,
    llmRouter: newRouter(),
    discovery: { opportunitySource: new SingleCandidateSource(), rawFeatures: rawFeaturesStub, topK },
    research: { sourceProvider: new NoCandidatesSourceProvider() },
    ...extra
  };
}

// Reads every system_runs row through a brand-new connection to the db file.
function readRunsDurably(dbPath) {
  const reader = new SqliteStorageDriver({ dbPath });
  try {
    return reader.all('SELECT id, status, stop_reason, ceiling_summary FROM system_runs ORDER BY started_at');
  } finally {
    reader.close();
  }
}

function parseSummary(row) {
  assert.ok(row.ceiling_summary, 'system_runs.ceiling_summary must be persisted');
  return JSON.parse(row.ceiling_summary);
}

// Runs one scenario on its own db and returns result, plus the persisted rows.
async function runScenario({ topK = 1, ...extra } = {}) {
  const { dir, dbPath } = newDb();
  const storage = new SqliteStorageDriver({ dbPath });
  let result;
  let error;
  try {
    result = await runAutonomousEntrypoint(baseDeps(storage, { topK, ...extra }));
  } catch (err) {
    error = err;
  } finally {
    storage.close();
  }
  const rows = readRunsDurably(dbPath);
  fs.rmSync(dir, { recursive: true, force: true });
  return { result, error, rows };
}

// The deterministic stats a run of this fixture computes, taken from a clean
// successful run (used as the expected value for runs that throw before the
// entrypoint could return its result).
async function referenceStats(topK = 1) {
  const { result } = await runScenario({ topK });
  assert.ok(result?.discovery?.stats, 'reference run must produce discovery stats');
  return result.discovery.stats;
}

test('selected work: discoveryStats are durably persisted on the COMPLETED run', async () => {
  const { result, rows } = await runScenario({ topK: 1 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'COMPLETED');
  const summary = parseSummary(rows[0]);
  assert.deepEqual(summary.discoveryStats, result.discovery.stats);
  assert.equal(summary.discoveryStats.discovered, 1);
  assert.equal(summary.discoveryStats.selected, 1);
  // The pre-existing ceiling fields are unchanged in shape.
  assert.equal(typeof summary.bounded, 'boolean');
  assert.ok(summary.rss && summary.dedup);
});

test('zero-selected / no_work: discoveryStats are durably persisted (COMPLETED, no_work)', async () => {
  const { result, rows } = await runScenario({ topK: 0 });
  assert.equal(result.discovery.stats.discovered, 1);
  assert.equal(result.discovery.stats.selected, 0);
  assert.equal(result.runner.stopReason, 'no_work');
  assert.equal(rows[0].status, 'COMPLETED');
  assert.equal(rows[0].stop_reason, 'no_work');
  const summary = parseSummary(rows[0]);
  assert.deepEqual(summary.discoveryStats, result.discovery.stats);
  assert.equal(summary.discoveryStats.selected, 0);
});

test('runner FAILED by counters (attempted work, zero successes): stats persisted, status FAILED, no throw', async () => {
  const { result, rows } = await runScenario({
    topK: 1,
    stageFns: {
      research: async () => ({ project: { id: 'p', status: 'FAILED' }, stopReason: 'SOURCE_DISCOVERY_FAILED' })
    }
  });
  assert.ok(result, 'contained non-success does not throw');
  assert.equal(rows[0].status, 'FAILED');
  assert.deepEqual(parseSummary(rows[0]).discoveryStats, result.discovery.stats);
});

test('thrown stage after Discovery: run is FAILED with the stage error as stop_reason AND stats persisted', async () => {
  const expected = await referenceStats(1);
  const { error, rows } = await runScenario({
    topK: 1,
    stageFns: {
      research: async () => {
        throw new Error('stage-exploded');
      }
    }
  });
  assert.match(error?.message ?? '', /stage-exploded/, 'the stage error is still rethrown');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'FAILED', 'status unchanged by persistence');
  assert.equal(rows[0].stop_reason, 'stage-exploded', 'stop_reason unchanged by persistence');
  const summary = parseSummary(rows[0]);
  assert.deepEqual(summary.discoveryStats, expected);
  assert.equal(summary.discoveryStats.selected, 1);
});

test('runner refuses to start after Discovery (LIVE while autonomous is disabled): stats persisted via the entrypoint release', async () => {
  const expected = await referenceStats(1);
  const { error, rows } = await runScenario({ topK: 1, mode: 'LIVE' });
  assert.ok(error, 'LIVE without AUTONOMOUS_ENABLED is refused');
  assert.match(error.message, /AUTONOMOUS_ENABLED/);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'FAILED');
  assert.equal(rows[0].stop_reason, error.message, 'stop_reason unchanged by persistence');
  assert.deepEqual(parseSummary(rows[0]).discoveryStats, expected);
});

test('failure while recording Discovery outcomes (after stats exist, before the runner): stats persisted', async () => {
  const expected = await referenceStats(1);
  const { dir, dbPath } = newDb();
  const storage = new SqliteStorageDriver({ dbPath });
  let error;
  try {
    await storage.migrate();
    // recordDiscoveryOutcomes UPDATEs discovery_observations.evaluation_outcome;
    // abort exactly that transition so the failure happens after Discovery
    // returned its stats and before the runner starts.
    storage.run(
      `CREATE TRIGGER test_abort_outcome_recording
         BEFORE UPDATE OF evaluation_outcome ON discovery_observations
         WHEN NEW.evaluation_outcome <> OLD.evaluation_outcome
       BEGIN SELECT RAISE(ABORT, 'outcome-recording-blocked'); END`
    );
    await runAutonomousEntrypoint(baseDeps(storage, { topK: 1 }));
  } catch (err) {
    error = err;
  } finally {
    storage.close();
  }
  const rows = readRunsDurably(dbPath);
  fs.rmSync(dir, { recursive: true, force: true });

  assert.ok(error, 'outcome recording failure fails closed');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'FAILED');
  assert.equal(rows[0].stop_reason, error.message);
  assert.deepEqual(parseSummary(rows[0]).discoveryStats, expected);
});

test('Discovery itself throws: no stats exist, so ceiling_summary stays NULL (nothing is fabricated)', async () => {
  const { dir, dbPath } = newDb();
  const storage = new SqliteStorageDriver({ dbPath });
  let error;
  try {
    await runAutonomousEntrypoint({
      ...baseDeps(storage, { topK: 1 }),
      discovery: {
        opportunitySource: new SingleCandidateSource(),
        rawFeatures: rawFeaturesStub,
        topK: 1,
        // Not a valid schedule: Discovery throws when it uses it.
        evaluationSchedule: {}
      }
    });
  } catch (err) {
    error = err;
  } finally {
    storage.close();
  }
  const rows = readRunsDurably(dbPath);
  fs.rmSync(dir, { recursive: true, force: true });
  assert.ok(error, 'Discovery failure propagates');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'FAILED');
  assert.equal(rows[0].stop_reason, error.message);
  assert.equal(rows[0].ceiling_summary, null);
});

// ---- runner-level regression: behavior when ceilingSummary is omitted ----

async function directRunnerRun({ withSummary, throwStage }) {
  const { dir, dbPath } = newDb();
  const storage = new SqliteStorageDriver({ dbPath });
  let error;
  try {
    await storage.migrate();
    const deps = {
      storage,
      stageFns: throwStage
        ? {
            research: async () => {
              throw new Error('direct-boom');
            }
          }
        : {}
    };
    if (withSummary) deps.ceilingSummary = { bounded: false, discoveryStats: { discovered: 7, selected: 3 } };
    if (throwStage) {
      // give the runner something to select so the stage actually runs
      storage.run(
        `INSERT INTO opportunities (id, title, source, discovered_at, status)
         VALUES ('opp-1', 'T', 'rss', ?, 'HANDED_TO_RESEARCH')`,
        [new Date().toISOString()]
      );
    }
    await runAutonomousOperation(deps);
  } catch (err) {
    error = err;
  } finally {
    storage.close();
  }
  const rows = readRunsDurably(dbPath);
  fs.rmSync(dir, { recursive: true, force: true });
  return { error, rows };
}

test('regression: runner called WITHOUT ceilingSummary leaves ceiling_summary NULL on a completed run', async () => {
  const { error, rows } = await directRunnerRun({ withSummary: false, throwStage: false });
  assert.equal(error, undefined);
  assert.equal(rows[0].status, 'COMPLETED');
  assert.equal(rows[0].ceiling_summary, null);
});

test('regression: runner called WITHOUT ceilingSummary leaves ceiling_summary NULL on a thrown stage (status/stop_reason as before)', async () => {
  const { error, rows } = await directRunnerRun({ withSummary: false, throwStage: true });
  assert.match(error?.message ?? '', /direct-boom/);
  assert.equal(rows[0].status, 'FAILED');
  assert.equal(rows[0].stop_reason, 'direct-boom');
  assert.equal(rows[0].ceiling_summary, null);
});

test('runner WITH ceilingSummary persists it on a thrown stage without changing status/stop_reason', async () => {
  const { error, rows } = await directRunnerRun({ withSummary: true, throwStage: true });
  assert.match(error?.message ?? '', /direct-boom/);
  assert.equal(rows[0].status, 'FAILED');
  assert.equal(rows[0].stop_reason, 'direct-boom');
  assert.deepEqual(JSON.parse(rows[0].ceiling_summary), {
    bounded: false,
    discoveryStats: { discovered: 7, selected: 3 }
  });
});

test('SystemRunRecorder.finish: a later finish() without the key never clears a persisted summary', async () => {
  const { dir, dbPath } = newDb();
  const storage = new SqliteStorageDriver({ dbPath });
  try {
    await storage.migrate();
    const recorder = new SystemRunRecorder(storage);
    const a = recorder.start({ mode: 'SIMULATION' });
    recorder.finish(a.id, { status: 'FAILED', stopReason: 'x', ceilingSummary: { discoveryStats: { discovered: 1 } } });
    // second finish WITHOUT the key must not clear what is there
    recorder.finish(a.id, { status: 'FAILED', stopReason: 'y' });
    const row = storage.get('SELECT status, stop_reason, ceiling_summary FROM system_runs WHERE id = ?', [a.id]);
    assert.equal(row.stop_reason, 'y');
    assert.deepEqual(JSON.parse(row.ceiling_summary), { discoveryStats: { discovered: 1 } });
  } finally {
    storage.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
