# Research Subsystem — Forward Governance Baseline

**Status:** OWNER-APPROVED — forward governance authority for the Research subsystem, effective from approval onward. This approval does not reconstruct, recover, certify, or retroactively replace Research v0.4; does not substantiate any historical freeze; and does not itself authorize a Research freeze, remediation, or closure of any open governance question. As of the current state of this document: RG-01 CLOSED, RG-02 CLOSED, RG-03 CLOSED, RG-04 CLOSED, RG-05 CLOSED — OWNER-AUTHORIZED (2026-09-17).
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

**Status:** `CLOSED — OWNER-AUTHORIZED`. Implementation and read-only verification are complete (Section 17 records the evidence: 22/22 focused RG-02 tests passing, and direct code inspection of production wiring in `src/index.js`). The Owner has explicitly authorized RG-02 closure. This closure is scoped to RG-02 only — it does not reconstruct or certify Research v0.4, does not close RG-03/RG-04/RG-05, and does not itself authorize a Research freeze (Research remains NOT FROZEN; see Section 18).

---

## 12. Database Schema

Current Research-relevant tables (`src/db/migrations/0003_research_subsystem.sql`): `research_projects`, `sources`, `claims`, `claim_sources`, `claim_relations`.

**Historical/pre-RG-03 state:** `claims.source_id`, `confidence`, and `supporting_evidence` were not written or read by current Research production logic, but remained physically present in the schema. `source_id` carried an explicit deprecation comment in the migration itself (`-- DEPRECATED (v0.2 S5)`). `confidence` and `supporting_evidence` carried no such comment but were, as verified, likewise not written or read by any current Research production logic (provenance and corroboration flowed entirely through `claim_sources`). At that time, `tests/unit/asset-provenance.test.js` exercised `claims.source_id` directly through raw SQL as a schema/backward-compatibility regression check; this did not constitute use by the Research production pipeline. Their disposition was an open Owner decision (RG-03).

**Current/post-RG-03 state:** The Owner-authorized removal has been implemented (commit `6fafa7c1071818431220ca40d362bdfcae64854f`; see RG-03 in Section 17 for full evidence). The authoritative `claims` schema no longer contains `source_id`, `confidence`, or `supporting_evidence`. The seven retained `claims` columns (`id`, `research_project_id`, `claim`, `claim_type`, `evidence_status`, `is_load_bearing`, `created_at`) are unchanged. `claim_sources` and `claim_relations` are unaffected by this removal. `tests/unit/asset-provenance.test.js` was updated in the same commit to stop exercising the removed `source_id` column.

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

