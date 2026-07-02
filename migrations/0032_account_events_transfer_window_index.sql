-- Network-wide transfer analytics filter by event_kind plus an observed_at window
-- before computing totals and sender/receiver leaderboards. Keep that public
-- route on a seekable time-window path instead of scanning every Transfer row.
CREATE INDEX IF NOT EXISTS idx_account_events_transfer_window
  ON account_events (event_kind, observed_at);
