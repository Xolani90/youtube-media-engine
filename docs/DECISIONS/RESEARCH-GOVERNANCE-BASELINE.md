# Research Subsystem — Forward Governance Baseline

**Status:** OWNER-APPROVED — forward governance authority for the Research subsystem, effective from approval onward. This approval does not reconstruct, recover, certify, or retroactively replace Research v0.4; does not substantiate any historical freeze; and does not itself authorize a Research freeze, remediation, or closure of any open governance question (RG-01–RG-05 remain OPEN).
**Creation date:** 2026-09-17
**Approval date:** 2026-09-17
**Authority:** Project Owner (Xolani Tshabalala)
**Document type:** New forward-looking governance specification. This is **not** a reconstruction, recovery, or recreation of any prior "Research v0.4" specification.

---

## 1. Governance Status

This document establishes a **new forward governance authority** for the Research subsystem, effective only upon explicit Owner approval.

- Historical Research v0.4 remains **UNRECOVERED / NOT CERTIFIED**. This document does not certify it, reconstruct it, or stand in for it.
- This document **does not retroactively freeze** Research and does not itself constitute a freeze.
- A formal Research freeze requires a later, separate, explicit Owner decision, made under the process defined in Section 18.
- Upon explicit Owner approval, this document becomes the forward governance authority for the Research subsystem. Prior to that approval, it had no governing effect.

---

## 2. Historical Disposition

- A retrospective "Research Subsystem Specification v0.4" was searched for exhaustively across the repository, Git history, refs, reflogs, and unreachable objects. No corroborating artifact was found.
- No Research freeze record, Owner-approval artifact, or unified Research evidence set (the previously claimed `3/3`, `11/11`, `75/75`, `298/298`) could be substantiated.
- `docs/DECISIONS/0004-db2-cumulative-per-content-cost-closure.md` is confirmed unrelated to Research and is not reused, referenced, or renumbered by this document.
- No speculation is offered as to why the historical material is missing; its absence is recorded as a fact, not explained.

**Historical Research v0.4 specification: UNRECOVERED / NOT CERTIFIED.**
**No Research freeze could be substantiated from the evidence available to the repository/audit environment.**
**This document establishes a new forward governance baseline and does not retroactively certify Research v0.4.**

---

## 3. Research Scope

The Research subsystem, as currently implemented (verified at `origin/main` commit `d5b04a98e6e0d6bcd7e3e91b1940ad2f19a5fd9c`), covers:

- Research project creation (one per Discovery opportunity, uniqueness enforced at the database level)
- Proposition consumption from the upstream Discovery stage
- Source acquisition (policy-bounded)
- Source classification (deterministic role and quality tiering)
- Source persistence
- Claim extraction (LLM-assisted, trust-fenced)
- Claim structural validation (deterministic)
- Claim persistence
- Claim/source provenance (`claim_sources`)
- Contradiction relation persistence and canonicalization (mechanism only — see Section 11)
- Evidence grading (deterministic)
- Completeness evaluation (deterministic)
- Stopping/termination behavior
- Brief eligibility and handoff
- Failure isolation across sources and stages

---

## 4. End-to-End Data / Provenance Model

```text
external source
→ source record (sources)
→ extracted claim (claims)
→ claim_sources (claim ↔ source provenance)
→ evidence status (deterministic grading)
→ contradiction relations where available (claim_relations, optional detector)
→ completeness evaluation
→ Brief eligibility
→ derived/provenance-fenced Brief prompt content
```

Distinctions:

- **Persisted provenance:** `claim_sources` rows, written deterministically whenever a claim is linked to a source.
- **Deterministic derived state:** evidence status, completeness, load-bearing classification — all computed by pure functions over persisted data and policy, not by LLM judgment.
- **Optional contradiction relationships:** `claim_relations` rows exist only when a `detectContradiction` callback is supplied and finds a contradiction; their absence is not itself evidence of a data or logic defect (see Section 11).

---

## 5. LLM Trust Boundary

- External source content is passed to the LLM claim-extraction step wrapped via the existing prompt-trust mechanism (`untrustedSourceBlock`, `src/providers/llm/promptTrust.js`), fencing it as untrusted input rather than instructions.
- The LLM's role is to **propose** claims from source text; it does not directly write to the database or execute privileged actions.
- Proposed claims undergo deterministic structural validation (`claims.js`) before persistence.
- Evidence status is computed deterministically from policy and source metadata — it is never self-certified by the LLM.
- Provenance (`claim_sources`) is preserved through this boundary and downstream to the Brief stage.

