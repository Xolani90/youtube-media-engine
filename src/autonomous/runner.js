import { SystemRunRecorder } from '../state/SystemRun.js';
import { runResearchProject } from '../research/pipeline.js';
import { createBrief } from '../brief/pipeline.js';
import { createScript } from '../script/pipeline.js';
import { runFactCheck } from '../fact-check/pipeline.js';
import { runOriginalityCheck } from '../originality/pipeline.js';
import { runQualityGate } from '../quality-gate/pipeline.js';
import { runProduction } from '../production/pipeline.js';
import { runAssetProvisioning } from '../asset-provisioning/pipeline.js';
import { runRightsVerification } from '../rights-verification/pipeline.js';
import { runMediaProduction } from '../media/pipeline.js';
import { runPublication } from '../publication/pipeline.js';
import { OUTCOME as PRODUCTION_OUTCOME } from '../production/constants.js';
import { OUTCOME as PUBLICATION_OUTCOME } from '../publication/constants.js';
import {
  selectEligibleResearch,
  selectEligibleBriefs,
  selectEligibleScripts,
  selectEligibleFactChecks,
  selectEligibleOriginalityChecks,
  selectEligibleQualityGates,
  selectEligibleProductions,
  selectEligibleAssetProvisioning,
  selectEligibleRightsVerification,
  selectEligibleMediaProductions,
  selectEligiblePublications
} from './workSelection.js';

/**
 * Ordered list of stages the runner sweeps, in ContentStateMachine
 * order (checkpoint §9/§14). Each entry pairs a work-selection query
 * with the stage's own existing, UNMODIFIED run*() entry point -- the
 * runner never reimplements, wraps, or second-guesses stage logic
 * (checkpoint §15). `deps` is the same deps object passed to
 * runAutonomousOperation(); per-stage extra dependencies (an LLM
 * router, a research source provider, artifact directories, a
 * publication provider/adapter) are read from it here, with a
 * stage-specific override taking priority over a shared default.
 *
 * `deps.stageFns`, if provided, replaces one or more stages' actual
 * run*() entry point with a substitute of the same call signature
 * `(callArgs) => result`. This exists solely so tests can inject a
 * stage-function spy/mock per stage (checkpoint §16 item 2) without
 * touching real pipeline modules or real storage side effects; it is
 * never used by runAutonomousOperation itself in normal operation,
 * where every stage's real, unmodified run*() function is called.
 *
 * `startedMode` is the authoritative mode of this run, as returned by
 * SystemRunRecorder.start() (never the process-global config value on
 * its own -- see D-C2/ADR-0008 §3.1.1). It is forwarded only to the
 * publication stage, which is the only stage that performs a D-C2
 * external side effect.
 */
