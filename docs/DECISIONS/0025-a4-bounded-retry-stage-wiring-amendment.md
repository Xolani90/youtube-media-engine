# ADR-0025: A4 Bounded Retry — Stage Wiring, Retry Eligibility, and Attempt Terminology

## 1. Status

**RECORDED — SLICE 1/2 IMPLEMENTATION COMMITTED**

Owner: **Xolani Tshabalala**. Amends the Bounded Retries + Quarantine governance
(migration `0016`, ADR-0023). It records the Owner's Slice 2 resolutions; it
introduces no policy beyond them.

The Slice 1/2 implementation was committed in
`b03b4bbe43496a4fbfb69d3986374a5641590546`
(`feat(autonomous): implement bounded failure containment slices 1-2`). This
supersedes the earlier "DRAFT, NOT COMMITTED" status line.

Slice 3 (formal classification / evidence machinery) is governed by **ADR-0026**
(and, for Research, ADR-0027). **Slice 3 implementation is not included in this
document and is not authorized merely by this amendment.** The corrections below
(sections 2, 3 and 5) are governance/documentation changes only and do not change
runtime behavior; where they describe behavior different from HEAD, the difference
is future work gated by ADR-0026.

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

Research is **not an A4 retry stage**. Research A9 terminalization,
reactivation and provider-wide handling are governed by **ADR-0027**, and no
Research retry counter is authorized. Rights Verification is not a retry stage.

## 3. A named outcome is a CLASS that MAY enter bounded retry — not an automatically retryable outcome

The actual failure must satisfy the transient / item-specific containment
policy. `src/state/StageRetryPolicy.js` `assessRetryEligibility()` is the single
place that decides; stage code never hard-codes "named outcome = retryable".

- Failure sites pass `evidence = { nature, basis }`.
- `TRANSIENT` with a non-empty `basis` → eligible; an attempt is recorded.
- `DETERMINISTIC` or `INFRASTRUCTURE` → not eligible.
- **Vocabulary (ADR-0026).** Two further semantics are recorded. *Provider-wide*:
  established by explicit structured provider-wide evidence, or by the ADR-0026
  repetition rule; it fails the invocation and is never budgeted. *Inconclusive*:
  a returned failure of a named outcome with no explicit classifying evidence;
  records no attempt, never quarantines, and is never converted to transient by
  outcome name. Whether inconclusive maps onto the existing `UNESTABLISHED` value
  or is named explicitly is an implementation matter under ADR-0026.
- No evidence: `STRUCTURAL_FAILURE` and `ASSET_CHECKSUM_MISMATCH` default to
  `DETERMINISTIC` (approved policy); every other outcome is `UNESTABLISHED`.
  Neither is eligible. No transient classification is invented without repository evidence.
- A non-eligible failure is logged and returned exactly as before (existing stage
  contract) plus `retryDisposition: { eligible, nature, basis }`. It records no
  attempt, creates no retry state, and can never quarantine. It is not converted
  into a retry loop either: it behaves as it did before A4, **except** that an
  *inconclusive* failure consumes the invocation pacing slot (the item is not
  re-called in that invocation) while still recording no retry attempt
  (ADR-0026 D1).
- Only an eligible failure records an attempt, in the same transaction as its
  decision_log entry; the 3rd attempt quarantines in that transaction.

Evidence supplied today: Brief / Script exhausted generation → TRANSIENT;
malformed stored script body → DETERMINISTIC; missing asset provider →
INFRASTRUCTURE.

**Corrected by ADR-0026 (governance; runtime change is future work):**

- The earlier statement "provider returned no asset → TRANSIENT" is **removed**.
  An explicit no-hit / no-candidate → **DETERMINISTIC**. An unexplained
  named-outcome failure → **INCONCLUSIVE**. Structured evidence controls
  classification, never the outcome name. `INVALID_PROVIDER_RESULT` keeps its
  structured `validation.reason` evidence. The Pixabay structured envelope is
  required by ADR-0026 (D2).
- **Media Production.** Failures without explicit structured evidence are
  inconclusive. The D7 infrastructure classifications (ENOENT, ENOSPC, EACCES,
  EIO, ENOBUFS, signal termination) fail the invocation. Deterministic Media
  failures (`ASSET_CHECKSUM_MISMATCH`, script-body violations) remain outside
  retry.
- Everything else in Fact-check, Originality and Quality Gate keeps its existing
  defaults and consumes no budget without explicit evidence.

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
budget and never quarantines content. **Under ADR-0026 (D4) that classification
is preserved and it now also fails the invocation.**

The earlier blanket statement that every provider throw is likewise contained as
INFRASTRUCTURE is **removed**. Under ADR-0026: an **unclassified throw is
run-fatal (FAILED)**; a throw carrying **explicit structured infrastructure
evidence is INFRASTRUCTURE and FAILED**. The error is preserved as evidence in
both cases.

The former deferral of the final provider-wide / infrastructure disposition to
Slice 3 is replaced by a cross-reference: see **ADR-0026** (sections 6, 9 and 10).
Implementing that behavior is not authorized by this amendment.
