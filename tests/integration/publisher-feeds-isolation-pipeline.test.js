import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { LLMRouter } from '../../src/providers/llm/router.js';
import { ResearchSourceProvider } from '../../src/research/ResearchSourceProvider.js';
import { runResearchProject } from '../../src/research/pipeline.js';
import { validateVerifierResponse, selectCandidateSources, REJECTION_REASON } from '../../src/research/evidenceVerification.js';
import researchPolicy from '../../config/research_policy.json' with { type: 'json' };
import { explainLoadBearingClaims } from '../../scripts/explain-research-evidence.js';
import { annotateBlockedSources } from '../../src/publisherFeeds/annotate.js';
import { findAuthorizedFeed, loadPublisherFeedConfig } from '../../src/publisherFeeds/feedClient.js';
import { parseFeed } from '../../src/discovery/rssParser.js';
import { main as annotateMain } from '../../scripts/annotate-blocked-sources.js';
import { freshMigratedStorage, removeDb, seedSource, feedXml, okFetch, snapshotResearchTables } from '../helpers/publisherFeedsFixture.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const feed = findAuthorizedFeed(loadPublisherFeedConfig(), { feedId: 'openai-news' });
const BLOCKED = 'https://openai.com/index/gpt-6-for-everyone';
const GOOD = 'https://publisher-one.com/story';
const SUMMARY = 'OpenAI reported that GPT-6 is now available to everyone worldwide.';

class UrlListProvider extends ResearchSourceProvider {
  constructor(urls) { super(); this.urls = urls; }
  get id() { return 'url-list-stub'; }
  async healthCheck() { return true; }
  async discoverCandidates() { return { candidates: this.urls.map((url, i) => ({ url, title: `t${i}`, snippet: 's' })) }; }
}
// openai.com answers 403 (blocked); the other publisher answers normally.
const blockingFetch = async (url) => (String(url).includes('openai.com')
  ? { ok: false, status: 403, headers: { get: () => 'text/html' }, text: async () => 'Forbidden' }
  : { ok: true, status: 200, headers: { get: () => 'text/html' }, text: async () => '<html><body>Acme reported $1B in Q3 revenue.</body></html>' });
const router = (claims) => new LLMRouter({
  priority: ['stub'], allowPaidProviders: false,
  registry: { stub: () => ({ id: 'stub', isPaid: false, async healthCheck() { return true; },
    async complete() { return { text: JSON.stringify(claims), model: 'stub', requestId: null, inputTokens: 1, outputTokens: 1, estimatedCost: 0, isPaid: false }; } }) }
});
const FACT = { claim: 'Acme reported $1B in Q3 revenue.', claim_type: 'FACT', is_load_bearing: true };

async function runPipeline() {
  const { storage, dbPath } = await freshMigratedStorage('pubfeeds-int');
  const oppId = crypto.randomUUID();
  storage.run(`INSERT INTO opportunities (id, title, source, discovered_at, status, opportunity_proposition) VALUES (?, 'Test', 'rss', ?, 'HANDED_TO_RESEARCH', ?)`,
    [oppId, new Date().toISOString(), JSON.stringify({ subject: 'S', target_audience: 'a', audience_problem: 'p', core_question: 'Did the launch cause a measurable sales increase?', gap: 'g', angle: 'a', differentiation: 'd', commercial_relevance: 'c', core_question_type: 'FACTUAL' })]);
  const result = await runResearchProject({ storage, opportunityId: oppId, sourceProvider: new UrlListProvider([BLOCKED, GOOD]), llmRouter: router([FACT]), policy: researchPolicy, classification: {}, fetchImpl: blockingFetch });
  return { storage, dbPath, result };
}

function feed50(extra = []) {
  const items = [{ link: BLOCKED, title: 'GPT-6 for everyone', description: SUMMARY }];
  for (let i = 0; i < 49; i += 1) items.push({ link: `https://openai.com/index/seeded-${i}`, description: `Seeded ${i} summary text for testing only.` });
  return parseFeed(feedXml([...items, ...extra]));
}

