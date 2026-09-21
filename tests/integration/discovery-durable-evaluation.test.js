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

// ADR-0033 through the REAL canonical entrypoint: real SQLite, real ledger,
// real single-run guard, real evaluation store. Only the LLM and rawFeatures
// are stubs. A failed run and a later run are separate entrypoint invocations.

const HOUR = 3_600_000;
const T0 = Date.parse('2026-03-01T00:00:00.000Z');

const STORIES = [
  { guid: 'g-1', link: 'https://news.test/one', title: 'Solar storage breakthrough', novelty: 95 },
  { guid: 'g-2', link: 'https://news.test/two', title: 'Rail freight reform passes', novelty: 85 },
  { guid: 'g-3', link: 'https://news.test/three', title: 'Ocean sensor network expands', novelty: 75 },
  { guid: 'g-4', link: 'https://news.test/four', title: 'New battery recycling rules', novelty: 65 },
  { guid: 'g-5', link: 'https://news.test/five', title: 'Urban heat mapping launched', novelty: 55 }
];
const EXTRA = { guid: 'g-6', link: 'https://news.test/six', title: 'Wind turbine blade recycling', novelty: 45 };

class StaticFeed extends OpportunitySource {
  constructor(stories) { super(); this.stories = stories; }
  get id() { return 'static-feed'; }
  async healthCheck() { return true; }
  async fetchCandidates() { return { candidates: this.stories.map((s) => ({ ...s })), failures: [] }; }
  normalize(raw) {
    return {
      title: raw.title,
      description: `Description of ${raw.title}: a reasonably detailed practical description.`,
      source: 'test',
      sourceUrl: raw.link,
      sourceId: raw.guid ?? null,
      feedUrl: 'https://feed.test/rss',
      discoveredAt: new Date(T0).toISOString()
    };
  }
}

class NoCandidates extends ResearchSourceProvider {
  get id() { return 'none'; }
  async healthCheck() { return true; }
  async discoverCandidates() { return { candidates: [], failures: [] }; }
}

