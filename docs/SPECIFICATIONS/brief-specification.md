# Brief Specification (Content Brief Stage)

## 1. Status

**STATUS: SPECIFICATION ACCEPTED — IMPLEMENTATION NOT AUTHORIZED**

The Project Owner has explicitly accepted this specification, exactly as
written and including D1–D16 (§20), as the authoritative v1 governance
specification for the Content Brief stage. This document is not an ADR.

**Acceptance of this specification is distinct from, and does not confer,
implementation authorization.** Acceptance means the product/governance
decisions herein (D1–D16) are settled and this document is the
authoritative reference for a future Brief implementation. It does not
authorize any code, migration, test, or configuration changes; those
require a separate, explicit implementation authorization not granted by
this acceptance.

**IMPLEMENTATION NOT AUTHORIZED.**

## 2. Scope

This specification covers only the Brief stage: the transformation of an
accepted Research output into a persisted `content_briefs` row that a
future Script stage can consume.

Out of scope: Research internals (claim extraction, evidence grading,
corroboration, claim identity), Discovery internals, Script generation
itself, and any database migration. Nothing in this document changes
existing behavior anywhere else in the repository.

## 3. Purpose

**Research output → Brief → Script**

The Brief is a structured **content-planning artifact**. Its job is to take
what Research established (claims, evidence status, contradictions) about an
opportunity and turn it into a compact, human- and Script-consumable plan:
what the piece is about, who it's for, what claims it can safely make, and
what angle/hook/structure it should take.

The Brief is explicitly **not**:
- a second Research system (it does not gather new evidence or grade
  sources),
- a script (it does not contain finished prose, narration, or dialogue).

Everything factual in a Brief must originate from Research. Creative
content (hook, angle, narrative framing, visual ideas) is new content Brief
generation is allowed to invent, but it must never be presented as, or
confused with, a Research-backed factual claim. §11 defines exactly what is
enforceable about this boundary for v1 and what remains a known limitation.

## 4. Lifecycle Position

`RESEARCH_COMPLETE → BRIEF_CREATED` in `ContentStateMachine.js`'s existing
`STATES` ordering. This document does not modify that file; it only defines
the product behavior expected to sit behind that transition when it is
eventually wired. Per D7, the v1 trigger for this transition is **manual**
— no automatic or scheduled triggering is in scope.

## 5. Input Contract

| Candidate input | Classification | Notes |
|---|---|---|
| `opportunity_id` | REQUIRED | Brief cannot exist without an opportunity; matches existing FK. |
| `research_project_id` | REQUIRED | Must reference a `RESEARCH_COMPLETE` project (§6, per D1). Schema allows NULL; a NULL value is RETAINED FOR COMPATIBILITY only, not a supported v1 creation path. |
| Research status | REQUIRED as an eligibility gate — see §6. |
| Core question (from the Research project) | REQUIRED — becomes `core_question`, copied deterministically (§7, per D14). |
| Research claims (rows) | REQUIRED — source pool for `key_claims`; not copied wholesale. |
| Claim types (`FACT` / `INFERENCE` / `OPINION` — per D12) | REQUIRED as a filter — only `FACT`/`INFERENCE` claims may back `key_claims`; `OPINION` claims may inform `angle`/interpretation but are never asserted as fact. |
| Evidence status (`VERIFIED` / `PARTIALLY_SUPPORTED` / `UNSUPPORTED` / `CONTESTED`) | REQUIRED as a filter — only `VERIFIED` qualifies for `key_claims` (§10, per D2). |
| Source references | NOT CONSUMED directly into Brief fields. Available only indirectly, through the claim IDs a Brief references — Brief does not duplicate source metadata. |
| Contradiction records (`claim_relations`) | REQUIRED as a per-claim filter input — see §11 (per D3). |
| Completeness outcome | REQUIRED as an eligibility gate — a project that never reached `RESEARCH_COMPLETE` is not eligible (§6). |

## 6. Eligible Research States

**Per D1 (Project Owner decision — resolved):**

- **`RESEARCH_COMPLETE`** — ELIGIBLE, subject to one additional condition:
  the project must have **at least one eligible key claim** — i.e. at least
  one `VERIFIED`, non-contested claim of type `FACT` or `INFERENCE` (per
  D10). If no such claim exists, Brief creation is rejected (§13, §18 AC3).
