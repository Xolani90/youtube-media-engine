import { pathToFileURL } from 'node:url';
import { createStorage } from './storage/index.js';
import { LLMRouter } from './providers/llm/router.js';
import { detectContradiction as detectContradictionProd } from './research/contradictionDetector.js';
import { RssSource } from './providers/opportunity/RssSource.js';
import { PixabayAssetSourceProvider } from './providers/asset/PixabayAssetSourceProvider.js';
import { TavilySearchProvider } from './providers/research/TavilySearchProvider.js';
import { runDiscoveryPipeline } from './discovery/pipeline.js';
import { runAutonomousOperation } from './autonomous/runner.js';
import { computeRawFeatures } from './discovery/featureComputation.js';
import { config } from './config/index.js';
import { prepareDiscoveryMemory, recordDiscoveryOutcomes } from './autonomous/discoveryMemory.js';
import { SystemRunRecorder, assertRunAllowed, AUTONOMOUS_RUN_ACTIVE } from './state/SystemRun.js';

/**
 * Process exit code used when an invocation is REFUSED because another
 * autonomous invocation holds the single-run guard (ADR-0024). Distinct from
 * 0 (ran) and 1 (failed); nothing retries automatically.
 */
export const REFUSED_EXIT_CODE = 3;

/**
 * THE canonical autonomous entrypoint and the single-run protection boundary
 * (ADR-0024). One autonomous invocation may be active at a time:
 *
 *   migrate -> ACQUIRE guard (atomic, fail fast) -> Discovery RSS fetch
 *   -> Discovery Memory Ledger -> Discovery pipeline -> outcome recording
 *   -> runAutonomousOperation (all sweeps) -> RELEASE (COMPLETED / FAILED)
 *
 * The guard is the system_runs RUNNING row. It is acquired before ANY
 * Discovery/ledger work and released only by finish(). If the guard is held
 * the invocation is REFUSED: nothing after acquisition executes, no
 * system_runs row is created, and this function RETURNS
 * `{ refused: true, reason: 'AUTONOMOUS_RUN_ACTIVE', ... }` (it does not
 * throw). A crashed run leaves its RUNNING row, which is never inferred
 * stale; only explicit Owner reclamation (reclaimOrphanedRun) clears it.
 *
 * migrate() runs before acquisition because the guard lives in the database
 * schema. Concurrent FIRST-TIME migrations on a brand-new database are
 * outside this guard (pre-existing behavior; steady-state migrate is a no-op).
 *
 * Direct callers of runAutonomousOperation() (tests/helpers) are outside this
 * contract and are not protected by it. deps.systemRunRecorder is not honored
 * here: the entrypoint owns the run lifecycle.
 */
