-- The neurons / metagraph family on D1 (#9146 priority 1).
--
-- This is the ONLY live-refreshed family left on the decommissioned box: a
-- sync posts chain state through POST /api/v1/internal/neurons-sync every
-- refresh. The lakehouse holds its history, but history is frozen -- once the
-- box goes, the sync has nowhere to write and the metagraph stops advancing.
-- Porting the WRITE path is what keeps this data live; the reads follow.
--
-- Sized for D1 by construction rather than by hope. `neurons` is latest-only,
-- upserted on (netuid, uid) and pruned of stale UIDs every sync, so it is
-- bounded at ~33k rows (129 subnets x <=256 UIDs) and cannot grow unbounded.
-- `neuron_daily` and `account_position_daily` add one row per UID per UTC day.
--
-- Column sets are NOT transcribed by hand from the old (pre-#6477) D1 schema
-- or from Postgres: they are exactly `NEURON_INSERT_COLUMNS`
-- (src/metagraph-neurons.ts), which is the list the writer actually binds.
-- tests/neurons-d1-schema.test.ts asserts that correspondence in both
-- directions, so a column added to the writer without a migration -- or a
-- column here the writer never sends -- fails CI rather than silently writing
-- NULLs. That is the anti-drift guarantee; nothing here is kept in step by
-- hand.
--
-- Type translation follows 0004_user_state.sql's convention, with the specific
-- shapes the sync's own validator already enforces:
--   netuid/uid/captured_at  -> INTEGER (Number.isInteger, captured_at > 0)
--   NEURONS_SYNC_BOOLEAN_COLUMNS -> INTEGER 0/1 with CHECK
--   numeric metrics         -> REAL
--   snapshot_date           -> TEXT 'YYYY-MM-DD' (UTC day; lexicographic == chronological)
--   updated_at              -> INTEGER epoch-ms set by the writer

CREATE TABLE IF NOT EXISTS neurons (
  netuid              INTEGER NOT NULL,
  uid                 INTEGER NOT NULL,
  hotkey              TEXT,
  coldkey             TEXT,
  active              INTEGER CHECK (active IN (0, 1)),
  validator_permit    INTEGER CHECK (validator_permit IN (0, 1)),
  rank                REAL,
  trust               REAL,
  validator_trust     REAL,
  consensus           REAL,
  incentive           REAL,
  dividends           REAL,
  emission_tao        REAL,
  stake_tao           REAL,
  registered_at_block INTEGER,
  is_immunity_period  INTEGER CHECK (is_immunity_period IN (0, 1)),
  axon                TEXT,
  block_number        INTEGER,
  captured_at         INTEGER NOT NULL,
  take                REAL,
  PRIMARY KEY (netuid, uid)
);

-- Per-subnet listing and validator discovery: the metagraph route filters by
-- netuid, /validators and /subnets/{netuid}/validators add validator_permit.
CREATE INDEX IF NOT EXISTS idx_neurons_netuid_permit
  ON neurons (netuid, validator_permit);

-- "Which subnets does this hotkey operate on" -- the cross-subnet lookup
-- behind the account/validator detail routes.
CREATE INDEX IF NOT EXISTS idx_neurons_hotkey ON neurons (hotkey);

-- Daily history: one row per (netuid, uid, UTC day). Feeds the movers /
-- turnover / performance-history aggregates.
CREATE TABLE IF NOT EXISTS neuron_daily (
  netuid              INTEGER NOT NULL,
  uid                 INTEGER NOT NULL,
  hotkey              TEXT,
  coldkey             TEXT,
  active              INTEGER CHECK (active IN (0, 1)),
  validator_permit    INTEGER CHECK (validator_permit IN (0, 1)),
  rank                REAL,
  trust               REAL,
  validator_trust     REAL,
  consensus           REAL,
  incentive           REAL,
  dividends           REAL,
  emission_tao        REAL,
  stake_tao           REAL,
  registered_at_block INTEGER,
  is_immunity_period  INTEGER CHECK (is_immunity_period IN (0, 1)),
  axon                TEXT,
  block_number        INTEGER,
  captured_at         INTEGER NOT NULL,
  take                REAL,
  snapshot_date       TEXT    NOT NULL,
  updated_at          INTEGER NOT NULL,
  PRIMARY KEY (netuid, uid, snapshot_date)
);

-- Window scans ("this subnet between day A and day B") drive every aggregate
-- built on this table, so the leading column is the day, not the netuid.
CREATE INDEX IF NOT EXISTS idx_neuron_daily_date_netuid
  ON neuron_daily (snapshot_date, netuid);

-- The same snapshot re-keyed by (account, netuid, day): "what did this hotkey
-- hold, where, on that day" without scanning the per-UID table.
CREATE TABLE IF NOT EXISTS account_position_daily (
  account          TEXT    NOT NULL,
  netuid           INTEGER NOT NULL,
  snapshot_date    TEXT    NOT NULL,
  uid              INTEGER,
  coldkey          TEXT,
  active           INTEGER CHECK (active IN (0, 1)),
  validator_permit INTEGER CHECK (validator_permit IN (0, 1)),
  rank             REAL,
  trust            REAL,
  incentive        REAL,
  dividends        REAL,
  stake_tao        REAL,
  emission_tao     REAL,
  captured_at      INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  PRIMARY KEY (account, netuid, snapshot_date)
);

-- "This account's positions over time", the account-history read pattern.
CREATE INDEX IF NOT EXISTS idx_account_position_daily_account_date
  ON account_position_daily (account, snapshot_date);
