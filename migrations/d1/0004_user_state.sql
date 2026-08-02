-- User-state tables on D1: the last box-Postgres tenants of workers/data-api.ts
-- (infra: read-ports epic, accounts lane). Eleven tables of accounts, API keys,
-- usage accounting, alert subscriptions, push subscriptions, and the TAO/USD
-- price index -- all bounded, transactional, low-volume user/config state:
-- exactly D1's lane, and the only data in the decommissioned box's Postgres
-- that was neither chain-derived (R2/Iceberg's lane) nor an observation
-- (0002's lane).
--
-- Column sets are faithful translations of the LIVE Postgres shapes
-- (pg_dump --schema-only, captured 2026-08-02, 541 rows total migrated):
--   bigint sequence ids  -> INTEGER PRIMARY KEY AUTOINCREMENT (migrated rows
--                           keep their original ids; AUTOINCREMENT continues
--                           above them)
--   date                 -> TEXT 'YYYY-MM-DD' (writers pass ISO day strings;
--                           lexicographic order == date order)
--   numeric              -> REAL
--   jsonb / text[]       -> TEXT holding JSON (writers stringify)
--   timestamptz now()    -> INTEGER epoch-ms set by the writer
--   boolean              -> INTEGER 0/1 with CHECK
-- Partial/expression indexes translate verbatim -- SQLite supports both.

CREATE TABLE IF NOT EXISTS rpc_accounts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ss58          TEXT    NOT NULL UNIQUE,
  tier          TEXT    NOT NULL DEFAULT 'free',
  created_at    INTEGER NOT NULL,
  last_login_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_rpc_accounts_ss58 ON rpc_accounts (ss58);

CREATE TABLE IF NOT EXISTS github_accounts (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  github_user_id INTEGER NOT NULL UNIQUE,
  github_login   TEXT    NOT NULL,
  tier           TEXT    NOT NULL DEFAULT 'free',
  created_at     INTEGER NOT NULL,
  last_login_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_github_accounts_github_user_id
  ON github_accounts (github_user_id);

CREATE TABLE IF NOT EXISTS api_keys (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  prefix        TEXT UNIQUE,
  secret_hash   TEXT,
  owner_contact TEXT    NOT NULL,
  tier          TEXT    NOT NULL DEFAULT 'keyed',
  created_at    INTEGER NOT NULL,
  revoked_at    INTEGER,
  last_used_at  INTEGER,
  account_id    INTEGER,
  unkey_key_id  TEXT
);
CREATE INDEX IF NOT EXISTS idx_api_keys_prefix ON api_keys (prefix);
CREATE INDEX IF NOT EXISTS idx_api_keys_account_id
  ON api_keys (account_id) WHERE account_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_api_keys_unkey_key_id
  ON api_keys (unkey_key_id) WHERE unkey_key_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS api_key_blocks (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id     INTEGER NOT NULL,
  reason_code    TEXT    NOT NULL,
  note           TEXT,
  blocked_at     INTEGER NOT NULL,
  blocked_by     TEXT,
  unblocked_at   INTEGER,
  unblocked_note TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_api_key_blocks_one_active_per_account
  ON api_key_blocks (account_id) WHERE unblocked_at IS NULL;

CREATE TABLE IF NOT EXISTS api_key_usage_daily (
  account_id     INTEGER NOT NULL,
  day            TEXT    NOT NULL,
  route          TEXT    NOT NULL,
  request_count  INTEGER NOT NULL DEFAULT 0,
  rejected_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, day, route)
);
CREATE INDEX IF NOT EXISTS idx_api_key_usage_daily_account_day
  ON api_key_usage_daily (account_id, day DESC);

CREATE TABLE IF NOT EXISTS api_quota_daily (
  account_id  INTEGER NOT NULL,
  day         TEXT    NOT NULL,
  units_spent INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (account_id, day)
);

CREATE TABLE IF NOT EXISTS api_usage_rollup (
  day           TEXT    NOT NULL,
  route_family  TEXT    NOT NULL,
  cost_shape    TEXT    NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0,
  keyed_count   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, route_family, cost_shape)
);
CREATE INDEX IF NOT EXISTS idx_api_usage_rollup_day
  ON api_usage_rollup (day DESC, request_count DESC);
CREATE INDEX IF NOT EXISTS idx_api_usage_rollup_shape
  ON api_usage_rollup (cost_shape, day DESC);

CREATE TABLE IF NOT EXISTS chain_alert_triggers (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_token     TEXT    NOT NULL,
  name            TEXT,
  table_filter    TEXT,
  netuid          INTEGER,
  event_kind      TEXT,
  account         TEXT,
  min_amount_tao  REAL,
  channel         TEXT    NOT NULL
    CHECK (channel IN ('webhook', 'email', 'telegram', 'discord', 'webpush')),
  destination     TEXT    NOT NULL,
  active          INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  last_matched_at INTEGER,
  match_count     INTEGER NOT NULL DEFAULT 0,
  condition       TEXT,
  owner_ss58      TEXT
);
CREATE INDEX IF NOT EXISTS idx_cat_active
  ON chain_alert_triggers (active) WHERE active;
CREATE INDEX IF NOT EXISTS idx_cat_owner_ss58_active
  ON chain_alert_triggers (owner_ss58)
  WHERE owner_ss58 IS NOT NULL AND active;

CREATE TABLE IF NOT EXISTS chain_alert_deliveries (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  trigger_id       INTEGER NOT NULL
    REFERENCES chain_alert_triggers(id) ON DELETE CASCADE,
  delivered_at     INTEGER NOT NULL,
  success          INTEGER NOT NULL CHECK (success IN (0, 1)),
  status_code      INTEGER,
  retry_count      INTEGER NOT NULL DEFAULT 0,
  response_snippet TEXT
);
CREATE INDEX IF NOT EXISTS idx_cad_trigger_delivered_at
  ON chain_alert_deliveries (trigger_id, delivered_at DESC);

CREATE TABLE IF NOT EXISTS watch_push_subscriptions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  address      TEXT    NOT NULL,
  endpoint     TEXT    NOT NULL UNIQUE,
  p256dh       TEXT    NOT NULL,
  auth         TEXT    NOT NULL,
  user_agent   TEXT,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_wps_address
  ON watch_push_subscriptions (address, created_at DESC);

CREATE TABLE IF NOT EXISTS tao_usd_index (
  block_number INTEGER NOT NULL,
  observed_at  INTEGER NOT NULL,
  usd_per_tao  REAL,
  price_basis  TEXT    NOT NULL
    CHECK (price_basis IN ('wrapped_onchain_median', 'insufficient_pools')),
  eth_usd      REAL,
  pool_count   INTEGER NOT NULL CHECK (pool_count >= 0),
  pools        TEXT    NOT NULL DEFAULT '[]',
  PRIMARY KEY (block_number, observed_at),
  CHECK (
    (price_basis = 'insufficient_pools' AND usd_per_tao IS NULL)
    OR (price_basis <> 'insufficient_pools' AND usd_per_tao IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS idx_tao_usd_index_observed
  ON tao_usd_index (observed_at DESC);