This document makes no stronger semantic claim than the above — e.g., it does not assert that trust-fencing guarantees immunity from prompt injection, only that the existing mechanism is applied at this boundary.

---

## 6. Source Acquisition

Governed by `config/research_policy.json` (current values, `version: "0.1"`):

- `acquisition.max_sources_per_research_project`: 8
- `acquisition.max_acquisition_attempts`: 12
- `retry.max_retries_per_source`: 2
- `staleness.maximum_source_age_hours`: 8760 (365 days)

Behavior verified in `src/research/acquisition.js` and `tests/unit/research-acquisition.test.js`:

- Acquisition is bounded by the above limits, not unbounded or best-effort.
- Retrieval failures are isolated per source; a single failed or unparseable source does not abort the research project.
- Failed and unparseable sources are recorded with an explicit `retrieval_status` rather than silently dropped.

---

## 7. Source Classification

Verified in `src/research/sourceClassification.js` and `tests/unit/research-source-classification.test.js`:

- Source role (`primary_authoritative`, `independent_reporting`, `syndicated`) is classified deterministically from a caller-supplied domain map, defaulting unmatched domains to `independent_reporting`.
- An unparseable URL is flagged as ambiguous rather than silently guessed.
- Source quality tiering is independent of role for successfully retrieved content, but any non-`SUCCESS` retrieval is always classified `UNUSABLE` regardless of role.

No new classification requirements are introduced by this document.

---

## 8. Claims

Verified in `src/research/claims.js`, `src/db/migrations/0003_research_subsystem.sql`, and `tests/unit/research-claims.test.js`:

- Claims are extracted via LLM assistance (Section 5) and structurally validated before persistence.
- `claim_type` is constrained to `FACT`, `INFERENCE`, `OPINION`.
- `evidence_status` is constrained to `VERIFIED`, `PARTIALLY_SUPPORTED`, `UNSUPPORTED`, `CONTESTED`, defaulting to `UNSUPPORTED`.
- `is_load_bearing` is a persisted field read directly by the completeness check.
- Claim–source linkage is recorded through `claim_sources`, with a unique index preventing duplicate (claim, source, role) corroboration rows on retry.

---

## 9. Evidence Grading

Verified in `src/research/evidenceGrading.js` and `tests/unit/research-evidence-grading.test.js`:

- Evidence status is derived deterministically from policy-configured factors:
  - freshness (`staleness.maximum_source_age_hours`)
  - source quality tier (`evidence.source_quality.minimum_quality_tier_for_corroboration`)
  - independent reporting count (`evidence.independent_reporting_minimum`)
  - corroboration eligibility by source role (`evidence.source_roles`)
  - contradiction status, **where a contradiction relation is available**
- Contradiction affects `evidence_status` only, never `claim_type`.
- This document does not imply that contradiction detection is currently guaranteed to run; see Section 11.

---

## 10. Completeness

Verified in `src/research/completeness.js`, `config/research_policy.json`, and `tests/unit/research-completeness.test.js`:

- Load-bearing claims of type `FACT` or `INFERENCE` require `VERIFIED` evidence status by default (policy may permit `PARTIALLY_SUPPORTED` for `INFERENCE`).
- `OPINION` claims cannot satisfy a factual completeness requirement.
- Overall completeness requires meeting `completeness.overall_resolution_threshold` (currently `0.7`).
- A defined stopping condition must be met before completeness can be evaluated as satisfied.

**Current stopping behavior (verified in `src/research/pipeline.js`):** the pipeline sets `stoppingConditionMet = true` unconditionally after a single bounded acquisition/processing pass, and does not perform an iterative second acquisition pass. This is recorded as current implementation behavior, not given a new name (e.g. it is not labeled "OD-1" or any other term this document does not itself define).

---

## 11. Contradiction Handling

Verified in `src/research/contradictions.js`, `src/research/contradictionDetector.js`, `src/research/pipeline.js`, `src/research/constants.js`, `src/autonomous/runner.js`, `src/index.js`:

- Contradiction persistence and canonicalization exist unchanged: `claim_relations` stores undirected `CONTRADICTS` relations with canonical ordering (smaller `claim_id` first) enforced at the application layer, plus a unique index preventing mirrored duplicate pairs. No schema migration was made or required (see RG-02 implementation note below).
- `detectContradiction` is still an **optional injected callback** on `runResearchProject` (`pipeline.js`: `detectContradiction = null` by default) — Research can still reach a terminal status without contradiction detection ever running if no detector is supplied at all, and this is logged as `NOT_CHECKED`, never conflated with `NO_CONTRADICTION`.
- A **concrete production detector now exists**: `src/research/contradictionDetector.js` exports `detectContradiction(claimA, claimB, llmRouter)`, an LLM-assisted, claim-to-claim semantic judgment implementing the Owner-authorized RG-02 contract (temporal, scope/entity, negation, and numeric-value semantics per the RG-02 authorization; claim text is fenced via `derivedContentBlock` before crossing the LLM boundary). It resolves to exactly one of `CONTRADICTION_RESULT`: `CONTRADICTS`, `NO_CONTRADICTION`, `UNCERTAIN`, `ERROR` — never a boolean.
- **Production wiring:** `src/index.js`'s `runAutonomousEntrypoint` now defaults `deps.research.detectContradiction` to this production detector when no caller override is supplied, so the real autonomous entrypoint actually performs contradiction checking. A caller-supplied `deps.research.detectContradiction` (tests, controlled callers) still takes priority.
- **Eligibility:** contradiction detection is scoped to `claim_type = FACT` claims with `is_load_bearing = true` only (both the semantic scope and the cost-control boundary for pairwise detector calls). `INFERENCE`/`OPINION` claims and non-load-bearing `FACT` claims are excluded and never passed to the detector.
- **Execution-state observability:** every contradiction-check pass logs a `CONTRADICTION_CHECK`-stage `decision_log` entry distinguishing `NOT_CHECKED` (no detector configured, or fewer than 2 eligible claims), `NO_CONTRADICTION`, `CONTRADICTS`, `UNCERTAIN`, and `ERROR` — `NOT_CHECKED` and `NO_CONTRADICTION` are never indistinguishable.
- **Fail-closed on detector failure:** a detector call that returns `ERROR`, or that throws/rejects, is treated identically — the research project transitions to `FAILED` with `stop_reason = 'CONTRADICTION_CHECK_FAILED'`, and evidence grading/completeness evaluation are never run for that pass. Research cannot silently complete as though contradiction checking succeeded when it did not.
- The binary Research baseline is preserved: the only persisted relation remains `CONTRADICTS`; `UNCERTAIN` and `ERROR` never persist a relation.
- Evidence grading's existing deterministic rule is unchanged: a recorded unresolved `CONTRADICTS` relation still drives `evidence_status = CONTESTED` (`src/research/evidenceGrading.js`, unmodified).

**Status:** `IMPLEMENTED — VERIFICATION EVIDENCE IN SECTION 17`. This document does not, by itself, close RG-02 or authorize a Research freeze; only the Owner can authorize final closure (Section 17).

---

## 12. Database Schema

Current Research-relevant tables (`src/db/migrations/0003_research_subsystem.sql`): `research_projects`, `sources`, `claims`, `claim_sources`, `claim_relations`.

`claims.source_id`, `confidence`, and `supporting_evidence` are not written or read by current Research production logic. They remain physically present in the schema. At least one non-Research test (`tests/unit/asset-provenance.test.js`) exercises `claims.source_id` directly through raw SQL as a schema/backward-compatibility regression check. This does not constitute use by the Research production pipeline.

- `source_id` carries an explicit deprecation comment in the migration itself (`-- DEPRECATED (v0.2 S5)`).
- `confidence` and `supporting_evidence` carry no such comment but are, as verified, likewise not written or read by any current Research production logic (provenance and corroboration now flow entirely through `claim_sources`).
- This document does not remove, rename, or otherwise alter these columns. Their future disposition (retain / deprecate formally / remove via a separately authorized migration / assign new semantics) remains an open Owner decision (RG-03).

---

## 13. Policy Configuration

`config/research_policy.json` (current content reproduced in Section 6, evidence/completeness sections) governs acquisition limits, retry limits, evidence corroboration rules, source-quality thresholds, staleness, and the completeness resolution threshold.