function harness() {
  const counters = { proposition: 0, rawFeatures: 0 };
  const router = new LLMRouter({
    priority: ['stub'],
    allowPaidProviders: false,
    registry: {
      stub: () => ({
        id: 'stub', isPaid: false,
        async healthCheck() { return true; },
        async complete(request) {
          if (request.prompt.includes('sameEvent')) {
            return { text: JSON.stringify({ sameEvent: false, distinctAngle: false }) };
          }
          counters.proposition++;
          return {
            text: JSON.stringify({
              subject: 'Subject', target_audience: 'Practitioners', audience_problem: 'They need reliable information.',
              core_question: 'What does this mean in practice?', gap: 'Coverage lacks a practical view.',
              angle: 'Practical angle.', differentiation: 'Concrete workflows.', commercial_relevance: 'Measurable value.',
              core_question_type: 'FACTUAL'
            }),
            model: 'stub-model'
          };
        }
      })
    }
  });
  const all = [...STORIES, EXTRA];
  const rawFeatures = (failOnGuid, hook) => (observation) => {
    counters.rawFeatures++;
    const story = all.find((s) => s.title === observation.title);
    if (hook) hook(story);
    if (failOnGuid && story?.guid === failOnGuid) throw new Error(`feature computation exploded on ${failOnGuid}`);
    return {
      novelty: story?.novelty ?? 50, competition: 10, story_potential: 90, evidence_availability: 90,
      production_difficulty: 10, audience_potential: 90, commercial_intent: 90, affiliate_potential: 90,
      lead_generation_potential: 90, product_adjacency: 90, sponsorship_potential: 90,
      policyRisk: 0, copyrightRisk: 0, repetitionRisk: 0
    };
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-durable-'));
  const storage = new SqliteStorageDriver({ dbPath: path.join(dir, 't.db') });
  const run = (over = {}, nowMs = T0) => runAutonomousEntrypoint({
    storage, llmRouter: router,
    discovery: {
      opportunitySource: new StaticFeed(over.stories ?? STORIES),
      rawFeatures: rawFeatures(over.failOn, over.hook),
      topK: over.topK ?? 2, now: () => new Date(nowMs)
    },
    research: { sourceProvider: new NoCandidates() }
  });
  return { storage, counters, run, cleanup: () => { storage.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

const count = (storage, table) => storage.get(`SELECT COUNT(*) n FROM ${table}`).n;
const ledger = (storage) => Object.fromEntries(storage.all('SELECT * FROM discovery_observations').map((r) => [r.identity_value, r]));
const evaluations = (storage) => storage.all('SELECT * FROM discovery_evaluations');

test('H/J. a run that fails at candidate 3 keeps evaluations 1-2, records no ledger outcome and no selection; the next run reuses 1-2 and resumes', async () => {
  const h = harness();
  try {
    await assert.rejects(h.run({ failOn: 'g-3' }, T0), /exploded on g-3/);

    // Durable evaluations survive the failed run.
    assert.equal(evaluations(h.storage).length, 2);
    assert.equal(h.counters.proposition, 3);
    assert.equal(h.counters.rawFeatures, 3);

    // Failure safety: no partial selection, no ledger outcome, no opportunity.
    assert.equal(count(h.storage, 'opportunities'), 0);
    const rows = Object.values(ledger(h.storage));
    assert.equal(rows.length, 5);
    assert.ok(rows.every((r) => r.evaluation_outcome === 'NOT_EVALUATED' && r.last_evaluated_at === null && r.opportunity_id === null),
      'ledger untouched by evaluation completion: still NOT_EVALUATED, no evaluation time, no opportunity');
    assert.equal(h.storage.get('SELECT status FROM system_runs ORDER BY started_at DESC LIMIT 1').status, 'FAILED', 'Discovery failure is not converted to success');

    const second = await h.run({}, T0 + HOUR);
    assert.equal(h.counters.proposition, 3 + 3, 'g-1 and g-2 were NOT regenerated; only g-3..g-5 needed proposition calls');
    assert.equal(h.counters.rawFeatures, 3 + 3, 'only g-3..g-5 needed feature calls');
    assert.equal(second.discovery.stats.scored, 5);
    assert.equal(second.discovery.stats.selected, 2);
    assert.equal(evaluations(h.storage).length, 5);

    // Outcomes are recorded only now, after selection over the whole admitted population.
    const after = ledger(h.storage);
    assert.deepEqual(Object.values(after).map((r) => r.evaluation_outcome).sort(),
      ['SCORED_NOT_SELECTED', 'SCORED_NOT_SELECTED', 'SCORED_NOT_SELECTED', 'SELECTED', 'SELECTED']);
    assert.equal(after['g-1'].evaluation_outcome, 'SELECTED');
    assert.equal(after['g-2'].evaluation_outcome, 'SELECTED');
    assert.equal(count(h.storage, 'opportunities'), 5);
    assert.equal(h.storage.get(`SELECT COUNT(*) n FROM decision_log WHERE decision = 'REUSED'`).n, 2);
  } finally { h.cleanup(); }
});

test('J. while evaluations are being committed the ledger is untouched (no outcome before global selection)', async () => {
  const h = harness();
  try {
    const seen = [];
    const hook = (story) => {
      if (story?.guid === 'g-5') {
        seen.push({
          evaluations: count(h.storage, 'discovery_evaluations'),
          outcomes: h.storage.all('SELECT DISTINCT evaluation_outcome o FROM discovery_observations').map((r) => r.o),
          evaluated: h.storage.get('SELECT COUNT(*) n FROM discovery_observations WHERE last_evaluated_at IS NOT NULL').n
        });
      }
    };
    await h.run({ hook }, T0);
    assert.deepEqual(seen, [{ evaluations: 4, outcomes: ['NOT_EVALUATED'], evaluated: 0 }],
      'with 4 evaluations already durable, no ledger outcome or evaluation time exists yet');
  } finally { h.cleanup(); }
});

test('I. current-population boundary: a durable evaluation for an identity absent from the current fetch is never selected', async () => {
  const h = harness();
  try {
    await assert.rejects(h.run({ failOn: 'g-5' }, T0), /exploded on g-5/);
    assert.equal(evaluations(h.storage).length, 4, 'g-1..g-4 are durably evaluated');

    const rawBefore = h.counters.rawFeatures;
    const second = await h.run({ stories: [STORIES[4], EXTRA], topK: 5 }, T0 + HOUR);
    assert.equal(second.discovery.stats.discovered, 2, 'population is the current admitted fetch only');
    assert.equal(second.discovery.stats.scored, 2);
    assert.equal(second.discovery.stats.selected, 2);
    assert.equal(h.counters.rawFeatures - rawBefore, 2, 'only g-5 and g-6 were evaluated');

    const titles = h.storage.all('SELECT title FROM opportunities').map((r) => r.title).sort();
    assert.deepEqual(titles, [EXTRA.title, STORIES[4].title].sort(), 'g-1..g-4 have durable evaluations but were not selected or inserted');
    const by = ledger(h.storage);
    for (const guid of ['g-1', 'g-2', 'g-3', 'g-4']) {
      assert.equal(by[guid].evaluation_outcome, 'NOT_EVALUATED', `${guid} untouched`);
      assert.equal(by[guid].times_seen, 1, `${guid} was not admitted this run`);
    }
  } finally { h.cleanup(); }
});

test('K. resume comes from the evaluation store, not decision_log', async () => {
  const h = harness();
  try {
    await assert.rejects(h.run({ failOn: 'g-3' }, T0), /exploded on g-3/);
    h.storage.run('DELETE FROM decision_log');
    await h.run({}, T0 + HOUR);
    assert.equal(h.counters.proposition, 3 + 3, 'decision_log wiped: g-1 and g-2 still reused');
  } finally { h.cleanup(); }

  const h2 = harness();
  try {
    await assert.rejects(h2.run({ failOn: 'g-3' }, T0), /exploded on g-3/);
    assert.ok(count(h2.storage, 'decision_log') > 0, 'audit rows exist for the completed work');
    h2.storage.run('DELETE FROM discovery_evaluations');
    await h2.run({}, T0 + HOUR);
    assert.equal(h2.counters.proposition, 3 + 5, 'store wiped: audit rows alone do not enable resume');
  } finally { h2.cleanup(); }
});

test('cycle scope: outcome recording closes the cycle, so cooldown reconsideration and SELECTED re-admission evaluate afresh', async () => {
  const h = harness();
  try {
    await h.run({}, T0);
    assert.equal(h.counters.proposition, 5);
    assert.equal(evaluations(h.storage).length, 5);

    // 1h later: only the 2 SELECTED are re-admitted. Their records completed at
    // T0, which is not after last_evaluated_at (T0), so they are NOT reused.
    await h.run({}, T0 + HOUR);
    assert.equal(h.counters.proposition, 5 + 2);
    assert.equal(h.counters.rawFeatures, 5 + 2);

    // Cooldown expiry: the 3 SCORED_NOT_SELECTED identities are reconsidered
    // with a FRESH evaluation (their record predates the recorded outcome).
    const before = h.counters.rawFeatures;
    await h.run({}, T0 + 25 * HOUR);
    const fresh = h.counters.rawFeatures - before;
    assert.ok(fresh >= 3, `the 3 cooldown-expired identities were re-evaluated (got ${fresh} feature calls)`);
  } finally { h.cleanup(); }
});

test('documented consequence (deferred, ADR-0033 section 7): sticky SELECTED never advances last_evaluated_at, so a record made by a re-admission stays reusable', async () => {
  const h = harness();
  try {
    await h.run({}, T0);                 // g-1, g-2 SELECTED (last_evaluated_at = T0)
    await h.run({}, T0 + HOUR);          // re-admitted, evaluated afresh at T0+1h; SELECTED row is not updated
    const before = h.counters.proposition;
    await h.run({}, T0 + 2 * HOUR);      // re-admitted again: the T0+1h record is "after" T0, so it is reused
    assert.equal(h.counters.proposition - before, 0);
    assert.equal(ledgerBoundary(h.storage, 'g-1'), new Date(T0).toISOString(), 'the ledger boundary for a SELECTED identity is the first selection time');
  } finally { h.cleanup(); }
});

function ledgerBoundary(storage, guid) {
  return storage.get('SELECT last_evaluated_at FROM discovery_observations WHERE identity_value = ?', [guid]).last_evaluated_at;
}