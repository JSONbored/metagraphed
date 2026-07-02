-- Per-UID metagraph snapshot (#1303, epic #1302): the chain-level depth
-- metagraphed previously lacked. One row per (netuid, uid), refreshed daily by
-- the refresh-metagraph workflow (Taostats source) — latest-only, REPLACE-on-
-- conflict, so the table stays bounded (~33k rows: 129 subnets x <=256 UIDs) and
-- never grows unbounded. Powers /api/v1/subnets/{netuid}/metagraph + /neurons/{uid}
-- (#1304) and /validators (#1305).
--
-- Units (verified against /api/v1/economics ground truth 2026-06-21):
--   stake_tao   = Taostats total_alpha_stake / 1e9  (sum matches economics total_stake_tao)
--   emission_tao= Taostats emission / 1e9
--   trust/validator_trust/consensus/incentive/dividends = 0..1 ratios (as-is)
--   validator_permit/active/is_immunity_period = 0/1 booleans
CREATE TABLE IF NOT EXISTS neurons (
  netuid               INTEGER NOT NULL,
  uid                  INTEGER NOT NULL,
  hotkey               TEXT,
  coldkey              TEXT,
  active               INTEGER,            -- 0/1
  validator_permit     INTEGER,            -- 0/1
  rank                 REAL,
  trust                REAL,
  validator_trust      REAL,
  consensus            REAL,
  incentive            REAL,
  dividends            REAL,
  emission_tao         REAL,
  stake_tao            REAL,               -- total_alpha_stake / 1e9 (canonical stake)
  registered_at_block  INTEGER,
  is_immunity_period   INTEGER,            -- 0/1
  axon                 TEXT,               -- "host:port" or NULL
  block_number         INTEGER,            -- chain height at capture
  captured_at          INTEGER NOT NULL,   -- epoch milliseconds
  PRIMARY KEY (netuid, uid)
);

-- Validator discovery (#1305) + per-subnet listing (#1304): filter by subnet and
-- validator_permit, order by stake/emission.
CREATE INDEX IF NOT EXISTS idx_neurons_netuid_permit
  ON neurons (netuid, validator_permit);

-- Cross-subnet hotkey lookup: "which subnets does this hotkey operate on".
CREATE INDEX IF NOT EXISTS idx_neurons_hotkey
  ON neurons (hotkey);
