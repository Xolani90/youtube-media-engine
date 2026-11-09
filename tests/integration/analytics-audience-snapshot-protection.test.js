import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { collectAudienceAnalytics } from '../../src/analytics/audienceCollection.js';
import { runWindowCollection } from '../../src/analytics/windowCollection.js';
import { SqliteStorageDriver } from '../../src/storage/SqliteStorageDriver.js';

// Focused proof that an audience snapshot's SUCCESS is protected IN SQL (not by the planner), that
// different publications / kinds / periods stay isolated, that failures never fabricate zeros, and
// that DEFERRED always carries a reason. Complements analytics-audience-success-immutable.test.js.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PUBLISHED_AT = '2020-01-01T10:00:00.000Z';
const NOW = '2026-10-01T00:00:00.000Z';
const P1 = { periodStart: '2020-01-02', periodEnd: '2020-01-08' };
const P2 = { periodStart: '2020-01-02', periodEnd: '2020-01-02' };
const okRet = { status: 'SUCCESS', summary: { at10: 0.9, at25: 0.7, at50: 0.5, at75: 0.3, steepestDrop: null, pointCount: 100 }, points: [] };
const okTraffic = { status: 'SUCCESS', totalViews: 100, totalViewsComplete: true, zeroViews: false, sources: [{ source: 'SEARCH', viewsShare: 0.4 }] };
const unavailable = async () => ({ status: 'UNAVAILABLE', errorClass: 'no_data' });
const NON_SUCCESS = ['UNAVAILABLE', 'TRANSIENT_FAILURE', 'PERMANENT_FAILURE', 'AUTH_FAILURE', 'RATE_LIMITED'];

async function open({ dbPath = path.join(os.tmpdir(), `snapprot-${process.pid}-${Math.random()}.db`), pubs = ['pub1'] } = {}) {
  const storage = new SqliteStorageDriver({ dbPath });
  await storage.migrate();
  storage.run('PRAGMA foreign_keys = OFF');
  storage.run(`INSERT INTO system_runs (id, mode, autonomous_enabled, started_at, config_snapshot) VALUES ('run1', 'LIVE', 1, ?, '{}')`, [PUBLISHED_AT]);
  pubs.forEach((id, i) => {
    storage.run(`INSERT INTO publications (id, content_version_id, media_artifact_id, provider, status, request_json, provider_item_id, result_json, created_at, updated_at)
      VALUES (?, ?, 'ma1', 'youtube', 'PUBLISHED', ?, ?, ?, ?, ?)`, [id, `cv-${id}`, JSON.stringify({ requestedPublishAt: null }), `vid${i}AAAAAAA`.slice(0, 11), JSON.stringify({ confirmedVisibility: 'public' }), PUBLISHED_AT, PUBLISHED_AT]);
    storage.run(`INSERT INTO decision_log (id, run_id, subject_type, subject_id, decision, reason, created_at) VALUES (?, 'run1', 'content_version', ?, 'PUBLISHED', ?, ?)`, [`dl-${id}`, `cv-${id}`, `publication_${id}_persisted`, PUBLISHED_AT]);
  });
  const cleanup = () => { storage.close(); for (const s of ['', '-wal', '-shm']) fs.rmSync(dbPath + s, { force: true }); };
  return { storage, dbPath, cleanup };
}
const target = (pub, p, kinds) => ({ publicationId: pub, ...p, kinds });
const rows = (s) => s.all(`SELECT publication_id, kind, period_start, period_end, status, failure_reason, summary_json, result_json FROM analytics_audience_snapshots ORDER BY publication_id, kind, period_start, period_end`);
const adapterOf = (ret, traf = async () => okTraffic) => ({ collectRetentionCurve: ret, collectTrafficSources: traf });