test('real pipeline: annotating 50 matching feed items leaves every research table byte-identical and nothing becomes VERIFIED', async () => {
  const { storage, dbPath, result } = await runPipeline();
  try {
    const blockedRow = storage.get("SELECT * FROM sources WHERE url = ?", [BLOCKED]);
    assert.equal(blockedRow.retrieval_status, 'FAILED');
    assert.match(blockedRow.notes, /HTTP 403/);
    // 49 more blocked openai.com rows (mixed classes) so 50 blocked sources match 50 feed items.
    const errors = ['HTTP 403', 'HTTP 429', 'HTTP 500', 'HTTP 401', 'fetch failed'];
    for (let i = 0; i < 49; i += 1) seedSource(storage, { projectId: blockedRow.research_project_id, url: `https://openai.com/index/seeded-${i}`, error: errors[i % errors.length] });

    const statusBefore = storage.all('SELECT id, evidence_status FROM claims ORDER BY id');
    assert.ok(statusBefore.length >= 1);
    assert.ok(statusBefore.every((c) => c.evidence_status !== 'VERIFIED'), 'baseline: single non-authoritative source is not VERIFIED');
    const explainBefore = JSON.stringify(explainLoadBearingClaims(storage.db));
    const before = snapshotResearchTables(storage);

    const s = annotateBlockedSources({ db: storage, feed, feedResult: { ok: true, feedUrl: feed.feedUrl, fetchedAt: 'T0', items: feed50() } });
    assert.equal(s.blockedSourcesConsidered, 50);
    assert.equal(s.sourcesWithMatch, 50);
    assert.equal(s.inserted, 50);
    assert.equal(storage.get('SELECT COUNT(*) n FROM publisher_feed_items').n, 50);

    assert.deepEqual(snapshotResearchTables(storage), before, 'sources, claims, claim_sources, decision_log and every other table identical');
    assert.deepEqual(storage.all('SELECT id, evidence_status FROM claims ORDER BY id'), statusBefore);
    assert.equal(JSON.stringify(explainLoadBearingClaims(storage.db)), explainBefore, 'evidence explanation identical');
    const projectBefore = JSON.stringify(storage.get('SELECT * FROM research_projects WHERE id = ?', [blockedRow.research_project_id]));
    assert.ok(projectBefore.length > 2 && result, 'pipeline produced a project row (also covered by the table snapshot)');

    // Idempotent re-run: still identical and still 50 rows.
    const again = annotateBlockedSources({ db: storage, feed, feedResult: { ok: true, feedUrl: feed.feedUrl, fetchedAt: 'T1', items: feed50() } });
    assert.equal(again.inserted, 0); assert.equal(again.duplicates, 50);
    assert.deepEqual(snapshotResearchTables(storage), before);
    assert.equal(storage.get('SELECT COUNT(*) n FROM publisher_feed_items').n, 50);
  } finally { storage.close(); removeDb(dbPath); }
});

test('feed summaries can never satisfy quote validation or become candidate evidence', async () => {
  const { storage, dbPath } = await runPipeline();
  try {
    annotateBlockedSources({ db: storage, feed, feedResult: { ok: true, feedUrl: feed.feedUrl, fetchedAt: 'T', items: feed50() } });
    const blocked = storage.get('SELECT * FROM sources WHERE url = ?', [BLOCKED]);
    const quote = JSON.stringify({ result: 'SUPPORTS', quote: SUMMARY });
    // The verifier only ever sees sources.content; a blocked page has none and the feed text is not in it.
    for (const sourceText of [blocked.content ?? '', 'Acme reported $1B in Q3 revenue.']) {
      const v = validateVerifierResponse(quote, { source: blocked, sourceText });
      assert.equal(v.quoteAccepted ?? false, false);
      assert.equal(v.rejectionReason, REJECTION_REASON.QUOTE_NOT_IN_SOURCE);
    }
    // No feed row is ever a candidate: selection reads sources only, and the blocked page is ineligible.
    const sources = storage.all('SELECT * FROM sources');
    const claim = storage.get('SELECT * FROM claims LIMIT 1');
    const picked = selectCandidateSources({ claim, sources, policy: researchPolicy });
    assert.ok(Array.isArray(picked));
    for (const c of picked) assert.notEqual(c.source.url, BLOCKED);
    assert.equal(storage.get('SELECT COUNT(*) n FROM sources WHERE url LIKE ?', ['%rss.xml%']).n, 0, 'feed URL never becomes a source row');
  } finally { storage.close(); removeDb(dbPath); }
});