export async function runAutonomousEntrypoint(deps = {}) {
  const ownsStorage = !deps.storage;
  const storage = deps.storage ?? createStorage();
  const recorder = new SystemRunRecorder(storage);
  let guard = null;
  let released = false;

  try {
    await storage.migrate();

    const acquisition = recorder.acquireExclusive({ mode: deps.mode });
    if (!acquisition.acquired) {
      return {
        refused: true,
        reason: AUTONOMOUS_RUN_ACTIVE,
        activeRuns: acquisition.activeRuns,
        recorded: recorder.recordRefusal(acquisition),
        discovery: null,
        runner: null
      };
    }
    guard = acquisition;

    // The runner is handed the ALREADY-ACQUIRED run, so one invocation has
    // exactly one system_runs row. start() keeps the original Owner-override
    // ordering (assertRunAllowed at runner start, after Discovery); finish()
    // is the single release path.
    const guardedRecorder = {
      start: () => {
        assertRunAllowed({ mode: guard.mode });
        return { id: guard.id, mode: guard.mode };
      },
      finish: (runId, opts) => {
        const changes = recorder.finish(runId, opts);
        released = true;
        return changes;
      },
      logDecision: (runId, entry) => recorder.logDecision(runId, entry)
    };

    const llmRouter =
      deps.llmRouter ??
      new LLMRouter({
        priority: config.llmProviderPriority,
        allowPaidProviders: config.allowPaidProviders
      });

    const opportunitySource =
      deps.discovery?.opportunitySource ??
      new RssSource({
        feedUrls: config.opportunityProviderPriority.includes('rss')
          ? (process.env.RSS_FEED_URLS || '')
              .split(',')
              .map((url) => url.trim())
              .filter(Boolean)
          : []
      });

    // M2: deps.discovery.rawFeatures remains an explicit override (used by
    // tests and controlled callers). When not supplied, fall back to the
    // production feature-computation function, bound to the same
    // llmRouter constructed/injected above — Discovery itself is never
    // responsible for constructing providers.
    const rawFeatures =
      deps.discovery?.rawFeatures ??
      ((observation) => computeRawFeatures(observation, llmRouter));

    const {
      candidates,
      failures
    } = await opportunitySource.fetchCandidates();

    const observations = candidates.map((candidate) =>
      opportunitySource.normalize(candidate)
    );

    const discoveryPolicy =
      deps.discovery?.discoveryPolicy ?? config.discoveryPolicy;

    // Discovery Observation Memory Ledger: derive identities, read memory
    // (fail closed), apply the cooldown policy, and mark admitted
    // observations NOT_EVALUATED -- BEFORE any Discovery LLM call. Only
    // currently-eligible observations enter the unmodified pipeline.
    const memory = prepareDiscoveryMemory({
      storage,
      observations,
      sourceScope: opportunitySource.id ?? null,
      discoveryPolicy,
      now: deps.discovery?.now
    });

    const discoveryResult = await runDiscoveryPipeline({
      storage,
      runId: deps.discovery?.runId ?? null,
      observations: memory.admitted,
      llmRouter,
      discoveryPolicy,
      scoringWeights:
        deps.discovery?.scoringWeights ?? config.scoringWeights,
      alreadyProducedCorpus:
        deps.discovery?.alreadyProducedCorpus ?? [],
      topK: deps.discovery?.topK ?? config.discoveryTopK,
      rawFeatures
    });

    // Record outcomes only after Discovery returned successfully. If
    // Discovery threw, the rows stay NOT_EVALUATED (non-suppressing). A
    // failed write fails closed: the runner does not start.
    recordDiscoveryOutcomes({
      storage,
      plan: memory.plan,
      discoveryResult,
      now: deps.discovery?.now
    });

    const runnerResult = await runAutonomousOperation({
      ...deps,
      storage,
      systemRunRecorder: guardedRecorder,
      llmRouter,
      researchPolicy: deps.researchPolicy ?? config.researchPolicy,
      // RG-02: the production path must actually receive a concrete
      // contradiction detector (§10) -- deps.research.detectContradiction
      // was previously always undefined here, so Research silently ran
      // with contradiction checking disabled. A caller-supplied override
      // (tests, controlled callers) still takes priority.
      //
      // ADR-0015: the production path must also receive a concrete
      // sourceProvider -- deps.research.sourceProvider was previously
      // always undefined here, so SOURCE_DISCOVERY crashed on
      // `provider.discoverCandidates` in every real run that reached
      // Research. Default to TavilySearchProvider; a caller-supplied
      // override (tests, controlled callers) still takes priority.
      research: {
        ...deps.research,
        detectContradiction: deps.research?.detectContradiction ?? detectContradictionProd,
        sourceProvider: deps.research?.sourceProvider ?? new TavilySearchProvider()
      },
      briefPolicy: deps.briefPolicy ?? config.briefPolicy,
      scriptPolicy: deps.scriptPolicy ?? config.scriptPolicy,
      // Asset Provisioning previously had no default provider in the real
      // entrypoint: deps.assetProvisioning?.provider was always undefined
      // outside tests, so runAssetProvisioning() ran with no concrete
      // AssetSourceProvider. Default to the existing PixabayAssetSourceProvider;
      // a caller-supplied override (tests, controlled callers) still wins.
      assetProvisioning: {
        ...deps.assetProvisioning,
        provider: deps.assetProvisioning?.provider ?? new PixabayAssetSourceProvider()
      },
      production: {
        ...deps.production,
        artifactsDir:
          deps.production?.artifactsDir ?? config.productionArtifactsDir
      },
      media: {
        ...deps.media,
        artifactsDir:
          deps.media?.artifactsDir ?? config.mediaArtifactsDir
      }
    });

    return {
      discovery: {
        ...discoveryResult,
        memory: memory.summary,
        failures
      },
      runner: runnerResult
    };
  } catch (err) {
    // Any failure after acquisition (Discovery, ledger, Owner override, the
    // runner) must release the guard as FAILED. If the runner already
    // released it, this is skipped. If release itself cannot be written the
    // RUNNING row remains and the next invocation refuses (fail closed).
    if (guard && !released) {
      try {
        recorder.finish(guard.id, { status: 'FAILED', stopReason: err.message });
      } catch {
        // fail closed: RUNNING evidence stays for Owner reclamation
      }
    }
    throw err;
  } finally {
    if (ownsStorage) {
      storage.close();
    }
  }
}

async function main() {
  // No deps.discovery.rawFeatures supplied: runAutonomousEntrypoint falls
  // back to the production feature-computation function (M2).
  const result = await runAutonomousEntrypoint({});

  if (result.refused) {
    const ids = result.activeRuns.map((r) => r.id).join(', ') || 'unknown';
    console.error(
      `Autonomous entrypoint REFUSED: ${result.reason} (active run(s): ${ids}). ` +
      'Nothing was executed. If that run crashed, the Owner may reclaim it with ' +
      'scripts/reclaim-autonomous-run.js.'
    );
    process.exitCode = REFUSED_EXIT_CODE;
    return;
  }

  console.log(
    `Autonomous entrypoint complete: discovered=${result.discovery.stats.discovered}, ` +
    `selected=${result.discovery.stats.selected}, ` +
    `processed=${result.runner.processed.reduce((sum, item) => sum + item.count, 0)}`
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('Autonomous entrypoint failed:', err);
    process.exitCode = 1;
  });
}
