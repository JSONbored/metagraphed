-- Every remaining D1 table that is going to Neon, in one file (#9787).
--
-- WHY ONE FILE. D1 holds 49 tables; 21 of them already exist in Neon. Of the
-- 28 that do not, two are never moving (below), so this file is the other 26.
-- They are not one family and do not share a lane, but they share a blocker: a
-- table with no schema on the other side cannot be mirrored, cannot be
-- reconciled, and cannot be read from. Splitting the DDL per family would mean
-- six merges before the first row could move. DDL is additive and
-- scripts/neon-migrate.ts applies a file exactly once inside a transaction, so
-- the cost of batching is a longer diff, not a longer outage.
--
-- VERIFIED BEFORE MERGE, not after: applied to a throwaway Neon branch off
-- production (pg 18), then every one of the 26 column sets diffed against
-- `pragma_table_info` on the live D1 -- 26/26 match name-for-name, which is
-- what the reconciler's named-column INSERT depends on.
--
-- WHAT IS DELIBERATELY NOT HERE:
--
--   lane_health     the durable sink every watchdog writes to, including the
--                   ones watching this migration. It moves LAST and on its
--                   own, because until it does it is the only thing that can
--                   report a lane that broke while being moved.
--   d1_migrations   D1's own bookkeeping. Neon tracks its schema in
--                   `schema_migrations`, written by scripts/neon-migrate.ts.
--
-- TYPE MAPPING, unchanged from 0001 and verified against information_schema
-- rather than assumed:
--
--   INTEGER CHECK (x IN (0,1))   -> BOOLEAN   the mirror sends real JS
--                                             booleans and the reconciler
--                                             converts on the way out of D1
--                                             (shapeRowForNeon); Postgres
--                                             rejects `boolean = integer`
--   INTEGER (epoch milliseconds) -> BIGINT    epoch-ms does not fit in int4
--   INTEGER (block / counts / id)-> INTEGER
--   REAL                         -> DOUBLE PRECISION
--   TEXT                         -> TEXT
--   TEXT 'YYYY-MM-DD' (day)      -> TEXT      lexicographic order IS date
--                                             order for ISO dates on both
--                                             sides; DATE here would make the
--                                             same value round-trip
--                                             differently per store
--
-- IDENTITY COLUMNS ARE `BY DEFAULT`, NEVER `ALWAYS`. 0003 declared four
-- history ids `GENERATED ALWAYS` and 0004 had to undo it: the copy carries
-- D1's ids verbatim so that `MAX(id)` picks the same latest revision and an
-- `(observed_at, id)` keyset cursor means the same thing on either side.
-- `ALWAYS` rejects an explicit id outright. The sequences still need a
-- `setval` past D1's high-water mark once the copy lands -- an explicit insert
-- does not advance them -- and that belongs with the write cutover, not here,
-- because doing it before the rows exist sets it to the wrong number.
--
-- FOREIGN KEYS ARE OMITTED where D1 declares them (surfaces -> providers,
-- surfaces -> subnets). Not an oversight and not a loosening of the model: the
-- reconciler copies one table per unit of work in its own transaction, with no
-- ordering between tables, so a FK here would fail the `surfaces` copy for as
-- long as `providers` happened to be behind. The registry sync is a single
-- write path that builds all three from one commit and already maintains the
-- relationship; the constraint would be re-checking its own invariant at the
-- cost of making the backfill order-dependent. The one FK kept is
-- chain_alert_deliveries -> chain_alert_triggers, because ON DELETE CASCADE
-- there is behaviour a caller relies on rather than a restatement, and both
-- tables are empty so no copy can be caught by it.

-- --------------------------------------------------------------------------
-- 1. The registry cluster (#9779). Rebuilt wholesale from a commit's registry
--    JSON, so `updated_at` defaults the way D1 does and the writer supplies
--    every other column.
-- --------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS subnets (
  netuid        INTEGER NOT NULL PRIMARY KEY,
  slug          TEXT    NOT NULL UNIQUE,
  name          TEXT    NOT NULL,
  source        TEXT    NOT NULL DEFAULT 'community',
  overlay       TEXT    NOT NULL,
  source_commit TEXT    NOT NULL,
  updated_at    BIGINT  NOT NULL DEFAULT (EXTRACT(EPOCH FROM now()) * 1000)::BIGINT
);

CREATE INDEX IF NOT EXISTS idx_subnets_source ON subnets (source);

CREATE TABLE IF NOT EXISTS providers (
  id            TEXT    NOT NULL PRIMARY KEY,
  overlay       TEXT    NOT NULL,
  source_commit TEXT    NOT NULL,
  updated_at    BIGINT  NOT NULL DEFAULT (EXTRACT(EPOCH FROM now()) * 1000)::BIGINT
);

CREATE TABLE IF NOT EXISTS surfaces (
  id             TEXT    NOT NULL PRIMARY KEY,
  subnet_netuid  INTEGER NOT NULL,
  provider_id    TEXT,
  surface_key    TEXT    NOT NULL,
  kind           TEXT    NOT NULL,
  url            TEXT    NOT NULL,
  authority      TEXT    NOT NULL DEFAULT 'community',
  review_state   TEXT    NOT NULL DEFAULT 'community-submitted',
  probe_eligible BOOLEAN NOT NULL DEFAULT FALSE,
  public_safe    BOOLEAN NOT NULL DEFAULT TRUE,
  overlay        TEXT    NOT NULL,
  source_commit  TEXT    NOT NULL,
  updated_at     BIGINT  NOT NULL DEFAULT (EXTRACT(EPOCH FROM now()) * 1000)::BIGINT,
  UNIQUE (subnet_netuid, kind, url)
);

CREATE INDEX IF NOT EXISTS idx_surfaces_subnet ON surfaces (subnet_netuid);
CREATE INDEX IF NOT EXISTS idx_surfaces_provider ON surfaces (provider_id);
CREATE INDEX IF NOT EXISTS idx_surfaces_probe
  ON surfaces (probe_eligible, review_state) WHERE probe_eligible;

-- Intentionally carries no reference to `surfaces`: an audit trail has to
-- survive the deletion of the thing it describes, which is the whole point of
-- recording `action = 'delete'`.
CREATE TABLE IF NOT EXISTS surface_history (
  id            INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  surface_id    TEXT,
  subnet_netuid INTEGER NOT NULL,
  action        TEXT    NOT NULL,
  overlay       TEXT    NOT NULL,
  source_commit TEXT    NOT NULL,
  recorded_at   BIGINT  NOT NULL DEFAULT (EXTRACT(EPOCH FROM now()) * 1000)::BIGINT
);

CREATE INDEX IF NOT EXISTS idx_surface_history_subnet
  ON surface_history (subnet_netuid, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_surface_history_surface
  ON surface_history (surface_id, recorded_at DESC);

-- --------------------------------------------------------------------------
-- 2. The five completeness ledgers. One row per capture pass, keyed on the
--    pass's own timestamp; `completed_at` is set exactly once, by the request
--    that brings received_rows up to expected_rows, and never cleared.
--    account_balances_passes carries two extra columns the others do not.
-- --------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS account_balances_passes (
  captured_at   BIGINT  NOT NULL PRIMARY KEY,
  expected_rows INTEGER NOT NULL,
  received_rows INTEGER NOT NULL DEFAULT 0,
  completed_at  BIGINT,
  scanned       INTEGER,
  outcome       TEXT
);

CREATE INDEX IF NOT EXISTS idx_account_balances_passes_completed
  ON account_balances_passes (completed_at DESC);

CREATE TABLE IF NOT EXISTS hotkey_alpha_passes (
  captured_at   BIGINT  NOT NULL PRIMARY KEY,
  expected_rows INTEGER NOT NULL,
  received_rows INTEGER NOT NULL DEFAULT 0,
  completed_at  BIGINT
);

CREATE INDEX IF NOT EXISTS idx_hotkey_alpha_passes_completed
  ON hotkey_alpha_passes (completed_at DESC);

CREATE TABLE IF NOT EXISTS neurons_passes (
  captured_at   BIGINT  NOT NULL PRIMARY KEY,
  expected_rows INTEGER NOT NULL,
  received_rows INTEGER NOT NULL DEFAULT 0,
  completed_at  BIGINT
);

CREATE INDEX IF NOT EXISTS idx_neurons_passes_completed
  ON neurons_passes (completed_at DESC);

CREATE TABLE IF NOT EXISTS nominator_positions_passes (
  captured_at   BIGINT  NOT NULL PRIMARY KEY,
  expected_rows INTEGER NOT NULL,
  received_rows INTEGER NOT NULL DEFAULT 0,
  completed_at  BIGINT
);

CREATE INDEX IF NOT EXISTS idx_nominator_positions_passes_completed
  ON nominator_positions_passes (completed_at DESC);

CREATE TABLE IF NOT EXISTS validator_nominator_counts_passes (
  captured_at   BIGINT  NOT NULL PRIMARY KEY,
  expected_rows INTEGER NOT NULL,
  received_rows INTEGER NOT NULL DEFAULT 0,
  completed_at  BIGINT
);

CREATE INDEX IF NOT EXISTS idx_validator_nominator_counts_passes_completed
  ON validator_nominator_counts_passes (completed_at DESC);

-- --------------------------------------------------------------------------
-- 3. Chain detail -- the decoded seam. Four tables, ~725,000 rows, all keyed
--    on (block_number, ...) so a copy is resumable on the block number alone.
-- --------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS chain_detail_blocks (
  block_number        INTEGER NOT NULL PRIMARY KEY,
  block_hash          TEXT    NOT NULL,
  spec_version        INTEGER,
  extrinsic_count     INTEGER NOT NULL,
  chain_event_count   INTEGER NOT NULL,
  account_event_count INTEGER NOT NULL,
  observed_at         BIGINT  NOT NULL,
  synced_at           BIGINT  NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chain_detail_blocks_hash
  ON chain_detail_blocks (block_hash);

CREATE TABLE IF NOT EXISTS chain_detail_extrinsics (
  block_number    INTEGER NOT NULL,
  extrinsic_index INTEGER NOT NULL,
  extrinsic_hash  TEXT,
  signer          TEXT,
  call_module     TEXT,
  call_function   TEXT,
  success         BOOLEAN,
  fee_tao         TEXT,
  tip_tao         TEXT,
  call_args       TEXT,
  observed_at     BIGINT  NOT NULL,
  PRIMARY KEY (block_number, extrinsic_index)
);

CREATE INDEX IF NOT EXISTS idx_chain_detail_extrinsics_hash
  ON chain_detail_extrinsics (extrinsic_hash);

CREATE TABLE IF NOT EXISTS chain_detail_chain_events (
  block_number    INTEGER NOT NULL,
  event_index     INTEGER NOT NULL,
  pallet          TEXT    NOT NULL,
  method          TEXT    NOT NULL,
  args            TEXT,
  phase           TEXT    NOT NULL,
  extrinsic_index INTEGER,
  observed_at     BIGINT  NOT NULL,
  PRIMARY KEY (block_number, event_index)
);

CREATE INDEX IF NOT EXISTS idx_chain_detail_chain_events_extrinsic
  ON chain_detail_chain_events (block_number, extrinsic_index);

CREATE TABLE IF NOT EXISTS chain_detail_account_events (
  block_number    INTEGER NOT NULL,
  event_index     INTEGER NOT NULL,
  extrinsic_index INTEGER,
  event_kind      TEXT    NOT NULL,
  hotkey          TEXT,
  coldkey         TEXT,
  netuid          INTEGER,
  uid             INTEGER,
  amount_tao      TEXT,
  alpha_amount    TEXT,
  observed_at     BIGINT  NOT NULL,
  PRIMARY KEY (block_number, event_index)
);

CREATE INDEX IF NOT EXISTS idx_chain_detail_account_events_extrinsic
  ON chain_detail_account_events (block_number, extrinsic_index);

-- --------------------------------------------------------------------------
-- 4. Capture-lane state. Small, latest-only, and read on every tick.
-- --------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS blocks_head (
  block_number    INTEGER NOT NULL PRIMARY KEY,
  block_hash      TEXT    NOT NULL,
  parent_hash     TEXT,
  extrinsic_count INTEGER,
  event_count     INTEGER,
  author          TEXT,
  observed_at     BIGINT  NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_blocks_head_observed
  ON blocks_head (observed_at DESC);

-- `network` is TEXT rather than an integer id so the value is self-describing
-- in a query result -- 'mainnet' / 'testnet', the identifiers
-- src/chain-network.ts uses, so one vocabulary spans the capture lane, the KV
-- keys and the API's /{network}/ prefix.
CREATE TABLE IF NOT EXISTS raw_capture_state (
  network               TEXT    NOT NULL PRIMARY KEY,
  last_contiguous_block INTEGER NOT NULL,
  updated_at            BIGINT  NOT NULL,
  stopped_at            BIGINT,
  last_error            TEXT
);

CREATE TABLE IF NOT EXISTS emission_flow_watch (
  id               INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  item             TEXT    NOT NULL
    CHECK (item IN ('net_tao_flow_enabled', 'flow_norm_exponent',
                    'tao_flow_cutoff', 'flow_ema_smoothing_factor',
                    'subnet_ema_tao_flow')),
  netuid           INTEGER,
  is_set           BOOLEAN NOT NULL,
  ema_block        INTEGER,
  block_number     INTEGER,
  observed_at      BIGINT  NOT NULL,
  predates_capture BOOLEAN NOT NULL DEFAULT FALSE,
  CHECK (
    (item = 'subnet_ema_tao_flow' AND netuid IS NOT NULL AND ema_block IS NOT NULL)
    OR (item <> 'subnet_ema_tao_flow' AND netuid IS NULL AND ema_block IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS emission_flow_watch_item_observed_idx
  ON emission_flow_watch (item, observed_at DESC);

-- --------------------------------------------------------------------------
-- 5. User state -- accounts, keys, quotas, alerts, push subscriptions. Every
--    one of these is written by a request rather than a lane, so none of them
--    has a reconciler: they move by pointing the writer at Neon, and the copy
--    is a one-shot.
-- --------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS github_accounts (
  id             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  github_user_id BIGINT  NOT NULL UNIQUE,
  github_login   TEXT    NOT NULL,
  tier           TEXT    NOT NULL DEFAULT 'free',
  created_at     BIGINT  NOT NULL,
  last_login_at  BIGINT
);

CREATE INDEX IF NOT EXISTS idx_github_accounts_github_user_id
  ON github_accounts (github_user_id);

CREATE TABLE IF NOT EXISTS rpc_accounts (
  id            INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  ss58          TEXT    NOT NULL UNIQUE,
  tier          TEXT    NOT NULL DEFAULT 'free',
  created_at    BIGINT  NOT NULL,
  last_login_at BIGINT
);

CREATE INDEX IF NOT EXISTS idx_rpc_accounts_ss58 ON rpc_accounts (ss58);

CREATE TABLE IF NOT EXISTS api_keys (
  id            INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  prefix        TEXT UNIQUE,
  secret_hash   TEXT,
  owner_contact TEXT    NOT NULL,
  tier          TEXT    NOT NULL DEFAULT 'keyed',
  created_at    BIGINT  NOT NULL,
  revoked_at    BIGINT,
  last_used_at  BIGINT,
  account_id    INTEGER,
  unkey_key_id  TEXT
);

CREATE INDEX IF NOT EXISTS idx_api_keys_prefix ON api_keys (prefix);
CREATE INDEX IF NOT EXISTS idx_api_keys_account_id
  ON api_keys (account_id) WHERE account_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_api_keys_unkey_key_id
  ON api_keys (unkey_key_id) WHERE unkey_key_id IS NOT NULL;

-- The partial unique index is the constraint that matters: one UNBLOCKED row
-- per account, any number of historical ones.
CREATE TABLE IF NOT EXISTS api_key_blocks (
  id             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  account_id     INTEGER NOT NULL,
  reason_code    TEXT    NOT NULL,
  note           TEXT,
  blocked_at     BIGINT  NOT NULL,
  blocked_by     TEXT,
  unblocked_at   BIGINT,
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
  units_spent BIGINT  NOT NULL DEFAULT 0,
  updated_at  BIGINT  NOT NULL,
  PRIMARY KEY (account_id, day)
);

CREATE TABLE IF NOT EXISTS api_usage_rollup (
  day           TEXT    NOT NULL,
  route_family  TEXT    NOT NULL,
  cost_shape    TEXT    NOT NULL,
  request_count BIGINT  NOT NULL DEFAULT 0,
  keyed_count   BIGINT  NOT NULL DEFAULT 0,
  PRIMARY KEY (day, route_family, cost_shape)
);

CREATE INDEX IF NOT EXISTS idx_api_usage_rollup_day
  ON api_usage_rollup (day DESC, request_count DESC);
CREATE INDEX IF NOT EXISTS idx_api_usage_rollup_shape
  ON api_usage_rollup (cost_shape, day DESC);

CREATE TABLE IF NOT EXISTS chain_alert_triggers (
  id              INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  owner_token     TEXT    NOT NULL,
  name            TEXT,
  table_filter    TEXT,
  netuid          INTEGER,
  event_kind      TEXT,
  account         TEXT,
  min_amount_tao  DOUBLE PRECISION,
  channel         TEXT    NOT NULL
    CHECK (channel IN ('webhook', 'email', 'telegram', 'discord', 'webpush')),
  destination     TEXT    NOT NULL,
  active          BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      BIGINT  NOT NULL,
  updated_at      BIGINT  NOT NULL,
  last_matched_at BIGINT,
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
  id               INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  trigger_id       INTEGER NOT NULL
    REFERENCES chain_alert_triggers (id) ON DELETE CASCADE,
  delivered_at     BIGINT  NOT NULL,
  success          BOOLEAN NOT NULL,
  status_code      INTEGER,
  retry_count      INTEGER NOT NULL DEFAULT 0,
  response_snippet TEXT
);

CREATE INDEX IF NOT EXISTS idx_cad_trigger_delivered_at
  ON chain_alert_deliveries (trigger_id, delivered_at DESC);

CREATE TABLE IF NOT EXISTS watch_push_subscriptions (
  id            INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  address       TEXT    NOT NULL,
  endpoint      TEXT    NOT NULL UNIQUE,
  p256dh        TEXT    NOT NULL,
  auth          TEXT    NOT NULL,
  user_agent    TEXT,
  created_at    BIGINT  NOT NULL,
  last_used_at  BIGINT
);

CREATE INDEX IF NOT EXISTS idx_wps_address
  ON watch_push_subscriptions (address, created_at DESC);
