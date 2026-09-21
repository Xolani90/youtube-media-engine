# ADR-0033: Durable Per-Observation Discovery Evaluation State

## 1. Status

**AUTHORIZED, OWNER DECISION RECORDED, IMPLEMENTATION PROCEEDING (NOT YET COMMITTED)**

Owner: **Xolani Tshabalala**. Baseline at recording:
`88d2fdb2decf57411b9272c1316c1dd9883e131c` (HEAD = origin/main).

This record follows the authorization-provenance pattern of ADR-0013: it
records the Owner's explicit implementation authorization and its exact scope
*before* any implementation code is changed. It **overrides the "no
Discovery / ledger change" restrictions of ADR-0010, ADR-0023 section 9,
ADR-0024 section 8 and ADR-0029 section 8 ONLY for the workstream defined in
section 5**. It does not amend the text of any of those records; their text is
unchanged, and every restriction they state remains in force outside the
scope below.

## 2. Problem

At baseline, `runDiscoveryPipeline` evaluates every admitted observation
(proposition generation, validation, feature extraction) and holds the results
in memory until global selection. Nothing about a completed evaluation is
durable and keyed to a stable identity: the `decision_log` rows written for
those stages use a random per-run candidate id (`src/discovery/pipeline.js`),
and `run_id` is `NULL` for Discovery rows in the production entrypoint. If a
run fails after some evaluations completed (provider rate limit, network
error, process interruption), the ledger rows stay `NOT_EVALUATED`
(non-suppressing) and the next run repeats all completed work.

Repository-established facts this decision relies on:

- Discovery population is exactly `memory.admitted` (`src/index.js`): the
  current fetch minus cooldown-suppressed identities.
- `identity_key` (`src/autonomous/discoveryMemory.js`, `deriveIdentity`) is the
  only stable cross-run identity. `candidateId`, `underlyingEventId`,
  opportunity ids and `decision_log` subject ids are random per run.
- Every evaluation stage consumes only `title` and `description`.
- Score and risk are pure functions of raw features plus current
  configuration (`scoring.js`, `riskGate.js`).
- `prepareDiscoveryMemory` resets `evaluation_outcome` to `NOT_EVALUATED` on
  admission but does not clear `last_evaluated_at`; `recordDiscoveryOutcomes`
  sets `last_evaluated_at` for every admitted identity after selection.
- `decision_log` is append-only audit history with cross-stage evidentiary
  consumers; no code updates or deletes its rows.

## 3. Owner authorization (verbatim scope)

> Introduce durable per-observation Discovery evaluation state so that
> completed evaluation work survives a failed/interrupted Discovery run and can
> be reused during a later run.
>
> `EVALUATION COMPLETE != SELECTION COMPLETE`
>
> A completed evaluation may be persisted before global selection. Global
> selection remains unchanged and occurs only after the current admitted
> population has either reused a valid durable evaluation, or completed a fresh
> evaluation. The current Discovery population remains **Model A: current
> admitted fetch only**. Do NOT implement persistent pending populations or
> full cross-run selection.

The Owner further instructed: do not expand scope, do not redesign Discovery,
do not add unrelated hardening, and do not modify behavior outside the
boundary recorded below.

## 4. Decisions recorded

1. **Model A population.** The selection population is the current
   `memory.admitted` population only. A durable evaluation for an identity
   that is absent from the current admitted population is never selected.
   Persistent pending populations and full cross-run selection are not
   authorized.
2. **Separate state.** Durable evaluation state is a new, additive store,
   separate from the ledger outcome state. The ledger outcome vocabulary
   (`NOT_EVALUATED`, `NOT_SCORED_UNRESOLVED`, `SCORED_NOT_SELECTED`,
   `SELECTED`) is unchanged and no evaluation-complete ledger state is added.
   A completed evaluation never causes a ledger outcome.
3. **`decision_log` remains audit-only.** It is not the resume store and is
   never read for resume. Reused evaluations are made distinguishable from
   fresh generation by a distinct decision value in the existing
   `PROPOSITION_GENERATION` stage; no `decision_log` schema or semantics change.
4. **Global selection unchanged.** `selectDiversePortfolio`, its score sort,
   `topK`, the similarity threshold, the risk-cleared filter, diversity
   semantics and candidate assembly order are unchanged. The selector cannot
   distinguish a reconstructed candidate from a freshly evaluated one.
5. **Content binding.** A record is bound to a fingerprint derived from
   exactly `title` and `description` (the only evaluation inputs). URL, source
   and feed are not content-binding inputs; feed is already part of identity.
