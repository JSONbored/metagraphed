-- Temporary replay receipts only; the original counters remain in api_usage_rollup.
CREATE TABLE api_usage_rollup_batches (
  batch_id TEXT NOT NULL PRIMARY KEY,
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  expires_at INTEGER NOT NULL,
  applied INTEGER NOT NULL DEFAULT 0 CHECK (applied IN (0, 1))
);
-- statement-breakpoint
CREATE INDEX idx_api_usage_rollup_batches_expiry
  ON api_usage_rollup_batches (expires_at);
