# ADR-0015: Research Source Provider — Tavily Search API

## 1. Status

**AUTHORIZED — OWNER DECISION RECORDED — IMPLEMENTATION PROCEEDING**

## 2. Purpose

This document records the Owner's explicit selection and authorization of a
concrete production implementation for the Research subsystem's
`ResearchSourceProvider` contract (`src/research/ResearchSourceProvider.js`),
resolving the previously identified integration gap in which
`deps.research.sourceProvider` had no production default, causing
`SOURCE_DISCOVERY` to fail with `Cannot read properties of undefined
(reading 'discoverCandidates')` on every real autonomous run that reached
Research.

This is a **new Owner-authorized technical design decision**. No prior
governance record (RG-01 through RG-05, the Research governance baseline, or
the Section 18 Research subsystem freeze) specified, named, or implied any
concrete source-discovery mechanism or vendor. This record does not
reconstruct, certify, or claim recovery of any historical Research v0.4
requirement — **historical Research v0.4 remains UNRECOVERED / NOT
CERTIFIED**, exactly as stated in `RESEARCH-GOVERNANCE-BASELINE.md`.

## 3. Owner decision

The Owner (Xolani Tshabalala) has selected **Tavily** (`api.tavily.com`) as
the concrete general web-search vendor implementing
`ResearchSourceProvider`, after an explicit category authorization (general
web search API) and a since-cancelled vendor selection (You.com, cancelled
before any implementation because its officially documented Search API is
credit-metered with no genuinely free, non-payment-gated tier — see §4 for
why Tavily's contract does not share that problem).

## 4. R0 / free-first requirement and how Tavily satisfies it

The Owner's R0 requirement for this decision is:

- No money may be charged to the Owner during initial implementation or
  normal operation while the provider's documented free allocation remains
  available.
- A provider may have a paid commercial tier and a limited free allocation,
  provided the free allocation is genuinely available without payment.
- The system must not automatically transition from free usage into paid
  usage.
- The system must fail closed when the free allocation/quota is exhausted or
  the provider reports insufficient credits.
- No billing authorization, automatic top-up, paid fallback, or spending
  mechanism may be introduced.

Verified against Tavily's current official documentation (`docs.tavily.com`)
at implementation time:

- The "Researcher" plan grants **1,000 API credits per month for $0/month,
  no credit card required** — a genuinely free, non-payment-gated
  allocation, not a time-limited trial.
- A basic-depth search costs 1 credit per request; this provider always
  requests `search_depth: "basic"` explicitly (never relies on
  `auto_parameters`, which can silently upgrade to `advanced` at 2 credits).
- Exceeding the free plan's monthly credit allocation returns **HTTP 432
  "Plan Limit Exceeded"** — the request is blocked, not silently charged.
- A separate **Pay-As-You-Go (PAYGO)** tier exists, but per Tavily's own
  documentation it must be explicitly enabled by the account holder via the
  Tavily dashboard; it is not something any API request or client code can
  turn on. Only once PAYGO has been manually enabled does an account risk
  **HTTP 433 "Pay-As-You-Go Limit Exceeded"** on further overage. Because
  enabling PAYGO is an out-of-band, manual Owner action outside anything
  this codebase does, the implementation itself cannot cause an automatic
  transition from free to paid usage.
- `401` (missing/invalid key), `429` (rate limit), `400`/`422` (bad request),
  and `500` are all documented, distinguishable failure conditions.

This provider therefore treats **HTTP 432, 433, 402-shaped
insufficient-credit responses, 401, 429, 400/422, 500, malformed responses,
and network failures** uniformly as discovery failures (isolated per the
existing `ResearchSourceProvider.discoverCandidates()` contract: never
thrown, recorded in the returned `failures` array with `candidates: []` or
whatever partial candidates were already obtained), and never attempts an
automatic retry-with-upgrade, credit purchase, or fallback to another
provider.

## 5. Authorized scope

- `src/providers/research/TavilySearchProvider.js` — new concrete
  `ResearchSourceProvider` subclass.
- One default-construction addition inside the existing `research: {...}`
  block in `src/index.js`, following the exact
  `deps.research?.sourceProvider ?? new TavilySearchProvider()` pattern
  already used for `opportunitySource` and `assetProvisioning.provider`.
- `.env.example` — one new `TAVILY_API_KEY=` entry with an explanatory
  comment, in the same style as the existing `PIXABAY_API_KEY` entry.
- `tests/unit/tavily-search-provider.test.js` — focused provider unit tests.
- One integration test addition proving the autonomous entrypoint
  constructs `TavilySearchProvider` as the default when no
  `research.sourceProvider` override is supplied, and that an explicit
  override still takes precedence, with the external API mocked.

No other file is in scope.

## 6. Explicit exclusions

This authorization does **not** cover, and implementation must not include:

- any change to `src/research/ResearchSourceProvider.js`'s interface;
- any change to `src/research/acquisition.js`, `src/research/retrieval.js`,
  `src/research/pipeline.js`, or Research lifecycle/state-machine semantics;
- any change to `config/research_policy.json` semantics;
- any change to the contradiction detector, Fact-Check, Asset Provisioning,
  Rights Verification, Media Production, Publication, or scheduler
  architecture;
- content retrieval, browser automation, JS-rendered scraping, or
  general-purpose crawling inside the provider — discovery and retrieval
  remain strictly separated, exactly as `ResearchSourceProvider.js`'s
  existing docstring requires;
- a hybrid/multi-provider Research architecture, or any specialized
  academic/news provider integration;
- automatic credit purchase, automatic billing, paid fallback, credit-card
  handling, quota escalation, or substitution of another search provider on
  failure;
- reopening or modifying RG-01 through RG-05 (all remain **CLOSED**) or
  rewriting the Section 18 Research subsystem freeze record
  (`0005-research-subsystem-freeze.md`), which is not touched by this
  record.

## 7. Implementation condition

Implementation proceeds under this authorization exactly as scoped in §5.
Tests must mock all Tavily API calls; no live external request may occur
during the test suite, and no real API key may be used in tests or fixtures.

## 8. Resulting implementation

Recorded upon completion, in the same style as prior implementation ADRs —
see the implementation report following this record.

## 9. Push authorization

Not given. Consistent with this repository's established convention,
commit and push authorization are separate acts from implementation
authorization.

## 10. Final status

```text
AUTHORIZED FOR IMPLEMENTATION — PUSH NOT YET AUTHORIZED
```
