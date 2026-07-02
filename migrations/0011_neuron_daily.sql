-- Per-UID daily metagraph HISTORY (block-explorer Tier-1, epic #1345 / depth #1302).
--
-- The refresh-metagraph cron lands the LATEST per-UID snapshot in `neurons`
-- (migration 0007, overwrite-on-conflict — no history is kept). A dedicated daily
-- rollup (rollupNeuronDaily, src/neuron-history.mjs) copies the current snapshot
-- into this append-only DATED table, giving per-UID and per-subnet time-series for
-- every subnet without a second fetch.
--
-- Shape mirrors `neurons` EXACTLY (so formatNeuron / buildSubnetMetagraph are
-- reused verbatim on the read path) plus snapshot_date. It lives in the SAME
-- database as `neurons` on purpose: D1 has no cross-database queries, so co-location
-- makes the rollup a single, atomic INSERT...SELECT instead of a brittle
-- Worker-mediated row shuttle. A 90-day prune (PR-A2) keeps it bounded (~3M rows /
-- ~0.7GB steady-state, far under D1's 10GB cap); older days tier to an R2 cold
-- archive (PR-A2).
CREATE TABLE IF NOT EXISTS neuron_daily (
  netuid               INTEGER NOT NULL,
  uid                  INTEGER NOT NULL,
  snapshot_date        TEXT    NOT NULL,   -- YYYY-MM-DD (UTC) derived from captured_at
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
  stake_tao            REAL,
  registered_at_block  INTEGER,
  is_immunity_period   INTEGER,            -- 0/1
  axon                 TEXT,
  block_number         INTEGER,
  captured_at          INTEGER NOT NULL,   -- epoch ms — the single consistent snapshot stamp
  updated_at           INTEGER NOT NULL,   -- epoch ms when this daily row was (re)rolled
  PRIMARY KEY (netuid, uid, snapshot_date)
);

-- Per-UID time series: WHERE netuid = ? AND uid = ? ORDER BY snapshot_date DESC.
CREATE INDEX IF NOT EXISTS idx_neuron_daily_uid_date
  ON neuron_daily (netuid, uid, snapshot_date);

-- Per-subnet as-of / validators on a date: WHERE netuid = ? AND snapshot_date = ?.
CREATE INDEX IF NOT EXISTS idx_neuron_daily_netuid_date
  ON neuron_daily (netuid, snapshot_date);

-- Point-in-time account history: which UID a hotkey held on a date.
CREATE INDEX IF NOT EXISTS idx_neuron_daily_hotkey_date
  ON neuron_daily (hotkey, snapshot_date);

-- Lets the (PR-A2) retention prune SEEK the old-day tail instead of full-scanning.
CREATE INDEX IF NOT EXISTS idx_neuron_daily_date
  ON neuron_daily (snapshot_date);
