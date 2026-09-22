-- Account, quota, and alert state with current account-kind isolation (#12160).
-- Sequence IDs retain their imported values; new rows continue above the seed.
-- JSON stays TEXT, booleans are 0/1, and epoch milliseconds remain exact.
CREATE TABLE rpc_accounts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ss58          TEXT    NOT NULL UNIQUE,
  tier          TEXT    NOT NULL DEFAULT 'free',
  created_at    INTEGER NOT NULL,
  last_login_at INTEGER
);
-- statement-breakpoint
CREATE INDEX idx_rpc_accounts_ss58 ON rpc_accounts (ss58);
-- statement-breakpoint

CREATE TABLE github_accounts (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  github_user_id INTEGER NOT NULL UNIQUE,
  github_login   TEXT    NOT NULL,
  tier           TEXT    NOT NULL DEFAULT 'free',
  created_at     INTEGER NOT NULL,
  last_login_at  INTEGER
);
-- statement-breakpoint
CREATE INDEX idx_github_accounts_github_user_id
  ON github_accounts (github_user_id);
-- statement-breakpoint

CREATE TABLE api_keys (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  prefix        TEXT UNIQUE,
  secret_hash   TEXT,
  owner_contact TEXT    NOT NULL,
  tier          TEXT    NOT NULL DEFAULT 'keyed',
  created_at    INTEGER NOT NULL,
  revoked_at    INTEGER,
  last_used_at  INTEGER,
  account_id    INTEGER,
  unkey_key_id  TEXT,
  revocation_requested_at INTEGER
);
-- statement-breakpoint
CREATE INDEX idx_api_keys_prefix ON api_keys (prefix);
-- statement-breakpoint
CREATE INDEX idx_api_keys_account_id
  ON api_keys (account_id) WHERE account_id IS NOT NULL;
-- statement-breakpoint
CREATE UNIQUE INDEX idx_api_keys_unkey_key_id
  ON api_keys (unkey_key_id) WHERE unkey_key_id IS NOT NULL;
-- statement-breakpoint

CREATE TABLE api_key_blocks (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id     INTEGER NOT NULL,
  reason_code    TEXT    NOT NULL,
  note           TEXT,
  blocked_at     INTEGER NOT NULL,
  blocked_by     TEXT,
  unblocked_at   INTEGER,
  unblocked_note TEXT,
  account_kind TEXT NOT NULL DEFAULT 'rpc' CHECK (account_kind IN ('rpc', 'github'))
);
-- statement-breakpoint
CREATE UNIQUE INDEX idx_api_key_blocks_one_active_per_account
  ON api_key_blocks (account_kind, account_id) WHERE unblocked_at IS NULL;
-- statement-breakpoint

CREATE TABLE api_key_usage_daily (
  account_id     INTEGER NOT NULL,
  day            TEXT    NOT NULL,
  route          TEXT    NOT NULL,
  request_count  INTEGER NOT NULL DEFAULT 0,
  rejected_count INTEGER NOT NULL DEFAULT 0,
  account_kind TEXT NOT NULL DEFAULT 'rpc' CHECK (account_kind IN ('rpc', 'github')),
  PRIMARY KEY (account_kind, account_id, day, route)
);
-- statement-breakpoint
CREATE INDEX idx_api_key_usage_daily_account_day
  ON api_key_usage_daily (account_kind, account_id, day DESC);
-- statement-breakpoint

CREATE TABLE api_quota_daily (
  account_id  INTEGER NOT NULL,
  day         TEXT    NOT NULL,
  units_spent INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL,
  account_kind TEXT NOT NULL DEFAULT 'rpc' CHECK (account_kind IN ('rpc', 'github')),
  PRIMARY KEY (account_kind, account_id, day)
);
-- statement-breakpoint

CREATE TABLE api_usage_rollup (
  day           TEXT    NOT NULL,
  route_family  TEXT    NOT NULL,
  cost_shape    TEXT    NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0,
  keyed_count   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, route_family, cost_shape)
);
-- statement-breakpoint
CREATE INDEX idx_api_usage_rollup_day
  ON api_usage_rollup (day DESC, request_count DESC);
-- statement-breakpoint
CREATE INDEX idx_api_usage_rollup_shape
  ON api_usage_rollup (cost_shape, day DESC);
-- statement-breakpoint

CREATE TABLE chain_alert_triggers (
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
-- statement-breakpoint
CREATE INDEX idx_cat_active
  ON chain_alert_triggers (active) WHERE active;
-- statement-breakpoint
CREATE INDEX idx_cat_owner_ss58_active
  ON chain_alert_triggers (owner_ss58)
  WHERE owner_ss58 IS NOT NULL AND active;
-- statement-breakpoint

CREATE TABLE chain_alert_deliveries (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  trigger_id       INTEGER NOT NULL
    REFERENCES chain_alert_triggers(id) ON DELETE CASCADE,
  delivered_at     INTEGER NOT NULL,
  success          INTEGER NOT NULL CHECK (success IN (0, 1)),
  status_code      INTEGER,
  retry_count      INTEGER NOT NULL DEFAULT 0,
  response_snippet TEXT
);
-- statement-breakpoint
CREATE INDEX idx_cad_trigger_delivered_at
  ON chain_alert_deliveries (trigger_id, delivered_at DESC);
-- statement-breakpoint

CREATE TABLE watch_push_subscriptions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  address      TEXT    NOT NULL,
  endpoint     TEXT    NOT NULL UNIQUE,
  p256dh       TEXT    NOT NULL,
  auth         TEXT    NOT NULL,
  user_agent   TEXT,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER
);
-- statement-breakpoint
CREATE INDEX idx_wps_address
  ON watch_push_subscriptions (address, created_at DESC);
