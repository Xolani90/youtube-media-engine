import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { planScenes, tokens, isHeading } from '../../src/asset-provisioning/scenePlan.js';
import { SqliteStorageDriver } from '../../src/storage/SqliteStorageDriver.js';
import { runAssetProvisioning } from '../../src/asset-provisioning/pipeline.js';
import { AssetSourceProvider } from '../../src/providers/asset/AssetSourceProvider.js';

// Deterministic fixture: the 12-scene script behind the 2026-10-21 Pixabay run (rebuilt from the logged scene
// texts) with the same five curated visual ideas. No network, no provider quota.
const SCRIPT = "While millions of small-firm employees worldwide are already experimenting with AI tools, local businesses now have access to structured, hands-on guidance to bridge the gap between curiosity and daily execution. Across the globe, small-firm employees are increasingly turning to artificial intelligence in their day-to-day work. To support this wave of adoption and help lean teams navigate new technology safely, a major new partnership has formed between OpenAI and America's Small Business Development Center network. Through this initiative, advisors receive specialized training, and local in-person workshops are being established to provide direct guidance. Furthermore, participants gain free access to advanced capabilities like ChatGPT Plus to support hands-on learning, while long-term sector-specific resource development is planned to ensure continued growth. Global Adoption Trends. A new report titled Small Businesses, Bigger Capabilities indicates that in just one recent week, from September 9-15, around 4 million small-firm employees worldwide used OpenAI's tools. The New SBDC Partnership. OpenAI announced on September 30, 2026, a new partnership with America's Small Business Development Center network, aiming to provide hands-on artificial intelligence training and localized guidance for small businesses across the United States. Advisor Training and Workshops. OpenAI plans to train approximately 150 SBDC advisors through its OpenAI Academy's Community Trainer Program. Hands-On Access. Advisors and clients who complete the in-person workshops will receive free access to ChatGPT Plus. Long-Term Resource Development. Beyond the initial rollout, the two organizations will co-develop playbooks and sector-specific resources designed to help the SBDC network scale AI training well beyond the pilot's initial states. While structured training initiatives offer valuable guidance, small businesses may still face hurdles such as limited time for staff participation, varying technological baselines among lean teams, and the ongoing need to ensure data privacy and tool reliability in fast-paced operational environments. By combining national technological resources with trusted local networks like the SBDC, small businesses gain a practical pathway to integrate artificial intelligence safely, effectively, and with hands-on support.";
const IDEAS = 'small business owner, laptop, coffee shop, local storefront, entrepreneur';

// Queries the pre-fix planner sent for scenes 6-12 and the images they returned (padlock, baseball base, Ouija board...).
const OLD_JUNK = ['small business owner access', 'development resource', 'small business owner beyond',
  'small business owner baseline', 'baseline businesse', 'small business owner artificial', 'artificial businesse'];

const plan = () => planScenes({ visualIdeas: IDEAS, scriptBody: SCRIPT, fallbackQuery: IDEAS });
const specific = (scene) => scene.queries.slice(0, -1);
const sceneWith = (p, fragment) => p.find((s) => s.text.includes(fragment));

test('stemming: plural folding no longer produces businesse/classe/glasse and leaves -is/-us/-ss words alone', () => {
  assert.deepEqual(tokens('businesses classes glasses'), ['business', 'class', 'glass']);
  assert.deepEqual(tokens('analysis campus address'), ['analysis', 'campus', 'address']);
  assert.deepEqual(tokens('policies workshops tools'), ['policy', 'workshop', 'tool']);
  assert.ok(tokens('Small businesses').includes('business'));
  assert.ok(tokens('business').includes('business'), 'singular and plural now meet');
});

test('headings: Title Case labels are detected, ordinary sentences are not', () => {
  for (const h of ['Advisor Training and Workshops.', 'Hands-On Access.', 'Long-Term Resource Development.', 'The New SBDC Partnership.']) {
    assert.equal(isHeading(h), true, h);
  }
  for (const s of ['Hands-on training starts in November.', 'Why does this matter?', 'Advisors, clients and staff attend.', 'Wow.',
    'Fresh coffee beans darken as they roast in the drum.']) {
    assert.equal(isHeading(s), false, s);
  }
});

