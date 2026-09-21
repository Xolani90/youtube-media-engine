# ADR-0027: Research F1-C Reopening, A9 Terminalization, Reactivation and Provider-Wide Handling

## 1. Status

**RECORDED, OWNER-FROZEN DECISIONS**

Owner: **Xolani Tshabalala**. Authoritative baseline at recording:
`b03b4bbe43496a4fbfb69d3986374a5641590546` (HEAD = origin/main).

This is a **GOVERNANCE RECORD**. It is the separately numbered governance
decision required by ADR-0005 section 8. It records Owner authorization only and
**does not itself change any code, test, configuration or migration.**

## 2. Relationship to ADR-0005

- **This record does NOT edit ADR-0005.** ADR-0005's text is unchanged.
- It records a specific Owner authorization under ADR-0005 section 8 and
  supersedes only the F1-C row of ADR-0005 section 6 ("No remediation
  authorized"), and only for the mechanisms listed in this record.
- Everything else in ADR-0005 stays in force.
- ADR-0026 (general classification) governs how provider-wide failure is detected.
  This record governs what Research does with it.

## 3. What this record authorizes (and only this)

Owner authorization is recorded solely for:

- F1-C (no Research project timeout / lease / retry / resume mechanism);
- Research A9 terminalization;
- Research provider-wide handling;
- Owner-only reactivation;
- P1 and P2 handling;
- deduplication requirements;
- evidence and history preservation.

Implementation on the frozen Research surface (`src/research/**` and the
Research-specific portions listed in ADR-0005 section 4) is authorized in
principle for this scope only. **No implementation is authorized by this record
itself;** a separate Owner authorization is required for WS6, and it is blocked by
the unresolved items in section 12.

## 4. Explicitly preserved (not reopened)

- **F-5** remains accepted/frozen, except where the F1-C reactivation mechanics
  necessarily touch its already-identified re-entry behavior (see U-7, open).
- **F1-A** (non-atomic claim and claim-source writes) remains accepted; not reopened.
- Research eligibility semantics.
- The `RESEARCH_COMPLETE` terminal state.
- Contradiction detection semantics.
- Evidence grading semantics.
- Completeness semantics.
- The Research -> Brief contract, including that Brief eligibility depends on
  `RESEARCH_COMPLETE`.
- F-4, Brief uniqueness, and all other ADR-0005 section 6 limitations.

## 5. Decisions (Owner decision D5, with A9 and C2)

1. **Scope.** F1-C only.
2. **Identity.** `(RESEARCH, research_project_id)`. Reactivation reuses the same
   project. No new project is created.
3. **No retry counter.** No Research A4 counter, no `RETRY_STAGE` widening, no
   `stage_retry_state` row. A9 terminalization is not an A4 retry cycle.
   Research is not an A4 retry stage.
4. **Item-specific exception.** A Research exception is item-specific only with
   explicit structured item-specific evidence. There is **no residual rule**:
   absence of provider-wide evidence never implies item-specificity.
5. **Terminalization.** A qualifying item-specific exception sets the project
   FAILED, preserves evidence, and prevents reselection. Only Owner reactivation
   reverses it.
6. **Provider-wide.** Detection follows ADR-0026. A returned Tavily failure must
   be surfaced into invocation-level evidence. The invocation ends FAILED; the
   project **stays RESEARCHING** and is not terminalized or quarantined.
7. **Single unexplained failure.** The project stays non-terminal, evidence is
   recorded, and it is not terminalized.
8. **Owner reactivation.** An Owner-only operation (actor OWNER plus reason,
   mirroring the existing quarantine reactivation) returns the project to
   RESEARCHING and resets it so the normal selector can pick it on a future
   invocation. There is no direct-run bypass unless required by existing
   architecture. It applies to A9-terminalized and non-terminal held projects. It
   does not apply to `INSUFFICIENT_EVIDENCE` or `RESEARCH_COMPLETE`. The selector
   mechanism is open (U-1).
9. **P1** (RESEARCHING with partial rows after a crash or throw): state and data
   are left intact. No automatic recovery. Owner reactivation is required.
10. **P2** (FAILED after contradiction check, claims ungraded): resume from
    persisted claims at the contradiction/grading boundary where safe, over the
    loaded claim set, using the frozen detection, grading and completeness
    functions. "Safe" requires every persisted claim to have at least one
    `claim_sources` link. Otherwise treat as P1. Nothing is deleted.
11. **Deduplication on reactivation.** Existing rows are reused and new evidence
    attaches to them, using the existing `UNIQUE(claim_id, source_id, role)`.
    Claim identity uses normalized text, as the in-memory index does today.
    Source identity has no canonicalization today and must be defined (U-8).
    **A read-only duplicate assessment on real data is required before any
    uniqueness migration.** No blind UNIQUE. Deduplication never deletes
    historical evidence.
12. **Evidence and history.** Failure evidence goes to `decision_log`
    (append-only). Prior sources, claims, contradictions and terminal reasons
    remain readable. Reactivation is itself logged. **No historical evidence is
    deleted; failure and recovery history is append-only.**

## 6. HEAD paths that this record governs

The following HEAD behaviors are inconsistent with the decisions above and would
have to change under a future implementation authorization:

- a returned Tavily failure currently ends as terminal `INSUFFICIENT_EVIDENCE`;
- a thrown discovery error is caught and terminalized FAILED;
- `CONTRADICTION_CHECK_FAILED` terminalizes FAILED (it arises from a detector
  error; its classification is subject to decision 4).

## 7. Migration impact

Definitely required: none by these decisions alone. Conditional (not authorized):
a selector discriminator column on `research_projects`, only if that mechanism is
chosen under U-1 (a nullable `ADD COLUMN` needs no rebuild); and a deduplication
uniqueness migration, only after the read-only duplicate assessment and never
before a non-destructive plan for existing duplicates.

**D9:** ADR-0026 and this record are the two governance records; the
ADR-0005 numbering inconsistency is in `ERRATUM-adr-0005-numbering-inconsistency.md`.

## 8. Relationship to other records

- ADR-0026: general classification, evidence and tracker semantics.
- ADR-0025: Research wording amended to point here.
- ADR-0023, ADR-0024: unaffected.

## 9. Not authorized

A Research retry counter; `RETRY_STAGE` widening; a residual item-specific rule;
fallback providers; automatic P1 recovery; deletion of historical evidence; any
blind uniqueness migration.

## 10. Implementation boundary

**No implementation authorization is created merely by this ADR.** WS6 remains
separately gated and blocked by U-1, U-7 and U-8.

## 11. Scope of this record

This record authorizes only its own creation as a governance document. No change
was made to `src/**`, `tests/**`, `config/**`, any migration, schema, CI
configuration or dependency.

## 12. OPEN OWNER QUESTIONS, IMPLEMENTATION BLOCKERS (Research)

**Every item below is UNRESOLVED and is not an authorized decision.** The full
U-1 to U-10 list is in ADR-0026 section 16.

| # | Unresolved question | Blocks |
|---|---|---|
| U-1 | How the normal selector distinguishes an Owner-reactivated RESEARCHING project from a crashed (P1), provider-blocked or single-failure one. These share status and fields. | WS6 |
| U-7 | ADR-0005 section 6 says F-5 is "covered by F1-C"; the freeze decision says do not reopen F-5, while deduplication is required. Whether deduplication is confined to reactivated cycles or applies to all `runResearchProject` re-entry. | WS6 |
| U-8 | Source identity (no URL canonicalization exists) and the treatment of previously FAILED or CONTENT_UNPARSEABLE source rows on reactivation, without mutating history. | WS6 |

## 13. Final status

```text
RESEARCH F1-C REOPENING RECORD: RECORDED, OWNER-FROZEN DECISIONS
GOVERNANCE ONLY. ADR-0005 is NOT edited. No implementation authorized.
U-1, U-7 and U-8 remain UNRESOLVED.
```
