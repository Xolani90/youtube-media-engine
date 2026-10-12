import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectAnalytics } from './collector.js';
import { loadEvidence, collectMeasurements, windowPeriods, DATA_LATENCY_DAYS } from './recommendations.js';

/**
 * Opt-in helper that collects the fixed 24H / 7D analytics windows used by the
 * recommendation generator, through the EXISTING collector only.
 *
 * Window definitions and "usable" timing are not re-implemented: they come from
 * recommendations.js (UTC days after the publish date; a window is due once
 * DATA_LATENCY_DAYS have passed after its end), so what this helper collects is
 * exactly what the generator will look for. Publications are selected with the
 * generator's own eligibility rules (PUBLISHED, public, not scheduled, linked to
 * a LIVE run, persisted publish timestamp), so simulated or unverifiable
 * publications never cost an API call.
 *
 * Due means: (a) no snapshot for the exact window yet, or (b) a snapshot exists
 * but is not SUCCESS (retried at most once per retryAfterHours). A SUCCESS
 * snapshot is never re-collected or overwritten. Nothing here touches
 * publications, content state, discovery, generation or publishing.
 */

export const DEFAULT_RETRY_AFTER_HOURS = 6;
export const LOCK_STALE_MS = 30 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const RETRYABLE = new Set(['snapshot_not_success', 'snapshot_collected_before_data_settled']);

/** Pure: which publication windows should be collected now. */
export function planWindowCollection(evidence, { now = new Date().toISOString(), retryAfterHours = DEFAULT_RETRY_AFTER_HOURS } = {}) {
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) throw new Error('planWindowCollection requires a valid now');
  const { collectionNeeded, exclusions } = collectMeasurements(evidence, { now });
  const pubById = new Map(evidence.publications.map((p) => [p.id, p]));
  const items = []; // { publicationId, window, periodStart, periodEnd, reason }
  const deferred = [];
  const notDue = [];
  const skipped = [];

  for (const c of collectionNeeded) {
    items.push({ publicationId: c.publicationId, window: c.window, periodStart: c.periodStart, periodEnd: c.periodEnd, reason: 'no_snapshot' });
  }
  for (const e of exclusions) {
    if (!e.window) { skipped.push({ publicationId: e.publicationId, reason: e.reason }); continue; }
    if (e.reason === 'window_not_yet_usable') { notDue.push({ publicationId: e.publicationId, window: e.window }); continue; }
    if (!RETRYABLE.has(e.reason)) continue;
    const pub = pubById.get(e.publicationId);
    const period = windowPeriods(pub.published_at)[e.window];
    const snap = evidence.snapshots.find((s) => s.publication_id === pub.id && s.period_start === period.start && s.period_end === period.end);
    const retryAtMs = Date.parse(snap?.collected_at) + retryAfterHours * HOUR_MS;
    if (Number.isFinite(retryAtMs) && nowMs < retryAtMs) { deferred.push({ publicationId: pub.id, window: e.window, retryAt: new Date(retryAtMs).toISOString() }); continue; }
    items.push({ publicationId: pub.id, window: e.window, periodStart: period.start, periodEnd: period.end, reason: 'retry_non_success' });
  }

  // One collector call per distinct exact period (publications sharing a publish date share it).
  const groups = new Map();
  for (const it of items) {
    const key = `${it.periodStart}|${it.periodEnd}`;
    if (!groups.has(key)) groups.set(key, { periodStart: it.periodStart, periodEnd: it.periodEnd, windows: new Set(), publicationIds: [] });
    const g = groups.get(key);
    g.windows.add(it.window);
    if (!g.publicationIds.includes(it.publicationId)) g.publicationIds.push(it.publicationId);
  }
  const due = [...groups.values()]
    .map((g) => ({ ...g, windows: [...g.windows].sort() }))
    .sort((a, b) => (a.periodStart + a.periodEnd).localeCompare(b.periodStart + b.periodEnd));
  return { now, dataLatencyDays: DATA_LATENCY_DAYS, due, deferred, notDue, skipped };
}

/** Exclusive local lock file; a lock older than staleMs is treated as left by a crash. */
export function acquireLock(lockPath, { nowMs = Date.now(), staleMs = LOCK_STALE_MS } = {}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, acquiredAt: new Date(nowMs).toISOString() }));
      fs.closeSync(fd);
      return () => fs.rmSync(lockPath, { force: true });
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      let age;
      try { age = nowMs - fs.statSync(lockPath).mtimeMs; } catch { continue; }
      if (age <= staleMs) return null;
      fs.rmSync(lockPath, { force: true });
    }
  }
  return null;
}

export const DEFAULT_LOCK_PATH = path.join(os.tmpdir(), 'ame-analytics-window-collect.lock');

/**
 * Plans and (unless execute is false) collects due windows via collectAnalytics.
 * Returns { status: 'LOCKED'|'PLANNED'|'OK'|'PARTIAL'|'FAILED', plan, groups }.
 */
export async function runWindowCollection({
  storage, adapter, provider = 'youtube', now = () => new Date().toISOString(), execute = true,
  retryAfterHours = DEFAULT_RETRY_AFTER_HOURS, lockPath = DEFAULT_LOCK_PATH, collect = collectAnalytics
}) {
  if (!storage) throw new Error('runWindowCollection requires storage');
  if (execute && (!adapter || typeof adapter.collect !== 'function')) throw new Error('runWindowCollection requires an adapter to execute');

  const release = acquireLock(lockPath);
  if (!release) return { status: 'LOCKED', plan: null, groups: [] };
  try {
    const plan = planWindowCollection(loadEvidence(storage, { provider }), { now: now(), retryAfterHours });
    if (!execute) return { status: 'PLANNED', plan, groups: [] };

    const groups = [];
    let aborted = false;
    for (const g of plan.due) {
      try {
        const s = await collect({ storage, adapter, provider, periodStart: g.periodStart, periodEnd: g.periodEnd, publicationIds: g.publicationIds, nowISO: now });
        groups.push({ periodStart: g.periodStart, periodEnd: g.periodEnd, windows: g.windows, eligible: s.eligible, collected: s.collected, unavailable: s.unavailable, failed: s.failed, aborted: s.aborted });
        if (s.aborted) { aborted = true; break; }
      } catch (err) {
        groups.push({ periodStart: g.periodStart, periodEnd: g.periodEnd, windows: g.windows, error: String(err?.message ?? err) });
        aborted = true;
        break;
      }
    }
    const bad = groups.some((g) => g.error || g.aborted || g.failed > 0);
    const anyOk = groups.some((g) => !g.error && g.collected > 0);
    const status = !bad ? 'OK' : anyOk ? 'PARTIAL' : 'FAILED';
    return { status, plan, groups, aborted };
  } finally {
    release();
  }
}
