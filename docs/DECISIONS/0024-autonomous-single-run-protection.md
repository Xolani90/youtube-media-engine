# ADR-0024: Autonomous Single-Run Protection

## 1. Status

**RECORDED — OWNER DECISION — IMPLEMENTED IN `src/index.js` AND `src/state/SystemRun.js`**

Owner: **Xolani Tshabalala**

Baseline at implementation: `7f96213c7d2d6d9bd8c0c8a5b102082058d10f73`.

## 2. Purpose

This record documents the Owner-ratified single-run concurrency policy that was
authorized for implementation after the read-only concurrency / single-run
governance audit, and how it was implemented. It authorizes nothing beyond the
workstream it records (see section 8).

Sections 3 and 4 are strictly separated. Section 3 is **governance** (frozen by
the Owner). Section 4 is **implementation detail** (chosen by the implementing
agent within the authorization) and is NOT additional governance: changing any
of it does not require a new Owner decision so long as section 3 still holds.

## 3. Policy (GOVERNANCE — Owner-ratified)

| # | Decision |
|---|---|
| D1 | Only ONE autonomous invocation may be active at a time. |
| D2 | Protection covers the WHOLE autonomous entrypoint: migrate, Discovery RSS fetch/normalization, Discovery Memory Ledger preparation, Discovery pipeline, Discovery outcome recording, `runAutonomousOperation`, all stage sweeps, run completion. It does not begin only inside the runner. |
| D3 | Contention fails fast. A second invocation refuses. No waiting, no bounded wait, no automatic retry. A refused invocation yields a deterministic, observable result that another autonomous invocation is already active. |
| D4 | There is NO automatic time-based stale-run expiry. A `RUNNING` row is never inferred stale from its age. |
| D5 | A stale/orphaned run may be reclaimed ONLY by an explicit Owner action. No automatic, scheduler, timeout, heartbeat or PID reclamation. Reclamation preserves the historical evidence of the previous run. |
| D6 | Supported topology: one host, local SQLite, potentially multiple local processes. Multi-host, distributed locking and distributed leases are out of scope. |
| D7 | Manual and future scheduled autonomous invocations use the SAME protection boundary. No separate scheduler lock. The scheduler itself is not implemented or authorized here. |
| D8 | No UNIQUE constraint on `content_briefs`. The Brief race remains a separate data-integrity workstream (RG-05 Finding 4 stands as recorded). |
| D9 | A refused invocation is observable and is never recorded as a normal COMPLETED or FAILED autonomous run. |
| D10 | An existing `RUNNING` row that predates the guard is never reclaimed automatically; behavior is deterministic and Owner-controlled. |
| D11 | The canonical protection boundary is the production entrypoint. Direct `runAutonomousOperation()` invocation is intentionally outside that contract (see 4.7). |

`actor === "OWNER"` in the reclamation operation is a governance-context
assertion, not authentication.

## 4. Implementation (NOT governance)

### 4.1 Mechanism — reuse of `system_runs`, no new authority

The guard IS the existing `system_runs` row: an acquired autonomous run is a
`system_runs` row with `status = 'RUNNING'`; a refused invocation is NO
`system_runs` row. There is no second lock, lease, table, timer or heartbeat.
**No migration** was required or added.

### 4.2 Atomic acquisition

`SystemRunRecorder.acquireExclusive()` performs one statement inside a
transaction:

```sql
INSERT INTO system_runs (...)
SELECT ?, ?, ?, ?, 'RUNNING', ?
 WHERE NOT EXISTS (SELECT 1 FROM system_runs WHERE status = 'RUNNING')
```

A single write statement takes SQLite's write lock before evaluating the
`NOT EXISTS` subquery and SQLite serializes writers (WAL), so two connections or
processes on one host cannot both observe "no RUNNING row". `changes === 1`
means acquired; `changes === 0` means refused, and the blocking `RUNNING` rows
are read in the same transaction. There is no SELECT-then-INSERT gap. A busy
database (`SQLITE_BUSY` after the driver's default timeout) is an error, not a
refusal.

No partial UNIQUE index was added: an index over `status = 'RUNNING'` cannot be
created on a database that already holds more than one orphaned `RUNNING` row,
and no live database was available to assess for duplicates. The atomic
statement gives the same exclusion without touching existing data.

### 4.3 Where acquisition and release occur

`runAutonomousEntrypoint()` (`src/index.js`):

1. `storage.migrate()` — before acquisition, because the guard lives in the
   schema. Concurrent FIRST-TIME migration of a brand-new database is outside
   the guard (pre-existing behavior); steady-state `migrate()` is a no-op.
2. `acquireExclusive()` — before any Discovery fetch, ledger read or write.
3. Discovery, ledger, `runAutonomousOperation()`.
4. Release: `SystemRunRecorder.finish()` marks the row COMPLETED or FAILED.

The runner receives the already-acquired run through the existing injectable
`deps.systemRunRecorder` seam (`src/autonomous/runner.js` is unchanged), so one
invocation has exactly one `system_runs` row and `result.runner.runId` is that
row. The runner's own `finish()` is the release on the normal and runner-failure
paths; a `catch` in the entrypoint releases as FAILED for any failure that
occurs before/outside the runner's own finish (Discovery, ledger, Owner
override). If release itself cannot be written, the `RUNNING` row remains and
later invocations refuse (fail closed). The Owner-override
(`assertRunAllowed`) still fires at runner start, exactly where it did before.
No signal handlers, timers, leases or heartbeats exist.

