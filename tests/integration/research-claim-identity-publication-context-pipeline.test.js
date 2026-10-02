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

// Regression: the provider id and each candidate's publishedAt must reach
// identity validation, so a trusted publication date can ground the year of a
// month-only claim -- and an untrusted provider (GDELT) must not.

const A = 'https://publisher-one.com/story';
const B = 'https://publisher-two.org/story';
const C = 'https://publisher-three.net/story';
const marker = (url) => `MARK_${new URL(url).hostname.replace(/\W/g, '_')}`;
const ident = (predicate) => ({
  subject: 'Acme', predicate, object: 'Widget', qualifiers: [], time: '2026-03', quantity: null, unit: null,
  polarity: 'AFFIRMED', modality: 'OCCURRED', relation: 'DESCRIPTIVE'
});
const CLAIMS = {
  [A]: [{ claim: 'Acme released Widget in March.', claim_type: 'FACT', is_load_bearing: true, identity: ident('release') }],
  [B]: [{ claim: 'Acme launched Widget in March.', claim_type: 'FACT', is_load_bearing: true, identity: ident('launch') }]
};

// `publishedAt` is either one value applied to every candidate, or a { [url]: value }
// map giving each candidate its OWN publication date (a url missing from the map
// gets no publishedAt key at all, like a provider that supplies no date).
async function run(providerId, publishedAt, claimsByUrl = CLAIMS) {
  const dbPath = path.join(os.tmpdir(), `pubctx-${Date.now()}-${Math.random()}.db`);
  const storage = new SqliteStorageDriver({ dbPath });
  await storage.migrate();
  const opportunityId = crypto.randomUUID();
  storage.run(
    `INSERT INTO opportunities (id, title, source, discovered_at, status, opportunity_proposition)
     VALUES (?, 'Test opportunity', 'rss', ?, 'HANDED_TO_RESEARCH', ?)`,
    [opportunityId, new Date().toISOString(), JSON.stringify({
      subject: 's', target_audience: 'a', audience_problem: 'p', core_question: 'Did Acme release Widget?',
      gap: 'g', angle: 'a', differentiation: 'd', commercial_relevance: 'c', core_question_type: 'FACTUAL'
    })]
  );
  class Provider extends ResearchSourceProvider {
    get id() { return providerId; }
    async healthCheck() { return true; }
    async discoverCandidates() {
      return {
        candidates: Object.keys(claimsByUrl).map((url, i) => {
          const candidate = { url, title: `t${i}`, snippet: 's' };
          const date = publishedAt !== null && typeof publishedAt === 'object' ? publishedAt[url] : publishedAt;
          if (date !== undefined) candidate.publishedAt = date;
          return candidate;
        })
      };
    }
  }
  const registry = {
    'pubctx-stub': () => ({
      id: 'pubctx-stub', isPaid: false,
      async healthCheck() { return true; },
      async complete({ prompt }) {
        const url = Object.keys(claimsByUrl).find((u) => prompt.includes(marker(u)));
        return { text: JSON.stringify(url ? claimsByUrl[url] : []), model: 'pubctx-stub', requestId: null, inputTokens: 1, outputTokens: 1, estimatedCost: 0, isPaid: false };
      }
    })
  };
  const result = await runResearchProject({
    storage, opportunityId, sourceProvider: new Provider(),
    llmRouter: new LLMRouter({ priority: ['pubctx-stub'], allowPaidProviders: false, registry }),
    policy: researchPolicy,
    fetchImpl: async (url) => ({
      ok: true, status: 200, headers: { get: () => 'text/html' },
      text: async () => `<html><body>${marker(url)} independent report covering the product topic in some detail. ${claimsByUrl[url].map((c) => c.claim).join(' ')}</body></html>`
    }),
    detectContradiction: null
  });
  const out = {
    claims: result.claims.length,
    merged: storage.all("SELECT 1 FROM decision_log WHERE decision = 'MERGED_BY_IDENTITY'").length,
    coverage: storage.all("SELECT config_snapshot FROM decision_log WHERE decision = 'EXTRACTED'").map((r) => JSON.parse(r.config_snapshot).identity),
    // Per-source identity coverage as the pipeline recorded it, keyed by the source's URL.
    bySource: Object.fromEntries(storage.all(
      "SELECT s.url AS url, d.config_snapshot AS snap FROM decision_log d JOIN sources s ON s.id = d.subject_id WHERE d.decision = 'EXTRACTED'"
    ).map((r) => [r.url, JSON.parse(r.snap).identity])),
    histogram: null
  };
  // Run-level identity reason histogram, derived from the per-source EXTRACTED coverage rows the
  // pipeline already records (not from any trace-summary row), so this test depends only on the
  // publication-context change itself: `null` counts fingerprinted claims, other keys are veto reasons.
  out.histogram = {};
  for (const c of Object.values(out.bySource)) {
    if (c.fingerprinted > 0) out.histogram.null = (out.histogram.null ?? 0) + c.fingerprinted;
    for (const [reason, n] of Object.entries(c.reasons)) out.histogram[reason] = (out.histogram[reason] ?? 0) + n;
  }
  storage.close();
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${dbPath}${suffix}`, { force: true });
  return out;
}

test('trusted provider + publication date reaches identity validation: month-only paraphrases fingerprint and merge', async () => {
  const out = await run('tavily', '2026-05-12');
  assert.equal(out.claims, 1);
  assert.equal(out.merged, 1);
  assert.ok(out.coverage.every((c) => c.fingerprinted === 1 && c.inconsistent === 0));
  assert.deepEqual(out.histogram, { null: 2 });
});

test('the same claims from GDELT (seendate never trusted) or with no publication date stay unfingerprinted and separate', async () => {
  for (const [providerId, publishedAt] of [['gdelt', '2026-05-12'], ['tavily', null]]) {
    const out = await run(providerId, publishedAt);
    assert.equal(out.claims, 2, providerId);
    assert.equal(out.merged, 0, providerId);
    assert.deepEqual(out.histogram, { time_year_not_grounded: 2 }, providerId);
  }
});

// Isolation: every source carries the SAME month-only claim, so the only thing that can
// differ between them is that source's own publication context. The valid date is rotated
// through every position so a leak of the first, last or any single source's date to the
// others (or a shared/overwritten value) would flip at least one assertion.
const SAME = 'Acme released Widget in March.';
const SAME_CLAIMS = Object.fromEntries([A, B, C].map((url) => [url, [{
  claim: SAME, claim_type: 'FACT', is_load_bearing: true, identity: ident('release')
}]]));
const VALID = '2026-05-12'; // 2 months after March, same calendar year: grounds the year
const TOO_LATE = '2026-09-30'; // 6 months after March: outside the 3-month gap
// For each rotation: which URL gets the valid date, which gets none, which gets the late one.
const ROTATIONS = [[A, B, C], [B, C, A], [C, A, B]];

test('publication context is isolated per source: only the source whose own date grounds the claim is fingerprinted', async () => {
  for (const [good, none, late] of ROTATIONS) {
    const out = await run('tavily', { [good]: VALID, [late]: TOO_LATE }, SAME_CLAIMS);
    const label = `valid=${good} none=${none} late=${late}`;
    assert.deepEqual(Object.keys(out.bySource).sort(), [A, B, C].sort(), label);

    assert.equal(out.bySource[good].factClaims, 1, label);
    assert.equal(out.bySource[good].fingerprinted, 1, `${label}: valid-date source must be fingerprinted`);
    assert.deepEqual(out.bySource[good].reasons, {}, label);

    for (const [url, why] of [[none, 'no publication date'], [late, 'date outside the allowed gap']]) {
      assert.equal(out.bySource[url].factClaims, 1, label);
      assert.equal(out.bySource[url].fingerprinted, 0, `${label}: ${why} must NOT be fingerprinted`);
      assert.deepEqual(out.bySource[url].reasons, { time_year_not_grounded: 1 }, `${label}: ${why}`);
    }

    // Run-level histogram agrees: exactly one grounded claim, two fail-closed.
    assert.deepEqual(out.histogram, { null: 1, time_year_not_grounded: 2 }, label);
    // Identical text from a source without a grounded identity never merges with the grounded one.
    assert.equal(out.merged, 0, label);
  }
});
