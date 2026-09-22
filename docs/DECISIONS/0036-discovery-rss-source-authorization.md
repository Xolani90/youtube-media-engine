# ADR-0036 — Discovery RSS Source Authorization

**Status:** Accepted — Owner Approved
**Decision Date:** 2026-09-22
**Related:** ADR-0001 (foundational architecture — RSS selected as the
first configured opportunity-source type), ADR-0033 (durable Discovery
evaluation state), ADR-0034 (fresh-evaluation scheduling and budget),
ADR-0035 (GitHub Actions scheduled trigger authorization)

---

## 1. Purpose

This record authorizes a specific, named set of RSS feed URLs as the
Owner-approved input to the Discovery stage's opportunity-ingestion
mechanism (`src/providers/opportunity/RssSource.js`). No prior decision
record authorizes any specific feed source; ADR-0001 selected RSS as the
architecture's first opportunity-source *type*, not any particular feed.

## 2. What this ADR is not

This ADR does not select or redesign the opportunity-source architecture.
That decision was already made in ADR-0001, which names RSS as the first
configured candidate source type (§ "RSS is the first configured
candidate"). This ADR also does not touch Discovery's internal logic —
deduplication, eligibility, scoring, diversity selection, cooldown, or the
durable evaluation/budget mechanisms established by ADR-0033 and ADR-0034.
Those remain entirely as governed today, applied unchanged to whatever
candidates the authorized feeds below produce.

This ADR also does not authorize runtime configuration or deployment of
these feeds — see §5.

## 3. Authorized RSS sources

The following four feeds are authorized as Discovery opportunity-ingestion
sources:

1. OpenAI News RSS — `https://openai.com/news/rss.xml`
2. Google AI RSS — `https://blog.google/technology/ai/rss/`
3. TechCrunch Artificial Intelligence RSS — `https://techcrunch.com/category/artificial-intelligence/feed/`
4. Ars Technica AI RSS — `https://arstechnica.com/ai/feed/`

No other feed is authorized by this record. Adding, removing, or
substituting a feed requires a separate, explicit Owner decision — this
ADR does not delegate that judgment to implementation, configuration, or
any automated process.

## 4. What this ADR does not authorize

This ADR explicitly does not authorize:

- Real external publication, or any live external publication of any kind.
- Activation of `RUN_MODE=LIVE`.
- YouTube access of any kind.
- Any new provider or new platform.
- Any change to Discovery's internal semantics — deduplication,
  eligibility, scoring, diversity selection, cooldown, or any other
  mechanism unrelated to *which feeds are ingested*.
- Any change to the fresh-evaluation scheduling or budget established by
  ADR-0034. Candidates from these feeds are subject to that budget and
  scheduling exactly as they would be for any other authorized source —
  this ADR adds an input, not a new evaluation pathway.
- Any change to ADR-0033's durable evaluation state mechanism.

## 5. Source authorization vs. runtime configuration vs. downstream credentials

Three distinct things are easy to conflate here; this ADR is precise about
which one it is:

- **Source authorization (this ADR):** the governance act of naming which
  feeds are permitted inputs to Discovery. This is what §3 does.
- **Runtime configuration (separate, later workstream):** actually setting
  `RSS_FEED_URLS` (or equivalent) in the GitHub Actions workflow so the
  authorized feeds are what the scheduled entrypoint actually fetches. This
  ADR does not perform that step. It only makes that step permissible once
  undertaken.
- **Downstream provider credentials (unrelated to this ADR):**
  `TAVILY_API_KEY`, `PIXABAY_API_KEY`, `GROQ_FREE_API_KEY` govern later
  pipeline stages (Research, Asset Provisioning, LLM-based feature
  computation) and are untouched by this record. Per the prior read-only
  audit, none of them had any causal role in the `discovered=0` result this
  ADR responds to.

The four URLs in §3 are public source configuration — they identify what
Discovery is permitted to read, not a credential, secret, or access grant.
They carry none of the confidentiality handling that API keys require.

## 6. Implementation remains separate

Authorizing these sources does not, by itself, change what the deployed
system does. A later, separate implementation workstream is required to
actually wire the authorized feed list into runtime configuration (e.g.
setting `RSS_FEED_URLS` as GitHub Actions runtime configuration on the
existing `.github/workflows/scheduled-run.yml`. ADR-0035 §4.1 provides the
existing workflow boundary for required non-public runtime configuration;
the later implementation workstream must verify that `RSS_FEED_URLS` falls
within that boundary before making the configuration change). That
implementation step is intentionally out of scope for this ADR.

## 7. Status

Accepted — Owner Approved. This decision authorizes the four RSS sources
in §3 as permitted Discovery opportunity-ingestion inputs. It does not, by
itself, implement or configure anything, and does not change
`discovered=0` behavior until the separate implementation workstream in §6
is authorized and completed.
