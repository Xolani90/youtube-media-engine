// Manual, opt-in, one-shot script. NOT part of `npm test`, NOT run at
// startup, NOT part of the autonomous runner.
//
// Purpose: push ONE real Pixabay asset (real API search + real download)
// through the REAL production Asset Provisioning -> persistence -> Rights
// Verification path, using a disposable SQLite DB and a disposable asset
// directory (both under os.tmpdir(), removed on exit). No publication, no
// permanent DB/asset writes.
//
// Usage:
//   PIXABAY_API_KEY=... node scripts/prove-real-asset-rights-boundary.js ["search query"]
//
// Exit code 0 only if the real asset was acquired, persisted and judged
// VERIFIED by the real Pixabay rights policy. The key is never printed.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { SqliteStorageDriver } from '../src/storage/SqliteStorageDriver.js';
import { PixabayAssetSourceProvider } from '../src/providers/asset/PixabayAssetSourceProvider.js';
import { runAssetProvisioning } from '../src/asset-provisioning/pipeline.js';
import { runRightsVerification } from '../src/rights-verification/pipeline.js';

function seedProduced(storage, visualIdeas) {
  const now = new Date().toISOString();
  const opp = crypto.randomUUID();
  storage.run(`INSERT INTO opportunities (id, title, source, discovered_at, status) VALUES (?, 'Opp', 'rss', ?, 'DISCOVERED')`, [opp, now]);
  const briefId = crypto.randomUUID();
  storage.run(
    `INSERT INTO content_briefs
      (id, opportunity_id, working_title, core_question, target_audience, viewer_promise,
       hook, angle, narrative_structure, key_claims, counterpoints, original_insights, visual_ideas,
       monetization_opportunities, risk_assessment, created_at)
     VALUES (?, ?, 'T', 'Q', 'A', 'P', 'H', 'Angle', 'Structure', '[]', 'C', 'I', ?, 'M', 'R', ?)`,
    [briefId, opp, visualIdeas, now]
  );
  const scriptId = crypto.randomUUID();
  storage.run(`INSERT INTO scripts (id, content_brief_id, version, body, claim_links, created_at) VALUES (?, ?, 1, 'Body.', '[]', ?)`, [scriptId, briefId, now]);
  const cvId = crypto.randomUUID();
  storage.run(`INSERT INTO content_versions (id, content_brief_id, script_id, state, created_at) VALUES (?, ?, ?, 'PRODUCED', ?)`, [cvId, briefId, scriptId, now]);
  storage.run(
    `INSERT INTO productions (id, content_version_id, script_id, artifact_type, artifact_path, artifact_checksum, manifest_json, created_at)
     VALUES (?, ?, ?, 'production_manifest_v1', 'manifest.json', 'x', '{}', ?)`,
    [crypto.randomUUID(), cvId, scriptId, now]
  );
  return { briefId, cvId };
}

async function main() {
  if (!process.env.PIXABAY_API_KEY) {
    console.error('PIXABAY_API_KEY is not set in the environment. Aborting -- no key, no live call.');
    process.exitCode = 1;
    return;
  }
  const query = process.argv[2] ?? 'mountain landscape';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-live-boundary-'));
  const storage = new SqliteStorageDriver({ dbPath: path.join(dir, 'disposable.db') });
  try {
    await storage.migrate();
    const { briefId, cvId } = seedProduced(storage, query);
    const provider = new PixabayAssetSourceProvider({ downloadDir: path.join(dir, 'assets') });

    console.log(`Provider: ${provider.id}`);
    console.log(`Query (via content_briefs.visual_ideas): "${query}"`);
    console.log(`Disposable dir: ${dir}`);

    const prov = await runAssetProvisioning({ storage, contentBriefId: briefId, provider });
    console.log(`Provisioning outcome: ${prov.outcome}`);
    if (prov.outcome !== 'PROVISIONED') {
      console.error(`FAIL: provisioning did not persist an asset (${prov.reason ?? prov.failureKind ?? 'no reason'}).`);
      process.exitCode = 1;
      return;
    }
    const a = storage.get('SELECT * FROM assets WHERE id = ?', [prov.asset.id]);
    console.log(`Asset id: ${a.id}`);
    console.log(`Asset type: ${a.asset_type}`);
    console.log(`Local path: ${a.location}`);
    console.log(`Local file exists: ${fs.existsSync(a.location)}`);
    console.log(`Checksum (sha256): ${a.checksum}`);
    console.log(`Origin: ${a.origin}`);
    console.log(`License: ${a.license}`);
    console.log(`Provenance notes: ${a.provenance_notes}`);
    console.log(`verification_status after provisioning: ${a.verification_status}`);

    const rights = runRightsVerification({ storage, contentBriefId: briefId });
    console.log(`Rights outcome: ${rights.outcome}`);
    for (const r of rights.results) console.log(`  decision=${r.decision} reason=${r.reason}`);
    const after = storage.get('SELECT verification_status FROM assets WHERE id = ?', [a.id]);
    const v = storage.get('SELECT policy_id, policy_version, decision FROM asset_verifications WHERE asset_id = ?', [a.id]);
    console.log(`verification_status after rights: ${after.verification_status}`);
    console.log(`asset_verifications row: ${JSON.stringify(v)}`);
    const pubs = storage.get('SELECT COUNT(*) AS n FROM publications').n;
    console.log(`publications rows: ${pubs}`);

    const accepted = after.verification_status === 'VERIFIED' && pubs === 0 && v?.decision === 'VERIFIED';
    console.log(`Accepted for production: ${accepted}`);
    if (!accepted) { process.exitCode = 1; return; }
    console.log('\nSuccess: one real Pixabay asset crossed the real asset -> rights boundary.');
  } finally {
    storage.close();
    fs.rmSync(dir, { recursive: true, force: true });
    console.log('Disposable dir removed.');
  }
}

main();
