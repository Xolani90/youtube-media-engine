// Manual, opt-in, one-shot script. NOT part of `npm test`, NOT run at
// startup, NOT part of the autonomous runner. Makes REAL network, LLM
// (cost-bearing) and Pixabay calls.
//
// Purpose: prove the canonical entrypoint -- runAutonomousEntrypoint() in
// src/index.js, unmodified and with no stage substituted -- can take a
// BRAND-NEW empty SQLite DB through real Discovery -> Research -> Brief ->
// Script -> Fact-Check -> Originality -> Quality Gate -> Production ->
// Asset Provisioning (real Pixabay) -> Rights Verification -> Media
// Production (real espeak-ng/ffmpeg/ffprobe). Nothing is seeded.
//
// Publication: the run is forced to mode SIMULATION and the script refuses
// to start unless config/authorized_external_actions.json authorizes
// nothing. The real Publication stage still runs and is expected to refuse
// (Gate 2 / authorization); publications must end at 0.
//
// Usage:
//   node scripts/prove-fresh-autonomous-to-media.js
//
// Required environment (values are never printed):
//   RSS_FEED_URLS, PIXABAY_API_KEY, and the LLM key for the configured
//   LLM_PROVIDER_PRIORITY (default `gemini-free` -> GEMINI_FREE_API_KEY).
//   TAVILY_API_KEY is optional (Research falls back to Google News RSS).
//
// Exit codes: 0 = whole chain proven; 1 = chain did not reach/finish media
// production or an assertion failed; 2 = missing prerequisite (no run made).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Safety: must be set BEFORE src/config is first imported.
process.env.RUN_MODE = 'SIMULATION';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SECRET_ENV = ['PIXABAY_API_KEY', 'GEMINI_FREE_API_KEY', 'GEMINI_API_KEY', 'TAVILY_API_KEY', 'GROQ_FREE_API_KEY', 'TEST_PAID_GEMINI_API_KEY'];

function redact(s) {
  let out = String(s);
  for (const k of SECRET_ENV) {
    const v = process.env[k];
    if (v && v.length >= 6) out = out.split(v).join('[REDACTED]');
  }
  return out;
}
const log = (...a) => console.log(redact(a.join(' ')));
const err = (...a) => console.error(redact(a.join(' ')));

function toolVersion(cmd, arg) {
  const r = spawnSync(cmd, [arg], { encoding: 'utf8' });
  return r.error || r.status !== 0 ? null : (r.stdout || '').split('\n')[0].trim();
}
const sha256File = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

const SEED_TABLES = ['opportunities', 'research_projects', 'claims', 'content_briefs', 'scripts', 'content_versions', 'productions', 'assets'];

function count(storage, table) {
  return storage.get(`SELECT COUNT(*) AS n FROM ${table}`).n;
}
function histogram(storage, table) {
  const cols = storage.all(`PRAGMA table_info(${table})`).map((c) => c.name);
  const col = ['status', 'decision', 'outcome', 'state', 'evidence_status'].find((c) => cols.includes(c));
  if (!col) return `${count(storage, table)} rows`;
  const rows = storage.all(`SELECT ${col} AS k, COUNT(*) AS n FROM ${table} GROUP BY ${col}`);
  return `${count(storage, table)} rows; ${col}: ${rows.map((r) => `${r.k}=${r.n}`).join(', ') || 'none'}`;
}

