# ADR-0028: U-2, Stage Success Definitions and Invocation Outcome Aggregation (WS2-A)

## 1. Status

**RECORDED, OWNER DECISION, IMPLEMENTED IN `src/autonomous/runner.js`**

Owner: **Xolani Tshabalala**.

Implementation commit: `d9d485d0df6fc607451c96beeb75a9c7b47eb73e`
(parent `cc1468991ad8e31707945c982c58bafc202015f3`).

This is a **GOVERNANCE RECORD**. It records the WS2-A contract that was
authorized and implemented. **It introduces no new policy and does not itself
change any code, test, configuration, migration or schema.**

## 2. Provenance of this record

The implementation named above was committed **before** this record existed.
This record was **not** committed before the implementation. It reconstructs the
WS2-A decision record, which was not present in the repository when
`d9d485d` was committed, and it resolves the open item U-2 that ADR-0026
section 16 left unresolved.

Nothing here changes what `d9d485d` does. Where this record and the committed
behavior could differ, the committed behavior of `d9d485d` is the reference and
this record describes it.

## 3. Scope

In scope: the per-stage definition of a successful stage attempt (U-2), and the
invocation-level aggregation that derives `system_runs.status` for a normal
termination of `runAutonomousOperation()`.

Out of scope, and unchanged by this record: see U-2-E (section 8).

## 4. U-2-A: stage success is stage-specific

A stage attempt counts as successful only when that stage's own existing result
contract is satisfied. The runner exposes each stage's existing contract as an
explicit success predicate (`isSuccess`) in the canonical `buildStages()` list.
No stage implementation was changed to support it.

The aggregation covers **all 11 canonical stages**, in this order:

`research -> brief -> script -> fact-check -> originality -> quality-gate -> production -> asset-provisioning -> rights-verification -> media-production -> publication`

No stage is excluded from aggregation.

| # | Stage | Success predicate, as committed in `d9d485d` |
|---|---|---|
| 1 | Research | The result is not `alreadyTerminal`, and the resulting project status is `RESEARCH_COMPLETE` or `INSUFFICIENT_EVIDENCE`. |
| 2 | Brief | `rejected === false` |
| 3 | Script | `rejected === false` |
| 4 | Fact-check | `outcome` is `PASS`, `REVIEW` or `EXISTING_RESULT_RETURNED` |
| 5 | Originality | `outcome` is `EVALUATED` or `EMPTY_CORPUS`, AND `transitioned === true` |
| 6 | Quality Gate | `aggregate === PASS`, AND `transitioned === true` |
| 7 | Production | `outcome` is `PRODUCED` or `ALREADY_PRODUCED` |
| 8 | Asset Provisioning | `outcome` is `PROVISIONED` or `ALREADY_PROVISIONED` |
| 9 | Rights Verification | `outcome` is `PROCESSED` |
| 10 | Media Production | `outcome` is `RENDERED` or `ALREADY_RENDERED` |
| 11 | Publication | `outcome` is `PUBLISHED` or `ALREADY_PUBLISHED` |

Notes on individual predicates:

- **Research.** A project that did not end in one of the two listed statuses is
  not a success. In particular `stopReason: 'SOURCE_DISCOVERY_FAILED'`, returned
  normally rather than thrown, is not a success. An already-terminal Research
  result (`alreadyTerminal: true`) is not counted as successful attempted work.
  `INSUFFICIENT_EVIDENCE` counts as success because it is a normal completeness
  evaluation outcome of the Research stage. See section 12 for the limitation
  attached to this decision.
- **Fact-check.** `EXISTING_RESULT_RETURNED` counts as success because it is an
  idempotent existing-result completion of the stage, regardless of whether the
  stored result it returns originated from a `PASS`, `REVIEW` or `REJECT`.
- **Originality and Quality Gate.** The transition requirement means the expected
  lifecycle transition actually occurred (`FACT_CHECK -> ORIGINALITY_CHECK` for
  Originality). A result without `transitioned === true` is not a success.
- **Malformed results.** Every predicate reads explicit stage-specific fields.
  A malformed, empty, `undefined` or unrecognized result shape does not satisfy
  any predicate and is therefore not a success. There is no fallback such as
  treating a missing or empty result as success, and no fallback for a stage that
  lacks a predicate.
- **No universal outcome vocabulary.** Predicates use each stage's own existing
  constants. No universal `SUCCESS` enum was introduced, and no stage's result
  shape was normalized.

## 5. U-2-B: contained non-success

A normally returned stage result that does not satisfy its stage-specific success
predicate is a **contained non-success**, unless an independently established
provider-wide, infrastructure or other fatal condition applies.

This record does not define a new universal failure taxonomy. Classification of
failures remains governed by ADR-0026 and `FailureClassification`.

## 6. U-2-C: invocation aggregation

For a normal termination of one autonomous invocation, status is derived as
follows:

1. Zero attempted items -> `COMPLETED`.
2. At least one attempted item and zero successful attempted items -> `FAILED`.
3. At least one successful attempted item -> `COMPLETED`.
4. Provider-wide failure -> `FAILED`, when provider-wide handling is implemented
   or established under the applicable governance (ADR-0026, ADR-0027). WS2-A
   does not implement it (section 8).