test('short headings fold into the sentence they introduce: no heading-only scene', () => {
  const p = plan();
  for (const s of p) assert.ok(!isHeading(s.text), `heading-only scene: ${s.text}`);
  assert.ok(sceneWith(p, 'Advisor Training and Workshops.').text.includes('OpenAI plans to train'));
  assert.ok(sceneWith(p, 'Long-Term Resource Development.').text.includes('Beyond the initial rollout'));
  const shortest = Math.min(...p.map((s) => s.span.end - s.span.start));
  assert.ok(shortest > 0.04, `no ~1% scenes (shortest ${shortest})`);
});

test('a trailing heading folds backwards instead of becoming its own scene', () => {
  const p = planScenes({ visualIdeas: '', scriptBody: 'Advisors receive training in a workshop. Teams share a playbook. Next Steps.' });
  assert.ok(p.length >= 2);
  assert.ok(p.at(-1).text.endsWith('Next Steps.'));
  assert.ok(p.every((s) => !isHeading(s.text)));
});

test('more scenes than curated ideas: all 12 scenes get scene-specific queries, whole-video query stays last', () => {
  const p = plan();
  assert.equal(p.length, 12);
  for (const s of p) {
    assert.ok(specific(s).length >= 1, `scene ${s.index + 1} has no scene-specific query`);
    assert.equal(s.queries.at(-1), IDEAS, 'whole-video query is the unchanged last resort');
    assert.ok(s.queries.length <= 4);
    assert.equal(new Set(s.queries.map((q) => q.toLowerCase())).size, s.queries.length, 'no duplicate queries');
  }
  assert.equal(p[0].span.start, 0); assert.equal(p.at(-1).span.end, 1);
  for (let i = 1; i < p.length; i++) assert.equal(p[i].span.start, p[i - 1].span.end);
});

test('whole-video query is never truncated away, even when a scene has the maximum number of specific queries', () => {
  for (const s of plan()) assert.equal(s.queries.at(-1), IDEAS);
});

test('advisor training / workshops scenes ask for training imagery, not a keyword', () => {
  const p = plan();
  for (const frag of ['Advisor Training and Workshops.', 'advisors receive specialized training']) {
    const q = specific(sceneWith(p, frag)).join(' | ').toLowerCase();
    assert.match(q, /training workshop|seminar|advisor training/, `${frag} -> ${q}`);
  }
});

test('partnership scenes ask for partnership imagery', () => {
  const p = plan();
  assert.match(specific(sceneWith(p, 'The New SBDC Partnership.')).join(' | '), /handshake|shaking hands/);
  assert.match(specific(sceneWith(p, 'a major new partnership has formed')).join(' | '), /handshake|shaking hands/);
});

test('access, resources and long-term development scenes keep their own subject', () => {
  const p = plan();
  assert.match(specific(sceneWith(p, 'Hands-On Access.')).join(' | '), /laptop|computer/);
  assert.match(specific(sceneWith(p, 'Long-Term Resource Development.')).join(' | '), /notebook|planning|growth|seedling/);
  assert.match(specific(sceneWith(p, 'limited time for staff participation')).join(' | '), /busy business owner|security padlock/);
});

test('no query is one of the old misleading single-word matches, and none contains a broken stem', () => {
  const all = plan().flatMap((s) => s.queries);
  for (const j of OLD_JUNK) assert.ok(!all.includes(j), `old junk query still present: ${j}`);
  for (const q of all) assert.ok(!/businesse\b|\bclasse\b|\bglasse\b/.test(q), q);
  for (const q of all.filter((x) => x !== IDEAS)) {
    assert.ok(q.split(/\s+/).length >= 2, `single-word query: ${q}`);
    assert.ok(!/\b(access|beyond|baseline|baselines|artificial|initial|development)$/.test(q), `abstract trailing word: ${q}`);
  }
});

test('curated ideas are reused only where they fit and neighbouring scenes do not all ask for the same picture', () => {
  const p = plan();
  assert.ok(!specific(sceneWith(p, 'Advisor Training and Workshops.')).includes('coffee shop'));
  assert.ok(!specific(sceneWith(p, 'Hands-On Access.')).includes('coffee shop'));
  for (let i = 1; i < p.length; i++) assert.notEqual(p[i].queries[0], p[i - 1].queries[0], `scenes ${i} and ${i + 1} share a primary query`);
  const counts = new Map();
  for (const s of p) counts.set(s.queries[0], (counts.get(s.queries[0]) ?? 0) + 1);
  assert.ok(Math.max(...counts.values()) <= 2, JSON.stringify([...counts]));
});