// Stage order: research -> brief -> script -> fact-check -> originality
// -> quality-gate -> production -> asset-provisioning -> rights-verification
// -> media-production -> publication (checkpoint §9/§14, extended for
// Milestone D's Asset Provisioning stage, inserted between Production and
// Media Production per its own frozen contract -- see
// src/asset-provisioning/pipeline.js -- and further extended per ADR-0013
// for Rights Verification, inserted between Asset Provisioning and Media
// Production per its own frozen contract -- see
// src/rights-verification/pipeline.js).
function buildStages(deps, startedMode) {
  const fn = deps.stageFns ?? {};
  return [
    {
      name: 'research',
      select: selectEligibleResearch,
      run: (item, runId) =>
        (fn.research ?? runResearchProject)({
          storage: deps.storage,
          opportunityId: item.opportunityId,
          sourceProvider: deps.research?.sourceProvider,
          llmRouter: deps.research?.llmRouter ?? deps.llmRouter,
          policy: deps.research?.policy ?? deps.researchPolicy,
          classification: deps.research?.classification,
          retrieveImpl: deps.research?.retrieveImpl,
          fetchImpl: deps.research?.fetchImpl,
          detectContradiction: deps.research?.detectContradiction,
          runId
        })
    },
    {
      name: 'brief',
      select: selectEligibleBriefs,
      run: (item, runId) =>
        (fn.brief ?? createBrief)({
          storage: deps.storage,
          researchProjectId: item.researchProjectId,
          llmRouter: deps.brief?.llmRouter ?? deps.llmRouter,
          policy: deps.brief?.policy ?? deps.briefPolicy,
          runId
        })
    },
    {
      name: 'script',
      select: selectEligibleScripts,
      run: (item, runId) =>
        (fn.script ?? createScript)({
          storage: deps.storage,
          contentBriefId: item.contentBriefId,
          llmRouter: deps.script?.llmRouter ?? deps.llmRouter,
          policy: deps.script?.policy ?? deps.scriptPolicy,
          runId
        })
    },
    {
      name: 'fact-check',
      select: selectEligibleFactChecks,
      run: (item, runId) =>
        (fn['fact-check'] ?? runFactCheck)({ storage: deps.storage, contentBriefId: item.contentBriefId, runId })
    },
    {
      name: 'originality',
      select: selectEligibleOriginalityChecks,
      run: (item, runId) =>
        (fn.originality ?? runOriginalityCheck)({ storage: deps.storage, contentBriefId: item.contentBriefId, runId })
    },
    {
      name: 'quality-gate',
      select: selectEligibleQualityGates,
      run: (item, runId) =>
        (fn['quality-gate'] ?? runQualityGate)({ storage: deps.storage, contentBriefId: item.contentBriefId, runId })
    },
    {
      name: 'production',
      select: selectEligibleProductions,
      // ADR-0023: a Production attempt is one runProduction() call
      // returning ARTIFACT_WRITE_FAILED; it consumes this item's single
      // automatic retry slot for the current invocation.
      consumedRetryAttempt: (result) => result?.outcome === PRODUCTION_OUTCOME.ARTIFACT_WRITE_FAILED,
      run: (item, runId) =>
        (fn.production ?? runProduction)({
          storage: deps.storage,
          contentBriefId: item.contentBriefId,
          artifactsDir: deps.production?.artifactsDir,
          runId
        })
    },
    {
      name: 'asset-provisioning',
      select: selectEligibleAssetProvisioning,
      run: (item, runId) =>
        (fn['asset-provisioning'] ?? runAssetProvisioning)({
          storage: deps.storage,
          contentBriefId: item.contentBriefId,
          provider: deps.assetProvisioning?.provider,
          runId
        })
    },
    {
      name: 'rights-verification',
      select: selectEligibleRightsVerification,
      run: (item, runId) =>
        (fn['rights-verification'] ?? runRightsVerification)({
          storage: deps.storage,
          contentBriefId: item.contentBriefId,
          runId
        })
    },
    {
      name: 'media-production',
      select: selectEligibleMediaProductions,
      run: (item, runId) =>
        (fn['media-production'] ?? runMediaProduction)({
          storage: deps.storage,
          contentBriefId: item.contentBriefId,
          artifactsDir: deps.media?.artifactsDir,
          runId
        })
    },
    {
      name: 'publication',
      // FROZEN -- see checkpoint §3/§13. Called exactly as any other
      // caller would: same function, same parameters, no bypass of
      // assertExternalActionAllowed, no write to
      // config/authorized_external_actions.json from here. The one
      // addition, `mode: startedMode`, is not a bypass -- it is what
      // lets runPublication's existing, unmodified
      // assertExternalActionAllowed({ action, mode }) call use this
      // run's actual persisted mode (D-C2) instead of silently falling
      // back to process-global config.runMode.
      select: selectEligiblePublications,
      // ADR-0023: a Publication attempt is one confirmed provider
      // EXPLICIT_FAILURE persisted as FAILED, surfaced by runPublication()
      // as OUTCOME.PROVIDER_FAILURE. AMBIGUOUS, AUTHORIZATION_DENIED and
      // every other outcome deliberately do NOT consume the slot.
      consumedRetryAttempt: (result) => result?.outcome === PUBLICATION_OUTCOME.PROVIDER_FAILURE,
      run: (item, runId) =>
        (fn.publication ?? runPublication)({
          storage: deps.storage,
          contentBriefId: item.contentBriefId,
          provider: deps.publication?.provider,
          adapter: deps.publication?.adapter,
          requestedPublishAt: deps.publication?.requestedPublishAt,
          runId,
          mode: startedMode
        })
    }
  ];
}

function eligibilitySignature(sweepEligible) {
  return sweepEligible
    .map(({ stage, items }) => `${stage.name}:${items.map((item) => JSON.stringify(item)).sort().join(',')}`)
    .join('|');
}

