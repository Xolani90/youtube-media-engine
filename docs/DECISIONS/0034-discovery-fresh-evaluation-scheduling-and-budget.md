# ADR-0034: Discovery Fresh-Evaluation Scheduling and Budget

## 1. Status

**AUTHORIZED, OWNER DECISION RECORDED (SEMANTICS FROZEN), IMPLEMENTATION PROCEEDING.**

Owner: **Xolani Tshabalala**. This workstream extends ADR-0033 (durable
per-observation Discovery evaluation state) at baseline `bfa096a`. The Owner
reviewed and froze every semantic decision below before implementation
proceeded; none are assumptions, and none were left open for the implementing
agent to choose. It does not amend ADR-0033's text or reuse contract.

## 2. Problem

ADR-0033 lets a candidate's evaluation be durably reused across runs, but
places no limit on how many candidates are *freshly* evaluated in a single
run. A run with many never-evaluated or invalidated candidates still calls
the proposition and feature LLMs once per candidate, with no per-run ceiling
and no guarantee that older never-evaluated candidates are ever reached
before newer ones. This workstream adds a per-run budget on fresh
evaluations, ordered so that the least-recently-evaluated (or never
evaluated) candidates are served first.

## 3. Decision

### 3.1 Schedule identity

`last_fresh_evaluation_at` is scoped **per canonical `identity_key`**, using
the same `deriveIdentity()` (`src/autonomous/discoveryMemory.js`) ADR-0033
uses. It is NOT scoped per source, source scope, run, cycle, or feed. The new
`discovery_evaluation_schedule` table is keyed by `identity_key` alone.
`sourceScope` is passed to `deriveIdentity()` only so the schedule and the
ADR-0033 store agree on identity for the same observation; it plays no other
role in scheduling.

### 3.2 Budget semantics

The budget is **25 successful fresh candidate evaluations per Discovery
run** (`discoveryFreshEvaluationBudget`, default 25, overridable via
`DISCOVERY_FRESH_EVALUATION_BUDGET`). "Per run" means one invocation of the
Discovery pipeline. It is not a count of LLM calls (one evaluation may use
two), not a monetary budget, not a time-window or daily budget, and not
scoped per feed or per provider.

### 3.2.1 Configuration validity

`DISCOVERY_FRESH_EVALUATION_BUDGET` has exactly two valid states:

- **Absent.** The effective budget is the documented default, `25`.
- **Explicitly supplied and a non-negative integer** (in the mathematical
  sense: a whole number ≥ 0, with no fractional component). `0` is a valid,
  meaningful value — it means zero successful fresh evaluations are permitted
  for that Discovery run; all candidates requiring fresh evaluation are
  budget-skipped.

Any other explicitly supplied value is **invalid**, including but not
limited to: negative integers, fractional values, non-numeric strings, the
literal string `"NaN"`, the literal string `"Infinity"`, an empty string, and
a whitespace-only string.

An invalid explicitly-supplied value MUST cause Discovery run startup to fail
before any fresh evaluation begins, with an explicit, attributable
configuration error. Invalid configuration MUST NOT be silently
reinterpreted as `0`, MUST NOT silently fall back to the default `25`, and
MUST NOT result in an unbounded (uncapped) fresh-evaluation budget for that
run.

This subsection defines only the validity and failure contract for the
configuration value itself. It does not alter this section's default or
budget size, §3.3's accounting table, §3.4's reuse-first ordering, §3.5's
scheduling order, §3.6's atomicity/timestamp semantics, or §3.7–§3.9.

### 3.3 Budget accounting

| Outcome                     | Budget consumed |
| ---------------------------- | --------------: |
| Durable reuse                 |               0 |
| Budget skipped                |               0 |
| Failed fresh evaluation       |               0 |
| Successful fresh evaluation   |               1 |

A candidate is a successful fresh evaluation only once its
`discovery_evaluations` commit and `last_fresh_evaluation_at` write have both
been durably persisted.

### 3.4 Reuse first

ADR-0033 reuse is checked before a candidate ever enters scheduling. A
reusable candidate never occupies a budget slot and never updates
`last_fresh_evaluation_at`.

### 3.5 Scheduling order

Among candidates requiring fresh evaluation:
`last_fresh_evaluation_at ASC NULLS FIRST, identity_key ASC` — never-evaluated
candidates first, then oldest successful fresh evaluation, with
`identity_key` as a deterministic tie-break. No cursor, sequence number, or
other scheduling state is introduced.