test('a claim whose only publisher evidence is a blocked authoritative page stays below VERIFIED with 50 feed items present', async () => {
  const { storage, dbPath } = await freshMigratedStorage('pubfeeds-suff');
  try {
    storage.run(`INSERT INTO opportunities (id, title, source, discovered_at, status) VALUES ('o','T','rss','2026-10-22T00:00:00.000Z','NEW')`);
    storage.run(`INSERT INTO research_projects (id, opportunity_id, status, created_at) VALUES ('p','o','RESEARCHING','2026-10-22T00:00:00.000Z')`);
    seedSource(storage, { projectId: 'p', url: BLOCKED, error: 'HTTP 403' });
    storage.run(`INSERT INTO claims (id, research_project_id, claim, claim_type, is_load_bearing, evidence_status, created_at) VALUES ('c','p','OpenAI released GPT-6 to everyone.','FACT',1,'UNSUPPORTED','2026-10-22T00:00:00.000Z')`);
    annotateBlockedSources({ db: storage, feed, feedResult: { ok: true, feedUrl: feed.feedUrl, fetchedAt: 'T', items: feed50() } });
    assert.equal(storage.get("SELECT evidence_status FROM claims WHERE id='c'").evidence_status, 'UNSUPPORTED');
    assert.equal(storage.get("SELECT COUNT(*) n FROM claim_sources").n, 0);
    const [row] = explainLoadBearingClaims(storage.db);
    assert.equal(row.explanation.hasPrimaryAuthoritative, false);
    assert.equal(row.explanation.independentCount, 0);
  } finally { storage.close(); removeDb(dbPath); }
});

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]));
}

