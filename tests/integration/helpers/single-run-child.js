// Test helper (NOT a test: not matched by the `tests/integration/*.test.js`
// glob). Runs the REAL autonomous entrypoint in a separate OS process against
// a shared SQLite file, for the single-run protection (ADR-0024) multi-process
// and crash tests.
//
// argv: <goAtEpochMs> <holdMs>
// env : SQLITE_PATH (shared DB), RUN_MODE=SIMULATION, AUTONOMOUS_ENABLED=false
//
// The process waits until goAt (so several children start acquisition at
// effectively the same instant), then calls runAutonomousEntrypoint with a
// stub opportunity source whose fetchCandidates -- i.e. the first Discovery
// step -- prints a marker and then holds for holdMs. Discovery normally runs
// only AFTER the guard is acquired, so the marker proves acquisition.
import { runAutonomousEntrypoint } from '../../../src/index.js';

const goAt = Number(process.argv[2]);
const holdMs = Number(process.argv[3]);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const source = {
  id: 'child-feed',
  async fetchCandidates() {
    console.log('IN_DISCOVERY');
    await sleep(holdMs);
    return { candidates: [], failures: [] };
  },
  normalize: (raw) => raw
};

while (Date.now() < goAt) {
  await sleep(1);
}

try {
  const result = await runAutonomousEntrypoint({
    llmRouter: { async complete() { throw new Error('child helper: no LLM expected'); } },
    discovery: { opportunitySource: source, rawFeatures: () => { throw new Error('child helper: no features expected'); } },
    research: { sourceProvider: { id: 'none', async discoverCandidates() { return { candidates: [], failures: [] }; } } }
  });
  console.log(`RESULT ${JSON.stringify({
    refused: result.refused === true,
    reason: result.reason ?? null,
    runId: result.runner?.runId ?? null,
    activeRuns: result.activeRuns ?? null
  })}`);
} catch (err) {
  console.log(`RESULT ${JSON.stringify({ error: String(err && err.message) })}`);
  process.exitCode = 1;
}
