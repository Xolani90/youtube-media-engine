import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { SqliteStorageDriver } from '../../src/storage/SqliteStorageDriver.js';
import { LLMRouter } from '../../src/providers/llm/router.js';
import { OpportunitySource } from '../../src/providers/opportunity/OpportunitySource.js';
import { ResearchSourceProvider } from '../../src/research/ResearchSourceProvider.js';
import { runResearchProject } from '../../src/research/pipeline.js';
import { assessContent, CONTENT_VERDICT } from '../../src/research/contentAssessment.js';
import { retrieveSource } from '../../src/research/retrieval.js';
import { classifySourceRole, assessEvidenceAdmissibility } from '../../src/research/sourceClassification.js';
import { runAutonomousEntrypoint } from '../../src/index.js';
import { config } from '../../src/config/index.js';
import researchPolicy from '../../config/research_policy.json' with { type: 'json' };

// ---- Part A: login / account walls -------------------------------------------------

const LOGIN_WALLS = [
  'Log in to continue.',
  'Log into Facebook to see more.',
  'Log in to Facebook to see more.',
  'Sign in to continue.',
  'Sign up to see more.',
  'Login required.',
  'Sign in required.',
  'You must log in to continue.'
];

test('Pass 46.1: every login/account-wall phrase is BOILERPLATE, not substantive', () => {
  for (const text of LOGIN_WALLS) {
    const a = assessContent(text);
    assert.equal(a.verdict, CONTENT_VERDICT.BOILERPLATE, `${text} -> ${a.verdict}`);
  }
});

test('Pass 46.1: a Facebook-style login wall retrieves as CONTENT_UNPARSEABLE, not SUCCESS', async () => {
  const res = { ok: true, status: 200, headers: { get: () => 'text/html' }, text: async () => '<html><body>Log into Facebook to see more.</body></html>' };
  const r = await retrieveSource('https://www.facebook.com/x/posts/1', { fetchImpl: async () => res, readerBaseUrl: null });
  assert.equal(r.status, 'CONTENT_UNPARSEABLE');
  assert.equal(r.content, null);
});

test('Pass 46.1: a genuine short article that merely mentions logging in is still substantive', () => {
  const t = 'Users can log in with their existing Google account, the company said on Tuesday.';
  assert.equal(assessContent(t).verdict, CONTENT_VERDICT.SUBSTANTIVE);
  assert.equal(assessContent('The tool measurably cuts costs.').verdict, CONTENT_VERDICT.SUBSTANTIVE);
});

test('Pass 46.1: a long article is never rejected for containing gate phrasing (wrapper rule is short-page only)', () => {
  const body = 'Google announced the new model on Tuesday with several upgrades. '.repeat(30) + 'Readers had to sign in to continue on some partner sites.';
  assert.equal(assessContent(body).verdict, CONTENT_VERDICT.SUBSTANTIVE);
});

test('Pass 46.1: reader fallback behaviour is unchanged for a login wall (one attempt, fail closed)', async () => {
  let calls = 0;
  const res = { ok: true, status: 200, headers: { get: () => 'text/html' }, text: async () => '<html><body>Sign in to continue.</body></html>' };
  const r = await retrieveSource('https://a.com/x', {
    fetchImpl: async () => res, readerBaseUrl: 'https://reader.example/',
    readerFetchImpl: async () => { calls++; return { ok: true, status: 200, text: async () => 'Sign in to continue.' }; }
  });
  assert.equal(calls, 1);
  assert.equal(r.status, 'CONTENT_UNPARSEABLE');
  assert.equal(r.fallback.attempted, true);
  assert.equal(r.fallback.success, false);
});

// ---- Part B/D: real classification wiring ------------------------------------------

test('Pass 46.1: the loaded production config marks blog.google authoritative and leaves unknown domains independent', () => {
  const c = config.researchSourceClassification;
  assert.deepEqual(c.authoritativeDomains, ['blog.google']);
  assert.equal(classifySourceRole('https://blog.google/innovation-and-ai/x', c).role, 'primary_authoritative');
  assert.equal(classifySourceRole('https://www.cnbc.com/2026/09/30/x.html', c).role, 'independent_reporting');
  assert.equal(classifySourceRole('https://news.example/a', { ...c, syndicatedDomains: ['news.example'] }).role, 'syndicated');
});

