-- Per-account daily position HISTORY (block-explorer Tier-1, epic #4329/6.1).
--
-- The refresh-metagraph cron lands the LATEST per-UID snapshot in `neurons`
-- (migration 0007, overwrite-on-conflict — no history is kept). A dedicated daily
-- rollup (rollupAccountPositionDaily, src/account-position-history.mjs) copies the
-- current snapshot into this append-only DATED table, keyed by
-- (account, netuid, snapshot_date) instead of neuron_daily's (netuid, uid,
-- snapshot_date) — giving /accounts/{addr}/portfolio's positions a per-account
-- time-series (the "Alpha Holdings chart", #4329) the same way neuron_daily gives
-- per-UID metagraph time-series (#1302). account = hotkey ss58, matching
-- loadAccountPortfolio's own "WHERE hotkey = ?" framing (src/account-portfolio.mjs).
--
-- Columns mirror ACCOUNT_PORTFOLIO_READ_COLUMNS plus coldkey for ownership display
-- — not the full neuron row (no axon/registered_at_block/is_immunity_period,
-- point-in-time metagraph facts, not portfolio economics). Simple retention prune
-- (ACCOUNT_POSITION_DAILY_RETENTION_DAYS, no cold-archive tier) — unproven at
-- scale; add archival later if row growth demands it, following neuron_daily's
-- own later evolution (PR-A2) rather than building it preemptively.
--
-- Known overlap with neuron_daily (#4330's own issue text mandates this new
-- table regardless — see src/account-position-history.mjs's header for the
-- full tradeoff writeup): every column here already exists in neuron_daily,
-- which already has a purpose-built idx_neuron_daily_hotkey_date index for
-- much the same read pattern. This doubles daily write volume onto the same
-- D1 database that has already hit its capacity limit once. Also: "position"
-- here is a hotkey's own registered-neuron stake, not a coldkey's aggregate
-- nominator/delegated stake — a real scope limitation given epic #4329 frames
-- this as matching taostats.io's (coldkey-centric) "Alpha Holdings" feature.
CREATE TABLE IF NOT EXISTS account_position_daily (
  account               TEXT    NOT NULL,  -- hotkey ss58
  netuid                INTEGER NOT NULL,
  snapshot_date         TEXT    NOT NULL,  -- YYYY-MM-DD (UTC) derived from captured_at
  uid                   INTEGER,
  coldkey               TEXT,
  active                INTEGER,           -- 0/1
  validator_permit      INTEGER,           -- 0/1
  rank                  REAL,
  trust                 REAL,
  incentive             REAL,
  dividends             REAL,
  stake_tao             REAL,
  emission_tao          REAL,
  captured_at           INTEGER NOT NULL,  -- epoch ms — the single consistent snapshot stamp
  updated_at            INTEGER NOT NULL,  -- epoch ms when this daily row was (re)rolled
  PRIMARY KEY (account, netuid, snapshot_date)
);

-- Per-subnet as-of / cross-account snapshot on a date.
CREATE INDEX IF NOT EXISTS idx_account_position_daily_netuid_date
  ON account_position_daily (netuid, snapshot_date);

-- Lets the retention prune SEEK the old-day tail instead of full-scanning.
CREATE INDEX IF NOT EXISTS idx_account_position_daily_date
  ON account_position_daily (snapshot_date);
