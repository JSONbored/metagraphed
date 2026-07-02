-- Counterparty relationship drilldowns read native-TAO Transfer rows for one
-- ordered account pair (and the reverse pair) newest-first. The single-party
-- hotkey/coldkey indexes can still force large residual scans for popular
-- accounts, so keep this pair lookup seekable for the public API route.
CREATE INDEX IF NOT EXISTS idx_account_events_transfer_pair
  ON account_events (event_kind, hotkey, coldkey, block_number, event_index);