6. **Evaluation contract version.** A record carries an evaluation contract
   version and is reusable only when it equals the current version. The version
   must be bumped whenever the proposition prompt or contract, the feature
   prompt or the set of value dimensions changes.
7. **Cycle-scoped reuse.** A record is reusable only if it was completed after
   the identity's ledger `last_evaluated_at` (or the identity has none).
   Outcome recording therefore closes the cycle, which preserves the 24h
   reconsideration (a fresh evaluation) and current `SELECTED` re-admission
   behavior. No age-based expiration is introduced.
8. **Current configuration on reuse.** Only LLM-derived artifacts (parsed
   proposition and raw feature values) are stored. On reuse, score and risk are
   recomputed by the existing functions from the current scoring weights,
   normalization and risk thresholds.
9. **Provider/model** are audit metadata only and never invalidate a record.
10. **Atomic commit.** Each observation's record is committed in a single
    statement after proposition validation and feature extraction succeed.
    Invalid propositions are not persisted (unchanged behavior), the
    feature-parser throw behavior is unchanged, and observations without a
    deterministic identity are never persisted.
11. **Failure invariant.** No ledger outcome is recorded until global
    selection has completed over the complete current admitted population. If
    any fresh evaluation fails, Discovery fails as it does today, no partial
    selection occurs, no ledger outcome is written, and previously committed
    evaluations remain available to the next run.

## 5. Authorized implementation scope

- One additive migration (`0020_discovery_evaluations.sql`) creating one table
  keyed by `identity_key`.
- A store module (`src/autonomous/discoveryEvaluationStore.js`) that reuses the
  existing `deriveIdentity`, reads the ledger `last_evaluated_at` read-only,
  and provides lookup and single-statement commit.
- An optional injected `evaluationStore` in `runDiscoveryPipeline`
  (`src/discovery/pipeline.js`). When absent, behavior is byte-for-byte the
  baseline behavior.
- Construction and injection of the store in `src/index.js`.
- Tests, including deliberate acknowledgement of the new latest migration in
  the two existing tests that pin it by name (both state this must be updated
  deliberately when a migration is added).

## 6. Explicitly protected (must not change)

`src/discovery/diversity.js`, `scoring.js`, `riskGate.js`, `dedup.js`,
`eligibility.js`, `proposition.js`, `featureComputation.js`, `similarity.js`,
`constants.js`; `src/autonomous/discoveryMemory.js` (write semantics),
migration `0015`, the `decision_log` and `opportunities` schemas and insertion
semantics, `src/autonomous/runner.js`, `workSelection.js`, the single-run
guard, the `HANDED_TO_RESEARCH` handoff, `config/*`, and the text of every
existing ADR.

## 7. Explicitly deferred (not implemented; discovered problems are documented only)

Workload budgets; clean budget-stop behavior; provider failure
classification; persistent pending populations; full cross-run selection;
cross-run `underlyingEventId`; durable Layer-3 dedup results; cross-run event
clustering; opportunity insertion idempotency; transactional opportunity
insertion; terminal-invalid evaluation persistence; feature-parser failure
redesign; record retention/cleanup; age-based expiration; the D3 "materially
updated" definition; new providers, LLMs, feeds, scoring, ranking or
portfolio-selection logic; analytics; unrelated autonomous behavior.

Known consequences that remain (documented, not addressed): a Discovery throw
still fails the whole invocation before the runner starts; Layer-3 dedup calls
still repeat every run and precede evaluation; invalid propositions are still
re-attempted each run; orphan evaluation records for identities that leave the
feed are not cleaned up; opportunity insertion remains non-transactional and
non-idempotent (ADR-0029 section 4).

## 8. Relationship to other records

- **ADR-0010, ADR-0023 section 9, ADR-0024 section 8, ADR-0029 section 8:**
  text unchanged; the restriction each states is overridden only for section 5.
- **ADR-0024:** the single-run guard boundary is unchanged; store reads and
  writes occur inside the guarded invocation.
- **ADR-0029 D2/D3:** ledger mechanics and the recorded `SELECTED`
  re-admission divergence are unchanged. Cycle-scoped reuse deliberately
  leaves both untouched.
- **Missing Discovery v0.6 specification (ADR-0010 C3):** not reconstructed.

## 9. Final status

```text
ADR-0033: AUTHORIZED, OWNER DECISION RECORDED.
Scope: durable per-observation evaluation state, Model A. Nothing else.
Not committed or pushed; acceptance, commit and push require separate
Owner authorization.
```