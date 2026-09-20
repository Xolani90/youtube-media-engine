# ADR-0023: Bounded Retries — One Automatic Retry Attempt Per Stage Per Autonomous Invocation

## 1. Status

**RECORDED — OWNER DECISION — IMPLEMENTED IN `src/autonomous/runner.js`**

Owner: **Xolani Tshabalala**

## 2. Purpose

This document records an Owner-approved amendment to the retry *pacing* of the
Bounded Retries + Quarantine governance workstream (implementation commit
`7cc6fc9`). It documents the decision and its implementation rationale. It does
not introduce policy beyond what the Owner authorized.

## 3. Context

The workstream authorized a 3-attempt cap per retry cycle for two failure
paths, persisted in `stage_retry_state` (migration `0016`), with quarantine on
exhaustion and Owner-only reactivation:

- **Production attempt** — one `runProduction()` invocation returning
  `ARTIFACT_WRITE_FAILED`.
- **Publication attempt** — one provider `EXPLICIT_FAILURE` persisted as
  `FAILED` (surfaced by `runPublication()` as `OUTCOME.PROVIDER_FAILURE`).

A read-only audit of `7cc6fc9` showed that `runAutonomousOperation()` re-selects
a still-eligible failing item on every sweep, and that the runner's
eligible-set signature guard (`no_progress`) only halts the run when *nothing*
in any stage changed. When unrelated work kept changing eligibility, the same
item could therefore consume all three attempts inside one invocation. The
governance specification was genuinely ambiguous on whether that was intended.

## 4. Decision

**Owner decision: Interpretation B is adopted.**

> The retry cap is three attempts per retry cycle, and no content item may
> consume more than one automatic retry attempt for the same stage during a
> single `runAutonomousOperation()` invocation.

Consequently:

- Attempt 1 may occur in autonomous run N; attempts 2 and 3 may occur only in
  later autonomous runs, while the item is below the cap.
- The third recorded failure produces QUARANTINED (unchanged).
- Owner reactivation starts a new retry cycle (unchanged).
- `AMBIGUOUS` is never automatically retried (unchanged).
- This pacing rule does not alter the definition of an attempt or the cap.

## 5. Implementation (run-local pacing)

Implemented only in `src/autonomous/runner.js`:

- `runAutonomousOperation()` creates an in-memory `Set` (`retryConsumed`) that
  lives for that invocation only. Keys are `${stage.name}:${contentBriefId}`.
- The `production` and `publication` stage descriptors carry a
  `consumedRetryAttempt(result)` predicate. Only these outcomes add the key:
  Production `ARTIFACT_WRITE_FAILED`; Publication `PROVIDER_FAILURE` (the
  repository's existing outcome for a confirmed provider failure).
- Before executing an item the loop skips it if its key is present; after a
  stage returns it adds the key if the predicate matches.
- Nothing else consumes the slot: not generic errors, D-C2
  `AUTHORIZATION_DENIED`, the SIMULATION veto, `AMBIGUOUS`, `BLOCKED`,
  `REJECTED`, or `NEEDS_REVIEW`. Those behave exactly as before.

**Key assumption (documented, not new).** The runner's items expose
`contentBriefId`; the durable counter is keyed by `content_version_id`. The
schema has no UNIQUE constraint on `content_versions.content_brief_id`, but
every stage resolves the single content version for a brief, so the two keys are
equivalent in current architecture. If a brief could ever map to several
content versions, this keying must be revisited.

## 6. Why the pacing set is not persisted

The rule is scoped to one in-process invocation, which an in-memory set
expresses exactly. Persisting a run identifier (a `stage_retry_state` column or
similar) would require a migration and new state for no additional guarantee
under single-run-at-a-time operation. The durable 3-attempt counter and
quarantine (`StageRetryPolicy`) remain the sole authority for exhaustion and are
unchanged.

## 7. Why runner signature semantics are unchanged

The set is checked at execution time only. The sweep snapshot and the
eligible-set signature are computed from the unfiltered eligible lists, as
before. Consequences, all intended:

- An isolated failing item still ends the run after one attempt with
  `no_progress` (2 sweeps).
- Changing unrelated work still produces further sweeps; the paced item is
  simply skipped during them.
- The run is never terminated early because of a retry failure; other items and
  stages continue. `no_work` / `no_progress` semantics are unchanged.

## 8. Reactivation note

Owner reactivation (`reactivateQuarantined`) requires
`ownerAction.actor === 'OWNER'` and a non-empty reason. This is a
governance-context assertion supplied by the caller, **not authentication**; no
stronger Owner-identity mechanism exists in the repository and none is
introduced here. `StageRetryPolicy` is unmodified by this amendment.

## 9. Not authorized by this decision

This amendment does NOT authorize: a scheduler; concurrency or lease control;
publication volume controls; LIVE YouTube publication or credentials; any D-C2
change; any Discovery or Discovery Memory Ledger change; or any NEEDS_REVIEW
automation. Direct calls to `runProduction()` / `runPublication()` outside the
runner are not paced by this mechanism; each remains one attempt under the
unchanged definition.

## 10. Verification

`tests/integration/bounded-retry-run-pacing.test.js` exercises the real runner,
selectors and pipelines (unrelated stages stubbed only to force multi-sweep
runs), covering Production and Publication attempts across runs N through N+3,
independent items, and the AMBIGUOUS / D-C2 denial / SIMULATION exclusions.
