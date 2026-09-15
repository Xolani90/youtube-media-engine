# ADR-0007: D-G1 Implementation Authorization — Provenance Record

## 1. Purpose

This document records, retrospectively, the Owner's implementation authorization for
the D-G1 Originality measurement stage. It exists to close a governance provenance
gap: ADR-0006 ratified the D-G1 architecture direction but explicitly did not
authorize implementation, and the implementation was subsequently authorized by the
Owner outside the repository's Git history. This record makes that authorization
chain reconstructable from the repository itself, going forward.

This document does not authorize anything new. D-G1 is already implemented and
shipped at the commit referenced in §5. Nothing here changes ADR-0006, the
`ContentStateMachine`, or any source file.

## 2. Ratification reference

`docs/DECISIONS/0006-monetization-compliance-governance-ratification.md` (ADR-0006)
ratified the D-G1 architecture direction (`FACT_CHECK → ORIGINALITY_CHECK →
QUALITY_GATE`, as a separate, un-merged stage) as part of the Owner's ratification of
the twelve D-G decisions.

ADR-0006 is ratification only. It states this explicitly and repeatedly:

- §1: `RATIFIED — OWNER DECISION RECORDED — IMPLEMENTATION NOT AUTHORIZED`.
- D-G1 entry, §5: "Implementation authorization: None."
- §10, Implementation Authorization Boundary: this ADR does not authorize
  source-code changes, database migrations, new tables, or tests beyond
  documentation validation, and "[a]ny implementation of any decision recorded in §5
  must receive a separate, explicit implementation authorization after this
  ratification. Ratification is not that authorization."

ADR-0006 is unmodified by this record and remains the historical statement that
ratification and implementation authorization are distinct acts.

## 3. Owner authorization

After ADR-0006's ratification, the Owner (Xolani Tshabalala) subsequently gave
explicit authorization, outside of Git, to implement D-G1 within the scope recorded
in §4 below. This authorization was given out-of-band relative to the repository —
no commit, tag, or file existed in the repository to record it at the time it was
given. No specific timestamp or approval mechanism for that authorization is
recorded here, since none is independently established by repository evidence; this
document does not invent one.

## 4. Authorized scope

The Owner's implementation authorization for D-G1 covered:

- A standalone, explicitly-invoked D-G1 Originality measurement stage.
- Exact current-script resolution via `content_versions.script_id` (not
  latest-version inference).
- Corpus = every persisted `scripts` row except the exact current `script_id`.
- Reuse of the existing deterministic `tokenize()` and `jaccardSimilarity()`; no new
  algorithm, embeddings, semantic similarity, LLM, or provider dependency.
- A dedicated, append-only Originality result table, with every explicit evaluation
  creating a new result row.
- Explicit, distinct handling of the empty-corpus case: `corpus_size = 0`,
  `max_similarity = null`, `most_similar_script_id = null`.
- No threshold, no PASS/REVIEW/BLOCK verdict, no originality verdict of any kind, no
  AI detection, no copyright/fair-use adjudication, no reused-content adjudication,
  no monetization approval, and no Risk/Quality/Production/Publishing compliance
  logic.
- A genuine, durably persisted measurement preceding the `FACT_CHECK →
  ORIGINALITY_CHECK` transition; a computation or persistence failure must not
  transition state.
- Append-only dedicated-table evidence, with `decision_log` remaining only a
  lifecycle/event record.
- No `ContentStateMachine` redesign.
- No orchestrator, scheduler, pipeline coordinator, CLI, or production wiring.
- Minimum existing-code footprint: one migration and focused tests only, no
  unrelated refactors.
- Corpus-growth bias documented and accepted as a known v1 limitation.

## 5. Resulting implementation

The authorized scope in §4 was implemented and shipped as commit:

`09b6342413321064860c790c3db27b191aded72f` — "feat: implement d-g1 originality
measurement"

A prior reconciliation against this authorized scope (migration
`0006_originality_check_subsystem.sql`, `src/originality/constants.js`,
`src/originality/eligibility.js`, `src/originality/pipeline.js`, and
`tests/integration/originality-check-pipeline-e2e.test.js`) found the shipped
implementation within the boundaries recorded in §4. This record does not restate
that reconciliation in full and does not alter the implementation in any way.

## 6. Push authorization

Separately from the implementation authorization in §3, the Owner authorized pushing
the resulting implementation commit to `origin/main`. As with the implementation
authorization, this push authorization was given outside of Git, and no repository
artifact recorded it at the time. This document does not fabricate one; it records
only that the authorization was given and that the push it authorized is the one
reflected in the current `origin/main` history (`b621598` → `09b6342`).

## 7. Provenance status

This record is being added retrospectively. The original implementation and push
authorizations were both given by the Owner outside the repository's Git workflow,
prior to this document's creation. Its purpose is future auditability — so that the
authorization chain (ratification → implementation authorization → implementation →
verification → push authorization) can be reconstructed from repository contents
alone — not to retroactively alter, backdate, or reinterpret repository history.
