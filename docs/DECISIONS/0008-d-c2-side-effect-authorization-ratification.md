# ADR-0008: D-C2 — External Side-Effect Authorization — Owner Ratification

## 1. Status

**RATIFIED — OWNER DECISION RECORDED — IMPLEMENTATION NOT AUTHORIZED**

Ratification establishes governance direction only. It does not authorize
implementation, in the same sense ADR-0006 §1 and §10 established for the twelve
D-G decisions: ratifying an architecture and authorizing its implementation are
distinct acts, and this document performs only the former.

## 2. Background

D-C2 — "stronger side-effect authorization for Production/Publishing" — was first
named as a future requirement in `docs/DECISIONS/0002-governance-cost-and-prompt-trust-boundary.md`,
which accepted it as a requirement without specifying it: "Production and Publishing
stages will require a stronger, explicit side-effect authorization mechanism before
they are built out; this decision only records that requirement, it does not
implement it." ADR-0006 subsequently gated `D-G2` (asset/rights provenance) and
Gate 2/`FINAL_COMPLIANCE` (D-G8) behind D-C2 being "separately authorized," without
itself defining D-C2's architecture.

This document records the Owner's ratification of a concrete D-C2 architecture,
closing that specification gap. No implementation of D-C2 is authorized by this
document.

## 3. Ratified D-C2 architecture

### 3.1 Authorization model

D-C2 establishes a boundary protecting the transition from internal engine
computation into an external, state-changing action. An external side effect may
proceed only when **all** of the following hold:

1. The run is `LIVE`.
2. `AUTONOMOUS_ENABLED` is enabled.
3. The specific external action has explicit Owner-controlled authorization.

No one or two of these conditions is sufficient on its own — this mirrors the
existing two-factor precedent already in the codebase for paid LLM providers
(`config.allowPaidProviders` plus explicit presence in `config.llmProviderPriority`,
`src/providers/llm/router.js`), extended to a third independent condition for this
stronger boundary.

Authorization is granted **per external action** — not for an entire run, and not
for an entire content item's future actions in the abstract.

### 3.2 Authorization invariant

Authorization must originate from **Owner-controlled configuration/state that is
independent of the calling code**. The calling code may identify or name the
action it wants to perform; it must never be able to declare that action
authorized itself.

The exact storage/representation mechanism for this Owner-controlled authorization
data is **intentionally deferred to implementation** and must remain minimal — this
ratification does not mandate a specific persistence structure, config format, or
authorization framework, and implementation must not introduce one that is more
elaborate than this invariant requires.

### 3.3 SIMULATION

`SIMULATION` must never permit an external side effect, regardless of any other
setting, including an otherwise-valid authorization. This is absolute and is not
something an authorization mechanism can override.

### 3.4 Authorization timing

Authorization must be checked immediately before the specific external action
executes — not once at run start, and not cached or assumed to persist from an
earlier check.

### 3.5 Retry semantics

Every retry of an external side effect requires a **fresh** authorization check;
a prior authorization is never reused across attempts. If the outcome of an
external action is ambiguous or unknown, the system must not blindly retry —
retrying requires an idempotency/status mechanism capable of determining whether
the original action already occurred. The design of that mechanism is
provider-specific and out of scope for D-C2 itself.

### 3.6 Human approval

D-C2 does not require mandatory human approval. This is independent of, and must
not be conflated with, any future compliance/review mechanism (e.g., D-G10's
REVIEW outcome, per ADR-0006) — that mechanism governs whether content is fit to
proceed; D-C2 governs only whether an action may touch the outside world at all.

### 3.7 State machine

D-C2 introduces no new lifecycle state. It is a guard at the external side-effect
boundary, invoked by whatever future Production/Publishing code performs an
external action, and remains architecturally separate from
`ContentStateMachine.js`. No `PRODUCTION` state and no `FINAL_COMPLIANCE` state is
introduced by this ratification.

### 3.8 Scope

D-C2 applies to external, state-changing actions, including: publishing/uploading
content, scheduling publication, changing external visibility/state, submitting
external metadata, and other future external-platform actions that change
external state.

Internal computation, internal persistence, and the already-existing LLM/provider
authorization mechanism (D-B1, the paid-provider gate) are not themselves D-C2
external side effects and are not brought into D-C2's scope by this ratification.

## 4. Explicit exclusions

This ratification does **not** authorize or implement any of the following:

- Production
- Publishing
- external platform integrations (e.g., YouTube API client)
- credential management (storage, rotation, or authentication mechanics)
- queues, workers, or orchestration of any kind
- D-G2 (asset/rights provenance) implementation
- `FINAL_COMPLIANCE` / Gate 2 (D-G8)
- Quality Gate
- risk-policy redesign (`RiskPolicy`/`risk_assessments` remain untouched, consistent
  with Architectural Decision A in ADR-0006)
- analytics or learning (`ANALYZING`, `LEARNED`)

## 5. D-G2 relationship

Per Interpretation A (previously selected during D-C2 design discussion): D-G2 is
now **eligible for its own separate implementation authorization**, because D-C2
has been formally ratified. This ratification does **not** itself authorize D-G2
implementation. D-G2 still requires its own explicit Owner implementation
authorization, exactly as D-G1 required a separate implementation authorization
after ADR-0006's ratification (subsequently recorded in ADR-0007).

## 6. Implementation Authorization Boundary

Consistent with ADR-0006 §10: this ADR does **not** authorize source-code changes,
database migrations, new tables, `ContentStateMachine` changes, tests, or any
other implementation artifact for D-C2. Any implementation of the architecture
recorded in §3 must receive a **separate, explicit implementation authorization**
after this ratification. Ratification is not that authorization.

## 7. Final status

```text
RATIFIED — OWNER DECISION RECORDED — IMPLEMENTATION NOT AUTHORIZED
```
