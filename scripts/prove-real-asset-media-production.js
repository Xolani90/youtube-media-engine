// Manual, opt-in, one-shot script. NOT part of `npm test`, NOT run at
// startup, NOT part of the autonomous runner.
//
// Purpose: prove that ONE real Pixabay asset, acquired by the real
// PixabayAssetSourceProvider, persisted by the real Asset Provisioning
// pipeline and judged VERIFIED by the real Rights Verification pipeline,
// crosses the real Media Production gate and is rendered into a real,
// ffprobe-validated .mp4. Disposable SQLite DB + asset/artifact dirs under
// os.tmpdir(), removed on exit. No publication.
//
// Usage:
//   PIXABAY_API_KEY=... node scripts/prove-real-asset-media-production.js ["search query"]
//
// Narration: the REAL `espeak-ng` is required. If it is not on PATH the
// script stops with exit code 2 and reports it as the environmental
// blocker -- it never substitutes a stand-in narrator, so a pass here
// always means genuine narration. (The POSIX stand-in used by the
// rehearsal tests is deliberately NOT used.)
//
// Exit codes: 0 = full boundary proven; 1 = engine/boundary failure;
// 2 = missing prerequisite (key / espeak-ng / ffmpeg / ffprobe).
// The API key is never printed.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync, execFileSync } from 'node:child_process';
import { SqliteStorageDriver } from '../src/storage/SqliteStorageDriver.js';
import { PixabayAssetSourceProvider } from '../src/providers/asset/PixabayAssetSourceProvider.js';
import { runAssetProvisioning } from '../src/asset-provisioning/pipeline.js';
import { runRightsVerification } from '../src/rights-verification/pipeline.js';
import { runMediaProduction } from '../src/media/pipeline.js';

const NARRATION_PROSE = [
  'This is a short rehearsal narration for the media production boundary.',
  'It exists only to prove that a genuinely acquired, rights verified image can be rendered into a real video.',
  'Nothing here is published.'
].join(' ');

function tool(cmd) {
  const r = spawnSync(cmd, [cmd === 'espeak-ng' ? '--version' : '-version'], { encoding: 'utf8' });
  if (r.error || r.status !== 0) return null;
  return (r.stdout || '').split('\n')[0].trim();
}

