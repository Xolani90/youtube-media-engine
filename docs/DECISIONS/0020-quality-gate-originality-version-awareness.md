# ADR-0020 — Quality Gate Originality Version Awareness

**Status:** ACCEPTED — OWNER DECISION
**Owner:** Xolani Tshabalala
**Baseline:** `506f6f666e4292f5b2db2cc77f347b2ce9170bd4`
**Branch:** `main`
**Governance status:** AUTHORITATIVE OWNER DECISION RESOLVING THE PREVIOUSLY OPEN ADR-0019 §6 DEPENDENCY (QUALITY GATE VERSION AWARENESS)

---

## 1. Context

ADR-0019 (Originality Input Representation) introduced Originality `algorithm_version = v2` for all new Originality result rows. ADR-0019 §6 recorded an OPEN GOVERNANCE DEPENDENCY: the current Quality Gate checks only for the existence of an Originality result and does not inspect `algorithm_version`, so a historical `v1` row can satisfy the check. ADR-0019 did not authorize a Quality Gate change and left the question to a separate Owner decision.

This ADR records that Owner decision.

## 2. Decision

**Quality Gate's Originality evidence requirement remains version-agnostic.**

Option A, as presented in the preceding decision brief, is selected by the Owner.

## 3. Contract

**PASS:** an `originality_checks` row exists for the current Script.

**BLOCK:** no `originality_checks` row exists for the current Script.

The Quality Gate Originality evidence check does not require or inspect a particular `algorithm_version`.

## 4. Historical Data

- ADR-0019 introduced Originality representation version `v2`.
- Historical `v1` rows remain valid evidence under this Quality Gate contract.
- `v2` rows remain valid evidence under this Quality Gate contract.
- Historical Originality rows remain immutable.
- No migration, mutation, deletion, or rewrite of historical Originality rows is authorized.
- No Originality re-evaluation is authorized by this decision.

## 5. Future Versions

Future Originality algorithm versions are not rejected by Quality Gate solely because their version differs.

Any future decision to make Quality Gate version-aware requires a separate Owner-authorized governance decision.

## 6. ADR-0019 Closure

The Quality Gate version-awareness dependency identified in ADR-0019 §6 is **CLOSED** by this ADR.

ADR-0019's implementation contract remains unchanged.

## 7. Implementation Impact

- No production implementation change is authorized or required.
- No schema change is required.
- No test behaviour change is required by this decision.
- No Quality Gate implementation change is authorized by this decision.

## 8. Scope Boundary

This decision does NOT:

- alter Originality v2;
- alter the tokenizer;
- alter similarity calculation;
- alter Quality Gate thresholds;
- introduce thresholds;
- alter state transitions;
- alter publication;
- alter any other pipeline stage.

## 9. Provenance

The following repository evidence was established by the preceding read-only audit at the baseline above (**OBSERVED** unless marked otherwise):

- `src/quality-gate/checks.js` — `checkOriginalityEvidence(storage, scriptId)` selects the latest `originality_checks` row for the Script (`ORDER BY created_at DESC LIMIT 1`) and returns BLOCK (`ORIGINALITY_EVIDENCE_MISSING`) when no row exists, otherwise PASS (`originality_evidence_present`). It does not read `algorithm_version`. Its documentation comment records "Owner decision: evidence-existence only".
- `src/quality-gate/constants.js` — records that Quality Gate does not interpret `originality_checks.max_similarity`.
- `src/db/migrations/0006_originality_check_subsystem.sql` — `originality_checks` has an `algorithm_version TEXT NOT NULL` column, is append-only, and has no per-script uniqueness constraint.
- `src/originality/pipeline.js` — `runOriginalityCheck` inserts a new row per evaluation with the `ALGORITHM_VERSION` constant (`v2` after ADR-0019).
- `docs/DECISIONS/0019-originality-input-representation.md` — E-21, E-22, §6 and G-01 record the existence-only behaviour and the open dependency.

**UNRECOVERABLE / NOT FOUND:** the audit did not locate the originating Owner decision for the "evidence-existence only" contract in any ADR or checkpoint; it is recorded in the source comments cited above. This ADR does not attribute it to any earlier ADR. This ADR is the authoritative Owner decision for the contract as it applies from this baseline onward, and it does not reconstruct or certify the earlier decision.

## 10. Final Status

ACCEPTED — OWNER DECISION. Resolves ADR-0019 §6. No implementation authorized.

ADR-0020 export complete.