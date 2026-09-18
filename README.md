# [WORKING-NAME] — Autonomous Media Intelligence Engine

**Status: implemented pipeline, not live.** The repository now contains implementations for
the full content lifecycle — discovery, research, brief, script, fact-check, originality,
quality-gate, production, asset provisioning, rights verification, media production, and
publication — built on top of the M0 foundation (config, provider/storage/scheduler
abstractions, run/audit model, simulation-vs-live gating, cost tracking). This is implemented
infrastructure, not a live production system: see "Live operation" below.

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
- `src/db/migrations` — SQL schema spanning the full content lifecycle, from discovery
  through production, media artifacts, publication, and asset verification.
  Implemented pipeline subsystems are accompanied by unit and integration test coverage
  in the repository.
- `src/discovery`, `src/research`, `src/brief`, `src/script`, `src/fact-check`,
  `src/originality`, `src/quality-gate`, `src/production`, `src/asset-provisioning`,
  `src/rights-verification`, `src/media`, `src/publication` — implementations for each
  pipeline stage.
- `src/providers/llm` — `LLMProvider` interface and `LLMRouter`, which enforces R0-first
  provider selection with **no silent fallback to paid providers**. Groq is wired to real
  network calls (`https://api.groq.com/...`); Gemini, OpenRouter, and DeepSeek remain
  unconfigured stub providers (no keys configured, contract-only). `LocalStubProvider`
  supports zero-cost testing.
- `src/providers/opportunity` — `OpportunitySource` interface and discovery-source
  implementations.
- `src/scheduler` — `SchedulerDriver` interface; `github-actions` and `local-cron` drivers
  document the run-to-completion contract without coupling business logic to either.
- `src/state` — `SystemRunRecorder` (run/audit model + SIMULATION/LIVE gating + Owner override),
  `RiskPolicy` (PASS/WARNING/CRITICAL), `CostTracker` (unified free/paid cost accounting with
  budget enforcement), `ContentStateMachine` (enforced lifecycle transitions).
- `src/autonomous/runner.js` — orchestrates autonomous sweeps across the implemented pipeline
  stages (research, brief, script, fact-check, originality, quality-gate, production, asset
  provisioning, rights verification, media production, publication), each invoked through its
  own unmodified `run*()` entry point. **Discovery is deliberately excluded from the
  autonomous runner's stage list** — see
  `docs/DECISIONS/0010-autonomous-operation-scope-and-discovery-deferral.md`.

## Live operation
- Implemented functionality does not mean live/production operation. `RUN_MODE=SIMULATION`
  and `AUTONOMOUS_ENABLED=false` by default, and credentials are not configured merely
  because a provider adapter exists.
- There is no confirmed live discovery execution, live LLM execution beyond Groq's wired
  adapter, live YouTube publishing, or deployed production service established by this
  repository.

## Safety defaults
- `RUN_MODE=SIMULATION` and `AUTONOMOUS_ENABLED=false` out of the box. A LIVE run is refused
  with a logged reason unless autonomy is explicitly enabled.
- `ALLOW_PAID_PROVIDERS=false` and all cost limits default to `0` (no budget) — a paid or
  nonzero-cost provider call is rejected until the Owner explicitly raises a limit.

## Docs
- `docs/DECISIONS/0001-foundational-architecture.md` — architecture decision record for this phase.
- `docs/DECISIONS/0010-autonomous-operation-scope-and-discovery-deferral.md` — scope of the
  autonomous runner and the discovery deferral.
