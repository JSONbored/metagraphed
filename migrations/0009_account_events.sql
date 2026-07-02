-- Chain-event index (#1346, epic #1345): first-party per-entity activity decoded
-- DIRECTLY from finney (substrate System.Events), NOT Taostats. The chain-direct
-- event poller (scripts/fetch-events.py) runs in CI over a rolling window of
-- recent FINALIZED blocks, stages rows to R2, and the Worker loads them here via
-- its D1 binding (loadStagedEvents) with PARAMETERIZED INSERT OR IGNORE keyed
-- (block_number, event_index) — so overlapping windows re-insert harmlessly
-- (idempotent) and the poller needs no cursor. Powers /api/v1/accounts/{ss58}
-- + history (#1347).
--
-- Units: amount_tao = event tao field / 1e9 (matches neurons.stake_tao). netuid/
-- uid as-is. observed_at = block timestamp (epoch ms, matches neurons.captured_at).

CREATE TABLE IF NOT EXISTS account_events (
  block_number INTEGER NOT NULL,
  event_index  INTEGER NOT NULL,            -- position within the block's events
  event_kind   TEXT    NOT NULL,            -- SubtensorModule event id
  hotkey       TEXT,
  coldkey      TEXT,
  netuid       INTEGER,
  uid          INTEGER,
  amount_tao   REAL,                        -- tao field / 1e9 where applicable
  observed_at  INTEGER NOT NULL,            -- block timestamp, epoch ms
  PRIMARY KEY (block_number, event_index)
);

-- Per-entity history ("everything this hotkey/coldkey did"), newest-first.
CREATE INDEX IF NOT EXISTS idx_account_events_hotkey  ON account_events (hotkey, block_number);
CREATE INDEX IF NOT EXISTS idx_account_events_coldkey ON account_events (coldkey, block_number);
-- Per-subnet event stream + the daily-rollup scan.
CREATE INDEX IF NOT EXISTS idx_account_events_netuid  ON account_events (netuid, block_number);
CREATE INDEX IF NOT EXISTS idx_account_events_observed ON account_events (observed_at);

-- Durable daily rollup per (hotkey, netuid, day): the hot account_events window is
-- pruned (90d) but this is retained indefinitely so long-term per-entity history
-- survives (mirrors surface_uptime_daily). Rolled by the hourly cron before prune.
CREATE TABLE IF NOT EXISTS account_events_daily (
  hotkey      TEXT    NOT NULL,
  netuid      INTEGER NOT NULL,
  day         TEXT    NOT NULL,             -- UTC date, YYYY-MM-DD
  event_count INTEGER NOT NULL,
  event_kinds TEXT,                         -- comma-separated distinct kinds
  first_block INTEGER,
  last_block  INTEGER,
  updated_at  INTEGER NOT NULL,             -- epoch ms of the last rollup write
  PRIMARY KEY (hotkey, netuid, day)
);
CREATE INDEX IF NOT EXISTS idx_account_events_daily_netuid_day
  ON account_events_daily (netuid, day);
