# ADR-0035 — GitHub Actions Scheduled Trigger Authorization

**Status:** Accepted — Owner Approved
**Decision Date:** 2026-09-22
**Related:** ADR-0001 (foundational architecture — scheduler driver
selection), ADR-0024 (autonomous single-run protection)

---

## 1. Purpose

This record authorizes the creation of the concrete GitHub Actions workflow
artifact that triggers the existing autonomous media-engine entrypoint on a
schedule. No prior decision record authorizes this specific act.

## 2. What this ADR is not

This ADR does not re-select, redesign, or re-architect the scheduler. That
decision was already made in ADR-0001, which names GitHub Actions as the
initial `SchedulerDriver` implementation. ADR-0001 is an architectural
selection: it says *what mechanism the system is built to use*, not *that
the mechanism is authorized to run in production, unattended, today*.

This ADR also does not modify, reinterpret, or expand ADR-0024. ADR-0024
governs what happens once a run is initiated — specifically, that
overlapping invocations cannot both acquire the run guard. ADR-0024 §8
explicitly states it does not authorize "a scheduler, a GitHub Actions
workflow or cron, continuous autonomous operation." That exclusion is read
here at face value, not reinterpreted: ADR-0024 grants no scheduling
authorization, and none is claimed from it.

## 3. The gap this ADR closes

| Decision | What it establishes | What it does NOT establish |
|---|---|---|
| ADR-0001 | GitHub Actions as the architecturally selected scheduler driver | Authorization to actually create and activate a scheduled trigger |
| ADR-0024 | Single-run protection once a run starts | Any scheduler, workflow, or cron authorization (explicitly excluded, §8) |
| **ADR-0035 (this record)** | **Authorization to create the concrete `.github/workflows/*.yml` trigger, invoking the existing entrypoint, in safe/simulation operation only** | Real external publication; LIVE mode; any change to pipeline, Discovery, Research, Production, Rights Verification, Gate 2, or Publication semantics |

## 4. Authorization boundary

### 4.1 Authorized

- Creation of a `.github/workflows/*.yml` workflow that invokes the existing
  autonomous entrypoint (`src/index.js`) on a schedule.
- Use of the existing `SchedulerDriver` / `github-actions` driver
  architecture (ADR-0001) — no second scheduling mechanism is introduced.
- Reliance on the existing single-run protection (ADR-0024) as the sole
  overlap-prevention mechanism. This ADR does not add, modify, or duplicate
  that protection.
- Passing required non-public runtime configuration into the workflow via
  GitHub Actions Secrets / environment injection.
- Unattended scheduled execution strictly in the existing safe operating
  configuration:
  - `RUN_MODE=SIMULATION`
  - `AUTONOMOUS_ENABLED=false`

  (per `src/config/index.js`: `runMode` defaults to `SIMULATION` unless
  explicitly overridden; `autonomousEnabled` defaults to `false` via
  `envBool('AUTONOMOUS_ENABLED', false)`). The workflow sets these
  explicitly rather than relying silently on defaults, so the safe
  configuration is visible in the workflow file itself.
- An initial execution cadence of **four scheduled invocations per day,
  approximately every 6 hours** (Owner-approved, see §7). This is an
  operational scheduling parameter only; it does not guarantee any content
  output volume. Existing discovery, eligibility, budgeting, selection,
  no-work, production, and publication gates remain fully authoritative and
  unchanged by this ADR.

### 4.2 NOT authorized

This ADR explicitly does not authorize:

- Real YouTube publication, or any live external publication of any kind.
- Activation of `RUN_MODE=LIVE`.
- Activation or population of `authorized_external_actions.json`.
- Any OAuth publication credentials, or their storage/use.
- Any standing or per-item external publication authorization (that remains
  governed exclusively by ADR-0030 and D-C2 per ADR-0008/0009).
- New providers, new platforms, or new media capabilities.
- Any change to Discovery, Research, Brief, Script, Fact-Check, Originality,
  Quality Gate, Production, Asset Provisioning, Rights Verification, Gate 2,
  or Publication semantics.
- Any redesign of the scheduler abstraction itself, or introduction of a
  second scheduling mechanism alongside GitHub Actions.
- Any change to ADR-0024's single-run protection mechanism.

## 5. Safety semantic — scheduled execution ≠ authorized publication

Running the engine unattended and authorizing it to publish externally are
two separate capabilities, governed by two separate decision records. This
ADR grants only the former. Nothing in this ADR grants, implies, or
shortcuts the latter. Real external publication remains governed
exclusively by ADR-0030 (standing authorization) and the D-C2 boundary
(ADR-0008/0009), both of which remain fully in force and untouched.
Scheduled execution under `RUN_MODE=SIMULATION` / `AUTONOMOUS_ENABLED=false`
cannot reach real publication regardless of this ADR, because those existing
gates — not this record — are what block it.

## 6. Secrets

The workflow may receive required non-public runtime configuration (API
keys for existing providers: `TAVILY_API_KEY`, `PIXABAY_API_KEY`,
`GROQ_FREE_API_KEY`) through GitHub Actions Secrets / environment
variables, referenced by name only. Credentials and secrets are never
committed to the repository in any form, including inside the workflow file
itself. YouTube OAuth credentials (`YOUTUBE_CLIENT_ID`,
`YOUTUBE_CLIENT_SECRET`, `YOUTUBE_REFRESH_TOKEN`) are explicitly excluded
from this wiring per §4.2 — the workflow never references them, since real
publication is not authorized by this ADR.

## 7. Cadence — Owner-approved

The Owner has approved an initial execution cadence of **four scheduled
invocations per day, approximately every 6 hours**. This cadence:

- is an operational scheduling parameter only, and does not guarantee any
  particular content output volume — all existing pipeline gates remain
  authoritative;
- may be changed later only through an explicit Owner decision; it is not
  to be silently altered based on assumptions about workload, provider
  rate limits, or cost.

## 8. Failure / operational semantics

This ADR documents no new failure, retry, recovery, concurrency, or
notification behavior. The workflow inherits whatever behavior the existing
entrypoint and `SchedulerDriver` already provide (run-to-completion
contract; single-run protection via ADR-0024; existing decision_log/
system_runs audit trail). No new semantics are introduced by this record.

## 9. Minimum implementation surface

Authorized implementation is limited to:

1. The `.github/workflows/*.yml` file needed to trigger the existing
   entrypoint on the approved cadence (§7).
2. Only the configuration (env vars, secrets references) needed for that
   workflow to execute safely under §4.1.

No other file is in scope. This ADR does not pre-authorize any broader
scheduler redesign.

## 10. Status

Accepted — Owner Approved. This decision authorizes implementation of the
minimum workflow described in §9, under the boundary in §4.
