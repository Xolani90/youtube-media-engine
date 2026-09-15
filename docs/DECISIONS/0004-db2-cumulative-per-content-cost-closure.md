# ADR-0004: D-B2 Cumulative Per-Content Cost Enforcement — Closure Record

## Status
Closed (Owner-ratified). Documentation-only governance record — no
implementation, test, or configuration changes are contained in this
commit.

## Context
ADR-0002 deferred D-B2 (cumulative per-content budget), retaining only
the D-B1 per-call ceiling. The Owner subsequently authorized
implementation of D-B2. That implementation was carried out, and its
result was independently verified against the actual pushed commit on
the Windows development environment. This record closes D-B2 at that
verified implementation commit. This document does not itself implement,
modify, or re-verify anything — it records that the Owner's closure
decision has been made and on what evidence.

## Implementation Baseline
- Implementation commit: `9fe4911b233244b42a89731500ec15befef22106`
- `HEAD == origin/main` at verification, both equal to the commit above
- Working tree clean at verification
- Exactly four files changed by the implementation commit:
  - `.env.example`
  - `src/config/index.js`
  - `src/state/CostTracker.js`
  - `tests/unit/cost-tracker-cumulative.test.js`
- Commit statistics: 339 insertions, 1 deletion

## Verification Evidence
- Focused D-B2 test group (`tests/unit/cost-tracker-cumulative.test.js`):
  **13/13 passing**
- Full test suite (verified on the Windows development environment):
  **337/337 passing** — 0 failed, 0 cancelled, 0 skipped, 0 todo
- No tests beyond those actually run are claimed as evidence here.

## Ratified D-B2 Semantics
1. The accumulation unit is the lifetime of a single `content_id`.
2. The cumulative budget spans all pipeline stages (`job_stage` values);
   there is no stage-specific cumulative sub-budget.
3. Reruns/reprocessing of a `content_id` do not reset cumulative spend.
4. A new `content_id` starts an independent, unrelated cumulative
   budget.
5. A paid-provider attempt that reaches provider invocation consumes its
   estimated/reserved cost even if the provider subsequently fails.
6. Retries are separate attempts and each consumes its own
   estimated/reserved cost; a failed attempt's cost is not returned to
   the budget.
7. Free/local zero-cost calls do not consume the monetary cumulative
   budget.
8. A paid/nonzero call is rejected before recording when:
   `current cumulative recorded/reserved cost for content_id + new
   estimated cost > maxCumulativeCostPerContent`.
9. A rejected cumulative-budget call is rejected before provider
   invocation and before any `provider_calls` row is inserted.
10. The existing `provider_calls.content_id` column is reused; no schema
    change was made.
11. No new in-process locking was introduced.
12. Configuration is exposed as `maxCumulativeCostPerContent`
    (in-process) and `MAX_CUMULATIVE_COST_PER_CONTENT` (environment
    variable).
13. The default configuration value remains zero, consistent with the
    existing free-first behavior — a zero value means no budget is
    allocated, matching the convention of the pre-existing cost limits.

## Relationship to D-B1
D-B2 is additive to D-B1, not a replacement for it. D-B1's per-call
`maxCostPerContent` ceiling remains independently enforced, unchanged in
meaning or behavior. A call must satisfy both applicable limits — a call
that would violate either D-B1's per-call ceiling or D-B2's cumulative
ceiling is rejected, regardless of the state of the other.

## Accounting Semantics
Cumulative accounting is based on the system's existing
estimated/reserved cost bookkeeping (the same `estimated_cost` value
already used by the pre-existing daily/monthly spend checks), not on
actual provider invoices. Accordingly:
- A paid invocation that is accounted for and then fails during provider
  invocation still consumes its reserved/estimated cost against the
  cumulative budget — there is no rollback.
- Retries are separate attempts, each consuming its own reserved cost
  independently.
- No refund or invoice-reconciliation mechanism exists. This is
  unchanged from, and consistent with, the pre-call accounting
  consideration already recorded in ADR-0003.

## Scope Boundary
This closure record covers D-B2 only. It does not authorize, reopen, or
advance any of the following, all of which remain in the state ADR-0002
and ADR-0003 left them:
- D-B3 — monthly budget enforcement
- D-C2 — stronger Production/Publishing side-effect authorization
- D-E — Phase 2 requirement
- D-F — Phase 2 requirement for paid providers and Publishing
- Paid-provider adapters
- Publishing
- Billing/invoice reconciliation
- Any other deferred governance item

## Production Wiring Boundary
Production router call sites do not currently pass `contentId` into
`CostTracker.record()`. This was intentionally left outside the scope of
the D-B2 implementation that this record closes, matching the current
production configuration (a free `local-stub` provider, as already noted
in ADR-0003) under which no cumulative monetary ceiling is presently
exercised in practice. This closure record does not correct, wire, or
otherwise change that boundary. Doing so would require its own,
separately scoped and separately authorized implementation task.

## Governance Authority
This document records the Owner's decision to close D-B2 on the
evidence above. It is a governance record of that decision, not an
independent acceptance, freeze, or verification performed by an AI
agent on its own authority. The implementation and its verification
occurred prior to, and separately from, the creation of this document;
this document's role is limited to recording that closure accurately.

## Documentation-Only Change
This commit contains only this governance document. No implementation
code, test, configuration, migration, schema, or unrelated file is
changed by it.

## Consequences
D-B2 is closed at commit `9fe4911`. No further implementation work is
authorized by this record. Any future work — including production
`contentId` wiring, paid-provider adapters, or any deferred decision
listed above — requires its own separate, explicit Owner-approved
governance decision and implementation scope.