5. Infrastructure failure -> `FAILED`, on the same basis as item 4.
6. Unclassified fatal throw -> `FAILED`.
7. Fatal conditions fail fast.
8. Existing retry and quarantine semantics remain unchanged.
9. Stage success predicates are unchanged by aggregation.
10. Selector absence and not-selected items are neither success nor failure.
11. Missing-prerequisite and not-ready results (for example
    `NOT_YET_PRODUCED`) retain their existing semantics. When such a result is
    actually returned by an executed stage it is a contained attempted
    non-success. It does not automatically become an invocation failure merely
    because no progress occurred.
12. Aggregation uses the actual outcomes of attempted items in the current
    invocation. It never infers outcome retrospectively from database state.

### Invocation-local state

- The attempted and successful counters are created, at zero, for each autonomous
  invocation. They are local to `runAutonomousOperation()` and are not
  module-global.
- Only stage attempts whose `stage.run()` returned normally contribute. The
  attempted counter increments on any normal return; the successful counter
  increments only when the stage's predicate holds.
- Retry-paced skips occur before `stage.run()` and increment neither counter.
- The success or failure of any previous invocation cannot affect the status of
  the current invocation.

### Stop reasons

`no_work` and `no_progress` remain **stop reasons only**. They do not
independently determine final invocation status. In particular, `no_progress`
does not by itself produce `FAILED`.

### Fatal errors

An uncaught stage error retains its existing behavior. It records `FAILED` with
the error message as the stop reason, aborts the sweep (later work is not
executed) and is rethrown.

### Test-only `onStageError`

The canonical production entrypoint does not supply `onStageError`. When a caller
does supply it, a swallowed throw does not reach the counters, so it is not
counted as an attempt. This record defines no aggregation semantics for
swallowed errors and does not redesign that test-only behavior.

### Status vocabulary

WS2-A introduces no new status such as `PARTIAL` or `DEGRADED`, consistent with
ADR-0026 A7. It uses only the existing `COMPLETED` and `FAILED`, and introduces
no universal `SUCCESS` enum.

## 7. U-2-D: responsibility boundary

- ADR-0026 and `FailureClassification` define classification policy.
- WS2-A owns invocation-level aggregation only.
- The WS2-A implementation makes no new provider-wide or infrastructure
  classification decisions.
- `FailureClassification` remains a classifier. It does not own pipeline or
  invocation behavior.

## 8. U-2-E: scope boundary

WS2-A does not expand or change any of the following. Each remains governed by
its own record or deferred to its own authorized workstream:

- retry policy;
- quarantine policy;
- provider-wide detection;
- infrastructure detection;
- Research A9 handling;
- fallback policy;
- stage semantics;
- database schema.

## 9. Historical implementation reference

- Commit: `d9d485d0df6fc607451c96beeb75a9c7b47eb73e`.
- Parent: `cc1468991ad8e31707945c982c58bafc202015f3`.
- Authorized runtime scope, and the only files changed by the commit:
  - `src/autonomous/runner.js`
  - `tests/unit/autonomous-runner.test.js`

## 10. Relationship to other records

- **ADR-0026.** Section 9 (D4 invocation outcomes) recorded the invocation
  outcome rules and left the definition of a successful item open as U-2. This
  record resolves U-2. ADR-0026 is otherwise unchanged.
- **ADR-0027.** Governs Research A9, reactivation and Research provider-wide
  handling, and records the HEAD Research/Tavily behavior described in section 12.
- **ADR-0023, ADR-0024, ADR-0025.** Unaffected. Retry pacing, single-run
  protection and retry stage wiring are unchanged.

## 11. Implementation boundary

**No implementation authorization is created by this ADR.** It authorizes only its
own creation and the narrow U-2 cross-reference in ADR-0026. No change is made to
`src/**`, `tests/**`, `config/**`, any migration, schema or dependency.

## 12. Known limitation: Research provider failure masking

This is documented as a known limitation. It is **not** corrected by this record
or by WS2-A.

`src/research/acquisition.js` reads the discovery candidate collection
(`discovery.candidates`) without converting `discovery.failures` into a
provider-wide invocation failure. Consequently a provider failure such as a Tavily
authentication, rate-limit or missing-key failure can currently collapse into an
`INSUFFICIENT_EVIDENCE` Research outcome. ADR-0027 section 6 records this HEAD
behavior.

Therefore:

- WS2-A currently counts `INSUFFICIENT_EVIDENCE` as Research success, according to
  the approved stage-success contract.
- This does **not** mean the underlying provider failure is considered healthy.
- The provider-failure masking is a pre-existing Research behavior.
- Correcting it belongs to a separate Research and provider-wide workstream
  (ADR-0026 U-6, ADR-0027).
- No Research code is changed by this record, and WS2-A's success predicate is
  not retroactively changed.

## 13. Final status

```text
U-2 INVOCATION OUTCOME AGGREGATION RECORD: RECORDED, OWNER DECISION
Implemented in d9d485d. Governance only. No implementation authorized by this record.
U-2 is RESOLVED by this record. Provider-wide and infrastructure handling remain deferred.
```