- The policy file is operationally required: `src/config/index.js` throws at startup if it is missing.
- Its loader currently cites an unavailable "Research Subsystem Specification v0.4" as its authority; that citation is a source-comment attribution only and is not treated by this document as an existing external authority (see the framing note below).
- **Under this new governance baseline:** the policy is treated as an implementation-controlled configuration whose semantics are documented by this specification (Sections 6, 9, 10), not as an artifact independently backed by a recovered external specification.
- This document does not change the policy file or any value within it.

> Framing note on "v0.4" source comments: multiple files (`evidenceGrading.js`, `contradictions.js`, `completeness.js`, `acquisition.js`, `sourceClassification.js`, `pipeline.js`, `ResearchSourceProvider.js`, the schema migration) contain comments attributing specific behavior to "v0.4." This document does not treat those comments as proof that a v0.4 specification exists or ever existed in recoverable form. Where this document describes behavior also referenced by such a comment, it is described as: *current implementation behavior historically attributed in source comments to Research v0.4; original authority document remains unrecovered.*

---

## 14. Brief Handoff

Verified in `src/research/pipeline.js` and `src/research/completeness.js`:

- Research completion (`RESEARCH_COMPLETE` status) acts as the gate before Brief eligibility.
- Only claims meeting the completeness contract (Section 10) are treated as eligible input to Brief.
- Provenance (`claim_sources`) is preserved through the handoff.
- Derived Brief prompt content is fenced at the next LLM boundary consistent with the mechanism described in Section 5; this document does not modify Brief or make new claims about Brief's own guarantees beyond what Research hands off.

---

## 15. Failure Handling

Verified current behavior:

- **Missing opportunity:** research project creation depends on a valid Discovery opportunity reference (`research_projects.opportunity_id REFERENCES opportunities(id)`); absence is a referential-integrity failure, not silently tolerated.
- **Invalid status:** `research_projects.status` is constrained to `RESEARCHING`, `RESEARCH_COMPLETE`, `INSUFFICIENT_EVIDENCE`, `FAILED` at the database level.
- **Malformed proposition / source retrieval failure / unparseable content:** isolated per source; recorded via `retrieval_status` (`SUCCESS`, `FAILED`, `CONTENT_UNPARSEABLE`); does not abort the whole research project (Section 6).
- **Bounded acquisition exhaustion:** acquisition stops at policy limits (`max_sources_per_research_project`, `max_acquisition_attempts`) rather than continuing indefinitely; the project can reach `INSUFFICIENT_EVIDENCE` if completeness is not met once the stopping condition is reached.
- **Discovery failure:** out of scope for this document — Research assumes a valid, already-created opportunity as its precondition.

---

## 16. Verification Baseline

### Executed successfully (this audit session, `origin/main` @ `d5b04a98e6e0d6bcd7e3e91b1940ad2f19a5fd9c`, via `node --test`)

```text
tests/unit/research-retrieval.test.js
tests/unit/research-acquisition.test.js
tests/unit/research-source-classification.test.js
tests/unit/research-evidence-grading.test.js
tests/unit/research-completeness.test.js
tests/unit/research-claims.test.js
tests/unit/research-contradictions.test.js
tests/unit/research-schema.test.js
tests/integration/research-pipeline-e2e.test.js

Result: 84 / 84 passing, 0 failing
```

### Environment discrepancy — flagged for the Owner, not resolved here

