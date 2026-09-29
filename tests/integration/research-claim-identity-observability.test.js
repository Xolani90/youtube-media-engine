import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { SqliteStorageDriver } from '../../src/storage/SqliteStorageDriver.js';
import { runResearchProject } from '../../src/research/pipeline.js';
import { deriveClaimIdentity } from '../../src/research/claimIdentity.js';
import researchPolicy from '../../config/research_policy.json' with { type: 'json' };

const identity = (over = {}) => ({
  subject: 'Dots', predicate: 'available', object: null, qualifiers: [], time: null, quantity: null, unit: null,
  polarity: 'AFFIRMED', modality: 'OCCURRED', relation: 'DESCRIPTIVE', ...over
});

test('deriveClaimIdentity exposes the normalized identity for trusted and untrusted claims, without changing the verdict', () => {
  const ok = deriveClaimIdentity({ claim: 'Dots are available in ChatGPT.', claim_type: 'FACT', identity: identity() });
  assert.ok(ok.fingerprint);
  assert.equal(ok.identity.subject, 'dots');
  const bad = deriveClaimIdentity({ claim: 'Dots will be available soon.', claim_type: 'FACT', identity: identity() });
  assert.equal(bad.fingerprint, null);
  assert.equal(bad.reason, 'modality_text_mismatch');
  assert.equal(bad.identity.modality, 'OCCURRED');
});

test('pipeline logs one identity row per FACT claim: fingerprint+structure when trusted, reason when untrusted; no claim text', async () => {
  const dbPath = path.join(os.tmpdir(), `ident-obs-${Date.now()}-${Math.random()}.db`);
  const storage = new SqliteStorageDriver({ dbPath });
  await storage.migrate();
  const oppId = crypto.randomUUID();
  storage.run(
    `INSERT INTO opportunities (id, title, description, source, discovered_at, status, opportunity_proposition)
     VALUES (?, 't', 'd', 'rss', ?, 'HANDED_TO_RESEARCH', ?)`,
    [oppId, new Date().toISOString(), JSON.stringify({ subject: 'Dots', core_question: 'What are Dots?', core_question_type: 'FACTUAL' })]
  );
  const claims = [
    { claim: 'Dots are available in ChatGPT.', claim_type: 'FACT', is_load_bearing: true, identity: identity() },
    { claim: 'Dots will be available soon.', claim_type: 'FACT', is_load_bearing: true, identity: identity() },
    { claim: 'Dots are great.', claim_type: 'OPINION', is_load_bearing: false }
  ];
  const llmRouter = {
    async complete() {
      return { result: { text: JSON.stringify(claims), model: 'stub', estimatedCost: 0, isPaid: false }, providerUsed: 'stub' };
    }
  };
  const sourceProvider = { id: 'stub', async discoverCandidates() { return { candidates: [{ url: 'https://example.com/a', title: 't', snippet: 's' }], failures: [] }; } };
  const retrieveImpl = async () => ({ status: 'SUCCESS', content: 'Dots text.', error: null });

  await runResearchProject({ storage, opportunityId: oppId, sourceProvider, llmRouter, policy: researchPolicy, retrieveImpl });

  const rows = storage.all("SELECT decision, reason, config_snapshot FROM decision_log WHERE decision IN ('IDENTITY_FINGERPRINTED','IDENTITY_UNTRUSTED') ORDER BY rowid");
  assert.equal(rows.length, 2, 'FACT claims only');
  const trusted = JSON.parse(rows[0].config_snapshot);
  assert.equal(rows[0].decision, 'IDENTITY_FINGERPRINTED');
  assert.match(trusted.fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(trusted.identity.subject, 'dots');
  assert.equal(rows[1].decision, 'IDENTITY_UNTRUSTED');
  assert.equal(rows[1].reason, 'modality_text_mismatch');
  assert.equal(JSON.parse(rows[1].config_snapshot).fingerprint, null);
  for (const r of rows) assert.ok(!r.config_snapshot.includes('available in ChatGPT'), 'no claim text in the row');

  storage.close();
  for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) fs.rmSync(f, { force: true });
});