### 4.4 Refusal result and evidence (D3, D9)

`runAutonomousEntrypoint()` RETURNS (does not throw)
`{ refused: true, reason: 'AUTONOMOUS_RUN_ACTIVE', activeRuns, recorded, discovery: null, runner: null }`.
`SystemRunRecorder.recordRefusal()` writes one `decision_log` row per blocking
run (`decision = 'INVOCATION_REFUSED'`, attached to that run) and never a
`system_runs` row. `node src/index.js` prints the refusal and exits with
`REFUSED_EXIT_CODE` (3), distinct from success (0) and failure (1).

### 4.5 Crash semantics (D4, D10)

A killed process leaves its `RUNNING` row. Every later invocation — including
one facing a `RUNNING` row that predates the guard, of any age — refuses.
Nothing inspects `started_at` to judge staleness.

### 4.6 Owner reclamation (D5)

`reclaimOrphanedRun(storage, { runId, actor, reason })` in `src/state/SystemRun.js`,
reachable via `node scripts/reclaim-autonomous-run.js --list` and
`--run-id <id> --actor OWNER --reason "<why>"`. It requires `actor === 'OWNER'`
(assertion only), a non-empty reason and a currently-`RUNNING` target (decided
atomically by the `UPDATE ... WHERE status = 'RUNNING'`). It keeps the old row
(status `STOPPED`, original `started_at`/`mode`/`config_snapshot` untouched,
`stop_reason = 'OWNER_RECLAIMED: <reason>'`) and writes a
`decision_log` row (`OWNER_RECLAIMED`) recording the assertion, reason and
previous state. `finish()` will not overwrite an Owner-reclaimed row, so a
wrongly reclaimed run that later finishes cannot erase the evidence. No code
under `src/` other than the definition calls it (enforced by a test). Before
reclaiming, the Owner must confirm the original process is really gone:
reclaiming a live run permits a second concurrent invocation.

### 4.7 Direct runner callers (D11)

`runAutonomousOperation()` remains directly callable (tests, helpers). It is not
wrapped and is not protected by the entrypoint guard; its own `start()` behavior
is unchanged. A test documents this boundary.

### 4.8 Existing assertion changed

`tests/integration/discovery-memory-entrypoint.test.js` (ledger write failure
after Discovery) previously asserted `system_runs` count `0` ("runner did not
start"). Because the guard is now acquired before Discovery, the entrypoint's
one run row exists and is released `FAILED` with the ledger error. The
assertion was replaced (not weakened) by: exactly one row, `FAILED`,
`stop_reason` matches the ledger error, and no stage work ran.

### 4.9 Tests

`tests/integration/single-run-protection.test.js` (17 tests) plus
`tests/integration/helpers/single-run-child.js`: refusal without Discovery /
ledger / runner activity; two simultaneous invocations (in-process, two
connections); two and five simultaneous real OS processes; Discovery/ledger
overlap; completion and failure release (Discovery, runner, Owner override);
pre-existing `RUNNING` rows (one and several); Owner reclamation and evidence
preservation; SIGKILL crash followed by refusal and CLI reclamation; static
check that no autonomous path references reclamation; the D11 boundary; and
`node src/index.js` against a held guard (prints the refusal, exits 3, runs
nothing).

## 5. Known limitations (unchanged by this record)

- The Brief `SELECT`-then-`INSERT` window (RG-05 Finding 4) is closed for
  invocations that go through the entrypoint, but is not a database-level
  guarantee; direct callers remain exposed (D8, D11).
- Item-level stuck states (e.g. a crashed `RESEARCHING` project, RG F1-C) are
  not recovered by run-level reclamation.
- Concurrent first-time migration of a brand-new database is not covered.
- A host whose clock or filesystem semantics defeat SQLite's file locking (for
  example a network filesystem) is outside the supported topology (D6).

## 6. Relationship to ADR-0023

ADR-0023 section 6 relied on "single-run-at-a-time operation" as an assumption.
For the autonomous entrypoint that assumption is now enforced. ADR-0023 is
otherwise unchanged; retry pacing, the durable retry counter and quarantine are
untouched.

## 7. Verification evidence

See the implementation commit message and the final report for suite totals.

## 8. Not authorized by this decision

This record does NOT authorize or implement: a scheduler, a GitHub Actions
workflow or cron, continuous autonomous operation, multi-host locking,
distributed leases, heartbeats, PID recovery, automatic stale-run expiry, a
Brief UNIQUE constraint, any Discovery or Discovery Memory Ledger change,
retry/quarantine changes, publication changes, D-C2 changes, publication volume
limits, `NEEDS_REVIEW` automation, LIVE YouTube or credential changes, Gate 2,
public visibility, AMBIGUOUS reconciliation, or item-level stuck-state recovery.
