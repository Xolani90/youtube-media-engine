# ADR-0018 — Groq LLM Provider Retrospective Ratification

**Status:** Accepted — Retrospective Owner Ratification
**Decision Date:** 2026-09-19
**Decision Type:** Governance Reconciliation
**Related Implementation:** `cbad58b49c93ca8602af85a32eca035e1f257dea`, `82d3aec87b6e6b6435d6fadd4692cb0f5393856e`, `905ba77ea95524253bc72c7469611decc7833210`, `9f54d48349eaa8a16edb3cb8a153a5f6c4f91671`
**Related Investigation:** G-1 Governance Disposition Audit (preceding this ADR)
**Precedent:** ADR-0014 (present-tense retrospective ratification of already-shipped implementation)

---

## 1. Decision

The Owner retrospectively ratifies the already-existing Groq LLM provider implementation, specifically:

- `src/providers/llm/GroqProvider.js` (live network calls to `https://api.groq.com/openai/v1/chat/completions`);
- the existing Groq entry in provider candidate/priority wiring (`groq-free`, `src/config/index.js`);
- the existing bounded 429-retry behavior (`MAX_ATTEMPTS_ON_429 = 2`, `Retry-After` honored when present, 2-second fallback delay otherwise, no unrestricted retry loop);
- the existing tests covering the above (`tests/unit/groq-provider.test.js`);
- the existing real-credential diagnostic/proof harnesses associated with the Groq implementation (`scripts/generate-real-brief.js`, `scripts/generate-real-script.js`, and the diagnostic script added at commit `0717725`).

This is a present-tense governance act, performed now. It does not rewrite, backdate, or reinterpret the historical record of how or when the implementation came to exist.

---

## 2. Historical Implementation Fact

The Groq provider was implemented and shipped before this ratification, across:

- `cbad58b` — `feat: add real Groq LLM provider` (2026-09-16)
- `82d3aec` — `fix: use current Groq production model` (2026-09-16)
- `905ba77` — `feat: add bounded Groq 429 retry` (2026-09-17)
- `9f54d48` — `feat: add bounded Groq 429 retry` (2026-09-17, child of `905ba77`)

These commits predate this ADR by approximately three days. This ADR does not alter that sequence.

---

## 3. Authorization Status Before Ratification

The preceding G-1 Governance Disposition Audit established, and this ADR adopts without modification:

- Contemporaneous Owner authorization for the Groq implementation was **not established** — no artifact in this repository's established authorization-provenance format (the pattern used by ADR-0007, ADR-0009, ADR-0013, ADR-0015, ADR-0017) names Groq specifically.
- The implementation was deliberate and substantial — a multi-commit effort spanning provider implementation, model correction, bounded-retry hardening, and dedicated real-credential diagnostic harnesses.
- Owner awareness was strongly indicated — all implementing commits share the Owner's Git identity (`Xolani <xolani.tshabalala1990@gmail.com>`), and a later commit (`611abc3`, `docs(readme): reconcile current pipeline status`) authored under the same identity explicitly and factually acknowledged the live Groq wiring in `README.md`.
- The autonomous-operation checkpoint subsequently became stale/contradicted: its Hard Prohibitions (§6) and Summary (§8) sections continued to list "Implement real LLM providers" / "Real LLM providers" as prohibited/deferred-with-no-timeline, through two later reconciliation passes, after the implementation already existed.
- No existing artifact — prior to this ADR — constituted formal retrospective ratification. Descriptive acknowledgment (the README wording) is not equivalent to ratification, consistent with the distinction this repository's own convention already draws between documentation and governance acts (see ADR-0014 §5 and its surrounding sections).

This ADR does not claim that contemporaneous authorization existed. It records that it was not established, and that the present ratification is a separate, later governance act.

---

## 4. Current Owner Action

The Owner is **retrospectively ratifying** the already-existing Groq implementation identified in §1.

This ratification:

- applies only to the specific implementation already shipped and identified in §1;
- does not convert the original implementation into contemporaneously authorized work;
- does not imply that an authorization existed on 2026-09-16 or 2026-09-17;
- is not a blanket authorization for future Groq changes or for other, not-yet-implemented real LLM providers (Gemini, OpenRouter, DeepSeek, or any other candidate).

Future changes to Groq's runtime behavior, provider priority, retry behavior, credential handling, or the addition of any other real LLM provider remain subject to this repository's normal Owner-authorization/governance process, in the same manner as every other pipeline component.

---

## 5. Evidence Basis

The following material evidence supports this ratification decision. None of these items, individually or collectively, is claimed to independently prove contemporaneous authorization — they support the present, separate act of retrospective ratification:

