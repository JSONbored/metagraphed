-- Default GET /api/v1/accounts/{ss58}/history (no ?netuid) reads
-- account_events_daily with WHERE hotkey = ? ORDER BY day DESC. The PK
-- (hotkey, netuid, day) orders by netuid within hotkey, so day DESC spans
-- netuids and SQLite materializes a temp B-tree. This index lets the planner
-- range-scan (hotkey, day) in reverse day order without a temp sort (#2079).
CREATE INDEX IF NOT EXISTS idx_account_events_daily_hotkey_day
  ON account_events_daily (hotkey, day);
