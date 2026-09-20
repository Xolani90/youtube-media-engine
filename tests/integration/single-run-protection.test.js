// Single-run protection (ADR-0024): acceptance suite.
//
// Covers: whole-entrypoint guard (acquire before Discovery/ledger), fail-fast
// refusal, release on completion AND failure, no automatic reclamation of a
// pre-existing/orphaned RUNNING row, Owner-only reclamation with evidence
// preserved, and real multi-process races including a SIGKILL crash.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { SqliteStorageDriver } from '../../src/storage/SqliteStorageDriver.js';
import { LLMRouter } from '../../src/providers/llm/router.js';
import { OpportunitySource } from '../../src/providers/opportunity/OpportunitySource.js';
import { ResearchSourceProvider } from '../../src/research/ResearchSourceProvider.js';
import { runAutonomousEntrypoint } from '../../src/index.js';
import { runAutonomousOperation } from '../../src/autonomous/runner.js';
import { config } from '../../src/config/index.js';
import {
  SystemRunRecorder,
  AutonomousDisabledError,
  OwnerReclamationError,
  reclaimOrphanedRun,
  AUTONOMOUS_RUN_ACTIVE
} from '../../src/state/SystemRun.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const CHILD = path.join(HERE, 'helpers', 'single-run-child.js');
const RECLAIM_CLI = path.join(REPO, 'scripts', 'reclaim-autonomous-run.js');
const T0 = Date.parse('2026-03-01T00:00:00.000Z');

const STORIES = [
  { guid: 'g-1', link: 'https://news.test/one', title: 'Solar storage breakthrough', novelty: 95 },
  { guid: 'g-2', link: 'https://news.test/two', title: 'Rail freight reform passes', novelty: 85 },
  { guid: 'g-3', link: 'https://news.test/three', title: 'Ocean sensor network expands', novelty: 75 }
];

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};

class Feed extends OpportunitySource {
  constructor(stories, { gate = null, onEnter = null } = {}) {
    super();
    this.stories = stories;
    this.gate = gate;
    this.onEnter = onEnter;
    this.fetchCalls = 0;
  }
  get id() { return 'static-feed'; }
  async healthCheck() { return true; }
  async fetchCandidates() {
    this.fetchCalls++;
    this.onEnter?.();
    if (this.gate) await this.gate.promise;
    return { candidates: this.stories.map((s) => ({ ...s })), failures: [] };
  }
  normalize(raw) {
    return {
      title: raw.title,
      description: `Description of ${raw.title}: a reasonably detailed practical description.`,
      source: 'test',
      sourceUrl: raw.link,
      sourceId: raw.guid ?? null,
      feedUrl: 'https://feed.test/rss',
      discoveredAt: new Date(T0).toISOString()
    };
  }
}

class NoCandidates extends ResearchSourceProvider {
  get id() { return 'none'; }
  async healthCheck() { return true; }
  async discoverCandidates() { return { candidates: [], failures: [] }; }
}

function makeRouter(counters) {
  return new LLMRouter({
    priority: ['stub'],
    allowPaidProviders: false,
    registry: {
      stub: () => ({
        id: 'stub', isPaid: false,
        async healthCheck() { return true; },
        async complete(request) {
          counters.llm++;
          if (request.prompt.includes('same event')) {
            return { text: JSON.stringify({ sameEvent: false, confidence: 0.99, reason: 'x' }) };
          }
          return {
            text: JSON.stringify({
              subject: 'Subject', target_audience: 'Practitioners', audience_problem: 'They need reliable information.',
              core_question: 'What does this mean in practice?', gap: 'Coverage lacks a practical view.',
              angle: 'Practical angle.', differentiation: 'Concrete workflows.', commercial_relevance: 'Measurable value.',
              core_question_type: 'FACTUAL'
            })
          };
        }
      })
    }
  });
}

const featuresFor = (observation) => {
  const story = STORIES.find((s) => s.title === observation.title);
  return {
    novelty: story?.novelty ?? 50, competition: 10, story_potential: 90, evidence_availability: 90,
    production_difficulty: 10, audience_potential: 90, commercial_intent: 90, affiliate_potential: 90,
    lead_generation_potential: 90, product_adjacency: 90, sponsorship_potential: 90,
    policyRisk: 0, copyrightRisk: 0, repetitionRisk: 0
  };
};