test('deterministic: identical input gives an identical plan', () => {
  assert.deepEqual(plan(), plan());
});

test('nothing to search for: a scene with no concept, no phrase and no curated idea keeps only the whole-video query', () => {
  const body = 'It rained. They left. We sat. It ended.';
  const p = planScenes({ visualIdeas: '', scriptBody: body, fallbackQuery: 'rain' });
  assert.ok(p.length >= 2);
  for (const s of p) assert.deepEqual(s.queries, ['rain']);
});

test('a curated idea nothing in the narration supports is only a last-resort fallback, never a forced match', () => {
  const body = 'It rained. They left. We sat. It ended.';
  const p = planScenes({ visualIdeas: 'rainy street', scriptBody: body, fallbackQuery: 'rainy street' });
  assert.ok(p.length >= 2);
  assert.equal(p[0].queries[0], 'rainy street');
});

// ---------------------------------------------------------------------------------------------------------------
// Pipeline behaviour with the new queries: rejection of irrelevant hits, empty results, duplicates.
// ---------------------------------------------------------------------------------------------------------------

function freshStorage() {
  const dbPath = path.join(os.tmpdir(), `scene-query-${Date.now()}-${Math.random()}.db`);
  return { storage: new SqliteStorageDriver({ dbPath }), dbPath };
}
function cleanup(storage, dbPath, dirs = []) {
  storage.close();
  for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) fs.rmSync(f, { force: true });
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
}
function seed(storage) {
  const now = new Date().toISOString();
  const opp = crypto.randomUUID(); const brief = crypto.randomUUID(); const script = crypto.randomUUID(); const cv = crypto.randomUUID();
  storage.run(`INSERT INTO opportunities (id, title, source, discovered_at, status) VALUES (?, 'T', 'rss', ?, 'DISCOVERED')`, [opp, now]);
  storage.run(`INSERT INTO content_briefs (id, opportunity_id, working_title, core_question, target_audience, viewer_promise, hook, angle, narrative_structure, key_claims, counterpoints, original_insights, visual_ideas, monetization_opportunities, risk_assessment, created_at)
    VALUES (?, ?, 'T', 'Q', 'A', 'P', 'H', 'Angle', 'S', '[]', 'C', 'I', ?, 'M', 'R', ?)`, [brief, opp, IDEAS, now]);
  storage.run(`INSERT INTO scripts (id, content_brief_id, version, body, claim_links, created_at) VALUES (?, ?, 1, ?, '[]', ?)`, [script, brief, SCRIPT, now]);
  storage.run(`INSERT INTO content_versions (id, content_brief_id, script_id, state, created_at) VALUES (?, ?, ?, 'PRODUCED', ?)`, [cv, brief, script, now]);
  storage.run(`INSERT INTO productions (id, content_version_id, script_id, artifact_type, artifact_path, artifact_checksum, manifest_json, created_at)
    VALUES (?, ?, ?, 'production_manifest_v1', '/tmp/manifest.json', 'deadbeef', '{}', ?)`, [crypto.randomUUID(), cv, script, now]);
  return { brief, cv };
}

/** Behaves like the real provider contract: hits come from a per-query pool and pass through screenHit before "download". */
class PoolProvider extends AssetSourceProvider {
  constructor(dir, pool, { reuseFile = false } = {}) { super(); this.dir = dir; this.pool = pool; this.reuseFile = reuseFile; this.calls = []; }
  get id() { return 'pool'; }
  async healthCheck() { return true; }
  async acquireVisualAsset({ query, screenHit }) {
    this.calls.push(query);
    for (const hit of this.pool[query] ?? []) {
      if (screenHit && !screenHit(hit).accept) continue;
      const file = path.join(this.dir, this.reuseFile ? 'same.jpg' : `${hit.id}.jpg`);
      fs.writeFileSync(file, this.reuseFile ? 'same' : `bytes-${hit.id}`);
      const checksum = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
      return { assetType: 'image', location: file, checksum, origin: hit.pageURL, verificationStatus: 'UNVERIFIED' };
    }
    return null;
  }
}
const hit = (id, tags) => ({ id, pageURL: `https://pixabay.test/${id}`, tags });

