#!/usr/bin/env node
/**
 * Phase 3 -- YouTube Analytics Collection. Manual, opt-in invocation
 * surface (mirrors scripts/reclaim-autonomous-run.js's own convention):
 * nothing in src/autonomous/runner.js or src/index.js calls this. The
 * repository's autonomous entrypoint (ContentStateMachine-driven, one
 * sweep per invocation until no_work/no_progress) has no natural
 * "eligible once, becomes ineligible" slot for a capability that
 * re-collects indefinitely over time against already-PUBLISHED items,
 * so Phase 3 deliberately stays a standalone surface rather than
 * expanding that sweep (Phase 3 spec §15/§25 step 6).
 *
 *   node scripts/collect-youtube-analytics.js --start 2026-09-01 --end 2026-09-24
 *   node scripts/collect-youtube-analytics.js --days 1   (yesterday, UTC, lifetime-to-date convenience)
 *
 * Never touches publication status, provider video ids, D-C2, or the
 * content state machine -- see src/analytics/collector.js's own
 * docstring for the isolation this script relies on.
 *
 * Requires the same YOUTUBE_CLIENT_ID / YOUTUBE_CLIENT_SECRET /
 * YOUTUBE_REFRESH_TOKEN env vars the publication YouTubeAdapter already
 * uses -- see src/analytics/youtube/YouTubeAnalyticsAdapter.js's
 * docstring for the OAuth SCOPE caveat (yt-analytics.readonly must
 * already have been granted to that refresh token; this script cannot
 * grant it).
 */
import { createStorage } from '../src/storage/index.js';
import { collectAnalytics } from '../src/analytics/collector.js';
import { YouTubeAnalyticsAdapter } from '../src/analytics/youtube/YouTubeAnalyticsAdapter.js';

function utcDateString(date) {
  return date.toISOString().slice(0, 10);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--start') out.start = argv[++i];
    else if (a === '--end') out.end = argv[++i];
    else if (a === '--days') out.days = Number(argv[++i]);
    else if (a === '--provider') out.provider = argv[++i];
    else { console.error(`unknown argument: ${a}`); process.exitCode = 2; return null; }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (args) {
  let periodStart = args.start;
  let periodEnd = args.end;
  if (!periodStart || !periodEnd) {
    const days = Number.isFinite(args.days) && args.days > 0 ? args.days : 1;
    const end = new Date();
    const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
    periodStart = periodStart ?? utcDateString(start);
    periodEnd = periodEnd ?? utcDateString(end);
  }

  const storage = createStorage();
  try {
    await storage.migrate();
    const adapter = new YouTubeAnalyticsAdapter();
    const summary = await collectAnalytics({
      storage,
      adapter,
      provider: args.provider ?? 'youtube',
      periodStart,
      periodEnd
    });
    console.log(
      `Analytics collection [${summary.periodStart}..${summary.periodEnd}]: ` +
      `${summary.eligible} eligible, ${summary.collected} collected, ` +
      `${summary.unavailable} unavailable, ${summary.failed} failed` +
      `${summary.aborted ? ' (run aborted early -- see decision_log)' : ''}.`
    );
    if (summary.failed > 0 || summary.aborted) process.exitCode = 1;
  } catch (err) {
    console.error(`Failed: ${err.message}`);
    process.exitCode = 1;
  } finally {
    storage.close();
  }
}