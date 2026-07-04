-- Make the public account-events ?netuid filter index-satisfiable for each
-- account branch. The feed query pins its hotkey/coldkey branch indexes to avoid
-- an OR-across-columns scan; without netuid in those forced indexes, an absent or
-- rare netuid must walk the account's retained history before returning no rows.
CREATE INDEX IF NOT EXISTS idx_account_events_hotkey_netuid
  ON account_events (hotkey, netuid, block_number);
CREATE INDEX IF NOT EXISTS idx_account_events_coldkey_netuid
  ON account_events (coldkey, netuid, block_number);