test('every non-SUCCESS status that lands AFTER a SUCCESS is a no-op (separate DB connection = separate job)', async () => {
  for (const status of NON_SUCCESS) {
    const a = await open();
    const b = new SqliteStorageDriver({ dbPath: a.dbPath }); // second connection, as a second process would have
    try {
      const T = [target('pub1', P1, ['RETENTION'])];
      const slow = adapterOf(async () => {
        // while this job's request is in flight, another job (own connection) lands SUCCESS
        await collectAudienceAnalytics({ storage: b, adapter: adapterOf(async () => okRet), targets: T, nowISO: () => NOW });
        return { status, errorClass: `late_${status}` };
      });
      const out = await collectAudienceAnalytics({ storage: a.storage, adapter: slow, targets: T, nowISO: () => NOW });
      const [r, ...rest] = rows(a.storage);
      assert.equal(rest.length, 0, `${status}: still exactly one row`);
      assert.equal(r.status, 'SUCCESS', `${status} must not downgrade SUCCESS`);
      assert.equal(r.failure_reason, null);
      assert.ok(JSON.parse(r.summary_json).at10 === 0.9, 'original summary intact');
      assert.equal(out.failed, 0); assert.equal(out.unavailable, 0);
      assert.equal(out.alreadyCollected, 1);
      assert.equal(out.results.length, 0, 'a blocked write is not reported as a result');
      assert.equal(a.storage.all(`SELECT id FROM decision_log WHERE reason LIKE 'analytics_audience_retention_%' AND reason NOT LIKE '%_success_%'`).length, 0, 'no failure decision logged for a blocked write');
    } finally { b.close(); a.cleanup(); }
  }
});

test('a SUCCESS whose shape cannot be summarized (partial/garbled) cannot overwrite an existing SUCCESS', async () => {
  const a = await open();
  try {
    const T = [target('pub1', P1, ['RETENTION'])];
    const racing = adapterOf(async () => {
      await collectAudienceAnalytics({ storage: a.storage, adapter: adapterOf(async () => okRet), targets: T, nowISO: () => NOW });
      return { status: 'SUCCESS' }; // no summary: summarizeRetention throws -> would be PERMANENT_FAILURE
    });
    await collectAudienceAnalytics({ storage: a.storage, adapter: racing, targets: T, nowISO: () => NOW });
    const [r] = rows(a.storage);
    assert.equal(r.status, 'SUCCESS'); assert.ok(r.summary_json);
  } finally { a.cleanup(); }
});

test('TRUE concurrency: parallel OS processes racing SUCCESS against failures always end with one intact SUCCESS row', async () => {
  const child = path.join(os.tmpdir(), `snapprot-child-${process.pid}.mjs`);
  fs.writeFileSync(child, `
    import { collectAudienceAnalytics } from ${JSON.stringify(pathToFileURL(path.join(ROOT, 'src/analytics/audienceCollection.js')).href)};
    import { SqliteStorageDriver } from ${JSON.stringify(pathToFileURL(path.join(ROOT, 'src/storage/SqliteStorageDriver.js')).href)};
    const [dbPath, mode, startAt, jitter] = process.argv.slice(2);
    const storage = new SqliteStorageDriver({ dbPath });
    const wait = Math.max(0, Number(startAt) - Date.now()); if (wait) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait);
    const ret = async () => { await new Promise((r) => setTimeout(r, Number(jitter)));
      return mode === 'S' ? { status: 'SUCCESS', summary: { at10: 0.9, at25: 0.7, at50: 0.5, at75: 0.3, steepestDrop: null, pointCount: 100 }, points: [] } : { status: mode, errorClass: 'c_' + mode }; };
    await collectAudienceAnalytics({ storage, adapter: { collectRetentionCurve: ret, collectTrafficSources: async () => ({ status: 'UNAVAILABLE' }) },
      targets: [{ publicationId: 'pub1', periodStart: '2020-01-02', periodEnd: '2020-01-08', kinds: ['RETENTION'] }], nowISO: () => ${JSON.stringify(NOW)} });
    storage.close();
  `);
  const run = (args) => new Promise((resolve, reject) => execFile(process.execPath, [child, ...args], { timeout: 60000 }, (e, so, se) => (e ? reject(new Error(`${e.message}\n${se}`)) : resolve())));
  try {
    for (let round = 0; round < 4; round++) {
      const a = await open();
      try {
        const startAt = Date.now() + 2500;
        const modes = ['S', 'TRANSIENT_FAILURE', 'S', 'PERMANENT_FAILURE', 'UNAVAILABLE', 'RATE_LIMITED', 'AUTH_FAILURE', 'TRANSIENT_FAILURE'];
        await Promise.all(modes.map((m, i) => run([a.dbPath, m, String(startAt), String((i * 7 + round * 13) % 40)])));
        const all = rows(a.storage);
        assert.equal(all.length, 1, `round ${round}: one row`);
        assert.equal(all[0].status, 'SUCCESS', `round ${round}: SUCCESS survived`);
        assert.equal(all[0].failure_reason, null);
        assert.equal(JSON.parse(all[0].summary_json).pointCount, 100);
      } finally { a.cleanup(); }
    }
  } finally { fs.rmSync(child, { force: true }); }
});

