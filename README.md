# [WORKING-NAME] — Autonomous Media Intelligence Engine

**Status: M0 foundation only.** This is not yet a working content pipeline — it is the
architectural scaffolding (config, provider/storage/scheduler abstractions, run/audit model,
simulation-vs-live gating, cost tracking) that the M0 pipeline (discovery → scoring → research →
brief → script → fact-check → originality → risk → production-ready) will be built on top of in
the next phase.

Project name is a placeholder pending trademark/domain clearance — see
`docs/DECISIONS/0001-foundational-architecture.md`.

## Quick start

```bash
npm install
cp .env.example .env   # edit as needed; defaults are safe (SIMULATION, autonomy disabled, R0)
npm run migrate         # applies src/db/migrations/*.sql to ./data/media-engine.db
npm test                 # runs all unit + integration tests
node src/index.js       # runs a foundation smoke test (local-stub provider, zero cost)
```

### System prerequisite: espeak-ng (Media Production narration)

Media Production's narration step (`src/media/narration.js`) invokes the
`espeak-ng` command-line binary directly. This is a required system-level
dependency for v1 — it is not installed by `npm install`, not bundled with
this repository, and has no fallback or provider abstraction (see
`src/media/narration.js` and `src/media/constants.js` for the v1 rationale).
Any environment running Media Production, or the narration/Media Production
tests (`tests/unit/media-narration.test.js`,
`tests/integration/media-production-pipeline-e2e.test.js`,
`tests/integration/publication-pipeline-e2e.test.js`), must have `espeak-ng`
installed and resolvable on `PATH` before running them.

On Debian/Ubuntu:

```bash
sudo apt-get update
sudo apt-get install -y espeak-ng
```

For other platforms, install `espeak-ng` via your OS's package manager
(e.g. Homebrew's `espeak-ng` formula on macOS) and confirm it resolves with
`espeak-ng --version`.

## What exists today
- `src/config` — environment/config-driven settings; no business logic hard-coded.
- `src/storage` — `StorageDriver` interface + `SqliteStorageDriver` implementation.
- `src/db/migrations` — SQL schema scoped to M0 only (discovery through production-ready).
  Production/publishing/analytics/learning tables were deliberately removed after review
  (Phase 1.5) since they belong to a later, not-yet-specified phase.
- `src/providers/llm` — `LLMProvider` interface, candidate adapters (Gemini/Groq/OpenRouter/
  DeepSeek — none wired to real network calls yet, no keys exist), `LocalStubProvider` for
  zero-cost testing, and `LLMRouter` which enforces R0-first provider selection with **no
  silent fallback to paid providers**.
- `src/providers/opportunity` — `OpportunitySource` interface (no concrete implementation yet).
- `src/scheduler` — `SchedulerDriver` interface; `github-actions` and `local-cron` drivers
  document the run-to-completion contract without coupling business logic to either.
- `src/state` — `SystemRunRecorder` (run/audit model + SIMULATION/LIVE gating + Owner override),
  `RiskPolicy` (PASS/WARNING/CRITICAL), `CostTracker` (unified free/paid cost accounting with
  budget enforcement), `ContentStateMachine` (enforced lifecycle transitions).

## What does NOT exist yet (by design — see ADR-0001)
- Discovery, scoring, research, brief, script, fact-check, originality, and risk-gate business
  logic.
- Any real network call to an LLM or discovery provider (no API keys are configured; adapters
  throw a clear "not implemented yet" error if invoked).
- Any production/publishing automation.

## Safety defaults
- `RUN_MODE=SIMULATION` and `AUTONOMOUS_ENABLED=false` out of the box. A LIVE run is refused
  with a logged reason unless autonomy is explicitly enabled.
- `ALLOW_PAID_PROVIDERS=false` and all cost limits default to `0` (no budget) — a paid or
  nonzero-cost provider call is rejected until the Owner explicitly raises a limit.

## Docs
- `docs/DECISIONS/0001-foundational-architecture.md` — architecture decision record for this phase.
