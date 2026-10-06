# ADR-0039 — Resumable Research recovery (B4)

Status: implemented (Pass 36C). Owner decisions applied: (1) fail the attempt on a
transient extraction failure; (2) propagate infrastructure failures.

## Problem

`attemptExtraction` returned `PROVIDER_FAILED` without throwing and the pipeline's
source-level isolation (v0.4 S12) skipped the source, so a 429/outage on every source
ended as `INSUFFICIENT_EVIDENCE` — a terminal, valid-looking research result. A retry
after any interruption also re-acquired sources (duplicating evidence).

## Failure classification (`src/research/researchFailure.js`)

Pure; reads only structured fields (`status`, `code`, `name`, `causeCode`) — never message text.
Natures reuse the existing evidence vocabulary (`StageRetryPolicy.FAILURE_NATURE`).

| Condition | Nature | Effect |
|---|---|---|
| 429, 500, 502, 503, 504; AbortError/TimeoutError; ECONN*/ETIMEDOUT/EAI_AGAIN/ENOTFOUND/EPIPE/UND_ERR_* | TRANSIENT | whole attempt abandoned; one `RESEARCH` attempt recorded; bounded (cap 3, then quarantine) |
| 401, 402, 403; `NO_USABLE_PROVIDER`; `BudgetExceededError`; breaker opened by auth/credits | INFRASTRUCTURE | attempt abandoned; **no** attempt recorded; project stays RESEARCHING |
| anything else (incl. unknown status) | UNCLASSIFIED | fail closed: no attempt, no retry; project `FAILED`, stop reason `RESEARCH_UNCLASSIFIED_FAILURE` |
| empty/truncated/malformed/non-array output; local workload budget exhausted | ISOLATE | unchanged: that source is skipped (`EXTRACTION_FAILED`) |

A mixed set of provider failures takes the most conservative nature. No new project
status or semantic research outcome is introduced; only stop-reason strings.

## Checkpoints (`research_checkpoints`, migration 0029)

Each row is written in the **same transaction** as the evidence it describes.

- `SOURCES_PERSISTED` — acquired sources + decision rows (+ acquisition counters).
- `EXTRACTION_PERSISTED` — all claims, links, identity/convergence/decision rows.
  Extraction is two-phase: phase 1 = LLM calls only (no writes; call order, prompts and
  pacing unchanged); phase 2 = one transaction. `EXTRACTION_FAILED` rows keep their
  per-source order.
- `EXPANSION_PERSISTED` — expansion sources + exact expansion budget state:
  `topFactClaimId`, `expansionAttemptsUsed`, `callsRemaining`, `expansionSourcesAcquired`.

Resume skips whatever a checkpoint covers. A project holding sources but no
`SOURCES_PERSISTED` (pre-ADR-0039 partial state) is never selected and is refused on
direct invocation — re-acquiring would duplicate committed evidence.

## Retry stage

`RETRY_STAGE.RESEARCH` (subject = `research_projects.id`, not provider-scoped).
`selectEligibleResearch` additionally returns resumable, non-quarantined `RESEARCHING`
projects (same item shape as a fresh item). The runner paces Research per opportunity.

## Not changed (by instruction)

Providers/models/priority, Gemini pacing, evidence gates/thresholds, convergence
semantics, discovery/yield, Brief eligibility, script grounding, publication, media,
autonomous enablement, historical evidence rows.

## Known remaining items (out of B4 scope — not altered)

- A contradiction-detector provider error still ends the project `FAILED`
  (`CONTRADICTION_CHECK_FAILED`) rather than reaching retry.
- Re-running after `EXTRACTION_PERSISTED` repeats the contradiction pass and the first
  verification pass (their writes are idempotent; decision rows are re-logged and the
  verifier-call budget restarts). Only the expansion budget is persisted exactly.
