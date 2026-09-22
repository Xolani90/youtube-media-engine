# ADR-0037: Discovery LLM Output Token Ceilings

## Status
Approved

## Context
Three Discovery-stage LLM calls currently issue `llmRouter.complete({ prompt })`
requests with no `maxTokens` bound on the generated output:

1. `src/discovery/dedup.js` — `layer3SemanticJudgment`, invoked only for the
   ambiguous similarity band, expects a small structured JSON object
   (`{"sameEvent": boolean, "distinctAngle": boolean}`).
2. `src/discovery/proposition.js` — `generateProposition`, expects a
   structured Opportunity Proposition object with eight free-text fields
   plus `core_question_type`.
3. `src/discovery/featureComputation.js` — `computeRawFeatures`, expects a
   structured JSON object with eleven numeric (0-100) value-dimension
   fields.

Without an explicit ceiling, a provider has no per-call bound on generation
length for these stages, which is unnecessary given each stage's output
shape is small and well-defined, and leaves cost and latency for these
calls unbounded.

## Decision
Add an explicit `maxTokens` ceiling to each of the three `llmRouter.complete()`
requests above, scoped to that call only:

| Stage | File | Function | `maxTokens` |
|---|---|---|---|
| Semantic dedup judgment | `src/discovery/dedup.js` | `layer3SemanticJudgment` | 250 |
| Proposition generation | `src/discovery/proposition.js` | `generateProposition` | 1000 |
| Feature computation | `src/discovery/featureComputation.js` | `computeRawFeatures` | 800 |

These values bound generation length for their respective stage only. They
do not change retry, provider, or model behavior (governed by ADR-0018),
and do not add or change any call-count cap (Discovery fresh-evaluation
budget remains governed by ADR-0034).

Existing truncation-handling semantics in each stage are unchanged by this
decision:
- Dedup: an unparseable Layer 3 response (including one truncated
  mid-generation) continues to fall back conservatively to
  `sameEvent: true, distinctAngle: false`.
- Proposition: an unparseable or incomplete response continues to produce
  an empty/partial proposition that `validateProposition()` rejects.
- Feature computation: an unparseable or incomplete response continues to
  cause `computeRawFeatures` to throw explicitly rather than fabricate
  values.

## Consequences
- Bounded, predictable output length and cost per call for these three
  Discovery stages.
- No change to which provider/model is selected, retry behavior, or
  credentials (ADR-0018 remains authoritative).
- No change to Discovery's fresh-evaluation call-count budget (ADR-0034
  remains authoritative).
- If a legitimate response for one of these stages is ever cut off by its
  ceiling, it is handled by the same existing truncation/rejection paths
  as any other malformed response — this ADR does not introduce new
  truncation-recovery behavior.

## Governance
ADR-0037 is the governing decision for these three output ceilings.
ADR-0018 remains authoritative for Groq provider/model/retry/credential
behavior. ADR-0034 remains authoritative for the Discovery fresh-evaluation
call-count budget.
