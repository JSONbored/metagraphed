-- Account weight-setter lookups can recover hotkey-less WeightsSet events by
-- resolving the account's current (netuid, uid) rows through neurons. Keep that
-- fallback account-bounded instead of scanning the public 7d/30d network-wide
-- WeightsSet window for each requested account.
CREATE INDEX IF NOT EXISTS idx_account_events_netuid_uid_kind_observed
  ON account_events (netuid, uid, event_kind, observed_at);
