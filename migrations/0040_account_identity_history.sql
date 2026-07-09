-- Personal (coldkey) chain identity history (#4326, epic #4301/5.2): append-only
-- timeline of account_identity changes, detected when the daily
-- refresh-account-identity load diffs the freshly-staged snapshot against the
-- last recorded hash per account. Mirrors subnet_hyperparams_history
-- (migrations/0037_subnet_hyperparams_history.sql) exactly, just keyed by
-- account (TEXT ss58) instead of netuid, and with no block_number column —
-- account_identity itself carries no chain block height, only captured_at.
CREATE TABLE IF NOT EXISTS account_identity_history (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  account       TEXT    NOT NULL,
  observed_at   INTEGER NOT NULL,
  name          TEXT,
  url           TEXT,
  github        TEXT,
  image         TEXT,
  discord       TEXT,
  description   TEXT,
  additional    TEXT,
  identity_hash TEXT    NOT NULL
);

-- Newest-first paginated reads for one account.
CREATE INDEX IF NOT EXISTS idx_account_identity_history_account_observed
  ON account_identity_history (account, observed_at DESC, id DESC);

-- Latest-hash lookup per account during the diff.
CREATE INDEX IF NOT EXISTS idx_account_identity_history_account_id
  ON account_identity_history (account, id DESC);