function sha256File(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

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
  // Plain prose body: the documented "already-rendered prose" path of
  // scriptBodyToNarrationText (src/media/scriptText.js).
  storage.run(`INSERT INTO scripts (id, content_brief_id, version, body, claim_links, created_at) VALUES (?, ?, 1, ?, '[]', ?)`, [scriptId, briefId, NARRATION_PROSE, now]);
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
  const espeak = tool('espeak-ng');
  const ffmpeg = tool('ffmpeg');
  const ffprobe = tool('ffprobe');
  console.log(`espeak-ng: ${espeak ?? 'MISSING'}`);
  console.log(`ffmpeg:    ${ffmpeg ?? 'MISSING'}`);
  console.log(`ffprobe:   ${ffprobe ?? 'MISSING'}`);
  if (!process.env.PIXABAY_API_KEY) console.error('PIXABAY_API_KEY is not set.');
  if (!process.env.PIXABAY_API_KEY || !espeak || !ffmpeg || !ffprobe) {
    console.error('PREREQUISITE MISSING -- no live call made, no boundary claim.');
    process.exitCode = 2;
    return;
  }

  const query = process.argv[2] ?? 'mountain landscape';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-live-media-'));
  const storage = new SqliteStorageDriver({ dbPath: path.join(dir, 'disposable.db') });
  const fail = (msg) => { console.error(`FAIL: ${msg}`); process.exitCode = 1; };
  try {
    await storage.migrate();
    const { briefId, cvId } = seedProduced(storage, query);
    const provider = new PixabayAssetSourceProvider({ downloadDir: path.join(dir, 'assets') });
    console.log(`Provider: ${provider.id}   Query: "${query}"`);

    const prov = await runAssetProvisioning({ storage, contentBriefId: briefId, provider });
    console.log(`Asset Provisioning = ${prov.outcome}`);
    if (prov.outcome !== 'PROVISIONED') return fail(`provisioning: ${prov.reason ?? prov.failureKind ?? 'no reason'}`);

    const a = storage.get('SELECT * FROM assets WHERE id = ?', [prov.asset.id]);
    const actualSha = fs.existsSync(a.location) ? sha256File(a.location) : null;
    console.log(`  asset id=${a.id} type=${a.asset_type}`);
    console.log(`  local path=${a.location}`);
    console.log(`  checksum(recorded)=${a.checksum}`);
    console.log(`  checksum(on disk) =${actualSha}`);
    console.log(`  origin=${a.origin}  license=${a.license}`);
    if (!actualSha || actualSha !== a.checksum) return fail('recorded checksum does not match bytes on disk');

    const rights = runRightsVerification({ storage, contentBriefId: briefId });
    const afterRights = storage.get('SELECT verification_status FROM assets WHERE id = ?', [a.id]);
    const v = storage.get('SELECT policy_id, policy_version, decision, reason FROM asset_verifications WHERE asset_id = ?', [a.id]);
    console.log(`Rights Verification = ${afterRights.verification_status} (pipeline outcome ${rights.outcome})`);
    console.log(`  asset_verifications: ${JSON.stringify(v)}`);
    if (afterRights.verification_status !== 'VERIFIED' || v?.decision !== 'VERIFIED') return fail('asset not VERIFIED');

    // The exact persisted, verified asset must be the one attached to this content_version.
    const attached = storage.all('SELECT asset_id FROM asset_usages WHERE content_version_id = ?', [cvId]).map((r) => r.asset_id);
    if (attached.length !== 1 || attached[0] !== a.id) return fail(`asset_usages does not point at the verified asset (${JSON.stringify(attached)})`);

    const artifactsDir = path.join(dir, 'media');
    const media = runMediaProduction({ storage, contentBriefId: briefId, artifactsDir });
    console.log(`Media Production outcome = ${media.outcome}${media.reason ? ` (${media.reason})` : ''}`);
    if (media.outcome !== 'RENDERED') return fail('media production did not render');

    const art = storage.get('SELECT * FROM media_artifacts WHERE content_version_id = ?', [cvId]);
    const spec = JSON.parse(art.render_spec_json);
    const specText = JSON.stringify(spec);
    if (!specText.includes(a.id) || !specText.includes(JSON.stringify(a.location).slice(1, -1))) {
      return fail('render spec does not reference the verified asset id/location');
    }
    const exists = fs.existsSync(art.artifact_path);
    const size = exists ? fs.statSync(art.artifact_path).size : 0;
    const diskSha = exists ? sha256File(art.artifact_path) : null;
    console.log(`Artifact path=${art.artifact_path}`);
    console.log(`Artifact exists=${exists} size=${size} sha256(recorded)=${art.artifact_checksum} sha256(disk)=${diskSha}`);
    console.log(`Narration: tool=espeak-ng path=${art.narration_path} duration=${art.narration_duration_seconds}s`);

    const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', art.artifact_path]).toString());
    const streams = probe.streams.map((s) => `${s.codec_type}:${s.codec_name}${s.width ? `@${s.width}x${s.height}` : ''}`);
    console.log(`ffprobe = SUCCESS  duration=${probe.format.duration}s streams=[${streams.join(', ')}]`);

    const pubs = storage.get('SELECT COUNT(*) AS n FROM publications').n;
    console.log(`Publication rows = ${pubs}`);

    const ok = exists && size > 0 && diskSha === art.artifact_checksum && probe.streams.length >= 2 && pubs === 0;
    if (!ok) return fail('artifact/ffprobe/publication assertions did not all hold');
    console.log('\nPixabay acquisition = SUCCESS\nAsset Provisioning = PROVISIONED\nRights Verification = VERIFIED\nMedia Production = PRODUCED\nArtifact exists = TRUE\nArtifact size > 0\nffprobe = SUCCESS\nPublication rows = 0');
  } finally {
    storage.close();
    fs.rmSync(dir, { recursive: true, force: true });
    console.log('Disposable dir removed.');
  }
}

main();
