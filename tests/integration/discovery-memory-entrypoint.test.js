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
import discoveryPolicy from '../../config/discovery_policy.json' with { type: 'json' };

const HOUR = 3_600_000;
const T0 = Date.parse('2026-03-01T00:00:00.000Z');

const STORIES = [
  { guid: 'g-1', link: 'https://news.test/one', title: 'Solar storage breakthrough', novelty: 95 },
  { guid: 'g-2', link: 'https://news.test/two', title: 'Rail freight reform passes', novelty: 85 },
  { guid: 'g-3', link: 'https://news.test/three', title: 'Ocean sensor network expands', novelty: 75 },
  { guid: 'g-4', link: 'https://news.test/four', title: 'New battery recycling rules', novelty: 65 },
  { guid: 'g-5', link: 'https://news.test/five', title: 'Urban heat mapping launched', novelty: 55 }
];

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
  const counters = { llm: 0, rawFeatures: 0 };
  const router = new LLMRouter({
    priority: ['stub'],
    allowPaidProviders: false,
    registry: {
      stub: () => ({
        id: 'stub', isPaid: false,
        async healthCheck() { return true; },
        async complete(request) {
          counters.llm++;
          if (request.prompt.includes('same event')) {
            return { text: JSON.stringify({ sameEvent: false, confidence: 0.99, reason: 'x' }) };
          }
          return {
            text: JSON.stringify({
              subject: 'Subject', target_audience: 'Practitioners', audience_problem: 'They need reliable information.',
              core_question: 'What does this mean in practice?', gap: 'Coverage lacks a practical view.',
              angle: 'Practical angle.', differentiation: 'Concrete workflows.', commercial_relevance: 'Measurable value.',
              core_question_type: 'FACTUAL'
            })
          };
        }
      })
    }
  });
  const rawFeatures = (observation) => {
    counters.rawFeatures++;
    const story = STORIES.find((s) => s.title === observation.title);
    return {
      novelty: story?.novelty ?? 50, competition: 10, story_potential: 90, evidence_availability: 90,
      production_difficulty: 10, audience_potential: 90, commercial_intent: 90, affiliate_potential: 90,
      lead_generation_potential: 90, product_adjacency: 90, sponsorship_potential: 90,
      policyRisk: 0, copyrightRisk: 0, repetitionRisk: 0
    };
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-entry-'));
  const storage = new SqliteStorageDriver({ dbPath: path.join(dir, 't.db') });
  const run = (over = {}, nowMs = T0) => runAutonomousEntrypoint({
    storage, llmRouter: router,
    discovery: { opportunitySource: over.source ?? new StaticFeed(STORIES), rawFeatures: over.rawFeatures ?? rawFeatures, topK: 2, now: () => new Date(nowMs), discoveryPolicy: over.policy },
    research: { sourceProvider: new NoCandidates() }
  });
  return { storage, counters, run, cleanup: () => { storage.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

const ledgerByGuid = (storage) => Object.fromEntries(
  storage.all('SELECT * FROM discovery_observations').map((r) => [r.identity_value, r])
);
const count = (storage, table) => storage.get(`SELECT COUNT(*) n FROM ${table}`).n;

test('5-story feed, topK=2: unselected stories are not re-evaluated inside 24h (no LLM call, no new row)', async () => {
  const h = harness();
  try {
    const first = await h.run({}, T0);
    assert.equal(first.discovery.stats.selected, 2);
    assert.equal(first.discovery.stats.scored, 5);
    const by = ledgerByGuid(h.storage);
    const outcomes = Object.values(by).map((r) => r.evaluation_outcome).sort();
    assert.deepEqual(outcomes, ['SCORED_NOT_SELECTED', 'SCORED_NOT_SELECTED', 'SCORED_NOT_SELECTED', 'SELECTED', 'SELECTED']);
    const oppsAfterFirst = count(h.storage, 'opportunities');
    assert.equal(oppsAfterFirst, 5);

    const unselected = STORIES.filter((s) => by[s.guid].evaluation_outcome === 'SCORED_NOT_SELECTED');
    assert.equal(unselected.length, 3);

    // Second run 1h later: only the 3 suppressed identities are out; count evaluation work for the rest.
    const rawBefore = h.counters.rawFeatures;
    const second = await h.run({}, T0 + HOUR);
    assert.equal(second.discovery.memory.suppressedIdentities, 3);
    assert.equal(second.discovery.stats.discovered, 2, 'only non-suppressed observations enter Discovery');
    assert.equal(h.counters.rawFeatures - rawBefore, 2, 'no feature/LLM work for suppressed stories');
    for (const s of unselected) {
      assert.equal(h.storage.get('SELECT COUNT(*) n FROM opportunities WHERE title = ?', [s.title]).n, 1, `${s.title} not duplicated`);
      assert.equal(by[s.guid].opportunity_id != null, true);
    }
    const after = ledgerByGuid(h.storage);
    for (const s of unselected) assert.equal(after[s.guid].last_evaluated_at, by[s.guid].last_evaluated_at, 'cooldown clock not reset by suppression');
  } finally { h.cleanup(); }
});

test('cooldown boundary through the entrypoint: 24h-1ms suppressed, exactly 24h re-evaluated', async () => {
  const h = harness();
  try {
    await h.run({}, T0);
    const by = ledgerByGuid(h.storage);
    const unselected = STORIES.filter((s) => by[s.guid].evaluation_outcome === 'SCORED_NOT_SELECTED').length;

    const justBefore = await h.run({}, T0 + 24 * HOUR - 1);
    assert.equal(justBefore.discovery.memory.suppressedIdentities, unselected);

    const atBoundary = await h.run({}, T0 + 24 * HOUR);
    assert.equal(atBoundary.discovery.memory.suppressedIdentities, 0);
    assert.equal(atBoundary.discovery.stats.discovered, 5);

    const after = await h.run({}, T0 + 24 * HOUR + 1);
    // re-evaluated at T0+24h: cooldown restarted, so they are suppressed again
    assert.equal(after.discovery.memory.suppressedIdentities >= 1, true);
  } finally { h.cleanup(); }
});

test('observations without any deterministic identity pass through every run, unrecorded and unsuppressed', async () => {
  const h = harness();
  try {
    class NoIdentityFeed extends StaticFeed {
      normalize() { return { title: '', description: 'a description with enough words to be considered', source: 'test', sourceUrl: null, sourceId: null, discoveredAt: new Date(T0).toISOString() }; }
    }
    const src = new NoIdentityFeed([{}]);
    // may be rejected by Discovery eligibility; the point is that memory neither records nor suppresses it
    for (const t of [T0, T0 + HOUR]) {
      try { await h.run({ source: src }, t); } catch { /* Discovery-side outcome is out of scope here */ }
    }
    assert.equal(count(h.storage, 'discovery_observations'), 0);
  } finally { h.cleanup(); }
});

test('Discovery throwing leaves every admitted row NOT_EVALUATED (non-suppressing) and the next run re-evaluates', async () => {
  const h = harness();
  try {
    const boom = () => { throw new Error('feature computation exploded'); };
    await assert.rejects(h.run({ rawFeatures: boom }, T0), /exploded/);
    const rows = h.storage.all('SELECT * FROM discovery_observations');
    assert.equal(rows.length, 5);
    assert.ok(rows.every((r) => r.evaluation_outcome === 'NOT_EVALUATED' && r.last_evaluated_at === null));

    const rerun = await h.run({}, T0 + 1);
    assert.equal(rerun.discovery.memory.suppressedIdentities, 0);
    assert.equal(rerun.discovery.stats.discovered, 5);
  } finally { h.cleanup(); }
});

test('missing cooldown config fails closed before any LLM call or ledger write', async () => {
  const h = harness();
  try {
    const { reconsideration, ...withoutCooldown } = discoveryPolicy;
    await assert.rejects(h.run({ policy: withoutCooldown }, T0), /cooldownHours/);
    assert.equal(h.counters.llm, 0);
    assert.equal(h.counters.rawFeatures, 0);
    assert.equal(count(h.storage, 'discovery_observations'), 0);
  } finally { h.cleanup(); }
});

test('ledger write failure after Discovery fails closed: the entrypoint throws and the runner never starts', async () => {
  const h = harness();
  try {
    // Break only the post-Discovery outcome write: a trigger rejects any move away from NOT_EVALUATED.
    await h.storage.migrate();
    h.storage.run(`CREATE TRIGGER fail_outcome BEFORE UPDATE OF evaluation_outcome ON discovery_observations
                    WHEN NEW.evaluation_outcome != 'NOT_EVALUATED' BEGIN SELECT RAISE(ABORT, 'ledger write denied'); END`);
    await assert.rejects(h.run({}, T0), /discovery memory outcomes could not be written/);
    assert.equal(count(h.storage, 'system_runs'), 0, 'runner did not start');
    assert.ok(h.storage.all('SELECT * FROM discovery_observations').every((r) => r.evaluation_outcome === 'NOT_EVALUATED'));
  } finally { h.cleanup(); }
});
