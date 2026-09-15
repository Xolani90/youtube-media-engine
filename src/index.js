// Foundation entry point for M0 Phase 1. Deliberately does NOT implement
// discovery/scoring/research/script logic — that is out of scope for this
// phase (see ADR-0001). This exercises: storage + migrations, run/audit
// model, autonomous gating, cost tracking, and provider routing against
// the local-stub provider, end to end, so the foundation is demonstrably
// working before pipeline logic is built on top of it.

import { createStorage } from './storage/index.js';
import { SystemRunRecorder } from './state/SystemRun.js';
import { CostTracker } from './state/CostTracker.js';
import { LLMRouter } from './providers/llm/router.js';
import { config } from './config/index.js';

async function main() {
  const storage = createStorage();
  await storage.migrate();

  const runs = new SystemRunRecorder(storage);
  const costs = new CostTracker(storage);

  const { id: runId, mode } = runs.start({ mode: config.runMode });
  console.log(`Started run ${runId} in ${mode} mode (autonomousEnabled=${config.autonomousEnabled})`);

  // Foundation smoke exercise: route a trivial completion through the
  // local-stub provider (zero-cost, zero-network).
  //
  // D-B1 corrective fix (ADR-0002): the same `costs` CostTracker used for
  // this run's accounting is now handed to the router itself, so the
  // router's built-in pre-call enforcement boundary (see router.js) is
  // actually live on this, the one real production execution path — not
  // just exercised in isolation by unit tests. The router performs its
  // own `costs.record()` call before invoking the provider; this is the
  // sole recording of this call (no separate post-call `costs.record()`
  // here anymore, which would have double-counted the same call against
  // daily/monthly spend).
  const router = new LLMRouter({ priority: ['local-stub'], costTracker: costs });
  const { providerUsed } = await router.complete(
    { prompt: 'foundation smoke test' },
    { runId, jobStage: 'foundation-smoke-test' }
  );

  runs.logDecision(runId, {
    subjectType: 'system',
    subjectId: runId,
    decision: 'foundation_smoke_test_completed',
    reason: `Routed a completion via ${providerUsed} to verify storage, run, cost, and provider layers work end to end.`,
    provider: providerUsed,
    resultingState: 'COMPLETED'
  });

  runs.finish(runId, { status: 'COMPLETED' });
  console.log('Foundation smoke run complete.');
  storage.close();
}

main().catch((err) => {
  console.error('Foundation run failed:', err);
  process.exitCode = 1;
});
