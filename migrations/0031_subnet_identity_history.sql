-- On-chain subnet identity history (#1647): append-only timeline of
-- SubnetIdentitiesV3 changes, detected when the hourly cron diffs profiles.json
-- native_identity against the last recorded hash per netuid. Live-forward only
-- (pre-tracking backfill is a follow-up).
CREATE TABLE IF NOT EXISTS subnet_identity_history (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  netuid          INTEGER NOT NULL,
  block_number    INTEGER,
  observed_at     INTEGER NOT NULL,
  subnet_name     TEXT,
  symbol          TEXT,
  description     TEXT,
  github_repo     TEXT,
  subnet_url      TEXT,
  discord         TEXT,
  logo_url        TEXT,
  identity_hash   TEXT NOT NULL
);

-- Newest-first paginated reads for one subnet.
CREATE INDEX IF NOT EXISTS idx_subnet_identity_history_netuid_observed
  ON subnet_identity_history (netuid, observed_at DESC, id DESC);

-- Latest-hash lookup per netuid during the hourly diff.
CREATE INDEX IF NOT EXISTS idx_subnet_identity_history_netuid_id
  ON subnet_identity_history (netuid, id DESC);