> This environment discrepancy was carried forward into the RG-05 dependency-completeness audit and is recorded, resolved as a governance matter, in Section 17's RG-05 entry: the Owner-reported authoritative local environment (661/661) and this audit's sandbox environment (654/661, 7 pre-existing unrelated FFmpeg/narration-synthesis failures) are recorded separately, neither overwrites the other, and the environments are not claimed to be equivalent. RG-05 closure does not resolve which environment is authoritative for any future freeze-readiness verification — that remains a distinct question if and when a freeze is proposed under Section 18.

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
        CLOSED — OWNER-AUTHORIZED (2026-09-17). Implemented under the
        semantic contract in the RG-02 authorization prompt (claim-to-claim
        only; FACT + load-bearing eligibility; temporal/scope/negation/
        numeric semantics handled by detector judgment, no new structured
        columns; four-state result contract CONTRADICTS/NO_CONTRADICTION/
        UNCERTAIN/ERROR; fail-closed on detector ERROR or thrown/rejected
        calls; binary CONTRADICTS-only persisted relation; no confidence/
        rationale/detector-version schema).
        Implementation evidence: src/research/contradictionDetector.js
        (production detector), src/research/pipeline.js (eligibility,
        result-contract handling, fail-closed transition to FAILED),
        src/research/constants.js (CONTRADICTION_RESULT,
        CONTRADICTION_EXECUTION_STATE), src/index.js (production wiring of
        the concrete detector into deps.research.detectContradiction).
        Verification evidence: a read-only verification audit independently
        re-ran the focused RG-02 tests
        (tests/unit/research-contradiction-detector.test.js,
        tests/integration/research-contradiction-pipeline.test.js,
        tests/unit/research-contradictions.test.js) and confirmed
        22/22 PASS, and traced production wiring by direct code inspection
        of src/index.js. The same audit re-ran the full sandbox suite and
        recorded 647/654 PASS, with the 7 failures identified as
        pre-existing FFmpeg/narration-synthesis environment failures
        outside RG-02 scope, unchanged by this implementation. This is
        recorded as the actual sandbox result — it is not represented as
        matching the previously reported authoritative-environment result
        of 654/654.
        No schema migration was made or required — the existing
        claim_relations/decision_log schema already satisfied the contract.
        Follow-up (non-blocking): the same audit identified one LOW item —
        no automated end-to-end test currently exercises src/index.js's
        production wiring of the default contradiction detector; that
        wiring was verified by direct code inspection only. This is
        recorded as a test-hardening follow-up and does not reopen RG-02
        under this closure decision.
        Hash evidence: the verification audit was performed in a sandbox
        whose commit hashes (implementation 93cf31a86084b5c668de9887a963fe
        038ebd191f, HEAD cc6c392d6cdb59d4ce714ba69602288d7c24b309) differ
        from the previously established authoritative-environment hashes
        (implementation 50e12fd11536ff0bb122c2671d7ac6ae0c1bd21a, HEAD
        5f7d321dc5413e0db49c92a666e3934b1c73556a). The audit explicitly
        recorded CONTENT EQUIVALENCE: NOT ESTABLISHED between the sandbox
        and the authoritative environment for those hashes; this closure
        decision does not resolve or overwrite that finding, and it is
        preserved here rather than treated as an implementation defect.
        Owner decision: the Owner has reviewed this evidence and explicitly
        authorizes RG-02 closure. This closure is scoped to RG-02 only. It
        does not certify Research v0.4, does not close RG-03/RG-04/RG-05,
        and does not itself authorize a Research freeze.

RG-03 — Legacy claim-column disposition.
        CLOSED — OWNER-AUTHORIZED (2026-09-17).
        Owner disposition: REMOVE claims.source_id, claims.confidence, and
        claims.supporting_evidence.
        Evidence basis for the disposition decision (read-only audit,
        2026-09-17): claims.source_id was TEST-ONLY (sole dependency:
        tests/unit/asset-provenance.test.js,
        `INSERT INTO claims (..., source_id, ...)` and
        `assert.equal(claim.source_id, sourceId)`); the active claim-to-
        source relationship is represented separately by claim_sources
        (claim_sources.source_id is a distinct, actively-used column and is
        not conflated with claims.source_id here). claims.confidence and
        claims.supporting_evidence were UNUSED — no production or test
        writer/reader was found for either. Current evidence strength is
        handled by the Research evidence-grading model (evidence_status),
        not by these legacy fields. No known supported external consumer
        outside this repository was identified as requiring these columns
        (Owner-confirmed scope). No forward-looking semantic requirement
        for these columns was established.
        Implementation evidence: commit
        `6fafa7c1071818431220ca40d362bdfcae64854f` (origin/main HEAD),
        containing exactly the authorized four-file implementation surface:
        src/db/migrations/0012_remove_legacy_claim_columns.sql (preserve-
        and-rebuild migration removing exactly the three authorized
        columns and none other; the seven retained columns are copied into
        a replacement table before the original is dropped and the
        replacement renamed into place), src/storage/SqliteStorageDriver.js
        (FK-enforcement toggle scoped strictly to the
        0012_remove_legacy_claim_columns.sql filename, not applied to any
        other migration), tests/unit/asset-provenance.test.js (updated to
        stop exercising the removed source_id column), and
        tests/unit/rg03-claims-migration.test.js (new migration-behavior
        coverage).
        Verification evidence: an independent read-only audit re-cloned
        origin/main, confirmed 6fafa7c is HEAD on origin/main, confirmed
        the four-file changed-file scope exactly, and independently re-ran
        the test suite. Targeted RG-03 + asset-provenance tests: 17/17
        PASS. Full suite: 661 total, 654 PASS, 7 FAIL, with the 7 failures
        confirmed by direct inspection to be the known, pre-existing,
        unrelated `spawnSync espeak-ng ENOENT` FFmpeg/narration-synthesis
        environment failures (missing espeak-ng binary), not RG-03
        regressions. Populated-database migration behavior, FK
        restoration/rollback, and claim/claim_sources/claim_relations data
        preservation were exercised by
        tests/unit/rg03-claims-migration.test.js and confirmed passing.
        The implementation is therefore verified for RG-03.
        Owner decision: the Owner has reviewed this evidence and
        explicitly authorizes RG-03 closure. This closure is scoped to
        RG-03 only. It does not reconstruct or certify Research v0.4, does
        not close RG-04 or RG-05, and does not itself authorize a Research
        freeze. Research remains NOT FROZEN.

