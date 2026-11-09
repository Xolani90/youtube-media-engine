import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectAnalytics } from './collector.js';
import { collectAudienceAnalytics, planAudienceCollection } from './audienceCollection.js';
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
 *
 * Audience reports (retention curve, traffic sources) ride the same run, the
 * same lock and the same window arithmetic: after the scalar collection, any
 * due audience reports are collected through ./audienceCollection.js. That
 * step runs only when the adapter implements both audience methods (an
 * adapter with just collect() behaves exactly as before) and is skipped when
 * the scalar collection aborted on an account-level failure.
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
  retryAfterHours = DEFAULT_RETRY_AFTER_HOURS, lockPath = DEFAULT_LOCK_PATH, collect = collectAnalytics, collectAudience = collectAudienceAnalytics
}) {
  if (!storage) throw new Error('runWindowCollection requires storage');
  if (execute && (!adapter || typeof adapter.collect !== 'function')) throw new Error('runWindowCollection requires an adapter to execute');

  const release = acquireLock(lockPath);
  if (!release) return { status: 'LOCKED', plan: null, groups: [] };
  try {
    const evidence = loadEvidence(storage, { provider });
    // One planning instant per invocation, shared by both planners. The `now` callback itself
    // is still passed unchanged to the collectors for their actual collection timestamps.
    const planNow = now();
    const plan = planWindowCollection(evidence, { now: planNow, retryAfterHours });
    const audiencePlan = planAudienceCollection(evidence, { now: planNow, retryAfterHours });
    if (!execute) return { status: 'PLANNED', plan, groups: [], audience: { plan: audiencePlan, result: null } };

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

    // Scalar outcome: computed exactly as before audience reports existed, and
    // fixed BEFORE any audience work so nothing audience-related can change it.
    const scalarBad = groups.some((g) => g.error || g.aborted || g.failed > 0);
    const scalarOk = groups.some((g) => !g.error && g.collected > 0);
    const scalarStatus = !scalarBad ? 'OK' : scalarOk ? 'PARTIAL' : 'FAILED';
    const scalarAborted = aborted;

    // Audience reports: only with an adapter that supports them, and not after an account-level abort.
    let audienceResult = null;
    if (!scalarAborted && audiencePlan.targets.length > 0) {
      const missing = ['collectRetentionCurve', 'collectTrafficSources'].filter((m) => typeof adapter[m] !== 'function');
      if (missing.length > 0) {
        // Audience work is DUE but this adapter cannot do it: an explicit configuration failure,
        // never a silent skip. No snapshot rows are written (nothing was attempted or observed).
        // Counts are individual requested reports (sum of kinds across targets), not targets.
        const reportCount = audiencePlan.targets.reduce((n, t) => n + t.kinds.length, 0);
        audienceResult = {
          error: `AUDIENCE_ADAPTER_UNSUPPORTED: adapter lacks ${missing.join(', ')}`, unsupported: true, missingMethods: missing,
          requested: reportCount, alreadyCollected: 0, collected: 0, unavailable: 0, failed: reportCount, aborted: false
        };
      } else {
        try {
          audienceResult = await collectAudience({ storage, adapter, provider, targets: audiencePlan.targets, nowISO: now });
        } catch (err) {
          audienceResult = { error: String(err?.message ?? err), requested: 0, collected: 0, unavailable: 0, failed: 0, aborted: true };
        }
      }
    }
    const audienceBad = Boolean(audienceResult && (audienceResult.error || audienceResult.aborted || audienceResult.failed > 0));
    const audienceOk = Boolean(audienceResult && !audienceResult.error && audienceResult.collected > 0);
    // DEFERRED: due audience work exists but nothing was attempted because an earlier failure is
    // still cooling down. Not a new failure (it was reported when it happened) and not success.
    const audienceDeferred = !audienceResult && audiencePlan.targets.length === 0 && (Boolean(audiencePlan.holdReason) || audiencePlan.deferred.length > 0);
    const audienceStatus = audienceDeferred ? 'DEFERRED' : !audienceResult ? null : !audienceBad ? 'OK' : audienceOk ? 'PARTIAL' : 'FAILED';

    // `status` and `aborted` describe the SCALAR run only, as they always have: an audience
    // success can never lift a failed scalar run, and an audience failure can never fail or
    // abort a clean one. `overallStatus` is the combined view for operators and exit codes.
    const overallBad = scalarBad || audienceBad;
    const overallOk = scalarOk || audienceOk;
    const overallStatus = !overallBad ? 'OK' : overallOk ? 'PARTIAL' : 'FAILED';
    return { status: scalarStatus, overallStatus, plan, groups, aborted: scalarAborted, audience: { plan: audiencePlan, result: audienceResult, status: audienceStatus, holdReason: audiencePlan.holdReason ?? null,
      // Explicit machine-readable reason for every DEFERRED run (account-level hold, else per-report cool-down).
      deferredReason: audienceStatus === 'DEFERRED' ? (audiencePlan.holdReason ?? 'retry_cool_down') : null } };
  } finally {
    release();
  }
}
