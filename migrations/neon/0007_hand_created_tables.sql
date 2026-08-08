-- The six tables Neon has but no migration created (#10135).
--
-- WHY THEY WERE MISSING. These were stood up in Neon by hand during the early phase
-- of the migration, before migrations/neon/ existed as the record. They have
-- been serving correctly ever since -- which is exactly why nobody noticed that
-- nothing in the repo could recreate them.
--
-- It surfaced from the other direction: a guard added after lane_health was
-- flipped to sole-store against a table Neon did not have. Asking "does every
-- sole-store table have a migration" found lane_health AND these six.
--
-- WHY IT MATTERS NOW, and not before. While D1 held a copy, the D1 migrations
-- were a usable record of the schema. Sole-store means D1 is no longer written;
-- DELETING D1 removes that record too, and these six would exist only as live
-- objects in one database -- unreproducible on a new Neon branch, a restore, or
-- a fresh environment.
--
-- TRANSCRIBED FROM THE LIVE SCHEMA, not translated from D1's. information_schema
-- and pg_indexes are the source, so the types are what production actually has
-- rather than what a mapping table says they should be. The differences are
-- real and load-bearing:
--
--   INTEGER CHECK (x IN (0,1))  ->  BOOLEAN   active, validator_permit,
--                                             is_immunity_period
--   INTEGER (epoch ms)          ->  BIGINT    captured_at, updated_at,
--                                             block_number, registered_at_block
--   REAL                        ->  DOUBLE PRECISION
--   TEXT (YYYY-MM-DD)           ->  TEXT      snapshot_date stays TEXT so the
--                                             value round-trips identically
--
-- IF NOT EXISTS throughout: this is a description of what is already there, and
-- running it against production must be a no-op.

CREATE TABLE IF NOT EXISTS neurons (
  netuid              INTEGER NOT NULL,
  uid                 INTEGER NOT NULL,
  hotkey              TEXT,
  coldkey             TEXT,
  active              BOOLEAN,
  validator_permit    BOOLEAN,
  rank                DOUBLE PRECISION,
  trust               DOUBLE PRECISION,
  validator_trust     DOUBLE PRECISION,
  consensus           DOUBLE PRECISION,
  incentive           DOUBLE PRECISION,
  dividends           DOUBLE PRECISION,
  emission_tao        DOUBLE PRECISION,
  stake_tao           DOUBLE PRECISION,
  registered_at_block BIGINT,
  is_immunity_period  BOOLEAN,
  axon                TEXT,
  block_number        BIGINT,
  captured_at         BIGINT NOT NULL,
  take                DOUBLE PRECISION,
  PRIMARY KEY (netuid, uid)
);
CREATE INDEX IF NOT EXISTS idx_neurons_hotkey ON neurons (hotkey);
CREATE INDEX IF NOT EXISTS idx_neurons_netuid_permit
  ON neurons (netuid, validator_permit);

CREATE TABLE IF NOT EXISTS neuron_daily (
  netuid              INTEGER NOT NULL,
  uid                 INTEGER NOT NULL,
  hotkey              TEXT,
  coldkey             TEXT,
  active              BOOLEAN,
  validator_permit    BOOLEAN,
  rank                DOUBLE PRECISION,
  trust               DOUBLE PRECISION,
  validator_trust     DOUBLE PRECISION,
  consensus           DOUBLE PRECISION,
  incentive           DOUBLE PRECISION,
  dividends           DOUBLE PRECISION,
  emission_tao        DOUBLE PRECISION,
  stake_tao           DOUBLE PRECISION,
  registered_at_block BIGINT,
  is_immunity_period  BOOLEAN,
  axon                TEXT,
  block_number        BIGINT,
  captured_at         BIGINT NOT NULL,
  take                DOUBLE PRECISION,
  snapshot_date       TEXT   NOT NULL,
  updated_at          BIGINT NOT NULL,
  PRIMARY KEY (netuid, uid, snapshot_date)
);
CREATE INDEX IF NOT EXISTS idx_neuron_daily_hotkey_date
  ON neuron_daily (hotkey, snapshot_date);

CREATE TABLE IF NOT EXISTS account_position_daily (
  account          TEXT    NOT NULL,
  netuid           INTEGER NOT NULL,
  snapshot_date    TEXT    NOT NULL,
  uid              INTEGER,
  coldkey          TEXT,
  active           BOOLEAN,
  validator_permit BOOLEAN,
  rank             DOUBLE PRECISION,
  trust            DOUBLE PRECISION,
  incentive        DOUBLE PRECISION,
  dividends        DOUBLE PRECISION,
  stake_tao        DOUBLE PRECISION,
  emission_tao     DOUBLE PRECISION,
  captured_at      BIGINT NOT NULL,
  updated_at       BIGINT NOT NULL,
  PRIMARY KEY (account, netuid, snapshot_date)
);
CREATE INDEX IF NOT EXISTS idx_account_position_daily_account_date
  ON account_position_daily (account, snapshot_date);

CREATE TABLE IF NOT EXISTS nominator_positions (
  coldkey        TEXT    NOT NULL,
  hotkey         TEXT    NOT NULL,
  netuid         INTEGER NOT NULL,
  share_fraction DOUBLE PRECISION,
  captured_at    BIGINT  NOT NULL,
  PRIMARY KEY (coldkey, hotkey, netuid)
);
CREATE INDEX IF NOT EXISTS idx_nominator_positions_hotkey
  ON nominator_positions (hotkey, netuid);

CREATE TABLE IF NOT EXISTS validator_nominator_counts (
  hotkey          TEXT    NOT NULL PRIMARY KEY,
  nominator_count INTEGER NOT NULL,
  captured_at     BIGINT  NOT NULL
);

CREATE TABLE IF NOT EXISTS account_balances (
  ss58         TEXT   NOT NULL PRIMARY KEY,
  free_tao     DOUBLE PRECISION NOT NULL,
  reserved_tao DOUBLE PRECISION NOT NULL,
  captured_at  BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_account_balances_free
  ON account_balances (free_tao DESC);