const POOL = {
  'small business owner': [hit('s1', 'small business, shop owner, entrepreneur')],
  'business training workshop': [hit('w1', 'training, workshop, seminar, business')],
  'two people shaking hands': [hit('h1', 'handshake, partnership, business')],
  'business handshake partnership': [hit('h2', 'handshake, partnership, deal')],
  'person using laptop computer': [hit('l1', 'laptop, computer, desk')],
  // Irrelevant top hit: matches nothing in the scene or the query, so the unchanged gate must refuse it.
  'data security padlock': [hit('o1', 'ouija board, spooky, occult')],
  'business planning notebook': [hit('n1', 'notebook, planning, pen')]
};

test('pipeline: irrelevant hits are rejected and the scene is marked skipped, not silently filled', async () => {
  const { storage, dbPath } = freshStorage(); await storage.migrate();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-'));
  const { brief } = seed(storage);
  const provider = new PoolProvider(dir, POOL);
  const r = await runAssetProvisioning({ storage, contentBriefId: brief, provider, multiScene: true });
  assert.equal(r.outcome, 'PROVISIONED');
  assert.ok(!provider.calls.includes(IDEAS), 'whole-video query is never sent when scene queries exist');
  const skipped = storage.all("SELECT reason FROM decision_log WHERE decision = 'SCENE_ASSET_SKIPPED'").map((x) => x.reason);
  assert.ok(skipped.length >= 1, 'scenes with no acceptable candidate are recorded as skipped');
  assert.ok(!storage.all('SELECT origin FROM assets').some((a) => /ouija|o1$/.test(a.origin)), 'the irrelevant hit was never attached');
  const summary = JSON.parse(storage.get("SELECT reason FROM decision_log WHERE decision = 'SCENE_PROVISIONING_SUMMARY'").reason);
  assert.equal(summary.planned_scenes, 12);
  assert.equal(summary.fallback_reason, 'some_scene_assets_unavailable');
  assert.ok(summary.accepted_assets < 12);
  cleanup(storage, dbPath, [dir]);
});

test('pipeline: empty provider results leave the scene unresolved and never fail the stage', async () => {
  const { storage, dbPath } = freshStorage(); await storage.migrate();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-'));
  const { brief } = seed(storage);
  const provider = new PoolProvider(dir, { 'small business owner': POOL['small business owner'] });
  const r = await runAssetProvisioning({ storage, contentBriefId: brief, provider, multiScene: true });
  assert.equal(r.outcome, 'PROVISIONED');
  assert.equal(r.additionalAssets.length, 0);
  assert.equal(storage.get("SELECT COUNT(*) n FROM decision_log WHERE decision = 'SCENE_ASSET_SKIPPED'").n, 11);
  cleanup(storage, dbPath, [dir]);
});

test('pipeline: duplicate recovery still works with scene-specific queries', async () => {
  const { storage, dbPath } = freshStorage(); await storage.migrate();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-'));
  const { brief, cv } = seed(storage);
  // Every query's top hit is the same file; later scenes must refuse to attach it again.
  const provider = new PoolProvider(dir, Object.fromEntries(Object.keys(POOL).map((q) => [q, [hit('d1', `${q}, training, workshop`)]])), { reuseFile: true });
  const r = await runAssetProvisioning({ storage, contentBriefId: brief, provider, multiScene: true });
  assert.equal(r.outcome, 'PROVISIONED');
  const usages = storage.all('SELECT asset_id FROM asset_usages WHERE content_version_id = ?', [cv]);
  assert.equal(new Set(usages.map((u) => u.asset_id)).size, usages.length, 'no asset attached twice');
  assert.equal(usages.length, 1);
  cleanup(storage, dbPath, [dir]);
});

test('pipeline: relevant, distinct hits fill the scenes they match with provenance intact', async () => {
  const { storage, dbPath } = freshStorage(); await storage.migrate();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-'));
  const { brief, cv } = seed(storage);
  const provider = new PoolProvider(dir, POOL);
  const r = await runAssetProvisioning({ storage, contentBriefId: brief, provider, multiScene: true });
  assert.equal(r.outcome, 'PROVISIONED');
  const usages = storage.all('SELECT * FROM asset_usages WHERE content_version_id = ?', [cv]);
  assert.ok(usages.length >= 4);
  assert.equal(usages.filter((u) => u.provisioning_claim !== null).length, 1);
  for (const u of usages) assert.match(u.usage_context, /^b-roll scene \d+\/12 span /);
  for (const a of storage.all('SELECT verification_status FROM assets')) assert.equal(a.verification_status, 'UNVERIFIED');
  cleanup(storage, dbPath, [dir]);
});
