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

const SOCIAL = 'https://www.instagram.com/reel/xyz/';
const AUTH = 'https://acme.com/post';
const SOCIAL_CLAIM = 'The studio will ship a quick marketing tour feature for everyone.';
const AUTH_CLAIM = 'Acme released version two of its product on 1 October 2026.';
const BODIES = {
  [SOCIAL]: `<html><body>MARK_SOCIAL ${SOCIAL_CLAIM} Fans are sharing the reel widely across the platform today.</body></html>`,
  [AUTH]: `<html><body>MARK_AUTH ${AUTH_CLAIM} The company published the full details in its official announcement.</body></html>`
};
const fetchImpl = async (url) => ({ ok: true, status: 200, headers: { get: () => 'text/html' }, text: async () => BODIES[url] });

class Provider extends ResearchSourceProvider {
  get id() { return 'social-only-stub'; }
  async healthCheck() { return true; }
  async discoverCandidates() { return { candidates: [SOCIAL, AUTH].map((url, i) => ({ url, title: `t${i}`, snippet: 's' })) }; }
}

// Extraction returns the claim that matches whichever source text is in the prompt.
function router() {
  const registry = { stub: () => ({
    id: 'stub', isPaid: false, async healthCheck() { return true; },
    async complete(req) {
      const prompt = String(req?.prompt ?? req ?? '');
      const claim = prompt.includes('MARK_SOCIAL') ? SOCIAL_CLAIM : prompt.includes('MARK_AUTH') ? AUTH_CLAIM : null;
      const items = claim ? [{ claim, claim_type: 'FACT', is_load_bearing: true }] : [];
      return { text: JSON.stringify(items), model: 'stub', requestId: null, inputTokens: 1, outputTokens: 1, estimatedCost: 0, isPaid: false };
    }
  }) };
  return new LLMRouter({ priority: ['stub'], allowPaidProviders: false, registry });
}

test('pipeline: social-only load-bearing claim is downgraded + audited; authoritative claim stays load-bearing; grading unchanged', async () => {
  const dbPath = path.join(os.tmpdir(), `social-only-lb-${process.pid}-${Date.now()}.db`);
  const storage = new SqliteStorageDriver({ dbPath });
  await storage.migrate();
  try {
    const oppId = crypto.randomUUID();
    storage.run(
      `INSERT INTO opportunities (id, title, source, discovered_at, status, opportunity_proposition) VALUES (?, 'T', 'rss', ?, 'HANDED_TO_RESEARCH', ?)`,
      [oppId, new Date().toISOString(), JSON.stringify({
        subject: 'Acme product', target_audience: 'a', audience_problem: 'p', core_question: 'What did Acme release?',
        gap: 'g', angle: 'a', differentiation: 'd', commercial_relevance: 'c', core_question_type: 'FACTUAL' })]
    );
    await runResearchProject({
      storage, opportunityId: oppId, sourceProvider: new Provider(), llmRouter: router(), policy: researchPolicy,
      classification: { authoritativeDomains: ['acme.com'], socialDomains: ['instagram.com'] }, fetchImpl
    });
    const social = storage.get('SELECT * FROM claims WHERE claim = ?', [SOCIAL_CLAIM]);
    const auth = storage.get('SELECT * FROM claims WHERE claim = ?', [AUTH_CLAIM]);
    assert.ok(social && auth, 'both claims persisted');
    assert.equal(social.is_load_bearing, 0);
    assert.equal(social.evidence_status, 'UNSUPPORTED'); // grading unchanged: social still never evidence
    assert.equal(auth.is_load_bearing, 1);
    assert.equal(auth.evidence_status, 'VERIFIED');
    const logs = storage.all(
      `SELECT * FROM decision_log WHERE stage = 'LOAD_BEARING_CLASSIFICATION' AND reason = 'social_only_sources_downgrade'`);
    assert.equal(logs.length, 1);
    assert.equal(logs[0].subject_id, social.id);
    const snap = JSON.parse(logs[0].config_snapshot);
    assert.equal(snap.previous, 'LOAD_BEARING');
    assert.equal(snap.linkedSources[0].role, 'social_media');
    assert.equal(snap.linkedSources[0].domain, 'instagram.com');
  } finally {
    storage.close();
    for (const s of ['', '-wal', '-shm']) fs.rmSync(`${dbPath}${s}`, { force: true });
  }
});
