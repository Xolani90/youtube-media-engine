#!/usr/bin/env node
/**
 * Local, opt-in collection of the fixed 24H / 7D analytics windows that
 * scripts/analytics-recommendations.js reads. Run it by hand (or from a
 * scheduler you set up yourself); nothing here installs a schedule.
 *
 *   node scripts/collect-analytics-windows.js            # plan only: prints what is due, calls nothing
 *   node scripts/collect-analytics-windows.js --run      # collects due windows via the existing collector
 *   options: --provider youtube  --retry-after-hours 6
 *
 * Needs the same YOUTUBE_* env vars as collect-youtube-analytics.js for --run.
 * Never touches publications, content state, generation or publishing.
 */
import { createStorage } from '../src/storage/index.js';
import { YouTubeAnalyticsAdapter } from '../src/analytics/youtube/YouTubeAnalyticsAdapter.js';
import { runWindowCollection, DEFAULT_RETRY_AFTER_HOURS } from '../src/analytics/windowCollection.js';

const argv = process.argv.slice(2);
const opts = { run: false, provider: 'youtube', retryAfterHours: DEFAULT_RETRY_AFTER_HOURS };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--run') opts.run = true;
  else if (a === '--provider') opts.provider = argv[++i];
  else if (a === '--retry-after-hours') opts.retryAfterHours = Number(argv[++i]);
  else { console.error(`unknown argument: ${a}`); process.exit(2); }
}
if (!(opts.retryAfterHours >= 0)) { console.error('--retry-after-hours must be a number >= 0'); process.exit(2); }

const storage = createStorage();
try {
  await storage.migrate();
  const res = await runWindowCollection({
    storage, provider: opts.provider, execute: opts.run, retryAfterHours: opts.retryAfterHours,
    adapter: opts.run ? new YouTubeAnalyticsAdapter() : null
  });
  if (res.status === 'LOCKED') { console.error('Another window collection is running (lock held); nothing done.'); process.exitCode = 3; }
  else {
    const { plan } = res;
    console.log(`Due now: ${plan.due.length} period(s); deferred ${plan.deferred.length}; not yet usable ${plan.notDue.length}; skipped publications ${plan.skipped.length}.`);
    for (const g of plan.due) console.log(`  ${g.periodStart}..${g.periodEnd} [${g.windows.join(',')}] ${g.publicationIds.length} publication(s)`);
    for (const s of plan.skipped) console.log(`  skipped ${s.publicationId}: ${s.reason}`);
    if (!opts.run) console.log('Plan only. Re-run with --run to collect.');
    for (const g of res.groups) console.log(g.error ? `  ${g.periodStart}..${g.periodEnd} ERROR ${g.error}` : `  ${g.periodStart}..${g.periodEnd}: ${g.collected} collected, ${g.unavailable} unavailable, ${g.failed} failed${g.aborted ? ' (aborted)' : ''}`);
    if (opts.run) { console.log(`Result: ${res.status}`); if (res.status !== 'OK') process.exitCode = 1; }
  }
} catch (err) {
  console.error(`Failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  storage.close();
}