RG-04 — Policy governance under the new baseline.
        CLOSED — OWNER-AUTHORIZED (2026-09-17).
        The governance framing in Section 13 is Owner-approved: the policy
        is treated as implementation-controlled configuration whose
        semantics are documented by this specification, not as an artifact
        independently backed by a recovered Research v0.4 specification.
        Evidence basis: config/research_policy.json was verified unchanged
        since the forward governance baseline was established (last
        modified by a commit predating baseline creation; no commit since
        touches this file). Current production code reads the policy
        exclusively through loadResearchPolicy() in src/config/index.js;
        no production path in the repository modifies the policy file.
        The "v0.4" wording in that loader's error message is a source-
        comment/error-string attribution only, consistent with the
        Section 13 framing note, and is not treated as evidence of a
        recoverable v0.4 specification.
        The RG-04 audit identified, as a LOW finding, the absence of a
        technical enforcement mechanism (CI guard, runtime hash/signature
        check, or lint rule) preventing an unauthorized future edit to
        config/research_policy.json. The Owner has explicitly decided that
        no such technical enforcement mechanism is required for RG-04.
        The absence of a technical guard is therefore not a closure
        defect. Future policy changes remain subject to explicit Owner
        decision as a governance/process control, per point 3 of this
        entry and the existing text above.
        Owner decision: the Owner has reviewed this evidence and
        explicitly authorizes RG-04 closure as a governance-only decision.
        This closure does not reconstruct or certify Research v0.4, does
        not alter RG-01, RG-02, or RG-03, does not close RG-05, and does
        not itself authorize a Research freeze or declare Research
        production-ready. Research remains NOT FROZEN.

