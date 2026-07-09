-- Bound validator nominator flow queries by hotkey, stake kind, and time window.
CREATE INDEX IF NOT EXISTS idx_account_events_hotkey_kind_observed
  ON account_events (hotkey, event_kind, observed_at, coldkey);