test('duplicate SUCCESS is deterministic: the first row is kept (id, collected_at, summary)', async () => {
  const a = await open();
  try {
    const T = [target('pub1', P1, ['RETENTION'])];
    await collectAudienceAnalytics({ storage: a.storage, adapter: adapterOf(async () => okRet), targets: T, nowISO: () => '2026-10-01T00:00:00.000Z' });
    const first = a.storage.get(`SELECT id, collected_at, summary_json FROM analytics_audience_snapshots`);
    // Real duplicate: a second job passed the pre-request check, so it requests and writes while the
    // row is already SUCCESS. (Same job twice in sequence would be short-circuited by the pre-check.)
    const second = { ...okRet, summary: { ...okRet.summary, at10: 0.1 } };
    const b = new SqliteStorageDriver({ dbPath: a.dbPath });
    try {
      const staleView = adapterOf(async () => second);
      // b's pre-check ran "before" the first SUCCESS: simulate by calling the write path via a request that
      // only returns after a's SUCCESS already exists -> collectAudienceAnalytics on b re-checks first, so
      // instead race inside the request: nested winner on b, outer duplicate on a.
      const T = [target('pub1', P2, ['RETENTION'])];
      const dupRace = adapterOf(async () => {
        await collectAudienceAnalytics({ storage: b, adapter: adapterOf(async () => okRet), targets: T, nowISO: () => '2026-10-04T00:00:00.000Z' });
        return second;
      });
      await collectAudienceAnalytics({ storage: a.storage, adapter: dupRace, targets: T, nowISO: () => '2026-10-05T00:00:00.000Z' });
      const w = a.storage.get(`SELECT collected_at, summary_json FROM analytics_audience_snapshots WHERE period_end = ?`, [P2.periodEnd]);
      assert.equal(w.collected_at, '2026-10-04T00:00:00.000Z', 'first writer wins');
      assert.equal(JSON.parse(w.summary_json).at10, 0.9, 'duplicate SUCCESS did not replace the winner');
      void staleView;
    } finally { b.close(); }
    assert.deepEqual(a.storage.get(`SELECT id, collected_at, summary_json FROM analytics_audience_snapshots`), first);
  } finally { a.cleanup(); }
});

test('recovery: UNAVAILABLE -> TRANSIENT_FAILURE -> SUCCESS updates the SAME row; nothing is fabricated on the way', async () => {
  const a = await open();
  try {
    const T = [target('pub1', P1, ['RETENTION'])];
    await collectAudienceAnalytics({ storage: a.storage, adapter: adapterOf(unavailable), targets: T, nowISO: () => NOW });
    let [r] = rows(a.storage);
    assert.equal(r.status, 'UNAVAILABLE'); assert.equal(r.summary_json, null);
    await collectAudienceAnalytics({ storage: a.storage, adapter: adapterOf(async () => ({ status: 'TRANSIENT_FAILURE', errorClass: 'http_503' })), targets: T, nowISO: () => NOW });
    [r] = rows(a.storage);
    assert.equal(r.status, 'TRANSIENT_FAILURE'); assert.equal(r.summary_json, null);
    assert.doesNotMatch(r.result_json, /"(at10|views|totalViews|pointCount)"/, 'no measurement keys, let alone zeros');
    const id = a.storage.get(`SELECT id FROM analytics_audience_snapshots`).id;
    await collectAudienceAnalytics({ storage: a.storage, adapter: adapterOf(async () => okRet), targets: T, nowISO: () => NOW });
    assert.equal(rows(a.storage).length, 1);
    assert.equal(rows(a.storage)[0].status, 'SUCCESS');
    assert.equal(a.storage.get(`SELECT id FROM analytics_audience_snapshots`).id, id, 'same row upgraded in place');
  } finally { a.cleanup(); }
});