test('Pass 46.1: authority never rescues unusable content', () => {
  assert.equal(assessEvidenceAdmissibility('SUCCESS', 'primary_authoritative', 'Sign in to continue.').quality, 'UNUSABLE');
  assert.equal(assessEvidenceAdmissibility('SUCCESS', 'primary_authoritative', 'Google announced the new model on Tuesday.').quality, 'HIGH');
});

class StubProvider extends ResearchSourceProvider {
  constructor(urls) { super(); this.urls = urls; }
  get id() { return 'stub'; }
  async healthCheck() { return true; }
  async discoverCandidates() { return { candidates: this.urls.map((url) => ({ url, title: 't', snippet: 's' })) }; }
}
class NoCandidates extends OpportunitySource {
  get id() { return 'none'; }
  async healthCheck() { return true; }
  async fetchCandidates() { return { candidates: [], failures: [] }; }
  normalize(c) { return c; }
}

test('Pass 46.1: the autonomous entrypoint hands the research stage the configured classification, and the real pipeline applies it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pass46-1-'));
  const storage = new SqliteStorageDriver({ dbPath: path.join(dir, 't.db') });
  let captured = null;
  try {
    await storage.migrate();
    storage.run(`INSERT INTO opportunities (id, title, source, discovered_at, status) VALUES (?, 't', 'rss', ?, 'HANDED_TO_RESEARCH')`, [crypto.randomUUID(), new Date().toISOString()]);
    await runAutonomousEntrypoint({
      storage,
      llmRouter: new LLMRouter({ priority: ['u'], allowPaidProviders: false, registry: { u: () => ({ id: 'u', isPaid: false, async healthCheck() { return true; }, async complete() { throw new Error('unused'); } }) } }),
      discovery: { opportunitySource: new NoCandidates(), topK: 1 },
      stageFns: { research: ({ classification }) => { captured = classification; return { count: 0 }; } }
    });
    assert.ok(captured, 'research stage received a classification object (not undefined/{})');
    assert.deepEqual(captured.authoritativeDomains, ['blog.google']);

    // Feed exactly that object to the real pipeline.
    const opportunityId = crypto.randomUUID();
    storage.run(`INSERT INTO opportunities (id, title, source, discovered_at, status, opportunity_proposition) VALUES (?, 't2', 'rss', ?, 'HANDED_TO_RESEARCH', ?)`, [opportunityId, new Date().toISOString(),
      JSON.stringify({ subject: 'Gemini 4 Argon', target_audience: 'a', audience_problem: 'p', core_question: 'What did Google announce?', gap: 'g', angle: 'a', differentiation: 'd', commercial_relevance: 'c', core_question_type: 'FACTUAL' })]);
    const pages = {
      'https://blog.google/gemini-4-argon': '<html><body>Google announced Gemini 4 Argon on September 30, 2026 as its newest model.</body></html>',
      'https://blog.google/login-gated': '<html><body>Sign in to continue.</body></html>',
      'https://www.cnbc.com/a': '<html><body>CNBC reported that Google announced Gemini 4 Argon on Tuesday.</body></html>'
    };
    const fetchImpl = async (url) => ({ ok: true, status: 200, headers: { get: () => 'text/html' }, text: async () => pages[url] });
    const llmRouter = { complete: async () => ({ providerUsed: 's', result: { text: '[]', model: 's' } }) };
    const result = await runResearchProject({
      storage, opportunityId, sourceProvider: new StubProvider(Object.keys(pages)), llmRouter,
      policy: researchPolicy, classification: captured, fetchImpl
    });
    const byUrl = Object.fromEntries(result.sources.map((s) => [s.url, s]));
    assert.equal(byUrl['https://blog.google/gemini-4-argon'].role, 'primary_authoritative');
    assert.equal(byUrl['https://blog.google/gemini-4-argon'].quality_tier, 'HIGH');
    assert.equal(byUrl['https://www.cnbc.com/a'].role, 'independent_reporting');
    assert.equal(byUrl['https://www.cnbc.com/a'].quality_tier, 'MEDIUM');
    assert.equal(byUrl['https://blog.google/login-gated'].retrieval_status, 'CONTENT_UNPARSEABLE');
    assert.equal(byUrl['https://blog.google/login-gated'].quality_tier, 'UNUSABLE');
  } finally {
    storage.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
