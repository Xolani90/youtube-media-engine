-- 0002_opportunity_discovery.sql
-- Additive schema changes required by Opportunity Discovery Specification v0.6 §19.
-- No existing column is altered or removed. No new tables are added — this
-- migration only extends `opportunities` and `decision_log`.

ALTER TABLE opportunities ADD COLUMN opportunity_proposition TEXT; -- JSON, see v0.6 §7
ALTER TABLE opportunities ADD COLUMN underlying_event_id TEXT;     -- shared across angle-distinct opportunities, v0.6 §6

ALTER TABLE decision_log ADD COLUMN stage TEXT;
-- Allowed values (enforced at application layer, not a DB CHECK constraint,
-- consistent with how other controlled-value columns in this schema are handled):
--   EVENT_DEDUP | HARD_ELIGIBILITY | PROPOSITION_GENERATION | PROPOSITION_VALIDATION
--   | VALUE_SCORE | RISK_GATE | DIVERSITY_SELECTION