test('isolation: SUCCESS on one (publication, kind, period) never blocks or is touched by writes to any other', async () => {
  const a = await open({ pubs: ['pub1', 'pub2'] });
  try {
    // pub1/RETENTION/P1 = SUCCESS
    await collectAudienceAnalytics({ storage: a.storage, adapter: adapterOf(async () => okRet), targets: [target('pub1', P1, ['RETENTION'])], nowISO: () => NOW });
    const fail = adapterOf(async () => ({ status: 'TRANSIENT_FAILURE', errorClass: 'e' }), async () => ({ status: 'TRANSIENT_FAILURE', errorClass: 'e' }));
    await collectAudienceAnalytics({ storage: a.storage, adapter: fail, nowISO: () => NOW, targets: [
      target('pub1', P1, ['TRAFFIC_SOURCES']), // same pub + period, other kind
      target('pub1', P2, ['RETENTION']),       // same pub + kind, other period
      target('pub2', P1, ['RETENTION'])        // other publication
    ] });
    const key = (r) => `${r.publication_id}|${r.kind}|${r.period_start}..${r.period_end}`;
    const got = Object.fromEntries(rows(a.storage).map((r) => [key(r), r.status]));
    assert.deepEqual(got, {
      'pub1|RETENTION|2020-01-02..2020-01-08': 'SUCCESS',
      'pub1|TRAFFIC_SOURCES|2020-01-02..2020-01-08': 'TRANSIENT_FAILURE',
      'pub1|RETENTION|2020-01-02..2020-01-02': 'TRANSIENT_FAILURE',
      'pub2|RETENTION|2020-01-02..2020-01-08': 'TRANSIENT_FAILURE'
    });
    // and the reverse: a SUCCESS elsewhere upgrades only its own row, SUCCESS stays readable
    await collectAudienceAnalytics({ storage: a.storage, adapter: adapterOf(async () => okRet), targets: [target('pub2', P1, ['RETENTION'])], nowISO: () => NOW });
    const after = Object.fromEntries(rows(a.storage).map((r) => [key(r), r.status]));
    assert.equal(after['pub2|RETENTION|2020-01-02..2020-01-08'], 'SUCCESS');
    assert.equal(after['pub1|TRAFFIC_SOURCES|2020-01-02..2020-01-08'], 'TRANSIENT_FAILURE');
    assert.ok(JSON.parse(rows(a.storage).find((r) => key(r).startsWith('pub1|RETENTION|2020-01-02..2020-01-08')).summary_json).at10 === 0.9, 'earlier SUCCESS still readable');
  } finally { a.cleanup(); }
});

test('a first failed attempt stores NULL summary and no zero-valued measurements', async () => {
  const a = await open();
  try {
    await collectAudienceAnalytics({ storage: a.storage, adapter: adapterOf(async () => ({ status: 'PERMANENT_FAILURE', errorClass: 'http_400' }), async () => ({ status: 'RATE_LIMITED', errorClass: 'http_429' })), targets: [target('pub1', P1, undefined)], nowISO: () => NOW });
    for (const r of rows(a.storage)) {
      assert.equal(r.summary_json, null, `${r.kind} summary is NULL`);
      assert.doesNotMatch(r.result_json, /:\s*0(\D|$)/, `${r.kind} result carries no zero measurement`);
    }
  } finally { a.cleanup(); }
});

test('a blocked RATE_LIMITED/AUTH_FAILURE write still aborts the run (account-level signal is not discarded)', async () => {
  for (const status of ['RATE_LIMITED', 'AUTH_FAILURE']) {
    const a = await open({ pubs: ['pub1', 'pub2'] });
    try {
      const T = [target('pub1', P1, ['RETENTION']), target('pub2', P1, ['RETENTION'])];
      const requested = [];
      const adapter = adapterOf(async ({ videoId }) => {
        requested.push(videoId);
        if (requested.length === 1) {
          await collectAudienceAnalytics({ storage: a.storage, adapter: adapterOf(async () => okRet), targets: [T[0]], nowISO: () => NOW });
          return { status, errorClass: 'late' };
        }
        return { status: 'TRANSIENT_FAILURE', errorClass: 'should_not_be_probed' };
      });
      const out = await collectAudienceAnalytics({ storage: a.storage, adapter, targets: T, nowISO: () => NOW });
      assert.equal(out.aborted, true, `${status} aborts`);
      assert.equal(requested.length, 1, 'second publication was NOT probed');
      assert.equal(rows(a.storage).filter((r) => r.status !== 'SUCCESS').length, 0);
    } finally { a.cleanup(); }
  }
});