function env() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'single-run-'));
  const dbPath = path.join(dir, 't.db');
  const opened = [];
  const open = () => { const s = new SqliteStorageDriver({ dbPath }); opened.push(s); return s; };
  const first = open();
  return {
    dir, dbPath, open, storage: first,
    // Two independent connections to one file: the same isolation two
    // processes get (WAL, separate connections, one writer at a time).
    invoke(storage, { source, rawFeatures = featuresFor, stageFns, mode, counters = { llm: 0 } } = {}) {
      return runAutonomousEntrypoint({
        storage,
        llmRouter: makeRouter(counters),
        mode,
        stageFns,
        discovery: { opportunitySource: source, rawFeatures, topK: 2, now: () => new Date(T0) },
        research: { sourceProvider: new NoCandidates() }
      });
    },
    cleanup() {
      for (const s of opened) { try { s.close(); } catch { /* already closed */ } }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

const count = (storage, table) => storage.get(`SELECT COUNT(*) n FROM ${table}`).n;
const runs = (storage) => storage.all('SELECT * FROM system_runs ORDER BY started_at, id');
const refusals = (storage) => storage.all(`SELECT * FROM decision_log WHERE decision = 'INVOCATION_REFUSED'`);

function insertRunning(storage, { id = crypto.randomUUID(), startedAt = '2020-01-01T00:00:00.000Z', mode = 'SIMULATION' } = {}) {
  storage.run(
    `INSERT INTO system_runs (id, mode, autonomous_enabled, started_at, status, config_snapshot)
     VALUES (?, ?, 0, ?, 'RUNNING', '{}')`,
    [id, mode, startedAt]
  );
  return id;
}

// ---------------------------------------------------------------- A / D / E / F

test('A/D/E: a second invocation while one is active is REFUSED fail-fast; it runs no Discovery, no ledger work, no runner, creates no system_runs row', async () => {
  const e = env();
  try {
    const storageB = e.open();
    await e.storage.migrate();
    const entered = deferred();
    const gate = deferred();
    const feedA = new Feed(STORIES, { gate, onEnter: entered.resolve });
    const feedB = new Feed(STORIES);
    const countersB = { llm: 0 };
    let runnerStageCallsB = 0;

    const a = e.invoke(e.storage, { source: feedA });
    await entered.promise; // A holds the guard and is inside Discovery

    const b = await e.invoke(storageB, {
      source: feedB, counters: countersB,
      stageFns: { research: async () => { runnerStageCallsB++; } }
    });

    assert.equal(b.refused, true);
    assert.equal(b.reason, AUTONOMOUS_RUN_ACTIVE);
    assert.equal(b.discovery, null);
    assert.equal(b.runner, null);
    assert.equal(b.recorded, true, 'the refusal is observable');
    const held = runs(e.storage);
    assert.equal(held.length, 1, 'no system_runs row for the refused invocation');
    assert.equal(held[0].status, 'RUNNING');
    assert.deepEqual(b.activeRuns.map((r) => r.id), [held[0].id]);
    assert.equal(feedB.fetchCalls, 0, 'D: refused invocation did not start Discovery');
    assert.equal(countersB.llm, 0, 'D: no Discovery LLM call');
    assert.equal(count(e.storage, 'discovery_observations'), 0, 'D: refused invocation did no ledger work');
    assert.equal(runnerStageCallsB, 0, 'E: refused invocation did not run the runner');

    const evidence = refusals(e.storage);
    assert.equal(evidence.length, 1);
    assert.equal(evidence[0].run_id, held[0].id);
    assert.match(evidence[0].reason, /AUTONOMOUS_RUN_ACTIVE/);

    gate.resolve();
    const aResult = await a;
    assert.equal(aResult.refused, undefined);
    assert.equal(runs(e.storage)[0].status, 'COMPLETED');
    assert.equal(runs(e.storage).length, 1);
  } finally { e.cleanup(); }
});

test('A: two simultaneous invocations (Promise.all, two connections) -> exactly one acquires, exactly one refuses', async () => {
  const e = env();
  try {
    const storageB = e.open();
    await e.storage.migrate();
    const feedA = new Feed(STORIES);
    const feedB = new Feed(STORIES);
    const [ra, rb] = await Promise.all([
      e.invoke(e.storage, { source: feedA }),
      e.invoke(storageB, { source: feedB })
    ]);
    const refused = [ra, rb].filter((r) => r.refused);
    const ran = [ra, rb].filter((r) => !r.refused);
    assert.equal(refused.length, 1);
    assert.equal(ran.length, 1);
    assert.equal(feedA.fetchCalls + feedB.fetchCalls, 1, 'Discovery executed exactly once');
    assert.equal(runs(e.storage).length, 1);
    assert.equal(runs(e.storage)[0].status, 'COMPLETED');
  } finally { e.cleanup(); }
});

test('F: Discovery + ledger cannot overlap: while A is mid-Discovery (ledger already prepared) B is refused and the ledger holds exactly A\'s single pass', async () => {
  const e = env();
  try {
    const storageB = e.open();
    await e.storage.migrate();
    const entered = deferred();
    const gate = deferred();
    let first = true;
    const gatedFeatures = async (observation) => {
      if (first) { first = false; entered.resolve(); await gate.promise; }
      return featuresFor(observation);
    };
    const feedB = new Feed(STORIES);
    const countersB = { llm: 0 };

    const a = e.invoke(e.storage, { source: new Feed(STORIES), rawFeatures: gatedFeatures });
    await entered.promise; // ledger prepared (NOT_EVALUATED rows written), Discovery in flight

    const midRows = e.storage.all('SELECT * FROM discovery_observations');
    assert.equal(midRows.length, STORIES.length);
    assert.ok(midRows.every((r) => r.evaluation_outcome === 'NOT_EVALUATED' && r.times_seen === 1));

    const b = await e.invoke(storageB, { source: feedB, counters: countersB });
    assert.equal(b.refused, true);
    assert.equal(feedB.fetchCalls, 0);
    assert.equal(countersB.llm, 0);
    const afterB = e.storage.all('SELECT * FROM discovery_observations');
    assert.ok(afterB.every((r) => r.times_seen === 1), 'B did not read or write the ledger');

    gate.resolve();
    await a;
    const final = e.storage.all('SELECT * FROM discovery_observations');
    assert.ok(final.every((r) => r.times_seen === 1 && r.evaluation_outcome !== 'NOT_EVALUATED'));
  } finally { e.cleanup(); }
});

// ---------------------------------------------------------------- B / C / G

test('B/G: normal completion releases the guard; the next invocation acquires and behaves normally', async () => {
  const e = env();
  try {
    const first = await e.invoke(e.storage, { source: new Feed(STORIES) });
    assert.equal(first.refused, undefined);
    assert.equal(first.runner.stopReason, 'no_work');
    assert.equal(runs(e.storage)[0].status, 'COMPLETED');
    assert.equal(first.runner.runId, runs(e.storage)[0].id, 'one system_runs row per invocation');

    const second = await e.invoke(e.storage, { source: new Feed(STORIES) });
    assert.equal(second.refused, undefined);
    assert.equal(second.runner.stopReason, 'no_work');
    const all = runs(e.storage);
    assert.equal(all.length, 2);
    assert.ok(all.every((r) => r.status === 'COMPLETED'));
    assert.equal(all.filter((r) => r.status === 'RUNNING').length, 0);
  } finally { e.cleanup(); }
});

test('C: a failure inside Discovery releases the guard as FAILED; the next invocation acquires', async () => {
  const e = env();
  try {
    await assert.rejects(
      e.invoke(e.storage, { source: new Feed(STORIES), rawFeatures: () => { throw new Error('features exploded'); } }),
      /features exploded/
    );
    const [row] = runs(e.storage);
    assert.equal(row.status, 'FAILED');
    assert.match(row.stop_reason, /features exploded/);

    const next = await e.invoke(e.storage, { source: new Feed(STORIES) });
    assert.equal(next.refused, undefined);
    assert.equal(runs(e.storage).length, 2);
  } finally { e.cleanup(); }
});

test('C: a failure inside the runner releases the guard as FAILED (single release path, single row)', async () => {
  const e = env();
  try {
    await e.storage.migrate();
    e.storage.run(
      `INSERT INTO opportunities (id, title, source, discovered_at, status) VALUES (?, 'T', 'rss', ?, 'HANDED_TO_RESEARCH')`,
      [crypto.randomUUID(), new Date(T0).toISOString()]
    );
    await assert.rejects(
      e.invoke(e.storage, {
        source: new Feed([]),
        stageFns: { research: async () => { throw new Error('stage exploded'); } }
      }),
      /stage exploded/
    );
    const all = runs(e.storage);
    assert.equal(all.length, 1);
    assert.equal(all[0].status, 'FAILED');
    assert.match(all[0].stop_reason, /stage exploded/);
    const next = await e.invoke(e.storage, { source: new Feed([]) , stageFns: { research: async () => {} } });
    assert.equal(next.refused, undefined);
  } finally { e.cleanup(); }
});

test('C: the Owner override (LIVE while AUTONOMOUS_ENABLED=false) still fires at runner start, exactly where it did before; the guard is then released FAILED', async () => {
  const e = env();
  const savedEnabled = config.autonomousEnabled;
  config.autonomousEnabled = false;
  try {
    const feed = new Feed(STORIES);
    await assert.rejects(e.invoke(e.storage, { source: feed, mode: 'LIVE' }), AutonomousDisabledError);
    assert.equal(feed.fetchCalls, 1, 'override ordering unchanged: Discovery ran before the override fired');
    const [row] = runs(e.storage);
    assert.equal(row.status, 'FAILED');
    assert.equal(row.mode, 'LIVE');
    const next = await e.invoke(e.storage, { source: new Feed(STORIES) });
    assert.equal(next.refused, undefined, 'guard was released');
  } finally { config.autonomousEnabled = savedEnabled; e.cleanup(); }
});

// ---------------------------------------------------------------- pre-existing RUNNING row / no auto reclaim

test('D4/D10: a pre-existing RUNNING row is NEVER reclaimed automatically, however old; every invocation refuses and the row is untouched', async () => {
  const e = env();
  try {
    await e.storage.migrate();
    const orphanId = insertRunning(e.storage, { startedAt: '2001-01-01T00:00:00.000Z' });
    const before = e.storage.get('SELECT * FROM system_runs WHERE id = ?', [orphanId]);

    for (let i = 0; i < 2; i++) {
      const feed = new Feed(STORIES);
      const r = await e.invoke(e.storage, { source: feed });
      assert.equal(r.refused, true);
      assert.deepEqual(r.activeRuns.map((x) => x.id), [orphanId]);
      assert.equal(feed.fetchCalls, 0);
    }
    assert.deepEqual(e.storage.get('SELECT * FROM system_runs WHERE id = ?', [orphanId]), before, 'row byte-for-byte unchanged');
    assert.equal(runs(e.storage).length, 1);
    assert.equal(refusals(e.storage).length, 2);
  } finally { e.cleanup(); }
});

test('D10: several pre-existing RUNNING rows are all reported and none is touched', async () => {
  const e = env();
  try {
    await e.storage.migrate();
    const a = insertRunning(e.storage, { startedAt: '2020-01-01T00:00:00.000Z' });
    const b = insertRunning(e.storage, { startedAt: '2021-01-01T00:00:00.000Z' });
    const r = await e.invoke(e.storage, { source: new Feed(STORIES) });
    assert.equal(r.refused, true);
    assert.deepEqual(r.activeRuns.map((x) => x.id), [a, b]);
    assert.equal(runs(e.storage).filter((x) => x.status === 'RUNNING').length, 2);
  } finally { e.cleanup(); }
});

// ---------------------------------------------------------------- Owner reclamation

test('D5: Owner reclamation requires explicit Owner context, a reason, and a RUNNING target; anything else changes nothing', async () => {
  const e = env();
  try {
    await e.storage.migrate();
    const id = insertRunning(e.storage);
    const snapshot = () => JSON.stringify([runs(e.storage), e.storage.all('SELECT id FROM decision_log')]);
    const before = snapshot();

    assert.throws(() => reclaimOrphanedRun(e.storage, { runId: id, reason: 'crashed' }), OwnerReclamationError);
    assert.throws(() => reclaimOrphanedRun(e.storage, { runId: id, actor: 'SCHEDULER', reason: 'crashed' }), OwnerReclamationError);
    assert.throws(() => reclaimOrphanedRun(e.storage, { runId: id, actor: 'OWNER', reason: '   ' }), OwnerReclamationError);
    assert.throws(() => reclaimOrphanedRun(e.storage, { runId: 'nope', actor: 'OWNER', reason: 'x' }), /no system_runs row/);
    assert.equal(snapshot(), before);

    e.storage.run(`UPDATE system_runs SET status = 'COMPLETED' WHERE id = ?`, [id]);
    assert.throws(() => reclaimOrphanedRun(e.storage, { runId: id, actor: 'OWNER', reason: 'x' }), /not RUNNING/);
  } finally { e.cleanup(); }
});

test('D5: Owner reclamation preserves the historical run, records who/why, and only then can a new invocation acquire; a late finish() cannot erase it', async () => {
  const e = env();
  try {
    await e.storage.migrate();
    const id = insertRunning(e.storage, { startedAt: '2024-05-05T05:05:05.000Z', mode: 'SIMULATION' });
    const original = e.storage.get('SELECT * FROM system_runs WHERE id = ?', [id]);

    const refusedFirst = await e.invoke(e.storage, { source: new Feed(STORIES) });
    assert.equal(refusedFirst.refused, true);

    const result = reclaimOrphanedRun(e.storage, { runId: id, actor: 'OWNER', reason: 'process killed during deploy' });
    assert.equal(result.previousStatus, 'RUNNING');

    const after = e.storage.get('SELECT * FROM system_runs WHERE id = ?', [id]);
    assert.equal(after.status, 'STOPPED');
    assert.match(after.stop_reason, /^OWNER_RECLAIMED: process killed during deploy$/);
    assert.equal(after.started_at, original.started_at, 'history kept');
    assert.equal(after.mode, original.mode);
    assert.equal(after.config_snapshot, original.config_snapshot);
    assert.equal(count(e.storage, 'system_runs'), 1, 'old row NOT deleted');

    const log = e.storage.all(`SELECT * FROM decision_log WHERE decision = 'OWNER_RECLAIMED'`);
    assert.equal(log.length, 1);
    assert.equal(log[0].run_id, id);
    assert.match(log[0].reason, /actor=OWNER \(asserted, not authenticated\)/);
    assert.match(log[0].reason, /process killed during deploy/);
    assert.match(log[0].reason, /"started_at":"2024-05-05T05:05:05.000Z"/);
    assert.equal(refusals(e.storage).length, 1, 'earlier refusal evidence retained');

    // A "ghost" of the reclaimed run finishing late must not overwrite the reclaim evidence.
    new SystemRunRecorder(e.storage).finish(id, { status: 'COMPLETED', stopReason: 'late' });
    assert.equal(e.storage.get('SELECT status FROM system_runs WHERE id = ?', [id]).status, 'STOPPED');

    const next = await e.invoke(e.storage, { source: new Feed(STORIES) });
    assert.equal(next.refused, undefined);
    assert.equal(count(e.storage, 'system_runs'), 2);
  } finally { e.cleanup(); }
});

test('D5/D7: no autonomous code path can invoke reclamation (outside comments, only its definition and the Owner CLI reference it)', () => {
  const offenders = [];
  const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (p.endsWith('.js') && stripComments(fs.readFileSync(p, 'utf8')).includes('reclaimOrphanedRun')) offenders.push(path.relative(REPO, p));
    }
  };
  walk(path.join(REPO, 'src'));
  assert.deepEqual(offenders, [path.join('src', 'state', 'SystemRun.js')]);
  assert.ok(fs.readFileSync(RECLAIM_CLI, 'utf8').includes('reclaimOrphanedRun'));
});

