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

// The research decision-log traces (CLAIM_TRACE, EVIDENCE_TRACE,
// RESEARCH_TRACE_SUMMARY) are inert unless DIAGNOSTIC_TRACE === 'true', and
// enabling them must not change any research outcome.

const A = 'https://publisher-one.com/story';
const B = 'https://publisher-two.org/story';
const marker = (url) => `MARK_${new URL(url).hostname.replace(/\W/g, '_')}`;
const ident = (predicate) => ({
  subject: 'Acme', predicate, object: 'Widget', qualifiers: [], time: '2026-03', quantity: null, unit: null,
  polarity: 'AFFIRMED', modality: 'OCCURRED', relation: 'DESCRIPTIVE'
});
const CLAIMS = {
  [A]: [{ claim: 'Acme released Widget in March.', claim_type: 'FACT', is_load_bearing: true, identity: ident('release') }],
  [B]: [{ claim: 'Acme launched Widget in March.', claim_type: 'FACT', is_load_bearing: true, identity: ident('launch') }]
};
const TRACE_DECISIONS = ['CLAIM_TRACE', 'EVIDENCE_TRACE', 'RESEARCH_TRACE_SUMMARY'];

async function run(flagValue) {
  const previous = process.env.DIAGNOSTIC_TRACE;
  if (flagValue === undefined) delete process.env.DIAGNOSTIC_TRACE; else process.env.DIAGNOSTIC_TRACE = flagValue;
  const dbPath = path.join(os.tmpdir(), `tracegate-${Date.now()}-${Math.random()}.db`);
  const storage = new SqliteStorageDriver({ dbPath });
  try {
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
      get id() { return 'tavily'; }
      async healthCheck() { return true; }
      async discoverCandidates() {
        return { candidates: Object.keys(CLAIMS).map((url, i) => ({ url, title: `t${i}`, snippet: 's', publishedAt: '2026-05-12' })) };
      }
    }
    const registry = {
      'tracegate-stub': () => ({
        id: 'tracegate-stub', isPaid: false,
        async healthCheck() { return true; },
        async complete({ prompt }) {
          const url = Object.keys(CLAIMS).find((u) => prompt.includes(marker(u)));
          return { text: JSON.stringify(url ? CLAIMS[url] : []), model: 'tracegate-stub', requestId: null, inputTokens: 1, outputTokens: 1, estimatedCost: 0, isPaid: false };
        }
      })
    };
    const result = await runResearchProject({
      storage, opportunityId, sourceProvider: new Provider(),
      llmRouter: new LLMRouter({ priority: ['tracegate-stub'], allowPaidProviders: false, registry }),
      policy: researchPolicy,
      fetchImpl: async (url) => ({
        ok: true, status: 200, headers: { get: () => 'text/html' },
        text: async () => `<html><body>${marker(url)} independent report covering the product topic in some detail. ${CLAIMS[url].map((c) => c.claim).join(' ')}</body></html>`
      }),
      detectContradiction: null
    });
    const traceCounts = Object.fromEntries(TRACE_DECISIONS.map((d) => [
      d, storage.all('SELECT 1 FROM decision_log WHERE decision = ?', [d]).length
    ]));
    return {
      traceCounts,
      outcome: result.claims.map((c) => [c.claim, c.claim_type, c.evidence_status]).sort()
    };
  } finally {
    storage.close();
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${dbPath}${suffix}`, { force: true });
    if (previous === undefined) delete process.env.DIAGNOSTIC_TRACE; else process.env.DIAGNOSTIC_TRACE = previous;
  }
}

test('research traces are inert by default: no CLAIM/EVIDENCE/SUMMARY trace rows without DIAGNOSTIC_TRACE', async () => {
  for (const flag of [undefined, '', 'false', '1']) {
    const off = await run(flag);
    assert.deepEqual(off.traceCounts, { CLAIM_TRACE: 0, EVIDENCE_TRACE: 0, RESEARCH_TRACE_SUMMARY: 0 }, `flag=${JSON.stringify(flag)}`);
  }
});

test('DIAGNOSTIC_TRACE=true writes the research traces and does not change any research outcome', async () => {
  const off = await run(undefined);
  const on = await run('true');
  assert.ok(on.traceCounts.CLAIM_TRACE >= 1);
  assert.ok(on.traceCounts.EVIDENCE_TRACE >= 1);
  assert.equal(on.traceCounts.RESEARCH_TRACE_SUMMARY, 1);
  assert.ok(off.outcome.length >= 1);
  assert.deepEqual(on.outcome, off.outcome);
});
