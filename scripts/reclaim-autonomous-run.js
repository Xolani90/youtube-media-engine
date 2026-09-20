#!/usr/bin/env node
/**
 * Owner-only reclamation of an ORPHANED autonomous run (ADR-0024).
 *
 * A crashed/killed autonomous invocation leaves its system_runs row RUNNING,
 * and every later invocation refuses (AUTONOMOUS_RUN_ACTIVE). The system
 * never treats a RUNNING row as stale by age, heartbeat, PID or scheduler;
 * this script is the ONLY sanctioned way to clear it. Nothing in src/ calls it.
 *
 *   node scripts/reclaim-autonomous-run.js --list
 *   node scripts/reclaim-autonomous-run.js --run-id <id> --actor OWNER --reason "<why>"
 *
 * `--actor OWNER` is an explicit governance-context assertion, NOT
 * authentication: whoever can run this against the database can reclaim.
 * Before reclaiming, confirm the run's process is really gone -- reclaiming a
 * live run would allow a second concurrent invocation.
 *
 * The old row is preserved (status STOPPED, original started_at/mode kept,
 * stop_reason "OWNER_RECLAIMED: <reason>") and a decision_log row records the
 * reclamation. The database is SQLITE_PATH (default data/media-engine.db).
 */
import { createStorage } from '../src/storage/index.js';
import { reclaimOrphanedRun, OwnerReclamationError } from '../src/state/SystemRun.js';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--list') out.list = true;
    else if (a === '--run-id') out.runId = argv[++i];
    else if (a === '--actor') out.actor = argv[++i];
    else if (a === '--reason') out.reason = argv[++i];
    else { console.error(`unknown argument: ${a}`); process.exitCode = 2; return null; }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (args) {
  const storage = createStorage();
  try {
    if (args.list) {
      const rows = storage.all(
        `SELECT id, mode, started_at FROM system_runs WHERE status = 'RUNNING' ORDER BY started_at, id`
      );
      if (rows.length === 0) console.log('No RUNNING autonomous runs.');
      for (const r of rows) console.log(`${r.id}\t${r.mode}\tstarted ${r.started_at}`);
    } else {
      const result = reclaimOrphanedRun(storage, { runId: args.runId, actor: args.actor, reason: args.reason });
      console.log(`Reclaimed run ${result.runId} (was ${result.previousStatus}, started ${result.previousStartedAt}). Evidence preserved.`);
    }
  } catch (err) {
    console.error(err instanceof OwnerReclamationError ? `Reclamation refused: ${err.message}` : `Failed: ${err.message}`);
    process.exitCode = 1;
  } finally {
    storage.close();
  }
}