// ---------------------------------------------------------------- D11 boundary

test('D11: the guard is the ENTRYPOINT boundary; direct runAutonomousOperation() callers are outside it (documented, deliberately not changed)', async () => {
  const e = env();
  try {
    await e.storage.migrate();
    const orphan = insertRunning(e.storage);
    const direct = await runAutonomousOperation({ storage: e.storage });
    assert.equal(direct.stopReason, 'no_work', 'a direct runner call is not blocked by the entrypoint guard');
    assert.equal(runs(e.storage).length, 2);

    const viaEntrypoint = await e.invoke(e.storage, { source: new Feed(STORIES) });
    assert.equal(viaEntrypoint.refused, true, 'the entrypoint still refuses because of the RUNNING row');
    assert.equal(e.storage.get('SELECT status FROM system_runs WHERE id = ?', [orphan]).status, 'RUNNING');
  } finally { e.cleanup(); }
});

// ---------------------------------------------------------------- real multi-process

function spawnChild(dbPath, goAt, holdMs) {
  const child = spawn(process.execPath, [CHILD, String(goAt), String(holdMs)], {
    cwd: REPO,
    env: { ...process.env, SQLITE_PATH: dbPath, RUN_MODE: 'SIMULATION', AUTONOMOUS_ENABLED: 'false' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  const marker = deferred();
  child.stdout.on('data', (d) => { stdout += d; if (stdout.includes('IN_DISCOVERY')) marker.resolve(); });
  child.stderr.on('data', (d) => { stderr += d; });
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  const result = () => {
    const line = stdout.split('\n').find((l) => l.startsWith('RESULT '));
    return line ? JSON.parse(line.slice('RESULT '.length)) : null;
  };
  return { child, exited, marker, result, out: () => ({ stdout, stderr }) };
}

async function runChildren(n, holdMs) {
  const e = env();
  try {
    // Pre-migrate: concurrent FIRST-TIME migration of a brand-new DB is outside
    // the guard (ADR-0024); steady state is what the guard protects.
    await e.storage.migrate();
    const goAt = Date.now() + 2500;
    const kids = Array.from({ length: n }, () => spawnChild(e.dbPath, goAt, holdMs));
    await Promise.all(kids.map((k) => k.exited));
    const results = kids.map((k) => k.result());
    for (const [i, r] of results.entries()) assert.ok(r, `child ${i} produced a result: ${JSON.stringify(kids[i].out())}`);
    return { e, results, kids, runRows: runs(e.storage), refusalRows: refusals(e.storage) };
  } catch (err) { e.cleanup(); throw err; }
}

test('A (multi-process): two simultaneous OS processes -> exactly one acquires, exactly one refuses', async () => {
  const { e, results, runRows, refusalRows, kids } = await runChildren(2, 2500);
  try {
    assert.equal(results.filter((r) => r.refused).length, 1);
    assert.equal(results.filter((r) => !r.refused && !r.error).length, 1);
    assert.equal(results.filter((r) => r.error).length, 0);
    const discoveryEntries = kids.filter((k) => k.out().stdout.includes('IN_DISCOVERY')).length;
    assert.equal(discoveryEntries, 1, 'Discovery started in exactly one process');
    assert.equal(runRows.length, 1);
    assert.equal(runRows[0].status, 'COMPLETED');
    assert.equal(refusalRows.length, 1);
  } finally { e.cleanup(); }
});

test('A (multi-process): five simultaneous OS processes -> exactly one acquires, four refuse', async () => {
  const { e, results, runRows, refusalRows, kids } = await runChildren(5, 3500);
  try {
    assert.equal(results.filter((r) => r.refused).length, 4);
    assert.equal(results.filter((r) => !r.refused && !r.error).length, 1);
    assert.equal(results.filter((r) => r.error).length, 0);
    assert.equal(kids.filter((k) => k.out().stdout.includes('IN_DISCOVERY')).length, 1);
    assert.equal(runRows.length, 1);
    assert.equal(refusalRows.length, 4);
  } finally { e.cleanup(); }
});

test('crash (SIGKILL mid-Discovery): RUNNING evidence remains, later invocations refuse, only explicit Owner reclamation (CLI) clears it, history is kept', async () => {
  const e = env();
  try {
    await e.storage.migrate();
    const victim = spawnChild(e.dbPath, Date.now(), 60_000);
    await victim.marker.promise; // guard acquired, inside Discovery
    victim.child.kill('SIGKILL');
    const { signal } = await victim.exited;
    assert.equal(signal, 'SIGKILL');

    const [orphan] = runs(e.storage);
    assert.equal(orphan.status, 'RUNNING', 'crash leaves RUNNING evidence; nothing marks it stale');

    const feed = new Feed(STORIES);
    const refused = await e.invoke(e.storage, { source: feed });
    assert.equal(refused.refused, true);
    assert.equal(feed.fetchCalls, 0);
    assert.equal(e.storage.get('SELECT status FROM system_runs WHERE id = ?', [orphan.id]).status, 'RUNNING');

    const runCli = (args) => new Promise((resolve) => {
      const p = spawn(process.execPath, [RECLAIM_CLI, ...args], {
        cwd: REPO, env: { ...process.env, SQLITE_PATH: e.dbPath }, stdio: ['ignore', 'pipe', 'pipe']
      });
      let out = ''; let err = '';
      p.stdout.on('data', (d) => { out += d; });
      p.stderr.on('data', (d) => { err += d; });
      p.on('exit', (code) => resolve({ code, out, err }));
    });

    const listed = await runCli(['--list']);
    assert.equal(listed.code, 0);
    assert.ok(listed.out.includes(orphan.id));

    const noActor = await runCli(['--run-id', orphan.id, '--reason', 'crash']);
    assert.equal(noActor.code, 1);
    assert.match(noActor.err, /explicit Owner context/);
    assert.equal(e.storage.get('SELECT status FROM system_runs WHERE id = ?', [orphan.id]).status, 'RUNNING');

    const ok = await runCli(['--run-id', orphan.id, '--actor', 'OWNER', '--reason', 'victim process was SIGKILLed in test']);
    assert.equal(ok.code, 0, ok.err);
    const kept = e.storage.get('SELECT * FROM system_runs WHERE id = ?', [orphan.id]);
    assert.equal(kept.status, 'STOPPED');
    assert.match(kept.stop_reason, /OWNER_RECLAIMED: victim process was SIGKILLed in test/);
    assert.equal(kept.started_at, orphan.started_at);

    const next = await e.invoke(e.storage, { source: new Feed(STORIES) });
    assert.equal(next.refused, undefined, 'after explicit reclamation the guard is available again');
    assert.equal(runs(e.storage).length, 2);
  } finally { e.cleanup(); }
});

test('D3/D9 (CLI): `node src/index.js` against a held guard prints the refusal, exits 3, executes nothing and records no run', async () => {
  const e = env();
  try {
    await e.storage.migrate();
    const orphan = insertRunning(e.storage);
    const out = await new Promise((resolve) => {
      const p = spawn(process.execPath, [path.join(REPO, 'src', 'index.js')], {
        cwd: REPO,
        env: { ...process.env, SQLITE_PATH: e.dbPath, RUN_MODE: 'SIMULATION', AUTONOMOUS_ENABLED: 'false', RSS_FEED_URLS: '' },
        stdio: ['ignore', 'pipe', 'pipe']
      });
      let stdout = ''; let stderr = '';
      p.stdout.on('data', (d) => { stdout += d; });
      p.stderr.on('data', (d) => { stderr += d; });
      p.on('exit', (code) => resolve({ code, stdout, stderr }));
    });
    assert.equal(out.code, 3);
    assert.match(out.stderr, /REFUSED: AUTONOMOUS_RUN_ACTIVE/);
    assert.ok(out.stderr.includes(orphan));
    assert.equal(out.stdout.includes('Autonomous entrypoint complete'), false);
    assert.equal(runs(e.storage).length, 1);
    assert.equal(refusals(e.storage).length, 1);
  } finally { e.cleanup(); }
});
