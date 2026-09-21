# ADR-0029: D1-D3, Process-Exit Documentation, Discovery Ledger Provenance and SELECTED Re-admission Policy

## 1. Status

**RECORDED, OWNER DECISIONS, GOVERNANCE ONLY**

Owner: **Xolani Tshabalala**. Baseline at recording:
`d0bb5c80fa0037c46dc402d6aec686a286c7d0f9` (HEAD = origin/main).

This is a **GOVERNANCE RECORD**. It records three Owner decisions (D1, D2, D3)
that were identified by the post-WS2-A governance audit. **It does not change
any code, test, configuration, migration or schema, and it authorizes no
implementation.** It does not amend ADR-0010, ADR-0023, ADR-0024, ADR-0026,
ADR-0027 or ADR-0028; their text is unchanged.

## 2. Scope

In scope: D1 (aggregate `FAILED` process-level behavior), D2 (Discovery
Observation Memory Ledger provenance) and D3 (`SELECTED` re-admission policy),
recorded together as one governance state.

Out of scope, and not decided, resolved or implied by this record: D4, D5, D6
and D7; the remaining WS2 work; WS3, WS4, WS5, WS6 and WS7.

## 3. D1: aggregate FAILED process-level behavior

**Owner decision: D1 = B.**

Document the current process-exit behavior without introducing a new
aggregate-`FAILED` exit-code contract at this time.

Recorded meaning:

- `system_runs.status = FAILED` remains the autonomous invocation outcome
  (ADR-0028 section 6).
- Process exit behavior is not changed by this record.
- No new numeric exit code is assigned or invented for aggregate `FAILED`.
- ADR-0024 refusal semantics (`REFUSED_EXIT_CODE` = 3) are unchanged.
- Any future change to process or operator exit semantics requires separate
  Owner authorization.

Current behavior of `node src/index.js` at baseline `d0bb5c8`, recorded as
observed, not as newly authorized policy:

| Situation | `system_runs.status` | Process exit |
|---|---|---|
| At least one attempted item, zero successes, all failures contained | `FAILED` | 0 |
| At least one success, with or without contained failures | `COMPLETED` | 0 |
| Zero attempted work | `COMPLETED` | 0 |
| Unclassified fatal throw | `FAILED` (stop reason = error message) | 1 (`main()` sets `process.exitCode = 1`) |
| Refused by the single-run guard (ADR-0024) | no `system_runs` row | 3 |

Further recorded facts: `runAutonomousOperation()` does not return the derived
status in its result, and `main()` prints a completion line (discovered,
selected, processed counts) whenever the invocation did not throw and was not
refused, including when the derived status is `FAILED`. Provider-wide and
infrastructure failure handling is not implemented (ADR-0028 section 8) and is
not affected by this record.

## 4. D2: Discovery Observation Memory Ledger provenance

**Owner decision: D2 = C.**

Ratify and document the current Discovery Ledger mechanics while explicitly
reserving the `SELECTED` re-admission policy to D3.