test('DEFERRED always carries an explicit reason: per-report cool-down and account-level hold; exit-code class = OK', async () => {
  const a = await open();
  const lp = path.join(os.tmpdir(), `snapprot-lock-${process.pid}-${Math.random()}`);
  try {
    const scalarOk = async (x) => ({ status: 'SUCCESS', byVideoId: Object.fromEntries(x.videoIds.map((v) => [v, { views: 10, impressions: 2000, impressionsCtr: 5, averageViewPercentage: 50 }])) });
    const mk = (status) => ({ collect: scalarOk, collectRetentionCurve: async () => ({ status, errorClass: 'e' }), collectTrafficSources: async () => ({ status, errorClass: 'e' }) });
    // per-report cool-down (TRANSIENT_FAILURE is not account-level)
    const r1 = await runWindowCollection({ storage: a.storage, adapter: mk('TRANSIENT_FAILURE'), now: () => NOW, lockPath: lp });
    assert.equal(r1.audience.status, 'FAILED'); assert.equal(r1.audience.deferredReason, null, 'only DEFERRED carries a deferredReason');
    assert.notEqual(r1.overallStatus, 'OK');
    const r2 = await runWindowCollection({ storage: a.storage, adapter: mk('TRANSIENT_FAILURE'), now: () => '2026-10-01T01:00:00.000Z', lockPath: lp });
    assert.equal(r2.audience.status, 'DEFERRED');
    assert.equal(r2.audience.deferredReason, 'retry_cool_down');
    assert.equal(r2.audience.result, null, 'nothing attempted');
    assert.equal(r2.overallStatus, 'OK');
  } finally { a.cleanup(); fs.rmSync(lp, { force: true }); }
  const b = await open();
  try {
    const mk = (status) => ({ collect: async (x) => ({ status: 'SUCCESS', byVideoId: Object.fromEntries(x.videoIds.map((v) => [v, { views: 10, impressions: 2000, impressionsCtr: 5, averageViewPercentage: 50 }])) }), collectRetentionCurve: async () => ({ status, errorClass: 'e' }), collectTrafficSources: async () => ({ status, errorClass: 'e' }) });
    await runWindowCollection({ storage: b.storage, adapter: mk('RATE_LIMITED'), now: () => NOW, lockPath: lp });
    const r = await runWindowCollection({ storage: b.storage, adapter: mk('RATE_LIMITED'), now: () => '2026-10-01T01:00:00.000Z', lockPath: lp });
    assert.equal(r.audience.status, 'DEFERRED');
    assert.equal(r.audience.deferredReason, 'account_level_failure_cooling_down');
  } finally { b.cleanup(); fs.rmSync(lp, { force: true }); }
});

test('PARTIAL audience (some reports succeed, some fail) is never OK; overall is PARTIAL', async () => {
  const a = await open();
  const lp = path.join(os.tmpdir(), `snapprot-lock-${process.pid}-${Math.random()}`);
  try {
    const adapter = { collect: async (x) => ({ status: 'SUCCESS', byVideoId: Object.fromEntries(x.videoIds.map((v) => [v, { views: 10, impressions: 2000, impressionsCtr: 5, averageViewPercentage: 50 }])) }),
      collectRetentionCurve: async () => okRet, collectTrafficSources: async () => ({ status: 'TRANSIENT_FAILURE', errorClass: 'http_503' }) };
    const r = await runWindowCollection({ storage: a.storage, adapter, now: () => NOW, lockPath: lp });
    assert.equal(r.audience.status, 'PARTIAL');
    assert.equal(r.overallStatus, 'PARTIAL');
    assert.equal(r.status, 'OK', 'scalar stays independent');
  } finally { a.cleanup(); fs.rmSync(lp, { force: true }); }
});