### 3.6 Schedule timestamp

`last_fresh_evaluation_at` means exactly: the time the candidate's most
recent successful fresh evaluation was durably completed. It is written only
inside the same database transaction as the `discovery_evaluations` commit,
and only when that transaction succeeds. It is never updated by reuse,
budget skip, proposition failure, invalid proposition, raw-feature failure,
retry exhaustion, scoring, selection, or `recordDiscoveryOutcomes`.

### 3.7 New / unscheduled candidates

A candidate with no row in `discovery_evaluation_schedule` is treated as
`last_fresh_evaluation_at = NULL` and receives the highest priority. No
backfill migration is performed.

### 3.8 Orthogonality to ADR-0033

Content-fingerprint or contract-version changes invalidate ADR-0033 reuse as
before, but never rewrite `last_fresh_evaluation_at`; an invalidated
candidate is simply fresh-evaluated again in its normal scheduling order.
ADR-0033's reuse contract is unmodified.

### 3.9 Starvation boundary

Candidate-level rotation prevents permanent starvation within a persistently
eligible population, but does not guarantee a fixed service rate to old
never-evaluated candidates under unlimited continuous arrival of new
never-evaluated candidates. This is a known, accepted limitation; feed
quotas, arrival-rate controls, and other scheduling mechanisms are explicitly
out of scope for this decision.

## 4. Implementation

- `src/db/migrations/0021_discovery_evaluation_schedule.sql` — new table
  `discovery_evaluation_schedule (identity_key TEXT PRIMARY KEY,
  last_fresh_evaluation_at TEXT NOT NULL)`, plus a supporting index.
- `src/autonomous/discoveryEvaluationSchedule.js` — read-only
  `lastFreshEvaluatedAt` / `identityKey`, and `recordFreshEvaluation` (a
  single statement; atomicity is the caller's responsibility, exactly as
  `discoveryEvaluationStore.commit` already documents).
- `src/discovery/pipeline.js` — partitions accepted candidates into reused vs.
  needs-fresh, orders needs-fresh per §3.5, skips the tail beyond
  `freshEvaluationBudget` (logged as `decision: 'SKIPPED'`,
  `reason: 'fresh_evaluation_budget_exhausted'`), and wraps the
  `discovery_evaluations` commit + schedule write in `storage.transaction()`
  when a schedule is supplied. New `stats` fields: `reused`, `freshEvaluated`,
  `budgetSkipped`.
- `src/index.js` — constructs the schedule store for the production
  entrypoint (overridable via `deps.discovery.evaluationSchedule`, mirroring
  the existing `evaluationStore` pattern) and reads the budget from
  `config.discoveryFreshEvaluationBudget`.
- `config/discovery_policy.json` — unchanged; the budget is a deployment
  knob (`discoveryFreshEvaluationBudget` / `DISCOVERY_FRESH_EVALUATION_BUDGET`
  in `src/config/index.js`), not a Discovery policy threshold.

### 4.1 Test F (ADR-0033 regression suite)

`tests/integration/discovery-evaluation-store.test.js` Test F asserted
`assert.deepEqual(reused.stats, fresh.stats)`. The three new counters are
expected to differ between a fresh run and a reused run by design, so the
assertion was narrowed to exclude exactly `reused`, `freshEvaluated`,
`budgetSkipped` and compare every other field. No other assertion in Test F
changed.

## 5. Tests

- `tests/integration/discovery-evaluation-schedule.test.js` (new): migration
  shape, budget enforcement (skip count, zero extra LLM/feature calls,
  nothing persisted for skipped candidates), scheduling order (never-evaluated
  before oldest-timestamp, identity_key tie-break), reuse consuming zero
  budget and leaving the schedule untouched, commit/schedule-write atomicity,
  and unbudgeted back-compat when no schedule is supplied.
- `tests/integration/discovery-evaluation-store.test.js` Test F: narrowed per
  §4.1.
- `tests/integration/bounded-retry-run-pacing.test.js` and
  `tests/integration/a4-stage-retry-quarantine.test.js`: pinned
  `LATEST_MIGRATION` updated from `0020_discovery_evaluations.sql` to
  `0021_discovery_evaluation_schedule.sql`.

This sandbox cannot load the native `better-sqlite3` binding
(`ERR_DLOPEN_FAILED: invalid ELF header`), so none of the SQLite-dependent
tests above were executed here; all files were syntax-checked
(`node --check`) only. They require the Owner's Windows environment to run.
