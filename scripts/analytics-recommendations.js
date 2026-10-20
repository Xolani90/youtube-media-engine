#!/usr/bin/env node
/**
 * Manual, opt-in surface for read-only analytics recommendations. Nothing in
 * src/autonomous/runner.js or src/index.js calls this, and approving a
 * recommendation changes only that recommendation row.
 *
 *   node scripts/analytics-recommendations.js generate        # create PENDING findings; prints exclusions and windows still to collect
 *   node scripts/analytics-recommendations.js list [PENDING|APPROVED|REJECTED]
 *   node scripts/analytics-recommendations.js approve <id> [note]
 *   node scripts/analytics-recommendations.js reject <id> [note]
 */
import { createStorage } from '../src/storage/index.js';
import { generateRecommendations, listRecommendations, decideRecommendation } from '../src/analytics/recommendations.js';

const [cmd, arg, ...rest] = process.argv.slice(2);
const storage = createStorage();
try {
  await storage.migrate();
  if (cmd === 'generate') {
    const r = generateRecommendations({ storage });
    console.log(`status=${r.status} created=${r.created} existing=${r.existing}`);
    for (const reason of r.reasons) console.log(`  reason: ${reason}`);
    for (const c of r.collectionNeeded) console.log(`  collect: node scripts/collect-youtube-analytics.js --start ${c.periodStart} --end ${c.periodEnd}   # ${c.window} for ${c.providerItemId}`);
    const counts = {};
    for (const e of r.exclusions) counts[e.reason] = (counts[e.reason] ?? 0) + 1;
    for (const [reason, n] of Object.entries(counts)) console.log(`  excluded x${n}: ${reason}`);
  } else if (cmd === 'list') {
    for (const row of listRecommendations(storage, { status: arg ?? null })) console.log(`${row.id}  ${row.status}  ${row.provider_item_id}  ${row.window_kind}  ${row.metric}  ${row.summary}`);
  } else if (cmd === 'approve' || cmd === 'reject') {
    if (!arg) throw new Error(`${cmd} requires a recommendation id`);
    const row = decideRecommendation({ storage, id: arg, decision: cmd === 'approve' ? 'APPROVED' : 'REJECTED', note: rest.join(' ') || null });
    console.log(`${row.id} -> ${row.status}`);
  } else {
    console.error('usage: generate | list [status] | approve <id> [note] | reject <id> [note]');
    process.exitCode = 2;
  }
} catch (err) {
  console.error(`Failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  storage.close();
}
