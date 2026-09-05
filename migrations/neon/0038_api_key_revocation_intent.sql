-- A committed intent disables platform access even if provider confirmation
-- or the final ledger write must be retried. Never clear this marker on retry.
ALTER TABLE api_keys
  ADD COLUMN IF NOT EXISTS revocation_requested_at BIGINT;
