# ADR-0025: A4 Bounded Retry — Stage Wiring, Retry Eligibility, and Attempt Terminology

## 1. Status

**DRAFT — IMPLEMENTED IN THE WORKING TREE, NOT COMMITTED — PENDING OWNER REVIEW OF THE SLICE 2 CHECKPOINT**

Owner: **Xolani Tshabalala**. Amends the Bounded Retries + Quarantine governance
(migration `0016`, ADR-0023). It records the Owner's Slice 2 resolutions; it
introduces no policy beyond them. Slice 3 (formal A2 classification / evidence
machinery) is NOT part of this document.

## 2. Retry identity (migration 0017)

`stage_retry_state` / `stage_retry_cycle_history` are keyed `(stage, subject_id)`.
The stage decides what `subject_id` names; no identifier is ever fabricated:

| Stage | subject_id | Named outcome class |
|---|---|---|
| BRIEF | `research_projects.id` | GENERATION_RETRY_EXHAUSTED |
| SCRIPT | `content_briefs.id` | GENERATION_RETRY_EXHAUSTED |
| FACT_CHECK / ORIGINALITY / QUALITY_GATE | `content_versions.id` | STRUCTURAL_FAILURE |
| ASSET_PROVISIONING | `content_versions.id` | NO_ASSET_ACQUIRED, INVALID_PROVIDER_RESULT |
| MEDIA_PRODUCTION | `content_versions.id` | NARRATION_FAILED, RENDER_FAILED, VALIDATION_FAILED, ASSET_CHECKSUM_MISMATCH |
| PRODUCTION / PUBLICATION | `content_versions.id` | unchanged (ADR-0023) |

Research and Rights Verification are not retry stages.

## 3. A named outcome is a CLASS that MAY enter bounded retry — not an automatically retryable outcome

The actual failure must satisfy the transient / item-specific containment
policy. `src/state/StageRetryPolicy.js` `assessRetryEligibility()` is the single
place that decides; stage code never hard-codes "named outcome = retryable".

- Failure sites pass `evidence = { nature, basis }`.
- `TRANSIENT` with a non-empty `basis` → eligible; an attempt is recorded.
- `DETERMINISTIC` or `INFRASTRUCTURE` → not eligible.
- No evidence: `STRUCTURAL_FAILURE` and `ASSET_CHECKSUM_MISMATCH` default to
  `DETERMINISTIC` (approved policy); every other outcome is `UNESTABLISHED`.
  Neither is eligible. No transient classification is invented without repository evidence.
- A non-eligible failure is logged and returned exactly as before (existing stage
  contract) plus `retryDisposition: { eligible, nature, basis }`. It records no
  attempt, creates no retry state, and can never quarantine. It is not converted
  into a retry loop either: it behaves as it did before A4.
- Only an eligible failure records an attempt, in the same transaction as its
  decision_log entry; the 3rd attempt quarantines in that transaction.

Evidence supplied today: Brief / Script exhausted generation → TRANSIENT;
Asset Provisioning provider returned no asset / invalid result → TRANSIENT
(item-specific provider results); missing provider or provider throw →
INFRASTRUCTURE; malformed stored script body → DETERMINISTIC. Everything else
in Fact-check, Originality, Quality Gate and Media Production has no transient
evidence, so it consumes no budget until Slice 3 supplies classification.

## 4. A4 attempts are NOT provider-generation attempts

Brief and Script already run their own bounded internal generation loop
(`policy.generation.max_attempts`, default 3). That is unchanged. A4 is a
separate, autonomous-invocation-level mechanism:

- one whole `createBrief()` / `createScript()` invocation that ends in
  GENERATION_RETRY_EXHAUSTED counts as ONE A4 attempt;
- max 3 A4 attempts per `(stage, subject_id)`; max one automatic retry per
  stage/item per autonomous invocation (ADR-0023 pacing);
- A4 never counts, resets or alters the internal generation counter and adds no
  nested loop.

Worst case = 3 A4 attempts × the internal cap (9 provider generations at the
default cap of 3). **Accepted by the Owner as intended.**

## 5. Missing asset provider is configuration, not an item failure

`deps.assetProvisioning.provider` missing (or lacking `acquireVisualAsset`)
returns the existing `NO_ASSET_ACQUIRED` outcome with
`reason: 'PROVIDER_NOT_CONFIGURED'`, `configurationFailure: true` and structured
evidence in `decision_log.config_snapshot`. It is INFRASTRUCTURE: it consumes no
budget and never quarantines content. A provider that throws is likewise not a
provider result; the error is preserved as evidence. Final provider-wide /
infrastructure disposition is deferred to Slice 3.