- Multi-commit, deliberate implementation (§2).
- Real provider wiring, verified by direct code inspection (`GroqProvider.js`, `src/config/index.js`).
- Bounded 429-retry hardening, verified by direct code inspection and existing tests.
- Real-credential diagnostic/proof artifacts (commit `0717725`), demonstrating deliberate, informed use of live credentials rather than incidental or accidental wiring.
- Subsequent same-identity README acknowledgment (`611abc3`) treating the Groq wiring as an existing, accepted fact.
- Consistent Owner Git identity across all of the above.
- The preceding G-1 Governance Disposition Audit, which found this evidence sufficient to support a future Owner ratification decision without itself constituting ratification.

---

## 6. Precedent

ADR-0014 is the closest precedent for this ADR's governance mechanism: a present-tense Owner ratification of an already-shipped implementation that lacked contemporaneous written authorization for its full scope.

The situations are procedurally similar, not identical. ADR-0014 ratified a single file addition (`src/autonomous/workSelection.js`) that fell narrowly outside an existing authorization's explicit scope (ADR-0013), where the surrounding stage implementation itself had been authorized. This ADR ratifies an implementation (Groq) for which no prior authorization of any scope had been given — the entire provider implementation, not one adjacent file, was undertaken without a preceding contemporaneous authorization record. The mechanism used to resolve both — an explicit, present-tense Owner ratification statement recorded in a numbered ADR — is the same; the extent of what had gone unauthorized beforehand differs.

---

## 7. Historical Integrity

The permanent historical record is:

1. ADR-0001 described real LLM-provider network wiring as a future Phase-2+ task, contingent on an Owner decision to obtain and store real credentials.
2. The Groq provider was implemented (`cbad58b` et seq.) without a preceding, discoverable ADR recording that Owner decision.
3. The checkpoint's Hard Prohibitions/Deferred-work language (introduced at `fb79de7`, itself written approximately 2.5 hours before the first Groq commit, and therefore accurate when written) was not updated in the two subsequent checkpoint reconciliation passes that followed the implementation.
4. The G-1 investigation and disposition audits found no contemporaneous authorization artifact, no evidence of explicit prohibition at implementation time, and evidence sufficient to support — but not constituting — retrospective ratification.
5. The Owner now retrospectively ratifies the specific, already-shipped Groq implementation through this ADR.

The retrospective nature of this decision is intentional and is not to be read as, or converted into, a claim of contemporaneous authorization.

---

## 8. No New Implementation Scope

This ADR authorizes no new source-code, migration, test, runtime, credential, or architectural change. It does not authorize modification of:

- `src/providers/llm/GroqProvider.js`;
- `src/config/index.js` or any other provider-priority configuration;
- Groq's retry behavior, model selection, or credential handling;
- any other provider (Gemini, OpenRouter, DeepSeek, or others);
- any other pipeline stage or subsystem.

Its sole purpose is to record the Owner's retrospective ratification of the already-shipped Groq implementation identified in §1.

---

## 9. No General Precedent

This retrospective ratification is specific to the Groq implementation identified in §1. It must not be interpreted as standing permission for future implementations to proceed without prior authorization on the expectation of later retrospective ratification. Future work requires explicit governance authorization through the repository's established process in the ordinary course.

---

## 10. Other Governance Matters

This ADR does not resolve or modify the separate governance status of:

- the historical Decision F Media Production failures;
- Discovery v0.6 or Research v0.4 (both UNRECOVERABLE per their respective governance records);
- any other real LLM provider (Gemini, OpenRouter, DeepSeek) — none is implemented, and none is authorized or ratified by this ADR;
- future publication, production, or provider architecture.

Those matters require their own evidence and governance records.

---

## 11. Final Decision

The specific question resolved by this ADR is:

> Should the already-shipped Groq LLM provider implementation (§1) be retrospectively ratified despite the absence of a contemporaneous authorization record?

**Owner decision: YES.**

The Owner retrospectively ratifies the specific, already-shipped Groq implementation identified in §1. This decision does not alter the historical fact that the implementation proceeded without a preceding, discoverable contemporaneous authorization artifact.

---

## 12. Record Status

**ACCEPTED — RETROSPECTIVE OWNER RATIFICATION**

This ADR is the permanent governance record for the Groq LLM provider implementation's authorization status. No source-code change is implied or authorized by this document. Checkpoint reconciliation of the specific §6/§8 statements this ADR supersedes is recorded separately (see `docs/CHECKPOINTS/autonomous-operation-checkpoint.md`).
