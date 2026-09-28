-- Durable provider-attempt state for resumable publication protocols.
-- Provider-neutral: adapters may persist transient state needed to
-- recover an interrupted external attempt (for example, a resumable
-- upload session URL). This is NOT a provider result; confirmed
-- outcomes remain in result_json.
ALTER TABLE publications ADD COLUMN provider_state_json TEXT;