Provenance recorded: the ledger was introduced by commit `a69a239`
(2026-09-20, "persistent Discovery Observation Memory Ledger with 24h
reconsideration cooldown"). The migration and module headers describe it as an
"Owner-authorized workstream", but no governance record existed in the
repository before this one. This record retrospectively ratifies the mechanics
below. Provenance reconstruction follows the precedent of ADR-0014, ADR-0018
and ADR-0021.

Ratified current mechanics (as implemented at `d0bb5c8`):

- Storage: table `discovery_observations` (migration
  `0015_discovery_observations.sql`), one row per deterministic observation
  identity, with a unique `identity_key`.
- Identity ladder (`src/autonomous/discoveryMemory.js`): `SOURCE_ID` scoped to
  the feed, else `CANONICAL_URL`, else `TITLE`, else no identity. Identity is
  exact and never uses similarity. Observations with no identity are never
  recorded or suppressed.
- Evaluation outcomes: `NOT_EVALUATED`, `SELECTED`, `SCORED_NOT_SELECTED`,
  `NOT_SCORED_UNRESOLVED`.
- Lifecycle in the canonical entrypoint (`src/index.js`): derive identities,
  read the ledger (fail closed), apply the cooldown policy and mark admitted
  observations `NOT_EVALUATED` before any Discovery LLM call; run the unmodified
  Discovery pipeline; record outcomes only after Discovery returns
  successfully (fail closed, one transaction).
- Cooldown suppression: only a `SCORED_NOT_SELECTED` row is suppressed, while
  the time since `last_evaluated_at` is below
  `config/discovery_policy.json` -> `reconsideration.cooldownHours` (currently
  24). At exactly the cooldown the observation is admitted. A missing or
  invalid cooldown fails closed.
- Never suppressed by the ledger: `NOT_EVALUATED`, `NOT_SCORED_UNRESOLVED`,
  `SELECTED`, unknown identities and identity-less observations.
- A recorded `SELECTED` outcome is sticky: later passes do not overwrite it,
  so the ledger keeps the `opportunity_id` of the first selection.
- `alreadyProducedCorpus` is passed to Discovery as `[]` by the production
  entrypoint unless a caller supplies one.
- No database uniqueness prevents repeated opportunity rows: the only
  opportunity-related unique index is `research_projects(opportunity_id)`.

Explicit reservation: the `SELECTED` non-suppression listed above is recorded
here as an implementation fact only. It is **not** ratified as independently
settled policy by D2. D3 is the governing decision for `SELECTED` re-admission.

D2 does not authorize any change to the ledger, Discovery, cooldown rules,
identity rules, `SELECTED` behavior or `alreadyProducedCorpus`.

## 5. D3: SELECTED re-admission

**Owner decision: D3 = C.**

A previously `SELECTED` opportunity may be re-admitted only when the underlying
opportunity is materially updated.

Governance qualification (Owner-stated):

- "Materially updated" is **not yet implementation-defined**. No definition is
  supplied or implied by this record.
- No material-update detection is implemented or authorized here.
- A future implementation workstream must define deterministic
  evidence/criteria for a materially updated opportunity and obtain separate
  Owner authorization before any code changes.

Recorded divergence (documentation, not a violation finding): at baseline
`d0bb5c8` the ledger admits a previously `SELECTED` identity unconditionally, so
current behavior does not enforce this policy. That divergence stands until a
separately authorized workstream addresses it. Any such work must respect
ADR-0010, ADR-0023 section 9 and ADR-0024 section 8.

## 6. Consistency of D1, D2 and D3

The three decisions form one consistent governance state. D1 documents current
exit behavior without changing it. D2 records ledger mechanics without deciding
`SELECTED` policy. D3 supplies the governing policy for `SELECTED` and leaves
its enforcement to a future, separately authorized workstream. D2 and D3 do not
conflict, because D2 expressly defers `SELECTED` to D3.

## 7. Relationship to other records

- **ADR-0010.** Discovery stays outside the runner and no change to
  `src/discovery/*` is authorized. Unchanged.
- **ADR-0023 section 9 and ADR-0024 section 8.** They authorize no Discovery or
  Ledger change. Unchanged; this record does not either.
- **ADR-0024.** Refusal exit code 3 and its 0/1 wording are unchanged.
- **ADR-0026, ADR-0027.** Unchanged. U-1, U-3 to U-10 remain unresolved.
- **ADR-0028.** Aggregation rules unchanged; this record adds only the
  documented process-exit facts of section 3.

## 8. Implementation boundary

**No implementation authorization is created by this ADR.** No change is made to
`src/**`, `tests/**`, `config/**`, any migration, schema or dependency. The
following remain separately unauthorized: any aggregate-`FAILED` exit-code
contract; any ledger or Discovery change; `alreadyProducedCorpus` population;
material-update definition or detection; enforcement of D3; the remaining WS2
work; WS3, WS4, WS5, WS6 and WS7.

## 9. Open items

D4, D5, D6 and D7 are **not decided** by this record and are not inferred from
D1 to D3. The definition of "materially updated" is an open Owner item. The
stale sections of `docs/CHECKPOINTS/autonomous-operation-checkpoint.md` and the
missing WS1 provenance record are not addressed here.

## 10. Final status

```text
D1-D3 GOVERNANCE RECORD: RECORDED, OWNER DECISIONS
D1 = B, D2 = C, D3 = C. Governance only. No implementation authorized.
D4-D7 UNRESOLVED. "Materially updated" is not defined.
```
