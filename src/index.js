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

export async function runAutonomousEntrypoint(deps = {}) {
  const ownsStorage = !deps.storage;
  const storage = deps.storage ?? createStorage();

  try {
    await storage.migrate();

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

    const discoveryResult = await runDiscoveryPipeline({
      storage,
      runId: deps.discovery?.runId ?? null,
      observations,
      llmRouter,
      discoveryPolicy:
        deps.discovery?.discoveryPolicy ?? config.discoveryPolicy,
      scoringWeights:
        deps.discovery?.scoringWeights ?? config.scoringWeights,
      alreadyProducedCorpus:
        deps.discovery?.alreadyProducedCorpus ?? [],
      topK: deps.discovery?.topK ?? config.discoveryTopK,
      rawFeatures
    });

    const runnerResult = await runAutonomousOperation({
      ...deps,
      storage,
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
        failures
      },
      runner: runnerResult
    };
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
