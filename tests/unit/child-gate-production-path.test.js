// NEW (scratch-only) regression test: drives the REAL production path
//   runAssetProvisioning -> planScenes -> buildHitScreen -> PixabayAssetSourceProvider (real class, fake fetch) -> DB
// with fixture Pixabay responses. No network, no credentials; temp dirs and a temp SQLite file only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { SqliteStorageDriver } from '../../src/storage/SqliteStorageDriver.js';
import { runAssetProvisioning } from '../../src/asset-provisioning/pipeline.js';
import { PixabayAssetSourceProvider } from '../../src/providers/asset/PixabayAssetSourceProvider.js';

const now = () => new Date().toISOString();
const PRO_SCRIPT = [
  'AI training helps professional teams build skills faster. A structured workshop keeps every session practical.',
  'OpenAI partnerships give business leaders access to tested tools. Managers compare vendors on a laptop before they commit.',
  'Modern office teams review results together. A shared dashboard shows which training modules actually work.',
  'Start with one workflow and measure the time saved. Then expand the programme to other departments.'
].join(' ');
const PRO_IDEAS = 'ai training workshop, openai partnership meeting, laptop, modern office';
const CHILD_SCRIPT = [
  'Children learn to read with simple picture books. A calm classroom helps kids focus on each page.',
  'Teachers read aloud while the children follow along. Small groups of kids practise new words together.',
  'Parents can repeat the same stories at home. Short daily sessions build confidence quickly.'
].join(' ');
const CHILD_IDEAS = 'children reading, kids classroom, picture books';

const ELIGIBLE = 'ai, training, workshop, laptop, office, business, team, professional';
const CHILD_TAGS = `${ELIGIBLE}, baby`;
const hit = (id, tags) => ({ id, tags, pageURL: `https://pixabay.com/p/${id}`, user: 'u', largeImageURL: `https://cdn.test/${id}.jpg`, webformatURL: `https://cdn.test/${id}.jpg` });

/** Fixture Pixabay: hitsFor(searchIndex, query) -> hits. Records every search query and every download URL. */
function fixtureFetch(hitsFor) {
  const searches = [];
  const downloads = [];
  const impl = async (url) => {
    const u = String(url);
    if (u.includes('pixabay.com/api')) {
      const q = new URL(u).searchParams.get('q');
      searches.push(q);
      return { ok: true, status: 200, json: async () => ({ hits: hitsFor(searches.length, q) }) };
    }
    downloads.push(u);
    return { ok: true, status: 200, arrayBuffer: async () => Buffer.from(`bytes-${u}`) };
  };
  return { impl, searches, downloads };
}

async function runScenario({ script, ideas, hitsFor, gate }) {
  const prev = process.env.SCENE_CANDIDATE_GATE;
  if (gate === undefined) delete process.env.SCENE_CANDIDATE_GATE; else process.env.SCENE_CANDIDATE_GATE = gate;
  const dbPath = path.join(os.tmpdir(), `child-gate-${Date.now()}-${Math.random()}.db`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'child-gate-dl-'));
  const storage = new SqliteStorageDriver({ dbPath });
  try {
    await storage.migrate();
    const opp = crypto.randomUUID(), brief = crypto.randomUUID(), scr = crypto.randomUUID(), cv = crypto.randomUUID();
    storage.run(`INSERT INTO opportunities (id, title, source, discovered_at, status) VALUES (?, 'T', 'rss', ?, 'DISCOVERED')`, [opp, now()]);
    storage.run(`INSERT INTO content_briefs (id, opportunity_id, working_title, core_question, target_audience, viewer_promise, hook, angle, narrative_structure, key_claims, counterpoints, original_insights, visual_ideas, monetization_opportunities, risk_assessment, created_at)
      VALUES (?, ?, 'T', 'Q', 'A', 'P', 'H', 'Angle', 'S', '[]', 'C', 'I', ?, 'M', 'R', ?)`, [brief, opp, ideas, now()]);
    storage.run(`INSERT INTO scripts (id, content_brief_id, version, body, claim_links, created_at) VALUES (?, ?, 1, ?, '[]', ?)`, [scr, brief, script, now()]);
    storage.run(`INSERT INTO content_versions (id, content_brief_id, script_id, state, created_at) VALUES (?, ?, ?, 'PRODUCED', ?)`, [cv, brief, scr, now()]);
    storage.run(`INSERT INTO productions (id, content_version_id, script_id, artifact_type, artifact_path, artifact_checksum, manifest_json, created_at) VALUES (?, ?, ?, 'production_manifest_v1', '/tmp/m.json', 'dead', '{}', ?)`, [crypto.randomUUID(), cv, scr, now()]);
    const f = fixtureFetch(hitsFor);
    const provider = new PixabayAssetSourceProvider({ fetchImpl: f.impl, apiKeyProvider: () => 'fixture-key', downloadDir: dir });
    const result = await runAssetProvisioning({ storage, contentBriefId: brief, provider, multiScene: true });
    return {
      result, searches: f.searches, downloads: f.downloads,
      assets: storage.all('SELECT origin, provenance_notes FROM assets ORDER BY rowid'),
      decisions: storage.all('SELECT decision, reason FROM decision_log')
    };
  } finally {
    storage.close();
    for (const s of ['', '-wal', '-shm']) fs.rmSync(`${dbPath}${s}`, { force: true });
    fs.rmSync(dir, { recursive: true, force: true });
    if (prev === undefined) delete process.env.SCENE_CANDIDATE_GATE; else process.env.SCENE_CANDIDATE_GATE = prev;
  }
}