async function main() {
  // ---------------------------------------------------------- prerequisites
  const tools = { 'espeak-ng': toolVersion('espeak-ng', '--version'), ffmpeg: toolVersion('ffmpeg', '-version'), ffprobe: toolVersion('ffprobe', '-version') };
  const { config } = await import('../src/config/index.js');
  const priority = config.llmProviderPriority;
  const llmKeyVars = { 'gemini-free': 'GEMINI_FREE_API_KEY' };
  const missing = [];
  for (const [t, v] of Object.entries(tools)) { log(`${t}: ${v ?? 'MISSING'}`); if (!v) missing.push(t); }
  log(`LLM_PROVIDER_PRIORITY (effective): ${priority.join(',')}`);
  for (const p of priority) {
    const v = llmKeyVars[p];
    if (v) { const set = Boolean(process.env[v]); log(`${v}=${set ? 'SET' : 'UNSET'}`); if (!set) missing.push(v); }
    else log(`(no key check implemented for provider "${p}" -- verify its credential yourself)`);
  }
  for (const v of ['PIXABAY_API_KEY', 'RSS_FEED_URLS']) {
    const set = Boolean(process.env[v]); log(`${v}=${set ? 'SET' : 'UNSET'}`); if (!set) missing.push(v);
  }
  log(`TAVILY_API_KEY=${process.env.TAVILY_API_KEY ? 'SET' : 'UNSET (optional)'}`);
  if (!config.opportunityProviderPriority.includes('rss')) missing.push('OPPORTUNITY_PROVIDER_PRIORITY must include rss');

  // Publication safety: refuse unless nothing is externally authorized.
  const authPath = path.join(REPO_ROOT, 'config', 'authorized_external_actions.json');
  let auth = null;
  try { auth = JSON.parse(fs.readFileSync(authPath, 'utf8')); } catch { /* handled below */ }
  if (!Array.isArray(auth) || auth.length !== 0) missing.push('config/authorized_external_actions.json must be an empty array for this run');
  if (config.runMode !== 'SIMULATION') missing.push(`effective run mode is ${config.runMode}, must be SIMULATION`);
  log(`run mode forced: SIMULATION   authorized external actions: ${Array.isArray(auth) ? auth.length : 'UNREADABLE'}`);

  if (missing.length) {
    err(`PREREQUISITE MISSING: ${missing.join('; ')} -- no run made, no boundary claim.`);
    process.exitCode = 2;
    return;
  }

  // ------------------------------------------------------------- fresh DB
  const { SqliteStorageDriver } = await import('../src/storage/SqliteStorageDriver.js');
  const { PixabayAssetSourceProvider } = await import('../src/providers/asset/PixabayAssetSourceProvider.js');
  const { runAutonomousEntrypoint } = await import('../src/index.js');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-fresh-chain-'));
  const dirs = { assets: path.join(dir, 'assets'), production: path.join(dir, 'production'), media: path.join(dir, 'media') };
  const storage = new SqliteStorageDriver({ dbPath: path.join(dir, 'fresh.db') });
  const checks = [];
  const check = (name, ok, detail = '') => { checks.push({ name, ok }); log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` -- ${detail}` : ''}`); };

  try {
    await storage.migrate();
    log('\n== Freshness proof (before run) ==');
    const before = Object.fromEntries(SEED_TABLES.map((t) => [t, count(storage, t)]));
    for (const t of SEED_TABLES) log(`  ${t}: ${before[t]}`);
    check('disposable DB starts with zero content rows', SEED_TABLES.every((t) => before[t] === 0));
    if (!SEED_TABLES.every((t) => before[t] === 0)) { process.exitCode = 1; return; }

    // ------------------------------------------------ the real entrypoint
    log('\n== Running REAL runAutonomousEntrypoint() (live network + LLM) ==');
    let result = null;
    let runError = null;
    const t0 = Date.now();
    try {
      result = await runAutonomousEntrypoint({
        storage,
        mode: 'SIMULATION',
        // Same real provider class the entrypoint defaults to; only the
        // download directory is redirected to the disposable temp dir.
        assetProvisioning: { provider: new PixabayAssetSourceProvider({ downloadDir: dirs.assets }) },
        production: { artifactsDir: dirs.production },
        media: { artifactsDir: dirs.media }
      });
    } catch (e) {
      runError = e;
    }
    log(`entrypoint finished in ${Math.round((Date.now() - t0) / 1000)}s`);
    if (runError) err(`entrypoint THREW: ${runError.message}`);
    if (result?.refused) err(`entrypoint REFUSED: ${result.reason}`);

    // ------------------------------------------------------ stage evidence
    log('\n== Stage results ==');
    const d = result?.discovery;
    log(`Discovery: ${d ? `stats=${JSON.stringify(d.stats ?? {})} feedFailures=${d.failures?.length ?? 0}` : 'no result'}; opportunities=${count(storage, 'opportunities')}`);
    const runner = result?.runner;
    if (runner) {
      log(`Runner: sweeps=${runner.sweeps} stopReason=${runner.stopReason} status=${runner.status ?? 'n/a'}`);
      for (const p of runner.processed ?? []) log(`  ${p.stage}: invoked ${p.count}x`);
    }
    const tableFor = { Research: 'research_projects', Brief: 'content_briefs', Script: 'scripts', 'Fact-Check': 'fact_checks', Originality: 'originality_checks', 'Quality Gate': 'content_versions', Production: 'productions', 'Asset Provisioning': 'assets', 'Rights Verification': 'asset_verifications', 'Media Production': 'media_artifacts', Publication: 'publications' };
    for (const [stage, table] of Object.entries(tableFor)) {
      try { log(`${stage} (${table}): ${histogram(storage, table)}`); } catch (e) { log(`${stage} (${table}): unreadable (${e.message})`); }
    }
    for (const t of ['gate', 'risk_assessments']) { try { log(`Final Compliance / gates (${t}): ${histogram(storage, t)}`); } catch { /* table optional */ } }

    log('\n== Research evidence ==');
    for (const rp of storage.all('SELECT * FROM research_projects')) {
      log(`  project=${rp.id} status=${rp.status} stop_reason=${rp.stop_reason ?? 'null'}`);
    }
    const claimsTotal = count(storage, 'claims');
    const loadBearing = storage.get('SELECT COUNT(*) AS n FROM claims WHERE is_load_bearing = 1').n;
    const verified = storage.get(`SELECT COUNT(*) AS n FROM claims WHERE evidence_status = 'VERIFIED'`).n;
    const lbVerified = storage.get(`SELECT COUNT(*) AS n FROM claims WHERE is_load_bearing = 1 AND evidence_status = 'VERIFIED'`).n;
    log(`  claims=${claimsTotal} load_bearing=${loadBearing} VERIFIED=${verified} load_bearing_VERIFIED=${lbVerified}`);

    log('\n== Script evidence ==');
    for (const s of storage.all('SELECT id, version, LENGTH(body) AS body_chars FROM scripts')) log(`  script=${s.id} version=${s.version} body_chars=${s.body_chars}`);
    log(`  content_versions: ${histogram(storage, 'content_versions')}`);

    log('\n== Downstream stage diagnostics (decision_log) ==');
    try {
      for (const b of storage.all('SELECT id, LENGTH(visual_ideas) AS n, SUBSTR(visual_ideas, 1, 120) AS preview FROM content_briefs')) {
        log(`  brief=${b.id} visual_ideas_chars=${b.n} preview="${String(b.preview).replace(/\s+/g, ' ')}"`);
      }
      const rows = storage.all(`SELECT stage, decision, reason, created_at FROM decision_log WHERE stage IN ('ASSET_PROVISIONING','RIGHTS_VERIFICATION','MEDIA_PRODUCTION','PRODUCTION') ORDER BY created_at`);
      if (!rows.length) log('  (no decision_log rows for those stage names)');
      for (const r of rows) log(`  ${r.stage}: ${r.decision} -- ${String(r.reason ?? '').slice(0, 200)}`);
    } catch (e) { log(`  diagnostics unavailable: ${e.message}`); }

    // ----------------------------------------------- anti-seeding proof
    log('\n== Freshness proof (after run: created by the pipeline) ==');
    const after = Object.fromEntries(SEED_TABLES.map((t) => [t, count(storage, t)]));
    for (const t of SEED_TABLES) log(`  ${t}: ${before[t]} -> ${after[t]}`);
    log('  (the harness contains no INSERT statements against the DB)');

    // ----------------------------------------------------- media evidence
    log('\n== Real media evidence ==');
    const art = storage.get('SELECT * FROM media_artifacts ORDER BY created_at LIMIT 1');
    if (art) {
      const usages = storage.all('SELECT asset_id FROM asset_usages WHERE content_version_id = ?', [art.content_version_id]).map((r) => r.asset_id);
      const asset = usages.length ? storage.get('SELECT * FROM assets WHERE id = ?', [usages[0]]) : null;
      const rights = asset ? storage.get('SELECT policy_id, policy_version, decision, reason FROM asset_verifications WHERE asset_id = ?', [asset.id]) : null;
      log(`  provider origin=${asset?.origin} license=${asset?.license}`);
      log(`  asset type=${asset?.asset_type} path=${asset?.location}`);
      const diskSha = asset && fs.existsSync(asset.location) ? sha256File(asset.location) : null;
      log(`  asset checksum recorded=${asset?.checksum} disk=${diskSha}`);
      log(`  rights: ${JSON.stringify(rights)} final verification_status=${asset?.verification_status}`);
      const exists = fs.existsSync(art.artifact_path);
      const size = exists ? fs.statSync(art.artifact_path).size : 0;
      const artSha = exists ? sha256File(art.artifact_path) : null;
      log(`  artifact path=${art.artifact_path} exists=${exists} size=${size}`);
      log(`  artifact checksum recorded=${art.artifact_checksum} disk=${artSha}`);
      log(`  narration tool=espeak-ng duration=${art.narration_duration_seconds}s`);
      let probeOk = false; let streams = [];
      try {
        const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', art.artifact_path]).toString());
        streams = probe.streams.map((s) => `${s.codec_type}:${s.codec_name}${s.width ? `@${s.width}x${s.height}` : ''}`);
        probeOk = streams.some((s) => s.startsWith('video:')) && streams.some((s) => s.startsWith('audio:'));
        log(`  ffprobe=SUCCESS duration=${probe.format.duration}s streams=[${streams.join(', ')}]`);
      } catch (e) { log(`  ffprobe=FAILED (${e.message.split('\n')[0]})`); }
      const specText = JSON.stringify(JSON.parse(art.render_spec_json));
      const pubs = count(storage, 'publications');
      log(`  publications=${pubs}`);

      log('\n== Assertions ==');
      check('pipeline created rows in every seeded-table (none were pre-seeded)', SEED_TABLES.every((t) => after[t] > 0));
      check('asset was downloaded into the disposable assets dir', Boolean(asset) && path.resolve(asset.location).startsWith(path.resolve(dirs.assets)));
      check('asset origin is pixabay.com', Boolean(asset?.origin?.startsWith('https://pixabay.com/')));
      check('asset checksum on disk matches the recorded checksum', Boolean(diskSha) && diskSha === asset?.checksum);
      check('rights decision VERIFIED and asset status VERIFIED', rights?.decision === 'VERIFIED' && asset?.verification_status === 'VERIFIED');
      check('media artifact render spec references that same asset id and location', Boolean(asset) && specText.includes(asset.id) && specText.includes(JSON.stringify(asset.location).slice(1, -1)));
      check('artifact exists, non-empty, checksum matches record', exists && size > 0 && artSha === art.artifact_checksum);
      check('ffprobe sees a video and an audio stream', probeOk);
      check('publications = 0', pubs === 0);
    } else {
      log('  no media_artifacts row: the chain did NOT reach a rendered artifact.');
      check('media artifact produced', false);
    }
    if (runError) check('entrypoint completed without throwing', false, runError.message);

    const allOk = checks.length > 0 && checks.every((c) => c.ok);
    log(`\n${allOk ? 'RESULT: fresh autonomous run -> real media artifact PROVEN' : 'RESULT: NOT PROVEN (see FAIL lines / stage results above for the bottleneck)'}`);
    if (!allOk) process.exitCode = 1;
  } finally {
    try { storage.close(); } catch { /* ignore */ }
    if (process.env.KEEP_TMP === '1') {
      log(`KEEP_TMP=1: disposable dir KEPT for inspection: ${dir} (delete it yourself afterwards)`);
    } else {
      fs.rmSync(dir, { recursive: true, force: true });
      log('Disposable dir removed.');
    }
  }
}

main().catch((e) => { err(`UNEXPECTED: ${e.message}`); process.exitCode = 1; });