/**
 * Minimum Autonomous Operation runner (checkpoint §14, implementing Gap
 * 3 in §8). Once per invocation -- matching SchedulerDriver's own
 * documented "process is invoked once, run-to-completion, by an
 * external cron/GitHub Actions" contract, so there is no in-process
 * scheduling loop across invocations, no queue, and no new locking
 * (checkpoint §15):
 *
 * 1. Starts a system_runs record via the existing SystemRunRecorder.
 * 2. Repeatedly sweeps every stage, in ContentStateMachine order,
 *    running one plain SELECT per stage (src/autonomous/workSelection.js)
 *    to find eligible work, and invoking that stage's existing,
 *    unmodified run*() function for each eligible item -- so a single
 *    invocation carries an item through as many consecutive stages as
 *    it becomes eligible for, rather than deferring later stages to the
 *    next invocation.
 * 3. Stops the sweep loop as soon as a full sweep finds the exact same
 *    eligible-item set as the sweep before it -- this is the
 *    within-invocation infinite-loop guard: if a stage's own idempotent
 *    guard causes a call to legitimately no-op (e.g. Publication safely
 *    refusing to auto-retry an AMBIGUOUS attempt, checkpoint §4), the
 *    eligible set stops shrinking and the runner stops rather than
 *    looping forever on the same stuck item. It is not a new state
 *    machine, table, or lock -- purely a guard on this function's own
 *    loop.
 * 4. Finishes the system_runs record.
 *
 * Never touches Publication's internal claim/authorization logic, never
 * writes to config/authorized_external_actions.json, never grants
 * itself elevated permission (checkpoint §13, §15).
 *
 * @param {object} deps
 * @param {import('../storage/StorageDriver.js').StorageDriver} deps.storage
 * @param {object} [deps.llmRouter] - default LLM router for any stage below that doesn't get a more specific one
 * @param {object} [deps.researchPolicy] - default policy for Research (falls back to deps.research.policy override)
 * @param {object} [deps.briefPolicy] - default policy for Brief
 * @param {object} [deps.scriptPolicy] - default policy for Script
 * @param {object} [deps.research] - { sourceProvider, llmRouter, policy, classification, retrieveImpl, fetchImpl, detectContradiction } -- Research-stage overrides. detectContradiction defaults to the RG-02 production detector (src/research/contradictionDetector.js) when not overridden -- see src/index.js.
 * @param {object} [deps.brief] - { llmRouter, policy } -- Brief-stage overrides
 * @param {object} [deps.script] - { llmRouter, policy } -- Script-stage overrides
 * @param {object} [deps.production] - { artifactsDir }
 * @param {object} [deps.assetProvisioning] - { provider } -- Asset Provisioning-stage AssetSourceProvider override
 * @param {object} [deps.media] - { artifactsDir }
 * @param {object} [deps.publication] - { provider, adapter, requestedPublishAt }
 * @param {string} [deps.mode] - 'SIMULATION' | 'LIVE', forwarded to SystemRunRecorder.start(); defaults to config.runMode there
 * @param {SystemRunRecorder} [deps.systemRunRecorder] - injectable for tests; defaults to `new SystemRunRecorder(deps.storage)`
 * @param {(stageName: string, item: object, error: Error) => void} [deps.onStageError] - if provided, a thrown stage error is reported here and swallowed so the sweep continues with the next item; without it, a thrown error aborts the whole run (the system_runs record is marked FAILED) and is rethrown to the caller
 * @param {object} [deps.stageFns] - test-only per-stage function substitutes, keyed by stage name ('research', 'brief', 'script', 'fact-check', 'originality', 'quality-gate', 'production', 'asset-provisioning', 'rights-verification', 'media-production', 'publication'). Never used in normal operation.
 * @returns {Promise<{ runId: string, mode: string, sweeps: number, processed: Array<{ stage: string, count: number }>, stopReason: 'no_work' | 'no_progress' }>}
 */
export async function runAutonomousOperation(deps) {
  if (!deps || !deps.storage) {
    throw new Error('runAutonomousOperation requires deps.storage');
  }
  const { storage, mode, onStageError } = deps;
  const recorder = deps.systemRunRecorder ?? new SystemRunRecorder(storage);

  const { id: runId, mode: startedMode } = recorder.start(mode ? { mode } : {});
  const stages = buildStages(deps, startedMode);
  const processed = new Map(stages.map((s) => [s.name, 0]));
  let sweeps = 0;
  let stopReason = 'no_work';

  // ADR-0023 run-local retry pacing: keys `${stage.name}:${contentBriefId}`
  // of items that have already consumed their one automatic retry attempt
  // in THIS invocation. Deliberately in-memory and invocation-scoped (never
  // module-global, never persisted): it disappears when this function
  // returns, so the next autonomous invocation starts empty. The durable
  // 3-attempt counter/quarantine (StageRetryPolicy) remains authoritative.
  // contentBriefId is the runner's item identity; each stage resolves the
  // single content version for that brief, so it is equivalent to the
  // counter's content_version_id key.
  const retryConsumed = new Set();

  try {
    let previousSignature = null;

    for (;;) {
      sweeps += 1;
      const sweepEligible = stages.map((stage) => ({ stage, items: stage.select(storage) }));
      const totalEligible = sweepEligible.reduce((sum, s) => sum + s.items.length, 0);

      if (totalEligible === 0) {
        stopReason = 'no_work';
        break;
      }

      const signature = eligibilitySignature(sweepEligible);
      if (signature === previousSignature) {
        stopReason = 'no_progress';
        break;
      }

      for (const { stage, items } of sweepEligible) {
        for (const item of items) {
          // Skip only at execution time; the eligible lists and the
          // signature above are intentionally NOT filtered by this set, so
          // no_work / no_progress semantics are unchanged.
          const retryKey = `${stage.name}:${item.contentBriefId}`;
          if (stage.consumedRetryAttempt && retryConsumed.has(retryKey)) continue;
          try {
            const result = await stage.run(item, runId);
            processed.set(stage.name, processed.get(stage.name) + 1);
            if (stage.consumedRetryAttempt?.(result)) retryConsumed.add(retryKey);
          } catch (err) {
            if (onStageError) {
              onStageError(stage.name, item, err);
            } else {
              throw err;
            }
          }
        }
      }

      previousSignature = signature;
    }

    recorder.finish(runId, { status: 'COMPLETED', stopReason });
  } catch (err) {
    recorder.finish(runId, { status: 'FAILED', stopReason: err.message });
    throw err;
  }

  return {
    runId,
    mode: startedMode,
    sweeps,
    processed: [...processed.entries()].map(([stage, count]) => ({ stage, count })),
    stopReason
  };
}

export default runAutonomousOperation;