// every search: a child-tagged hit ranked FIRST, a distinct eligible hit second
const childFirst = (n) => [hit(`kid-${n}`, CHILD_TAGS), hit(`ok-${n}`, ELIGIBLE)];

test('production path: unrelated professional scenes reject the child-tagged top hit, download and persist only the eligible one, keep provenance', async () => {
  const r = await runScenario({ script: PRO_SCRIPT, ideas: PRO_IDEAS, hitsFor: childFirst });
  assert.equal(r.result.outcome, 'PROVISIONED');
  const planned = r.result.sceneReport.planned_scenes;
  assert.ok(planned >= 2, `multi-scene plan expected, got ${planned}`);
  assert.equal(r.result.sceneReport.accepted_assets, planned, 'every scene filled by the eligible alternative');
  assert.equal(r.downloads.filter((u) => u.includes('/kid-')).length, 0, 'child-tagged candidate was never downloaded');
  assert.ok(r.downloads.length === planned && r.downloads.every((u) => u.includes('/ok-')), 'exactly one eligible download per scene');
  assert.ok(r.assets.every((a) => /pixabay\.com\/p\/ok-/.test(a.origin)), 'no child-tagged asset persisted');
  for (const a of r.assets) assert.match(a.provenance_notes, /screenRejected=kid-\d+:child_subject_tag:baby/, 'rejection provenance preserved on every accepted asset');
});

test('production path: gate on, NO eligible alternative -> scene 1 fails with the existing EMPTY_RESULT outcome; nothing downloaded or persisted', async () => {
  const r = await runScenario({ script: PRO_SCRIPT, ideas: PRO_IDEAS, hitsFor: (n) => [hit(`kid-${n}`, CHILD_TAGS), hit(`kid-b-${n}`, 'ai, training, toddler, laptop')] });
  assert.equal(r.result.outcome, 'NO_ASSET_ACQUIRED');
  assert.equal(r.downloads.length, 0);
  assert.equal(r.assets.length, 0);
  assert.ok(r.decisions.some((d) => d.reason === 'provider_failure_EMPTY_RESULT'), JSON.stringify(r.decisions));
});

test('production path: scene 1 eligible, later scenes only child-tagged -> later scenes skipped (provider_failure_EMPTY_RESULT), scene 1 intact', async () => {
  const r = await runScenario({ script: PRO_SCRIPT, ideas: PRO_IDEAS, hitsFor: (n) => (n === 1 ? [hit('ok-1', ELIGIBLE)] : [hit(`kid-${n}`, CHILD_TAGS)]) });
  assert.equal(r.result.outcome, 'PROVISIONED');
  const rep = r.result.sceneReport;
  assert.equal(rep.accepted_assets, 1);
  assert.equal(r.downloads.length, 1);
  assert.ok(r.downloads[0].includes('/ok-1'));
  const skippedReasons = r.decisions.filter((d) => d.decision === 'SCENE_ASSET_SKIPPED').map((d) => d.reason);
  assert.equal(skippedReasons.length, rep.planned_scenes - 1);
  assert.ok(skippedReasons.every((x) => /_provider_failure_EMPTY_RESULT$/.test(x)), skippedReasons.join(','));
});

test('production path: SCENE_CANDIDATE_GATE=off restores the legacy behaviour (top hit used, child asset accepted, no screen provenance)', async () => {
  const r = await runScenario({ script: PRO_SCRIPT, ideas: PRO_IDEAS, hitsFor: childFirst, gate: 'off' });
  assert.equal(r.result.outcome, 'PROVISIONED');
  assert.ok(r.downloads.length >= 1 && r.downloads.every((u) => u.includes('/kid-')), 'gate off: only top hits (child-tagged) downloaded');
  assert.ok(r.assets.every((a) => !/screenRejected/.test(a.provenance_notes ?? '')));
});

test('production path: affirmative child-focused scenes may still select a child-tagged top hit (gate on)', async () => {
  const r = await runScenario({ script: CHILD_SCRIPT, ideas: CHILD_IDEAS, hitsFor: (n) => [hit(`kid-${n}`, 'children, reading, books, classroom, baby'), hit(`ok-${n}`, 'reading, books, classroom')] });
  assert.equal(r.result.outcome, 'PROVISIONED');
  assert.ok(/pixabay\.com\/p\/kid-/.test(r.assets[0].origin), `child-focused scene 1 should accept the child-tagged hit, got ${r.assets[0].origin}`);
});