- **`INSUFFICIENT_EVIDENCE`** — **NOT ELIGIBLE.** The restricted Brief path
  previously proposed for this status is removed entirely. A Research
  project in `INSUFFICIENT_EVIDENCE` can never produce a Brief, with or
  without restrictions. The Brief stage is downstream of *accepted*
  Research and must not become an alternate route around insufficient
  evidence.
- **`FAILED`** — **NOT ELIGIBLE.** No Brief may be created from a `FAILED`
  Research project under any circumstance.

This resolves the eligibility model to exactly two outcomes: `RESEARCH_COMPLETE`
with ≥1 eligible key claim → eligible; everything else → not eligible.

## 7. Output Contract — Field-by-Field Data Dictionary

For each existing `content_briefs` column:

### `id`
- Classification: REQUIRED
- Meaning: primary key.
- Source: generated at creation.
- Validation: unique, non-null.
- LLM-generated: No.
- Traceable to Research: N/A.
- May contain new information: N/A.

### `opportunity_id`
- Classification: REQUIRED
- Meaning: the opportunity this Brief plans content for.
- Source: copied from the eligible Research project's `opportunity_id`.
- Validation: must reference an existing `opportunities` row.
- LLM-generated: No.
- Traceable to Research: Yes (via the Research project's own FK).
- May contain new information: No.

### `research_project_id`
- Classification: REQUIRED
- Meaning: the Research project this Brief was built from.
- Source: caller-supplied, validated against `research_projects`.
- Validation: must exist; must be `RESEARCH_COMPLETE` with ≥1 eligible key
  claim (§6).
- LLM-generated: No.
- Traceable to Research: Yes, by definition.
- May contain new information: No.

### `working_title`
- Classification: OPTIONAL
- Meaning: a provisional, non-final title for internal planning use.
- Source: generated (LLM or human) from opportunity + core question.
- Validation: non-empty if present; must not assert an unsupported fact
  (§11 enforceable-controls list — generation-instruction level only).
- LLM-generated: Yes, permitted.
- Traceable to Research: No — creative content.
- May contain new information: Yes (naming/framing only, not new facts).

### `core_question`
- Classification: REQUIRED
- Meaning: the question the content piece is answering.
- Source: **deterministically copied** from the Research project's
  authoritative core question (per D14). Minor deterministic normalization
  (e.g. whitespace trimming) is acceptable. The Brief LLM MUST NOT rewrite
  or paraphrase it.
- Validation: non-empty; must match the Research project's core question
  up to whitespace normalization.
- LLM-generated: No.
- Traceable to Research: Yes, exactly.
- May contain new information: No.

### `target_audience`
- Classification: OPTIONAL
- Meaning: intended viewer/reader description.
- Source: DERIVED from opportunity metadata (`audience` column) if present;
  may be refined by LLM interpretation.
- Validation: non-empty if present; must not assert an unsupported fact.
- LLM-generated: Yes, permitted (refinement only).
- Traceable to Research: No.
- May contain new information: Yes (interpretive framing, not factual).

### `viewer_promise`
- Classification: OPTIONAL
- Meaning: what the viewer gets out of watching/reading — a planning aid.
- Source: creative/interpretive.
- Validation: non-empty if present; must not assert an unsupported fact.
- LLM-generated: Yes, permitted.
- Traceable to Research: No.
- May contain new information: Yes (creative content).

### `hook`
- Classification: OPTIONAL
- Meaning: opening angle/attention-grabbing framing.
- Source: creative.
- Validation: non-empty if present; must not assert a fact that isn't
  independently present in `key_claims` (generation-instruction level —
  see §11 for enforcement limits).
- LLM-generated: Yes, permitted.
- Traceable to Research: No (framing only).
- May contain new information: Yes (creative framing only, not new factual
  assertions).

### `angle`
- Classification: OPTIONAL
- Meaning: the interpretive point of view the piece takes.
- Source: interpretive, built from claims + opinion-type Research output.
- Validation: non-empty if present; must not assert an unsupported fact.
- LLM-generated: Yes, permitted.
- Traceable to Research: Indirectly (should be grounded in claims present in
  `key_claims`, but the angle text itself is not a factual claim).
- May contain new information: Yes, as interpretation, not as new fact.

### `narrative_structure`
- Classification: OPTIONAL
- Meaning: high-level structural outline for Script to follow.
- Source: creative/interpretive.
- Validation: non-empty if present; must not assert an unsupported fact.
- LLM-generated: Yes, permitted.
- Traceable to Research: No.
- May contain new information: Yes (structural, not factual).

### `key_claims`
- Classification: REQUIRED, non-empty (per D10 — a `RESEARCH_COMPLETE`
  project with zero eligible claims does not produce a Brief at all; see
  §6, §13).
- Meaning: JSON array of `claims.id` values this Brief is built on.
- Source: DERIVED — selected from the Research project's own claims.
- Validation: every ID MUST exist in `claims`, belong to the same
  `research_project_id`, have `evidence_status = VERIFIED` (per D2), be of
  `claim_type` `FACT` or `INFERENCE`, and not be involved in an unresolved
  `CONTRADICTS` relationship (per D3).
- LLM-generated: The **selection** of which eligible claims to include may
  be LLM-assisted, but the claim IDs themselves are never invented, and the
  selection is deterministically re-validated after generation (§12).
- Traceable to Research: Yes, by construction (this is the traceability
  mechanism).
- May contain new information: No — an entry that does not resolve to an
  existing, evidence-eligible claim row is invalid output (§13 rejection).
- Referential model: **v1 uses live `claims.id` references only** (per
  D9). No claim text or evidence-status snapshot is captured. Later
  Research-side mutation or deletion of a referenced claim is explicitly
  **out of scope for v1**, not silently solved.

### `counterpoints`
- Classification: OPTIONAL
- Meaning: known opposing views or contested claims the piece should
  acknowledge.
- Source: DERIVED from `claim_relations` (CONTRADICTS) plus interpretation.
- Validation: non-empty if present; MUST be grounded in an actual
  `claim_relations` row (per D13) and must not invent an externally
  asserted fact.
- LLM-generated: Yes, permitted for phrasing; the underlying contradiction
  must come from an actual `claim_relations` row.
- Traceable to Research: Yes, for the underlying contradiction; the prose
  is not itself a factual claim. Remains a plain text field for v1 — no
  structured claim-ID linkage is added (per D13); richer machine-readable
  provenance is a future hardening consideration, not a v1 requirement.
- May contain new information: Only in phrasing, not in asserting a
  contradiction that Research doesn't record.

### `original_insights`
- Classification: OPTIONAL
- Meaning: novel synthesis/interpretation not stated outright by any single
  source, but reasonably inferable by combining accepted claims.
- Source: interpretive synthesis.
- Validation: non-empty if present; MUST be grounded in the selected
  Research claims (`key_claims`) (per D13) and clearly interpretive, not
  phrased as an independently-sourced fact.
- LLM-generated: Yes, permitted — this is INTERPRETATION per §11.
- Traceable to Research: Loosely — should be explainable in terms of
  `key_claims`, but is not itself a 1:1 claim reference. Remains a plain
  text field for v1 (per D13).
- May contain new information: Yes, as synthesis, never as new factual
  assertion presented as sourced.

### `visual_ideas`
- Classification: OPTIONAL
- Meaning: suggested visuals/B-roll/graphics concepts.
- Source: creative.
- Validation: non-empty if present; must not assert an unsupported fact.
- LLM-generated: Yes, permitted.
- Traceable to Research: No.
- May contain new information: Yes (pure creative content).

### `monetization_opportunities`
- Classification: OPTIONAL
- Meaning: notes on sponsorship/ad/affiliate angles relevant to the topic.
- Source: creative/business judgment.
- Validation: non-empty if present; must not assert an unsupported fact.
- LLM-generated: Yes, permitted.
- Traceable to Research: No.
- May contain new information: Yes. Per D15, no additional
  platform-policy, sponsorship-policy, legal-policy, advertising-policy,
  or monetization-governance constraints apply beyond the general
  truth/invention boundary (§11) and deterministic validation controls
  already specified — this remains a creative/business-judgment field for
  v1. Such constraints may be considered in future hardening but are out
  of scope here.

### `risk_assessment`
- Classification: OPTIONAL, RETAINED FOR COMPATIBILITY (per D4).
- Meaning: a non-binding advisory note (e.g. "unverified claim about X
  present in angle"). It is NOT an approval gate and is NOT equivalent to
  the existing `risk_assessments` table tied to `content_versions`, which
  remains the sole authoritative risk gate. This task does not duplicate,
  remove, or migrate that existing mechanism.
- LLM-generated: Yes, permitted, non-binding.
- Traceable to Research: Indirectly.
- May contain new information: Advisory notes only.

### `created_at`
- Classification: REQUIRED
- Meaning: creation timestamp.
- Source: generated at creation.
- Validation: non-null, ISO timestamp, consistent with existing table
  conventions (`TEXT NOT NULL`).
- LLM-generated: No.

## 8. (reserved — merged into §7)

This section intentionally left as a marker; field-level detail lives in §7
to avoid duplication. See §11 for the truth/invention boundary and §9/§10
for claim traceability and evidence handling.

## 9. Claim Traceability

`key_claims` is the authoritative traceability mechanism for factual
content in a Brief:

- Every entry MUST be an existing `claims.id` belonging to the same
  `research_project_id`.
- An entry referencing a nonexistent or mismatched-project claim ID is a
  validation failure — the Brief is rejected, not silently corrected.
- Referential model for v1: **live references only** (per D9). Brief
  validation at creation time checks current existence, ownership,
  evidence status, and contradiction status. No claim text or
  evidence-status snapshot is captured at creation time. Later Research-side
  mutation or deletion of a referenced claim is explicitly **out of scope
  for v1** — this is a known limitation, not a silently-resolved question.
- Evidence-status bar for a claim to be eligible for `key_claims` (per D2):
  - `VERIFIED` — eligible.
  - `PARTIALLY_SUPPORTED` — **NOT eligible** (tightened from an earlier
    draft default; per D2 this is now VERIFIED-only).
  - `UNSUPPORTED` — NOT eligible.
  - `CONTESTED` — NOT eligible.
- Claim-type bar: only `FACT` and `INFERENCE` claims may appear in
  `key_claims`; `OPINION` claims never do (per D12 terminology — the
  correct enum values are `FACT`/`INFERENCE`/`OPINION`, not "FACTUAL").
- Contradiction bar: a claim involved in an unresolved `claim_relations`
  (CONTRADICTS) record MUST NOT appear in `key_claims`, regardless of its
  own evidence status (per D3; see §11).

## 10. Evidence Handling

**Per D2 (Project Owner decision — resolved), the bar for `key_claims` is
now VERIFIED-only:**

| Evidence status | May back a `key_claims` entry? |
|---|---|
| `VERIFIED` | Yes |
| `PARTIALLY_SUPPORTED` | No |
| `UNSUPPORTED` | No |
| `CONTESTED` | No |

This is a Brief-eligibility rule only. It does not reinterpret or modify
Research's own evidence grading, which is computed entirely independently
and unaffected by this document.

## 11. Truth / Invention Boundary (incl. Contradiction Handling)

**Contradiction handling — per D3 (resolved):**

- A contradiction existing *somewhere* in the Research project does **not**
  automatically block Brief creation.
- A specific claim involved in an unresolved `CONTRADICTS` relationship
  MUST be excluded from `key_claims`. It must never be presented as
  settled factual content.
- The Brief may proceed using the project's other eligible `VERIFIED`
  claims.
- `counterpoints` may acknowledge the existence of conflicting claims when
  grounded in an actual `claim_relations` record (§7).
- In short: **project-level contradiction ≠ automatic Brief failure**;
  **candidate key claim being contested = exclude that claim.**

**Free-text factual integrity — per D11 (resolved):**

The Brief must not intentionally introduce unsupported factual claims in
any free-text field (`working_title`, `hook`, `angle`, `viewer_promise`,
`target_audience`, `narrative_structure`, `counterpoints`,
`original_insights`, `visual_ideas`, `monetization_opportunities`). This
specification does **not** mandate a new semantic/NLI/claim-extraction
subsystem to enforce that goal. The v1 approach is deliberately layered:

**Enforceable v1 controls** (deterministic, testable):
1. `key_claims` entries must be valid claim IDs.
2. Those claims must belong to the correct `research_project_id`.
3. Those claims must meet the `VERIFIED` evidence-status requirement (§10).
4. Claims with an unresolved contradiction are excluded (above).
5. No claim's evidence status may be upgraded or reinterpreted by Brief
   generation.
6. No claim ID may be invented — only IDs supplied from the actual
   Research project may appear in `key_claims`.
7. Generation instructions (prompt-level) explicitly prohibit unsupported
   factual invention in every free-text field.

**Known v1 limitation / future hardening** (explicitly acknowledged, not
solved here): semantic detection of unsupported factual assertions
embedded in arbitrary free-text prose (`hook`, `angle`, `counterpoints`,
etc.) is **not** performed by any deterministic validation in v1. The
specification does not claim that deterministic validation can fully
guarantee factual integrity of free text — only that the enforceable
controls above are in place, and that going further (e.g. an NLI-based
recheck of generated prose) is a future hardening concern, out of scope
for v1 and not authorized by this document.

- **Interpretation** (e.g. `original_insights`, `angle`) may synthesize
  across multiple accepted (`VERIFIED`) claims, but must not contradict
  Research's determination on any individual claim (e.g. must not treat a
  `CONTESTED` claim as settled).
- **Creative content** (`working_title`, `hook` framing,
  `narrative_structure`, `visual_ideas`, etc.) is free to invent
  presentation, wording, and structure, but may never smuggle in a factual
  claim that isn't independently backed in `key_claims`.

## 12. LLM Role

- An LLM MAY be used for Brief generation, consistent with the existing
  `LLMRouter`/R0-first infrastructure already built for Research.
- The LLM receives: the eligible claims (id, text, claim_type, evidence
  status) for the research project, and the opportunity's core metadata
  (title, description, audience, category). It does NOT receive raw source
  text/URLs — Brief does not re-derive sourcing.
- The LLM MAY generate: `working_title`, `hook`, `angle`,
  `narrative_structure`, `visual_ideas`, `monetization_opportunities`,
  `original_insights`, `counterpoints` phrasing, `viewer_promise`,
  `target_audience` refinement, and a proposed `key_claims` selection
  (subset of the `VERIFIED`, non-contested `FACT`/`INFERENCE` claim IDs it
  was given).
- The LLM MUST NOT: invent new claim IDs, invent new factual statements not
  present in the claims it was given, alter a claim's evidence status,
  resolve a contradiction on its own authority, or rewrite/paraphrase
  `core_question` (per D14 — that field is copied deterministically, not
  LLM-generated).
- **Claim paraphrasing (per D16 — resolved):** the LLM MAY paraphrase a
  Research claim's wording when referencing it in `angle`, `counterpoints`,
  or `original_insights`, provided the paraphrase (a) preserves the
  meaning of the underlying claim, (b) does not strengthen, broaden, or
  materially alter the claim, (c) does not introduce unsupported factual
  content, (d) does not imply evidence the claim does not have, and (e)
  does not resolve or conceal a contradiction. If wording is presented as
  a **direct quotation**, it MUST be reproduced exactly from the
  authoritative Research claim/source text available to the Brief
  process — a paraphrase MUST NOT be presented as a direct quote. No new
  quote/provenance subsystem is introduced for this — the existing
  `key_claims` live-ID mechanism remains the sole authoritative structural
  traceability mechanism; quotation accuracy itself is a
  generation-instruction-level control, not a deterministically validated
  one (consistent with the free-text limitation in §11).
- All LLM output MUST be deterministically validated post-generation (same
  pattern as Research's `validateExtractedClaim`-style gating): any claim
  ID not in the supplied eligible set is rejected; any output missing
  required fields is rejected.
- Retries: permitted, following the same bounded-attempt pattern as
  Research's acquisition/retry logic (attempt cap, no unbounded loop).
- Idempotency of retries: a retry MUST NOT create a second `content_briefs`
  row for the same Research project (§14).
- On invalid LLM output after exhausting retries: no Brief is persisted;
  this is a Brief-creation failure (§16), not a partially-invalid Brief.

## 13. Validation

A Brief creation attempt MUST fail validation if any of the following
hold:

- `opportunity_id` does not reference an existing opportunity.
- `research_project_id` does not reference an existing `RESEARCH_COMPLETE`
  Research project (per D1 — `INSUFFICIENT_EVIDENCE` and `FAILED` are both
  rejected here, with no restricted/partial path for either).
- The Research project has **zero eligible key claims** (`VERIFIED`,
  non-contested, `FACT`/`INFERENCE`) available (per D10) — Brief creation
  is rejected outright in this case; no Brief row is created.
- Any `key_claims` entry does not resolve to an existing claim on that
  Research project, or fails the evidence/type/contradiction bar in §9/§10.
- `core_question` is empty, or does not match the Research project's core
  question (up to whitespace normalization — per D14).
- Required fields per §7 are missing.
- Generated content is empty/malformed (e.g., non-JSON `key_claims`).

**Duplicate handling is NOT a validation-failure case** — it is handled
distinctly per §14/§16 (return-existing or replace, never a bare rejection).

## 14. Idempotency and Duplicate Policy

**Per D5 and D6 (Project Owner decisions — resolved), using one consistent
behavior throughout this document:**

- **One Research project may have at most one canonical Brief** (D5). The
  current schema does not enforce this with a UNIQUE constraint yet — that
  is an implementation/migration concern for later, not performed by this
  specification document.
- **Regeneration replaces the existing canonical Brief in place** (D6). No
  Brief version history and no append-only history are part of v1.
- **The exact consistent duplicate-request semantic** (resolving the prior
  §13/§16 contradiction):
  > A duplicate creation request **without** an explicit regeneration flag
  > returns the existing canonical Brief. An **explicit regeneration**
  > request replaces the existing canonical Brief in place. Retries must
  > never create an additional canonical row.
- This is a product behavior decision, not merely a technical convenience,
  and is now settled for v1 per the Owner's explicit input — no competing
  "reject vs. return vs. replace" language remains in this document.
- A database-level UNIQUE constraint on `content_briefs.research_project_id`
  is the natural future enforcement mechanism, but adding it is a **future
  implementation requirement** — no schema change is made here.

## 15. Lifecycle Transition

- **Trigger (per D7 — resolved):** Brief creation is **manually initiated**
  for a Research project that has reached `RESEARCH_COMPLETE` with ≥1
  eligible key claim. No automatic, scheduled, or background-orchestrated
  triggering is in scope for v1.
- **What `BRIEF_CREATED` means:** a valid canonical Brief has been
  successfully persisted (row inserted and validated per §13) — the
  transition is not fired for a partially-generated or unvalidated
  attempt.
- **What must be persisted before transition:** a valid `content_briefs`
  row passing all validation in §13 must exist before the state machine
  transitions the underlying content/opportunity record to
  `BRIEF_CREATED`.
- **On failure (per D8 — resolved):** if Brief creation fails validation or
  exhausts LLM retries, no Brief is persisted, no `BRIEF_CREATED`
  transition occurs, and the underlying Research/content state **remains
  unchanged** — no new failure state is introduced. The caller can retry.
- **Partial Briefs:** not allowed. A Brief is created and validated as a
  whole, or not persisted at all.
- **Atomicity:** the Brief row insert and the state transition are treated
  as a single logical unit; exact transactional mechanics are an
  implementation detail out of scope here.
- **Regeneration and lifecycle state (per D6/§15 clarification):**
  regenerating (replacing) an existing canonical Brief does **not** create
  a new lifecycle state or fire an additional `BRIEF_CREATED` transition if
  the project is already past that point in the state machine — it is a
  data-layer replace operation.

## 16. Failure Behavior

| Failure case | Behavior |
|---|---|
| Invalid/nonexistent Research project | Reject; no Brief created. |
| `INSUFFICIENT_EVIDENCE` Research | Reject unconditionally; no Brief created (per D1 — no restricted path exists). |
| `FAILED` Research | Reject unconditionally; no Brief created. |
| `RESEARCH_COMPLETE` with zero eligible key claims | Reject; no Brief created (per D10). |
| Invalid LLM output (after retries) | Reject; no Brief created; no transition. |
| Database failure during Brief write | No Brief considered created; caller must retry; no partial row. |
| Duplicate creation attempt, no regeneration flag | Return the existing canonical Brief (per D6) — not an error. |
| Duplicate creation attempt, explicit regeneration flag | Replace the existing canonical Brief in place (per D6). |
| Missing/invalid claim ID in generated `key_claims` | Reject that generation attempt; do not silently drop the bad ID and proceed. |
| Unresolved contradiction on a proposed key claim | Exclude that claim from `key_claims` (per D3); do not fail the whole Brief solely for this. |
| Validation failure (any §13 rule) | Reject; no Brief created; no transition. |
| Retry exhaustion (LLM) | Treated as Brief-creation failure; no partial output persisted; underlying state unchanged (per D8). |

## 17. Brief → Script Contract

Script may assume, for any Brief it receives:

- The Brief passed all validation in §13 at creation time.
- Every ID in `key_claims` resolves to an existing Research claim that was
  `VERIFIED`, non-contested, and of type `FACT`/`INFERENCE` **as of
  Brief-creation time** (live-reference model, per D9 — Script must be
  aware that no snapshot guarantees this remains true if Research data is
  later mutated; that scenario is out of scope for v1).
- `core_question`, `opportunity_id`, and `research_project_id` are present
  and correct.
- `target_audience`, `hook`, `angle`, `narrative_structure`, and
  `visual_ideas` may or may not be populated (all OPTIONAL per §7) — Script
  must handle absence gracefully.
- `risk_assessment` on the Brief is advisory only, not the authoritative
  risk gate (per D4) — Script/downstream stages must not treat it as a
  pass/fail signal.
- **Free-text fields are not guaranteed free of unsupported factual
  assertions** beyond the generation-instruction level (§11's "known v1
  limitation"). Script should not treat `hook`/`angle`/`counterpoints`/
  `original_insights` prose as independently fact-checked — only
  `key_claims` entries carry a deterministic evidence-status guarantee.

Designing Script itself is out of scope for this document.

## 18. Acceptance Criteria

Testable statements a future implementation must satisfy:

1. Given a Research project in `RESEARCH_COMPLETE` with at least one
   `VERIFIED`, non-contested `FACT`/`INFERENCE` claim, Brief generation
   produces a `content_briefs` row with a non-empty `key_claims` array,
   and every ID in that array references such a claim on that project.
2. Given a Research project in `FAILED`, Brief generation is rejected and
   no `content_briefs` row is created.
3. Given a Research project in `INSUFFICIENT_EVIDENCE`, Brief generation is
   rejected and no `content_briefs` row is created — unconditionally, with
   no restricted or partial path (per D1).
4. Given a `key_claims` selection (from LLM or otherwise) containing an ID
   not present among the Research project's eligible claims, the Brief is
   rejected and not persisted.
5. Given a claim with any evidence status other than `VERIFIED`, that
   claim can never appear in `key_claims` (per D2).
6. Given a claim involved in an unresolved contradiction, that claim is
   excluded from `key_claims`, but the Brief may still be created from the
   project's other eligible claims (per D3).
7. Given a Research project that already has a canonical Brief, a request
   without an explicit regeneration flag returns the existing Brief
   (no duplicate row created); a request with an explicit regeneration
   flag replaces the existing Brief in place (per D6).
8. Given a Brief creation attempt that fails validation, no partial
   `content_briefs` row is persisted and no `BRIEF_CREATED` transition
   occurs.
9. Given a `RESEARCH_COMPLETE` Research project with zero eligible key
   claims, Brief generation is rejected and no `content_briefs` row is
   created (per D10).

## 19. (reserved)

Superseded — Project Owner decisions are now consolidated in §20 rather
than listed separately here.

## 20. Project Owner Decisions

### PROJECT OWNER DECISIONS — RESOLVED FOR THIS PROPOSED VERSION

- **D1 — `INSUFFICIENT_EVIDENCE` eligibility:** INELIGIBLE. Only
  `RESEARCH_COMPLETE` is eligible for Brief creation; the restricted path
  is removed (§6).
- **D2 — Key-claim evidence bar:** `VERIFIED` only. `PARTIALLY_SUPPORTED`,
  `UNSUPPORTED`, and `CONTESTED` claims are all excluded from `key_claims`
  (§9, §10).
- **D3 — Contradictions:** exclude the specific contested claim from
  `key_claims`; do not block the entire Brief for a project-level
  contradiction elsewhere (§11).
- **D4 — Risk assessment:** advisory-only compatibility field; not an
  approval gate; does not duplicate `risk_assessments` (§7, §17).
- **D5 — One canonical Brief:** at most one canonical Brief per Research
  project; not yet enforced by a schema constraint (§14).
- **D6 — Regeneration/duplicates:** replace-in-place for v1; no version
  history; duplicate request without regeneration flag returns the
  existing Brief; explicit regeneration replaces it (§14, §16, §18 AC7).
- **D7 — Creation trigger:** manual only for v1; no automatic or scheduled
  triggering (§4, §15).
- **D8 — Failed Brief creation:** no new lifecycle/failure state; prior
  state remains unchanged; caller may retry (§15, §16).
- **D9 — Claim integrity model:** live `claims.id` references only for v1;
  no snapshot of claim text/evidence status; later Research-side mutation
  or deletion is explicitly out of scope for v1 (§9, §17).
- **D10 — Zero eligible claims:** a `RESEARCH_COMPLETE` project with zero
  eligible `VERIFIED`, non-contested key claims does not produce a Brief
  (§6, §13, §18 AC9).
- **D11 — Free-text factual invention:** enforce only the deterministic,
  structural controls listed in §11; no new NLI/semantic-matching
  subsystem is introduced; semantic detection of factual invention in
  free text is an explicitly acknowledged v1 limitation and future
  hardening concern (§11, §17).
- **D12 — Claim-type terminology:** use `FACT` / `INFERENCE` / `OPINION`
  (the actual `claim_type` enum) throughout; the separate question-type
  vocabulary (`FACTUAL` / `SENTIMENT` / `MIXED`) is unrelated and left
  untouched (§5, §9).
- **D13 — Counterpoints / original insights:** remain plain text fields
  for v1, no structured claim-ID linkage added; must be grounded in actual
  Research contradiction/claim data by generation instruction, not by
  schema enforcement (§7, §11).
- **D14 — Core question:** deterministically copied from the Research
  project's authoritative core question; whitespace-level normalization
  only; the Brief LLM must not rewrite or paraphrase it (§7, §12).
- **D15 — Monetization opportunities:** no additional policy constraints
  for v1 beyond the general truth/invention boundary (§11) and existing
  deterministic validation controls; remains a creative/business-judgment
  field; further governance (platform/sponsorship/legal/advertising
  policy) is future hardening, out of scope for v1 (§7).
- **D16 — Claim paraphrasing:** the LLM may paraphrase a Research claim's
  wording in `angle`/`counterpoints`/`original_insights`, provided the
  paraphrase preserves meaning, does not strengthen/broaden/alter the
  claim, introduces no unsupported fact, implies no evidence the claim
  lacks, and does not resolve or conceal a contradiction. Content
  presented as a direct quotation must be reproduced exactly from the
  authoritative Research claim/source text; a paraphrase must never be
  presented as a direct quote. No new quote/provenance subsystem is
  introduced — `key_claims` remains the sole authoritative structural
  traceability mechanism (§12).

All items previously listed under "NEW PROJECT OWNER DECISION REQUIRED"
have now been resolved as D15 and D16 above. No further unresolved items
remain identified as of this update.

## 21. Relationship to Research Governance

Research remains accepted per prior project history. This specification
does not reopen, modify, or re-litigate Research's implementation, claim
extraction, evidence grading, or corroboration logic. The status of
claim-identity/cross-source corroboration governance (formerly referenced
as "ADR-0002") could not be independently verified from the current
archive in a prior reconciliation audit, and this document does not
attempt to resolve that. Brief consumes Research's existing evidence-status
output as-is (§10, per D2); it does not change how that status is
computed.

## 22. Relationship to D-01/D-02

D-01 and D-02 (Discovery-stage work) remain closed and are unaffected by
this specification. No Discovery behavior is referenced, assumed, or
changed here beyond the existing `opportunity_id` linkage already present
in the schema.

## 23. Implementation Authorization Status

**SPECIFICATION ACCEPTED — IMPLEMENTATION NOT AUTHORIZED**

The Project Owner has explicitly accepted this specification (D1–D16, §20)
as the authoritative v1 governance specification for the Content Brief
stage (see §1). This acceptance does not, by itself, authorize
implementation, Research changes, Discovery changes, database migrations,
or Script implementation. Any of those requires a separate, explicit
implementation authorization, not granted by this document.
