-- 0011_asset_verification.sql
-- D-G2: Rights Verification decision history (ADR-0013 -- separately
-- authorized implementation of the F2 Rights Verification Design
-- Specification, following the D-G1/D-C2 authorization-provenance
-- pattern in ADR-0007/ADR-0009).
--
-- Append-only decision record, mirroring the existing decision_log
-- precedent used by every other stage: every explicit evaluation
-- creates a new row, never an update.
--
-- `assets.verification_status` (0007_asset_rights_provenance.sql)
-- remains the fast-read current-status cache and is NOT altered by this
-- migration. Every value it ever holds must be traceable to exactly one
-- row here explaining why.
--
-- No existing table is dropped or altered.

CREATE TABLE asset_verifications (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL REFERENCES assets(id),
  decision TEXT NOT NULL
    CHECK (decision IN ('VERIFIED', 'NOT_VERIFIED', 'DISPUTED')),
  policy_id TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  evidence_fields_examined TEXT NOT NULL, -- JSON, immutable snapshot
  reason TEXT NOT NULL,
  verifier_type TEXT NOT NULL
    CHECK (verifier_type IN ('automated', 'human')),
  created_at TEXT NOT NULL
);

CREATE INDEX idx_asset_verifications_asset_id ON asset_verifications(asset_id);