test('static isolation: nothing under src/research imports the feed module and the feed module never writes research tables', () => {
  for (const f of walk(path.join(ROOT, 'src', 'research')).filter((p) => p.endsWith('.js'))) {
    assert.doesNotMatch(fs.readFileSync(f, 'utf8'), /publisherFeeds|publisher_feed_items/, `${path.relative(ROOT, f)} must not reference publisher feeds`);
  }
  const mine = [...walk(path.join(ROOT, 'src', 'publisherFeeds')), path.join(ROOT, 'scripts', 'annotate-blocked-sources.js')].filter((p) => p.endsWith('.js'));
  for (const f of mine) {
    const code = fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    assert.doesNotMatch(code, /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM|DROP\s+TABLE|ALTER\s+TABLE)\s+(sources|claims|claim_sources|claim_relations|decision_log|research_projects|opportunities)\b/i, path.relative(ROOT, f));
    assert.doesNotMatch(code, /from ['"][^'"]*\/research\//, `${path.relative(ROOT, f)} must not import the frozen research surface`);
  }
});

test('static isolation: reader fallback stays unconfigured and untouched by the feed path', () => {
  const code = walk(path.join(ROOT, 'src', 'publisherFeeds')).map((f) => fs.readFileSync(f, 'utf8')).join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(code, /RESEARCH_READER_FALLBACK_URL|readerFallback|fetchViaReader/);
  assert.doesNotMatch(code, /\bUser-Agent\b|Sec-Fetch|ja3|impersonat|puppeteer|playwright|curl-impersonate/i);
});

test('script fails closed: feed 403/outage writes nothing and exits 2; research tables identical', async () => {
  const { storage, dbPath } = await freshMigratedStorage('pubfeeds-script');
  try {
    seedSource(storage, { projectId: (storage.run(`INSERT INTO opportunities (id, title, source, discovered_at, status) VALUES ('o','T','rss','2026-10-22T00:00:00.000Z','NEW')`), storage.run(`INSERT INTO research_projects (id, opportunity_id, status, created_at) VALUES ('p','o','RESEARCHING','2026-10-22T00:00:00.000Z')`), 'p'), url: BLOCKED, error: 'HTTP 403' });
    const before = snapshotResearchTables(storage);
    storage.close();
    for (const fetchImpl of [okFetch('', 403), okFetch('', 429), okFetch('', 500), async () => { throw new Error('fetch failed'); }, okFetch('<html>challenge</html>')]) {
      const lines = [];
      const code = await annotateMain({ argv: ['--db', dbPath, '--write'], out: (l) => lines.push(l), fetchImpl });
      assert.equal(code, 2);
      assert.match(lines.join('\n'), /FEED_UNAVAILABLE .*written=0/);
    }
    const { SqliteStorageDriver } = await import('../../src/storage/SqliteStorageDriver.js');
    const s2 = new SqliteStorageDriver({ dbPath });
    try {
      assert.equal(s2.get('SELECT COUNT(*) n FROM publisher_feed_items').n, 0);
      assert.deepEqual(snapshotResearchTables(s2), before);
    } finally { s2.close(); }
  } finally { removeDb(dbPath); }
});

test('script: missing table is reported (exit 3, nothing created) unless --apply-migration, which creates only that table', async () => {
  const { storage, dbPath } = await freshMigratedStorage('pubfeeds-script2');
  try {
    storage.run(`INSERT INTO opportunities (id, title, source, discovered_at, status) VALUES ('o','T','rss','2026-10-22T00:00:00.000Z','NEW')`);
    storage.run(`INSERT INTO research_projects (id, opportunity_id, status, created_at) VALUES ('p','o','RESEARCHING','2026-10-22T00:00:00.000Z')`);
    seedSource(storage, { projectId: 'p', url: BLOCKED, error: 'HTTP 403' });
    storage.run('DROP INDEX idx_publisher_feed_items_blocked_source'); storage.run('DROP TABLE publisher_feed_items');
    storage.run("DELETE FROM schema_migrations WHERE id = '0032_publisher_feed_items.sql'");
    const before = snapshotResearchTables(storage);
    storage.close();
    const xml = feedXml([{ link: BLOCKED, title: 'GPT-6 for everyone' }]);
    const l1 = []; assert.equal(await annotateMain({ argv: ['--db', dbPath, '--write'], out: (l) => l1.push(l), fetchImpl: okFetch(xml) }), 3);
    const l2 = []; assert.equal(await annotateMain({ argv: ['--db', dbPath, '--dry-run'], out: (l) => l2.push(l), fetchImpl: okFetch(xml) }), 0);
    assert.match(l2.join('\n'), /planned_rows=1 inserted=0/);
    const { SqliteStorageDriver } = await import('../../src/storage/SqliteStorageDriver.js');
    let s = new SqliteStorageDriver({ dbPath });
    assert.equal(s.all("SELECT name FROM sqlite_master WHERE name='publisher_feed_items'").length, 0, 'dry-run and exit-3 path created nothing');
    s.close();
    const l3 = []; assert.equal(await annotateMain({ argv: ['--db', dbPath, '--apply-migration', '--write'], out: (l) => l3.push(l), fetchImpl: okFetch(xml) }), 0);
    const l4 = []; assert.equal(await annotateMain({ argv: ['--db', dbPath, '--write'], out: (l) => l4.push(l), fetchImpl: okFetch(xml) }), 0);
    s = new SqliteStorageDriver({ dbPath });
    try {
      assert.equal(s.get('SELECT COUNT(*) n FROM publisher_feed_items').n, 1);
      assert.deepEqual(snapshotResearchTables(s), before);
      await s.migrate(); // runner after the explicit path must not fail
      assert.equal(s.get('SELECT COUNT(*) n FROM publisher_feed_items').n, 1);
    } finally { s.close(); }
  } finally { removeDb(dbPath); }
});