The prior owner decision package (this repository's audit history) recorded Research schema/E2E tests as **environment-blocked** because `better-sqlite3` was reported unavailable. In **this** audit session's container, `better-sqlite3` loaded successfully and all schema and E2E Research tests executed and passed. This document does not treat this as proof that your local/CI environment is in the same state — it records only what was verified in this session's environment, and flags the discrepancy explicitly:

> **Open question for the Owner:** which environment (this audit container vs. your local/CI setup) reflects the environment that should count for future freeze-readiness verification? This is addressed as an open item (RG-05), not resolved by this document.

No pass counts are invented; the 84/84 figure above is from an actual execution in this session, not carried over from any prior claim.

---

## 17. Open Governance Questions

```text
RG-01 — Historical v0.4 authority unavailable.
        CLOSED (Owner decision, Option B, 2026-09-17). The Owner has explicitly
        decided not to pursue further recovery of the historical Research v0.4
        specification. Historical Research v0.4 remains permanently recorded as
        UNRECOVERED / NOT CERTIFIED. This closure does not constitute retroactive
        certification of v0.4, does not substantiate any historical Research
        freeze, and does not itself authorize a Research freeze. This
        Owner-approved document remains the governing authority for the Research
        subsystem going forward.

RG-02 — Production contradiction detector absent.
        IMPLEMENTED — VERIFICATION PENDING (2026-09-17, RG-02 implementation
        session). Owner decision: the semantic contract in the RG-02
        authorization prompt (claim-to-claim only; FACT + load-bearing
        eligibility; temporal/scope/negation/numeric semantics handled by
        detector judgment, no new structured columns; four-state result
        contract CONTRADICTS/NO_CONTRADICTION/UNCERTAIN/ERROR; fail-closed
        on detector ERROR or thrown/rejected calls; binary CONTRADICTS-only
        persisted relation; no confidence/rationale/detector-version schema).
        Implementation evidence: src/research/contradictionDetector.js
        (production detector), src/research/pipeline.js (eligibility,
        result-contract handling, fail-closed transition to FAILED),
        src/research/constants.js (CONTRADICTION_RESULT,
        CONTRADICTION_EXECUTION_STATE), src/index.js (production wiring of
        the concrete detector into deps.research.detectContradiction).
        Verification evidence: focused tests
        tests/unit/research-contradiction-detector.test.js (12 tests) and
        tests/integration/research-contradiction-pipeline.test.js (8 tests),
        all passing; full suite 647/654 passing, the same 7 pre-existing
        sandbox FFmpeg/narration-synthesis failures as prior sessions
        (unrelated to Research), verified unchanged by this implementation.
        No schema migration was made or required — the existing
        claim_relations/decision_log schema already satisfied the contract.
        RG-02 is described here as IMPLEMENTED — VERIFICATION PENDING per
        the RG-02 authorization's own instruction: only the Owner may
        authorize final closure.

RG-03 — Legacy claim-column disposition unresolved.
        Unresolved. claims.source_id / confidence / supporting_evidence:
        retain, formally deprecate, remove via migration, or assign new semantics.

RG-04 — Policy governance under the new baseline.
        The governance framing in Section 13 is Owner-approved.
        The existing config/research_policy.json remains unchanged.
        Any future modification of its values or semantics requires a
        separate Owner decision.

RG-05 — Schema/E2E dependency-complete verification outstanding.
        Unresolved. An environment discrepancy (Section 16) exists between
        this audit session and previously reported local/CI results.
```

RG-01 is CLOSED (Owner decision, Option B, 2026-09-17). RG-02 through RG-05 are not closed by this document and remain OPEN.

---

## 18. Freeze Rules

A Research freeze may occur only after, in order:

1. The Owner approves this new governance authority (this document, or an amended version of it).
2. The Owner decides each of the open governance questions (RG-01 through RG-05).
3. Any authorized remediation arising from those decisions is completed.
4. Read-only verification is performed against the remediated state.
5. Dependency-complete verification evidence is available in the environment(s) the Owner designates as authoritative (RG-05).
6. The Owner explicitly authorizes a freeze.
7. The freeze is recorded in a **new, correctly numbered** governance record — not `0004`, and not any number already in use in `docs/DECISIONS/`.

No freeze record is created by this document. No freeze is declared, implied, or scheduled.

---

## Document Change Log

- 2026-09-17 — Initial DRAFT created per Owner authorization. Not approved. Not accepted. Not frozen. Research is not certified conformant by this document.
- 2026-09-17 — OWNER-APPROVED by Project Owner (Xolani Tshabalala) as the forward governance authority for the Research subsystem. This approval does not reconstruct, recover, or certify Research v0.4 (remains UNRECOVERED / NOT CERTIFIED); does not substantiate any historical Research freeze; does not authorize a Research freeze; and does not close RG-01 through RG-05, which remain OPEN. Not authorized by this approval: implementation of `detectContradiction`, removal/renaming/migration of legacy claim columns, modification of `config/research_policy.json`, modification of Research production code or tests, creation of a freeze record, or retroactive certification of v0.4.
- 2026-09-17 — RG-01 CLOSED by explicit Owner decision (Option B): the historical Research v0.4 specification will not be pursued for further recovery, and remains permanently recorded as UNRECOVERED / NOT CERTIFIED. This closure does not constitute retroactive certification of v0.4, does not substantiate any historical Research freeze, and does not itself authorize a Research freeze. RG-02, RG-03, RG-04, and RG-05 remain OPEN. All existing freeze rules (Section 18) remain unchanged.
