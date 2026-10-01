import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { SqliteStorageDriver } from '../../src/storage/SqliteStorageDriver.js';
import { ResearchSourceProvider } from '../../src/research/ResearchSourceProvider.js';
import { runResearchProject, buildResearchQuery } from '../../src/research/pipeline.js';
import researchPolicy from '../../config/research_policy.json' with { type: 'json' };

// Live run 36628871372, project d83f: subject named OpenAI, core_question did not.
const SUBJECT = "OpenAI's Dots proactive assistant";
const CORE_QUESTION = 'How does Dots help users stay in control while work moves forward?';

class CapturingProvider extends ResearchSourceProvider {
  constructor() { super(); this.queries = []; }
  get id() { return 'capturing-stub'; }
  async healthCheck() { return true; }
  async discoverCandidates({ query }) { this.queries.push(query); return { candidates: [] }; }
}

test('research discovery query carries the proposition subject, so a homonym topic stays disambiguated', async () => {
  const dbPath = path.join(os.tmpdir(), `research-query-${Date.now()}-${Math.random()}.db`);
  const storage = new SqliteStorageDriver({ dbPath });
  try {
    await storage.migrate();
    const id = crypto.randomUUID();
    storage.run(
      `INSERT INTO opportunities (id, title, source, discovered_at, status, opportunity_proposition)
       VALUES (?, 'Introducing dots', 'rss', ?, 'HANDED_TO_RESEARCH', ?)`,
      [id, new Date().toISOString(), JSON.stringify({
        subject: SUBJECT, target_audience: 'a', audience_problem: 'p', core_question: CORE_QUESTION,
        gap: 'g', angle: 'a', differentiation: 'd', commercial_relevance: 'c', core_question_type: 'FACTUAL'
      })]
    );
    const provider = new CapturingProvider();
    await runResearchProject({ storage, opportunityId: id, sourceProvider: provider, llmRouter: null, policy: researchPolicy });
    assert.equal(provider.queries.length, 1);
    assert.match(provider.queries[0], /OpenAI/);
    assert.ok(provider.queries[0].includes(CORE_QUESTION));
  } finally {
    storage.close();
    for (const s of ['', '-wal', '-shm']) fs.rmSync(`${dbPath}${s}`, { force: true });
  }
});

test('buildResearchQuery: no duplication when the question already contains the subject; falls back safely', () => {
  assert.equal(buildResearchQuery('Acme', 'Did Acme launch Widget?'), 'Did Acme launch Widget?');
  assert.equal(buildResearchQuery('', 'Q?'), 'Q?');
  assert.equal(buildResearchQuery(undefined, 'Q?'), 'Q?');
  assert.equal(buildResearchQuery('Acme', ''), 'Acme');
  assert.equal(buildResearchQuery('Acme', 'What happened?'), 'Acme What happened?');
});

test('buildResearchQuery: subject match is case-insensitive; whitespace is trimmed; non-string inputs fall back safely', () => {
  assert.equal(buildResearchQuery('ACME', 'Did acme launch Widget?'), 'Did acme launch Widget?');
  assert.equal(buildResearchQuery('  Acme  ', '  What happened?  '), 'Acme What happened?');
  assert.equal(buildResearchQuery(null, 'Q?'), 'Q?');
  assert.equal(buildResearchQuery(42, 'Q?'), 'Q?');
});

test('buildResearchQuery: a generic question without the entity is anchored, preventing generic-topic drift', () => {
  const q = buildResearchQuery("OpenAI's Dots proactive assistant", 'How does it keep users in control?');
  assert.ok(q.startsWith("OpenAI's Dots proactive assistant"));
  assert.ok(q.endsWith('How does it keep users in control?'));
});
