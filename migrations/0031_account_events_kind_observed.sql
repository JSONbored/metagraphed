-- Per-subnet transfer-volume (#subnet-transfer-volume) and network-wide
-- /chain/transfers scan Balances.Transfer rows by event kind plus an
-- observed_at window, then aggregate by hotkey/coldkey (with a neurons
-- membership filter on the per-subnet route). idx_account_events_observed is
-- time-only; idx_account_events_transfer_pair is pair-ordered for
-- counterparties — neither satisfies (event_kind, observed_at) prefix seeks.
-- These composites cover the live totals + leaderboard access pattern before
-- the residual membership / GROUP BY work.
CREATE INDEX IF NOT EXISTS idx_account_events_kind_observed
  ON account_events (event_kind, observed_at);

CREATE INDEX IF NOT EXISTS idx_account_events_kind_observed_hotkey
  ON account_events (event_kind, observed_at, hotkey);

CREATE INDEX IF NOT EXISTS idx_account_events_kind_observed_coldkey
  ON account_events (event_kind, observed_at, coldkey);
