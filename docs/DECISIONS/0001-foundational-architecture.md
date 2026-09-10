# ADR-0001: Foundational Architecture for [WORKING-NAME] M0

## Status
Accepted (Phase 1 foundation).

## Context (facts)
- The Owner (Xolani) has no capital currently allocated to this project.
- The Owner's other active projects (sa-teacher-assistant, Servit, NODAL, BizBot SA, Acadix,
  ClearFlow, TrendSurvivor EA) are predominantly JS/Node-based.
- The project's working name "Nexora" was investigated and rejected: DCC Technology (a
  ~2,500-employee global technology group) rebranded to "Nexora" in December 2025, and
  multiple existing "NexoraAI" businesses and registered trademarks already use the name in
  adjacent AI-automation space. The project is referred to as **[WORKING-NAME]** until a final
  name is selected and cleared.
- A survey of free-tier LLM APIs (Aug 2026) found genuine no-card-required standing free tiers
  from Google Gemini, Groq, OpenRouter, Cloudflare Workers AI, Mistral, SambaNova, and others.
- YouTube Data API v3 is free but capped at 10,000 quota units/day/project; search.list costs
  100 units/call (~100 searches/day ceiling), while read operations cost 1 unit.
- GitHub Actions provides free scheduled-workflow minutes on public repositories.

## Requirement (from the Owner)
1. Do not build around a paid LLM API as a prerequisite. R0 must be the default operating mode.
2. Use Node.js + SQLite as the primary application stack, not Python.
3. Provider selection (LLM, discovery/opportunity sources), storage, and scheduling must all be
   abstracted behind interfaces so no specific vendor or infrastructure choice is an
   irreversible architectural commitment.
4. M0 (content intelligence pipeline: discovery → scoring → research → brief → script →
   fact-check → originality → risk → production-ready) must be built and validated before any
   production/publishing automation is attempted.
5. The system must support a SIMULATION mode that performs the full decision chain without any
   irreversible external action (no publishing, no paid spend unless explicitly enabled), and a
   distinct LIVE mode, with the distinction persisted per run for audit.
6. A global Owner override (`AUTONOMOUS_ENABLED` / `AUTONOMOUS_DISABLED`) must exist; LIVE runs
   are refused outright while disabled.
7. Cost accounting must treat free and paid provider calls identically (cost = 0 for free calls,
   not a special/skipped path), and hard budget limits must be enforced before a paid call is
   recorded as spent.

## Assumption
- Free-tier LLM API limits and terms are accurate as surveyed in August 2026 and may change;
  the provider abstraction exists specifically because this assumption is expected to become
  stale over time.
- A low daily content-package volume (low single digits per day) is acceptable for M0's purpose
  of proving the intelligence loop, not scaled output.

## Decision
- **Language/runtime:** Node.js (ESM), no Python dependency introduced for the core application.
- **Database:** SQLite via `better-sqlite3`, accessed only through a `StorageDriver` interface
  (`src/storage/StorageDriver.js`), with `SqliteStorageDriver` as the sole M0 implementation.
  Business services depend on the interface, never on `better-sqlite3` directly.
- **LLM providers:** `LLMProvider` interface (`src/providers/llm/LLMProvider.js`) with
  candidate implementations for gemini-free, groq-free, openrouter-free, and an
  explicitly-paid deepseek-paid candidate — selected and prioritized via
  `config.llmProviderPriority`, routed through `LLMRouter`
  (`src/providers/llm/router.js`). Paid providers are never used unless
  `ALLOW_PAID_PROVIDERS=true` AND explicitly present in the priority list — no silent fallback.
- **Discovery providers:** `OpportunitySource` interface
  (`src/providers/opportunity/OpportunitySource.js`); RSS is the first configured candidate.
- **Scheduler:** `SchedulerDriver` interface (`src/scheduler/SchedulerDriver.js`) with
  `github-actions` as the initial driver; application code has a run-to-completion contract and
  never calls GitHub Actions APIs, so a future driver (cron, queue worker, hosted scheduler)
  can replace it without touching business services.
- **Run/audit model:** every execution is a `system_runs` record tagged `SIMULATION` or `LIVE`
  (never inferred after the fact); `decision_log` records what was decided, why, by which
  provider, under which config, and the resulting state, for every autonomous decision.
- **Risk policy:** `PASS` → execute; `WARNING` → execute + log; `CRITICAL` → stop + escalate.
  The flag-to-severity mapping (`src/state/RiskPolicy.js`) is isolated from business logic so
  the Owner can revise it without code changes to the pipeline itself.
- **Cost tracking:** every provider call (free or paid) is recorded via `CostTracker`
  (`src/state/CostTracker.js`) with `estimated_cost = 0` for free calls; budget limits
  (`MAX_DAILY_SPEND`, `MAX_MONTHLY_SPEND`, `MAX_COST_PER_CONTENT`) are enforced before a paid
  call is recorded, defaulting to 0 (no budget) until explicitly raised.
- **Scope boundary:** this ADR and the Phase 1 implementation cover foundation only — config,
  provider/storage/scheduler interfaces, migrations, run/audit model, simulation/live gating,
  and cost tracking. The discovery→scoring→research→script→quality-gate pipeline itself is
  explicitly out of scope for this ADR and is not implemented yet.
- **Schema scope (Phase 1.5 correction):** the initial migration originally included
  `production_jobs`, `publication_jobs`, `performance_metrics`, and `learning_events` for
  spec-completeness. These were removed after review, since they belong to the later
  Autonomous Media Production phase and had no M0 code path, test, or consumer. They will be
  reintroduced in a dedicated migration once that phase is specified — not before.

## Consequences
- Adding, removing, or reordering LLM/discovery providers requires only a config change and a
  new adapter implementing the existing interface — no business logic changes.
- Replacing SQLite with a different persistent store later requires only a new
  `StorageDriver` implementation.
- Replacing GitHub Actions with another scheduler later requires only a new
  `SchedulerDriver` implementation; business services are unaffected because they were never
  written against GitHub Actions specifically.
- Because the LLM candidate adapters are unconfigured stubs in this phase (no real network
  calls wired yet — no API keys exist), the router currently only produces usable completions
  via `local-stub`, which is the deliberate state for a scaffold that must be tested without
  live credentials. Wiring real API calls to Gemini/Groq/OpenRouter is a Phase 2+ task, once the
  Owner has decided to obtain and store real credentials.