RG-05 — Schema/E2E dependency-complete verification outstanding.
        CLOSED — OWNER-AUTHORIZED (2026-09-17).
        Evidence basis: an independent read-only dependency-completeness
        audit traced the Research subsystem's production dependency graph
        end-to-end — Discovery (HANDED_TO_RESEARCH) → Research eligibility
        → research_projects → source acquisition/persistence → claim
        extraction/persistence → claim_sources → contradiction detection
        → claim_relations → evidence grading → completeness → terminal
        state → Brief eligibility → Brief claim/source consumption →
        Script → Fact-Check. The audit verified: Research → Brief
        eligibility requires research_projects.status = RESEARCH_COMPLETE
        exactly (src/brief/eligibility.js); Brief claim selection is
        hard-scoped to a single research_project_id
        (src/brief/claims.js:selectEligibleKeyClaims); proposed key-claim
        ids are re-validated against that same scoped eligible set before
        persistence (validateKeyClaimIds), preventing cross-project claim
        contamination; Script and Fact-Check preserve Research project
        lineage through content_briefs.research_project_id and
        scripts.content_brief_id; the RG-03 removed columns
        (claims.source_id, claims.confidence, claims.supporting_evidence)
        are absent from the current schema and are not read or written by
        any active production path (claim_sources.source_id, a distinct
        column on a distinct table, is correctly unaffected); fresh-database
        (0001→0012) and populated-database upgrade migration paths were
        both independently verified, including FK integrity
        (PRAGMA foreign_key_check empty) and transactional rollback safety
        on an induced 0012 failure; RG-02's contradiction-detection wiring
        (eligibility → detector → claim_relations → evidence grading →
        fail-closed FAILED transition on detector ERROR) was verified
        connected with no downstream bypass; and RG-04's policy-governance
        framing was reconfirmed technically consistent with current code
        (config/research_policy.json unchanged, read exclusively through
        loadResearchPolicy(), no production writer).
        Test evidence: targeted subset (migration, contradiction, Brief
        claim-eligibility, and Research/Brief/Fact-Check/Script E2E tests)
        70/70 PASS. Owner-reported authoritative local environment: 661
        total, 661 pass, 0 fail, 0 cancelled, 0 skipped, 0 todo. This
        audit's sandbox environment: 661 total, 654 pass, 7 fail, all
        seven failures confirmed as the known, pre-existing, unrelated
        `spawnSync espeak-ng ENOENT` FFmpeg/narration-synthesis
        environment failures. These two results are recorded separately;
        neither overwrites the other, and the environments are not
        claimed to be equivalent.
        Owner-accepted limitations recorded (RG05-F1, decided 2026-09-17):
        F1-A (claims.insertClaim + linkClaimSource are not wrapped in a
        single transaction; a failure between them can leave an orphaned
        claim and, combined with F1-C, permanently strand the owning
        research_projects row in RESEARCHING) — accepted by the Owner as
        a bounded current architectural limitation; no transaction
        implementation is authorized by this closure. F1-B
        (recordContradiction's claim_relations write and logDecision's
        decision_log write are independent, uncoordinated writes) —
        confirmed as an intentional, non-defective design: decision_log
        has no production readers anywhere in the repository, so its loss
        or divergence from claim_relations does not affect Research
        correctness. F1-C (no timeout, lease, retry, or stale-project
        recovery mechanism exists; selectEligibleResearch excludes an
        opportunity from re-selection once any research_projects row
        exists for it, regardless of that row's status, so a crashed
        RESEARCHING project or a FAILED project cannot currently be
        resumed or retried; run_id carries no recovery semantics) —
        accepted by the Owner as a bounded current architectural
        limitation, explicitly treated as a separate future architectural
        decision; no resumability/retry/lease/state-machine implementation
        is authorized by this closure.
        RG-05 Finding 4 recorded (decided 2026-09-17): content_briefs has
        no database-level UNIQUE constraint on research_project_id;
        createBrief's idempotency check (src/brief/pipeline.js) is an
        application-level SELECT-then-INSERT only, leaving a narrow
        window under genuine concurrent invocation for duplicate Brief
        rows against the same research_project_id. Classified LOW
        severity — no failing test demonstrates the race, and it requires
        genuine concurrent invocation to manifest. The Owner accepts this
        as a known, bounded, LOW-severity downstream limitation for the
        current baseline. No schema change, transaction/concurrency
        implementation, or new concurrency test is authorized by this
        closure. This finding concerns Brief-side idempotency only; it
        does not indicate incorrect Research project scoping, and it does
        not reopen RG05-F1.
        These accepted limitations (F1-A, F1-C, Finding 4) do not
        represent unresolved dependency ambiguity for RG-05 closure — the
        full production dependency graph was traced and no unresolved
        *correctness* dependency remains. F1-B is confirmed intentional
        independent audit persistence, not a limitation requiring
        acceptance. None of the above constitutes implementation
        authorization for any future remediation; any future work on
        F1-A, F1-C, or Finding 4 requires separate, explicit Owner
        implementation authorization.
        This closure does not assert zero defects, production readiness,
        a Research freeze, recovery or certification of Research v0.4,
        transactional atomicity for F1-A, or a database uniqueness
        constraint for Brief. It does not reconstruct or certify Research
        v0.4 (remains UNRECOVERED / NOT CERTIFIED), does not alter RG-01,
        RG-02, RG-03, or RG-04, and does not itself authorize a Research
        freeze. Research remains NOT FROZEN.
        Owner decision: the Owner has reviewed this evidence and
        explicitly authorizes RG-05 closure.
