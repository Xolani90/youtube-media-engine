import { createStorage } from './storage/index.js';
import { LLMRouter } from './providers/llm/router.js';
import { RssSource } from './providers/opportunity/RssSource.js';
import { runDiscoveryPipeline } from './discovery/pipeline.js';
import { runAutonomousOperation } from './autonomous/runner.js';
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

    if (!deps.discovery?.rawFeatures) {
      throw new Error(
        'runAutonomousEntrypoint requires deps.discovery.rawFeatures; ' +
        'production Discovery feature computation is not implemented yet'
      );
    }

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
      rawFeatures: deps.discovery.rawFeatures
    });

    const runnerResult = await runAutonomousOperation({
      ...deps,
      storage,
      llmRouter,
      researchPolicy: deps.researchPolicy ?? config.researchPolicy,
      briefPolicy: deps.briefPolicy ?? config.briefPolicy,
      scriptPolicy: deps.scriptPolicy ?? config.scriptPolicy,
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
  const result = await runAutonomousEntrypoint({
    discovery: {
      rawFeatures: undefined
    }
  });

  console.log(
    `Autonomous entrypoint complete: discovered=${result.discovery.stats.discovered}, ` +
    `selected=${result.discovery.stats.selected}, ` +
    `processed=${result.runner.processed.reduce((sum, item) => sum + item.count, 0)}`
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('Autonomous entrypoint failed:', err);
    process.exitCode = 1;
  });
}
