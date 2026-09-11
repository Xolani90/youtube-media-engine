# ADR-0002: Governance — Fact-Check P1, Cost Enforcement, and Prompt Trust Boundary

## Status
Accepted (Owner-ratified). Documentation/governance record only — no implementation
changes are contained in this commit.

## Context
This record captures a set of Owner decisions made across several review sessions on
the pipeline built under ADR-0001. It exists so that future sessions do not need to
re-derive these decisions from conversation history, and so that the scope of what has
been approved (versus deferred) is unambiguous before any implementation work proceeds.

## Decisions

### D-A — Fact-Check P1 (state-machine destination on forced-rerun REJECT)
**ACCEPT AS IMPLEMENTED. Close P1.**
No `ContentStateMachine` change is authorized or required by this decision.

### D-B1 — LLMRouter-level cost enforcement
**APPROVED.** Cost enforcement is to be implemented at the `LLMRouter.complete()`
boundary, before a billable provider call is allowed to proceed, using the existing
`CostTracker` mechanism. `maxCostPerContent` remains a **per-call** ceiling; this
decision does not redefine it as a cumulative budget.

### D-B2 — Cumulative per-content budget
**DEFERRED.** Current per-call semantics are retained. No cumulative per-content
budgeting abstraction is authorized at this time.

### D-B3 — Monthly budget enforcement
**DEFERRED.** The existing cost mechanism is preserved as-is. Monthly budget
enforcement is left to a future, separately-approved cost implementation.

### D-C1 — Run-level LIVE/SIMULATION model
**ACCEPTED.** The existing run-level LIVE/SIMULATION model stands as the governing
model for this pipeline.

### D-C2 — Stronger side-effect authorization for Production/Publishing
**ACCEPTED as a future requirement.** No current implementation. Production and
Publishing stages will require a stronger, explicit side-effect authorization
mechanism before they are built out; this decision only records that requirement,
it does not implement it.

### D-D1 — Prompt trust boundary (Option D)
**ACCEPTED.** Where untrusted external source material is inserted into prompts, the
trust boundary must be made structurally explicit via:
- clear delimiters around untrusted content;
- explicit labeling that the content is UNTRUSTED DATA;
- source-role metadata where available.

This must be a structural change to prompt construction, not merely a prose/wording
change. The `LLMProvider` interface must not change as part of implementing this
decision.

### D-D2 — Derived content remains DERIVED/UNTRUSTED (Option 2)
**ACCEPTED.** Derived claims and Brief-derived content must not silently become
trusted instructions merely because they were generated internally by a prior
pipeline stage. Where derived claims or Brief fields are inserted into downstream
prompts, their provenance/trust status must be labeled appropriately. No trust
hierarchy beyond what D-D1/D-D2 require is authorized.

### D-E — (Phase 2 requirement)
**ACCEPTED as a Phase 2 requirement.** No current implementation.

### D-F — (Phase 2 requirement for paid providers and Publishing)
**ACCEPTED as a Phase 2 requirement.** No current implementation.

## Consequences
- D-B1, D-D1, and D-D2 are cleared for implementation in a follow-on, separately
  scoped and separately committed implementation task.
- D-B2, D-B3, D-C2, D-E, and D-F remain explicitly deferred; implementing them
  without a further Owner decision is out of scope.
- D-A closes Fact-Check P1 with no code change.