```

RG-01 is CLOSED (Owner decision, Option B, 2026-09-17). RG-02 is CLOSED (Owner-authorized, 2026-09-17). RG-03 is CLOSED (Owner-authorized, 2026-09-17). RG-04 is CLOSED (Owner-authorized, 2026-09-17). RG-05 is CLOSED (Owner-authorized, 2026-09-17). Neither the RG-02, RG-03, RG-04, nor RG-05 closure constitutes or authorizes a Research freeze; Research remains NOT FROZEN (Section 18). RG-01 through RG-05 are all now CLOSED; per Section 18, a Research freeze still requires a separate, explicit Owner authorization and has not occurred.

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

**Freeze mechanism (clarified 2026-09-17, following the Section 18 Research Freeze Readiness Audit, finding F-6):** a Research freeze under this document is a **governance-only** freeze unless the Owner separately authorizes a technical enforcement mechanism. It is established by (1) an explicit Owner freeze authorization, and (2) a new, correctly numbered governance record documenting that authorization and the frozen scope, per step 7 above. A Research freeze under this document does not inherently require branch protection, CI enforcement, runtime hash/signature checks, filesystem permissions, automated code-locking, a dedicated freeze branch, a Git tag, or any other technical enforcement mechanism — none of those is authorized or implied by this document. This is governance-only unless separately authorized otherwise: future technical enforcement, if the Owner ever wants it, requires its own separate, explicit Owner authorization, distinct from the freeze authorization itself. Any future change to the frozen Research surface, once a freeze is authorized, requires a separately numbered governance decision and explicit Owner authorization before implementation. This clarification does not itself constitute a freeze; Research remains NOT FROZEN.

---

## Document Change Log

- 2026-09-17 — Initial DRAFT created per Owner authorization. Not approved. Not accepted. Not frozen. Research is not certified conformant by this document.
- 2026-09-17 — OWNER-APPROVED by Project Owner (Xolani Tshabalala) as the forward governance authority for the Research subsystem. This approval does not reconstruct, recover, or certify Research v0.4 (remains UNRECOVERED / NOT CERTIFIED); does not substantiate any historical Research freeze; does not authorize a Research freeze; and does not close RG-01 through RG-05, which remain OPEN. Not authorized by this approval: implementation of `detectContradiction`, removal/renaming/migration of legacy claim columns, modification of `config/research_policy.json`, modification of Research production code or tests, creation of a freeze record, or retroactive certification of v0.4.
- 2026-09-17 — RG-01 CLOSED by explicit Owner decision (Option B): the historical Research v0.4 specification will not be pursued for further recovery, and remains permanently recorded as UNRECOVERED / NOT CERTIFIED. This closure does not constitute retroactive certification of v0.4, does not substantiate any historical Research freeze, and does not itself authorize a Research freeze. RG-02, RG-03, RG-04, and RG-05 remain OPEN. All existing freeze rules (Section 18) remain unchanged.
- 2026-09-17 — RG-02 CLOSED by explicit Owner decision (Owner-authorized), following implementation (commit `feat: implement RG-02 research contradiction contract`) and an independent read-only verification audit (22/22 focused RG-02 tests passing; full sandbox suite 647/654 passing with 7 pre-existing, unrelated FFmpeg/narration-synthesis environment failures; production wiring in `src/index.js` verified by direct code inspection). This closure records one non-blocking LOW follow-up (no automated end-to-end test yet exercises `src/index.js`'s default-detector wiring) and preserves the audit's hash-evidence finding (`CONTENT EQUIVALENCE: NOT ESTABLISHED` between the verification sandbox's commit hashes and the previously established authoritative-environment hashes) without treating either as an implementation defect. This closure does not reconstruct or certify Research v0.4, does not close RG-03, RG-04, or RG-05, and does not itself authorize a Research freeze. Research remains NOT FROZEN. All existing freeze rules (Section 18) remain unchanged.
- 2026-09-17 — RG-03 DISPOSITION AUTHORIZED by explicit Owner decision, following an independent read-only evidence audit (claims.source_id = TEST-ONLY, sole dependency `tests/unit/asset-provenance.test.js`; claims.confidence = UNUSED; claims.supporting_evidence = UNUSED; no known supported external consumer requires these columns, per Owner-confirmed scope). Owner disposition: REMOVE claims.source_id, claims.confidence, and claims.supporting_evidence, through a separately authorized future database/schema migration. This entry records the disposition decision only — it is not an implementation authorization, and no migration has been created or performed. RG-03 remains OPEN — DISPOSITION AUTHORIZED; IMPLEMENTATION PENDING, and is NOT CLOSED; closure requires a later, separately authorized implementation-and-verification process. This decision does not reconstruct or certify Research v0.4, does not alter RG-01, RG-02, RG-04, or RG-05, and does not itself authorize a Research freeze. Research remains NOT FROZEN. All existing freeze rules (Section 18) remain unchanged.
- 2026-09-17 — RG-03 CLOSED by explicit Owner decision (Owner-authorized), following implementation (commit `6fafa7c1071818431220ca40d362bdfcae64854f`, containing exactly the authorized four-file scope: `src/db/migrations/0012_remove_legacy_claim_columns.sql`, `src/storage/SqliteStorageDriver.js`, `tests/unit/asset-provenance.test.js`, `tests/unit/rg03-claims-migration.test.js`) and an independent read-only verification audit (targeted RG-03 + asset-provenance tests: 17/17 PASS; full suite: 661 total, 654 PASS, 7 FAIL, the 7 failures confirmed as the known, pre-existing, unrelated `espeak-ng ENOENT` FFmpeg/narration-synthesis environment failures; changed-file scope and origin/main HEAD position independently confirmed). This closure does not reconstruct or certify Research v0.4 (remains UNRECOVERED / NOT CERTIFIED), does not close RG-04 or RG-05, and does not itself authorize a Research freeze. Research remains NOT FROZEN. All existing freeze rules (Section 18) remain unchanged.
- 2026-09-17 — RG-04 CLOSED by explicit Owner decision (Owner-authorized, governance-only closure), following an independent read-only audit confirming: the Section 13 governance framing was Owner-approved; `config/research_policy.json` was verified unchanged since the forward governance baseline was established; current production code reads the policy exclusively through `loadResearchPolicy()` in `src/config/index.js`; no production path modifies the policy file; and the "v0.4" wording in that loader's error message is a source-comment/error-string attribution only, not evidence of a recoverable v0.4 specification. The audit identified, as a LOW finding, the absence of a technical enforcement mechanism (CI guard, runtime hash/signature check, or lint rule); the Owner explicitly decided no such mechanism is required for RG-04, and its absence is therefore not treated as a closure defect. No technical enforcement mechanism was implemented as part of this closure. This closure does not reconstruct or certify Research v0.4 (remains UNRECOVERED / NOT CERTIFIED), does not alter RG-01, RG-02, or RG-03, does not close RG-05 (remains OPEN), and does not itself authorize a Research freeze or declare Research production-ready. Research remains NOT FROZEN. All existing freeze rules (Section 18) remain unchanged.
- 2026-09-17 — RG-05 CLOSED by explicit Owner decision (Owner-authorized), following an independent read-only dependency-completeness audit that traced the Research subsystem's full production dependency graph (Discovery → Research → Brief → Script → Fact-Check), confirmed Research → Brief eligibility requires RESEARCH_COMPLETE, confirmed Brief claim selection and its re-validation are hard-scoped to a single research_project_id with no cross-project claim contamination possible, confirmed RG-03's removed claim columns are absent from the schema and unreferenced by any active production path, independently verified both fresh-database and populated-database-upgrade migration paths (including FK integrity and transactional rollback safety), and reconfirmed the RG-02 contradiction-detection wiring and RG-04 policy-governance framing remain technically consistent with current code. Targeted test subset: 70/70 PASS. Owner-reported authoritative local environment: 661/661 PASS, 0 fail. This audit's sandbox environment: 661 total, 654 PASS, 7 FAIL, confirmed as the known, pre-existing, unrelated `espeak-ng ENOENT` FFmpeg/narration-synthesis environment failures; the two results are recorded separately and are not claimed to be equivalent. This closure explicitly incorporates, without reopening, the following Owner-accepted limitations decided the same day: RG05-F1-A (claim/claim-source-link write pair is not transactional; accepted as a bounded limitation, no implementation authorized), RG05-F1-B (claim_relations and decision_log are intentionally independent writes; decision_log has no production readers; confirmed non-defective, no change required), RG05-F1-C (no Research project timeout/lease/retry/resume mechanism exists; a crashed RESEARCHING or FAILED project cannot currently be resumed; accepted as a bounded limitation and a separate future architectural decision, no implementation authorized), and RG-05 Finding 4 (`content_briefs.research_project_id` has no database-level UNIQUE constraint; `createBrief`'s idempotency check is application-level only, a narrow concurrency race; accepted as a known LOW-severity downstream limitation, no schema, transaction, or test implementation authorized). None of these accepted limitations were treated as unresolved dependency ambiguity preventing closure, and none of them was implemented, fixed, or tested as part of this closure decision. This closure does not reconstruct or certify Research v0.4 (remains UNRECOVERED / NOT CERTIFIED), does not alter RG-01, RG-02, RG-03, or RG-04, and does not itself authorize a Research freeze or declare Research or Brief production-ready. Research remains NOT FROZEN. RG-01 through RG-05 are now all CLOSED; per Section 18, a Research freeze still requires a separate, explicit Owner authorization, which has not occurred. All existing freeze rules (Section 18) remain unchanged.
- 2026-09-17 — SECTION 18 GOVERNANCE DISPOSITION recorded by explicit Owner decision, following the Section 18 Read-Only Research Freeze Readiness Audit, for findings F-4, F-5, F-6, and F-8. This is a governance disposition only; no implementation, test, migration, schema, configuration, CI, or branch-protection change was authorized or performed, and no Research freeze is being declared. F-6 (Section 18's freeze mechanism was unspecified as governance-only vs. technically enforced): clarified in Section 18 above — a Research freeze under this document is governance-only (an explicit Owner authorization plus a new, correctly numbered governance record) unless the Owner separately authorizes a technical enforcement mechanism; this clarification does not itself constitute a freeze. F-4 (the contradiction-result dispatch in src/research/pipeline.js falls through to NO_CONTRADICTION for any value outside the documented four-state contract, rather than explicitly rejecting it, though the current production detector is contract-constrained and no path is known to produce an out-of-contract value): accepted as a LOW-severity, non-blocking evidence/defensive-handling gap for the current baseline; no implementation, test, or detector refactor is authorized; does not block the freeze decision; future hardening may be separately authorized if desired. F-5 (a crashed RESEARCHING project can be re-entered with no dedup, potentially creating duplicate source/claim rows): determined to be a concrete downstream consequence of the already-accepted RG05-F1-C limitation, not a separate new blocker; requires no separate remediation; does not reopen RG-05; does not create a new governance item; no duplicate-prevention, retry/resume, or transaction implementation is authorized; the existing F1-C disposition (Research resumability/retry/lease/state-machine work is a separate future architectural decision requiring explicit Owner authorization) remains authoritative and unchanged. F-8 (this local sandbox's HEAD, a698f81546a83180125d9efead4d75f7c39968e9, differs in SHA from the pushed authoritative origin/main, f4615aa5315338f1f5540179b08f7cfa6a36d626, because the governance patch was recreated via `git am`, though repository tree content was independently verified identical): recorded as informational repository bookkeeping only — not a Research defect, not a freeze blocker, requires no governance remediation and no new governance item; not reconciled by reset/rebase/amend, and no commit was created merely to normalize the SHA. RG-01 through RG-05 remain CLOSED and unaltered by this entry; no historical closure narrative was rewritten; no evidence was removed. Research v0.4 remains UNRECOVERED / NOT CERTIFIED. Research remains NOT FROZEN. The Section 18 freeze authorization remains outstanding and is a separate, distinct future Owner decision from this disposition. This entry does not create RG-06 or any new numbered technical finding.
