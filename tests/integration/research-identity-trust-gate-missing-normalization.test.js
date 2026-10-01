import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Gate 6. Missing normalization must fail closed at the identity index.
//
// extractClaims() always attaches `normalization`, so the pipeline has no
// production seam that yields a claim without it. Rather than export internals
// or weaken the gate, this test re-executes itself in a child process with Node's
// module mocking enabled, wraps the REAL extractClaims, and strips `normalization`
// from the claims of selected sources. Production code is untouched.

const CHILD = process.env.IDENTITY_GATE_MISSING_NORMALIZATION_CHILD === '1';
const SELF = fileURLToPath(import.meta.url);

const A = 'https://publisher-one.com/story';
const B = 'https://publisher-two.org/story';
const C = 'https://publisher-three.net/story';
const W1 = 'Spain won the final in 2026.';
const W2 = 'The final in 2026 was won by Spain.';
const W3 = 'Spain were the winners of the final in 2026.';

async function childMain() {
  const { mock } = await import('node:test');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const crypto = await import('node:crypto');

  const claimsUrl = new URL('../../src/research/claims.js', import.meta.url).href;
  const real = await import(claimsUrl);
  const stripFor = new Set(JSON.parse(process.env.STRIP_NORMALIZATION_URLS));
  mock.module(claimsUrl, {
    namedExports: {
      ...real,
      extractClaims: async (input, router) => {
        const out = await real.extractClaims(input, router);
        if (stripFor.has(input.sourceUrl)) out.claims = out.claims.map(({ normalization, ...rest }) => rest);
        return out;
      }
    }
  });

  const { SqliteStorageDriver } = await import('../../src/storage/SqliteStorageDriver.js');
  const { LLMRouter } = await import('../../src/providers/llm/router.js');
  const { ResearchSourceProvider } = await import('../../src/research/ResearchSourceProvider.js');
  const { runResearchProject } = await import('../../src/research/pipeline.js');
  const { default: researchPolicy } = await import('../../config/research_policy.json', { with: { type: 'json' } });

  const { claimsByUrl, bodies } = JSON.parse(process.env.SCENARIO);
  const marker = (url) => `MARK_${url.replace(/\W/g, '_')}`;
  const dbPath = path.join(os.tmpdir(), `identity-gate-missing-${Date.now()}-${Math.random()}.db`);
  const storage = new SqliteStorageDriver({ dbPath });
  await storage.migrate();
  const oppId = crypto.randomUUID();
  storage.run(
    `INSERT INTO opportunities (id, title, source, discovered_at, status, opportunity_proposition)
     VALUES (?, 'Test opportunity', 'rss', ?, 'HANDED_TO_RESEARCH', ?)`,
    [oppId, new Date().toISOString(), JSON.stringify({
      subject: 's', target_audience: 'a', audience_problem: 'p', core_question: 'Who won the final in 2026?',
      gap: 'g', angle: 'a', differentiation: 'd', commercial_relevance: 'c', core_question_type: 'FACTUAL'
    })]
  );
  class UrlListProvider extends ResearchSourceProvider {
    get id() { return 'url-list-stub'; }
    async healthCheck() { return true; }
    async discoverCandidates() { return { candidates: Object.keys(claimsByUrl).map((url, i) => ({ url, title: `t${i}`, snippet: 's' })) }; }
  }
  const registry = {
    'gate-stub': () => ({
      id: 'gate-stub', isPaid: false,
      async healthCheck() { return true; },
      async complete({ prompt }) {
        const url = Object.keys(claimsByUrl).find((u) => prompt.includes(marker(u)));
        return { text: JSON.stringify(url ? claimsByUrl[url] : []), model: 'gate-stub', requestId: null, inputTokens: 1, outputTokens: 1, estimatedCost: 0, isPaid: false };
      }
    })
  };
  const result = await runResearchProject({
    storage, opportunityId: oppId, sourceProvider: new UrlListProvider(),
    llmRouter: new LLMRouter({ priority: ['gate-stub'], allowPaidProviders: false, registry }),
    policy: researchPolicy,
    fetchImpl: async (url) => ({
      ok: true, status: 200, headers: { get: () => 'text/html' },
      text: async () => `<html><body><p>${marker(url)} independent report covering the final in some detail.</p><p>${bodies[url] ?? ''}</p></body></html>`
    }),
    detectContradiction: null
  });
  const out = {
    claims: result.claims.map((c) => ({
      claim: c.claim,
      sources: new Set(storage.all('SELECT source_id FROM claim_sources WHERE claim_id = ?', [c.id]).map((r) => r.source_id)).size
    })),
    mergedByIdentity: storage.all("SELECT 1 FROM decision_log WHERE decision = 'MERGED_BY_IDENTITY'").length
  };
  storage.close();
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${dbPath}${suffix}`, { force: true });
  process.stdout.write(`RESULT:${JSON.stringify(out)}\n`);
}

function runScenario({ claimsByUrl, bodies, stripNormalizationFor }) {
  const child = spawnSync(process.execPath, ['--experimental-test-module-mocks', SELF], {
    encoding: 'utf8',
    env: {
      ...process.env, IDENTITY_GATE_MISSING_NORMALIZATION_CHILD: '1',
      SCENARIO: JSON.stringify({ claimsByUrl, bodies }), STRIP_NORMALIZATION_URLS: JSON.stringify(stripNormalizationFor)
    }
  });
  const line = child.stdout.split('\n').find((l) => l.startsWith('RESULT:'));
  assert.ok(line, `child produced no result (status ${child.status}): ${child.stderr}`);
  return JSON.parse(line.slice('RESULT:'.length));
}

const ident = () => ({
  subject: 'Spain', predicate: 'win', object: 'the final', qualifiers: [], time: '2026', quantity: null, unit: null,
  polarity: 'AFFIRMED', modality: 'OCCURRED', relation: 'DESCRIPTIVE'
});
const fact = (claim) => ({ claim, claim_type: 'FACT', is_load_bearing: true, identity: ident() });

if (CHILD) {
  await childMain();
} else {
  // Control: with normalization intact the same fixtures DO merge by identity.
  test('Gate 6 control. same fixtures with normalization present merge by identity', () => {
    const out = runScenario({
      claimsByUrl: { [A]: [fact(W1)], [B]: [fact(W2)] }, bodies: { [A]: W1, [B]: W2 }, stripNormalizationFor: []
    });
    assert.equal(out.claims.length, 1);
    assert.equal(out.mergedByIdentity, 1);
  });

  test('Gate 6. missing normalization fails closed at the identity index (missing-first and trusted-first)', () => {
    // Missing-first: the stripped claim must not seed the index; trusted peers still merge.
    const missingFirst = runScenario({
      claimsByUrl: { [A]: [fact(W3)], [B]: [fact(W1)], [C]: [fact(W2)] },
      bodies: { [A]: W3, [B]: W1, [C]: W2 }, stripNormalizationFor: [A]
    });
    assert.equal(missingFirst.claims.length, 2);
    assert.equal(missingFirst.claims[0].claim, W3);
    assert.equal(missingFirst.claims[0].sources, 1);
    assert.equal(missingFirst.claims[1].sources, 2);
    assert.equal(missingFirst.mergedByIdentity, 1);

    // Trusted-first: a trusted claim must not absorb a later claim that has no normalization.
    const trustedFirst = runScenario({
      claimsByUrl: { [A]: [fact(W1)], [B]: [fact(W2)] }, bodies: { [A]: W1, [B]: W2 }, stripNormalizationFor: [B]
    });
    assert.equal(trustedFirst.claims.length, 2);
    assert.ok(trustedFirst.claims.every((c) => c.sources === 1));
    assert.equal(trustedFirst.mergedByIdentity, 0);
  });
}
