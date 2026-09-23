CREATE INDEX _audit_neuron_coldkey_20260922 ON _audit_neuron_members_20260922(coldkey);

CREATE INDEX _audit_neuron_hotkey_20260922 ON _audit_neuron_members_20260922(hotkey);

CREATE INDEX account_position_daily_members_account_snapshot_date_idx ON account_position_daily_members(account,snapshot_date);

CREATE INDEX account_position_daily_members_snapshot_date_netuid_idx ON account_position_daily_members(snapshot_date,netuid);

CREATE INDEX emission_flow_watch_item_observed_idx
  ON emission_flow_watch (item, observed_at DESC);

CREATE INDEX emission_flow_watch_observed_idx ON emission_flow_watch(observed_at DESC);

CREATE INDEX emission_gate_param_history_observed_idx ON emission_gate_param_history(observed_at DESC);

CREATE UNIQUE INDEX emission_gate_param_history_param_observed_at_key ON emission_gate_param_history(param, observed_at);

CREATE INDEX emission_gate_param_history_param_observed_idx
  ON emission_gate_param_history (param, observed_at DESC);

CREATE INDEX idx_account_balances_passes_completed ON account_balances_passes (completed_at DESC);

CREATE INDEX idx_account_identity_history_account_observed ON account_identity_history (account, observed_at DESC, id DESC);

CREATE UNIQUE INDEX idx_api_key_blocks_one_active_per_account
  ON api_key_blocks (account_kind, account_id) WHERE unblocked_at IS NULL;

CREATE INDEX idx_api_key_usage_daily_account_day
  ON api_key_usage_daily (account_kind, account_id, day DESC);

CREATE INDEX idx_api_keys_account_id
  ON api_keys (account_id) WHERE account_id IS NOT NULL;

CREATE INDEX idx_api_keys_prefix ON api_keys (prefix);

CREATE UNIQUE INDEX idx_api_keys_unkey_key_id
  ON api_keys (unkey_key_id) WHERE unkey_key_id IS NOT NULL;

CREATE INDEX idx_api_usage_rollup_day
  ON api_usage_rollup (day DESC, request_count DESC);

CREATE INDEX idx_api_usage_rollup_shape
  ON api_usage_rollup (cost_shape, day DESC);

CREATE INDEX idx_attribution_candidates_last_seen ON attribution_candidates (last_seen DESC);

CREATE INDEX idx_attribution_candidates_netuid_last ON attribution_candidates (netuid, last_seen DESC);

CREATE INDEX idx_attribution_sweeps_swept_at ON attribution_sweeps (swept_at DESC);

CREATE INDEX idx_blocks_head_hash_lower ON blocks_head (lower(block_hash));

CREATE INDEX idx_blocks_head_observed ON blocks_head (observed_at DESC);

CREATE INDEX idx_cad_trigger_delivered_at
  ON chain_alert_deliveries (trigger_id, delivered_at DESC);

CREATE INDEX idx_cat_active
  ON chain_alert_triggers (active) WHERE active;

CREATE INDEX idx_cat_owner_ss58_active
  ON chain_alert_triggers (owner_ss58)
  WHERE owner_ss58 IS NOT NULL AND active;

CREATE INDEX idx_chain_concentration_daily_day ON chain_concentration_daily (day DESC);

CREATE INDEX idx_chain_detail_account_events_coldkey_observed ON chain_detail_account_events (coldkey, observed_at DESC);

CREATE INDEX idx_chain_detail_account_events_extrinsic ON chain_detail_account_events (block_number, extrinsic_index);

CREATE INDEX idx_chain_detail_account_events_hotkey_observed ON chain_detail_account_events (hotkey, observed_at DESC);

CREATE INDEX idx_chain_detail_account_events_observed ON chain_detail_account_events (observed_at);

CREATE INDEX idx_chain_detail_blocks_hash ON chain_detail_blocks (block_hash);

CREATE INDEX idx_chain_detail_chain_events_extrinsic ON chain_detail_chain_events (block_number, extrinsic_index);

CREATE INDEX idx_chain_detail_chain_events_observed ON chain_detail_chain_events (observed_at);

CREATE INDEX idx_chain_detail_extrinsics_hash_lower ON chain_detail_extrinsics (lower(extrinsic_hash));

CREATE INDEX idx_chain_detail_extrinsics_module_observed
 ON chain_detail_extrinsics(call_module, observed_at DESC, block_number DESC, extrinsic_index DESC);

CREATE INDEX idx_chain_detail_extrinsics_observed ON chain_detail_extrinsics (observed_at);

CREATE INDEX idx_compute_declarations_observed_at ON compute_declarations (observed_at DESC);

CREATE INDEX idx_github_accounts_github_user_id
  ON github_accounts (github_user_id);

CREATE INDEX idx_hotkey_alpha_captured ON hotkey_alpha (captured_at);

CREATE INDEX idx_hotkey_alpha_netuid ON hotkey_alpha (netuid, total_alpha DESC);

CREATE INDEX idx_hotkey_alpha_passes_completed ON hotkey_alpha_passes (completed_at DESC);

CREATE INDEX idx_lane_health_gaps ON lane_health_clocks (lane, gap DESC, checked_at DESC, previous_at);

CREATE INDEX idx_lane_health_lane_checked ON lane_health (lane, checked_at DESC);

CREATE INDEX idx_lane_health_stale ON lane_health (checked_at DESC) WHERE verdict = 'stale';

CREATE INDEX idx_lane_health_time ON lane_health (checked_at, lane, verdict);

CREATE INDEX idx_lane_health_verdict ON lane_health (lane, verdict, checked_at);

CREATE INDEX idx_nominator_positions_capture_pool ON nominator_positions(captured_at, hotkey, netuid);

CREATE INDEX idx_nominator_positions_hotkey ON nominator_positions (hotkey, netuid);

CREATE INDEX idx_nominator_positions_passes_completed ON nominator_positions_passes (completed_at DESC);

CREATE INDEX idx_origin_reachability_checked_at ON origin_reachability (checked_at DESC);

CREATE INDEX idx_origin_reachability_verdict ON origin_reachability (verdict, checked_at DESC);

CREATE INDEX idx_revenue_failures_netuid ON revenue_probe_failures (netuid, observed_at DESC);

CREATE INDEX idx_revenue_obs_netuid_period ON revenue_observations (netuid, period DESC);

CREATE INDEX idx_revenue_obs_period ON revenue_observations (period DESC);

CREATE INDEX idx_rpc_accounts_ss58 ON rpc_accounts (ss58);

CREATE INDEX idx_subnet_burn_history_observed ON subnet_burn_history (observed_at);

CREATE INDEX idx_subnet_dereg_daily_date ON subnet_deregistration_daily(snapshot_date DESC);

CREATE INDEX idx_subnet_dereg_daily_netuid_date ON subnet_deregistration_daily(netuid,snapshot_date DESC);

CREATE INDEX idx_subnet_hyperparams_history_netuid_observed ON subnet_hyperparams_history (netuid, observed_at DESC, id DESC);

CREATE INDEX idx_subnet_lifecycle_netuid_time ON subnet_lifecycle (netuid, observed_at DESC);

CREATE INDEX idx_subnet_lifecycle_time ON subnet_lifecycle (observed_at DESC);

CREATE INDEX idx_subnet_snapshots_date_netuid ON subnet_snapshots(snapshot_date,netuid);

CREATE INDEX idx_subnets_source ON subnets (source);

CREATE INDEX idx_surface_checks_netuid_time ON surface_checks(netuid,checked_at DESC);

CREATE INDEX idx_surface_checks_time ON surface_checks(checked_at DESC);

CREATE INDEX idx_surface_failure_day ON surface_failure_daily(day DESC,netuid);

CREATE UNIQUE INDEX idx_surface_failure_key ON surface_failure_daily(day,COALESCE(netuid,-1),kind,classification);

CREATE INDEX idx_surface_history_subnet ON surface_history (subnet_netuid, recorded_at DESC);

CREATE INDEX idx_surface_history_surface ON surface_history (surface_id, recorded_at DESC);

CREATE UNIQUE INDEX idx_surface_status_key ON surface_status(surface_key) WHERE surface_key IS NOT NULL;

CREATE INDEX idx_surface_status_netuid ON surface_status(netuid);

CREATE UNIQUE INDEX idx_surface_uptime_key_day ON surface_uptime_daily(surface_key,day) WHERE surface_key IS NOT NULL;

CREATE INDEX idx_surface_uptime_netuid_day ON surface_uptime_daily(netuid,day DESC);

CREATE INDEX idx_surfaces_probe ON surfaces (probe_eligible, review_state) WHERE probe_eligible;

CREATE INDEX idx_surfaces_provider ON surfaces (provider_id);

CREATE INDEX idx_tao_usd_index_observed ON tao_usd_index (observed_at DESC);

CREATE INDEX idx_treasury_readings_netuid_state ON treasury_readings (netuid, review_state);

CREATE INDEX idx_validator_nominator_counts_passes_completed ON validator_nominator_counts_passes (completed_at DESC);

CREATE INDEX idx_wps_address
  ON watch_push_subscriptions (address, created_at DESC);

CREATE INDEX neuron_daily_axon_pending_idx ON neuron_daily_members(netuid,uid,snapshot_date) WHERE axon_indexed=0;

CREATE INDEX neuron_daily_members_coldkey_idx ON neuron_daily_members(coldkey);

CREATE INDEX neuron_daily_members_hotkey_idx ON neuron_daily_members(hotkey);

CREATE INDEX neuron_daily_members_snapshot_date_netuid_idx ON neuron_daily_members(snapshot_date,netuid);

CREATE INDEX neuron_daily_members_subnet_day_shard_idx ON neuron_daily_members(netuid,snapshot_date DESC,shard,uid,hotkey,coldkey);

CREATE INDEX neurons_members_coldkey_idx ON neurons_members(coldkey);

CREATE INDEX neurons_members_hotkey_idx ON neurons_members(hotkey);

CREATE INDEX neurons_passes_completed_idx ON neurons_passes(completed_at DESC);

CREATE INDEX nominator_positions_coldkey_source_captured_idx ON nominator_positions (coldkey, source, captured_at);

CREATE UNIQUE INDEX root_basket_capture_page_cursors ON root_basket_capture_pages (capture_id,coalesce(start_after,''));

CREATE UNIQUE INDEX root_basket_capture_terminal_page ON root_basket_capture_pages (capture_id) WHERE next_after IS NULL;

CREATE INDEX root_basket_captures_export ON root_basket_captures
  (network, network_genesis_hash, decoder_version, capture_id);

CREATE INDEX root_basket_captures_history ON root_basket_captures (network_genesis_hash, length(finalized_block) DESC, finalized_block DESC);

CREATE INDEX root_basket_fund_address_history ON root_basket_fund_snapshots (hotkey,capture_id);

CREATE UNIQUE INDEX subnet_emission_enabled_history_netuid_observed_at_key ON subnet_emission_enabled_history(netuid, observed_at);

CREATE INDEX subnet_emission_enabled_history_netuid_observed_idx
  ON subnet_emission_enabled_history (netuid, observed_at DESC);

CREATE INDEX subnet_emission_enabled_history_observed_idx ON subnet_emission_enabled_history(observed_at DESC);

CREATE INDEX subnet_identity_captured_at_idx ON subnet_identity (captured_at DESC);

CREATE UNIQUE INDEX subnet_identity_history_netuid_hash_idx ON subnet_identity_history (netuid, identity_hash);

CREATE INDEX subnet_identity_history_netuid_observed_idx ON subnet_identity_history (netuid, observed_at DESC, id DESC);

CREATE INDEX subnet_identity_history_observed_idx ON subnet_identity_history (observed_at DESC, id DESC);

CREATE INDEX subnet_ownership_captured_at_idx ON subnet_ownership (captured_at DESC);

CREATE INDEX subnet_ownership_history_netuid_captured_at_idx ON subnet_ownership_history (netuid, captured_at);

CREATE UNIQUE INDEX subnet_ownership_history_netuid_owner_idx ON subnet_ownership_history (netuid, owner_hotkey, owner_coldkey);

CREATE TABLE _audit_neuron_docs_20260922(netuid INTEGER PRIMARY KEY NOT NULL,payload BLOB NOT NULL,stamp INTEGER NOT NULL);

CREATE TABLE _audit_neuron_members_20260922(netuid INTEGER NOT NULL,uid INTEGER NOT NULL,hotkey TEXT NOT NULL,coldkey TEXT,PRIMARY KEY(netuid,uid)) WITHOUT ROWID;

CREATE TABLE _migration_capture_governance(table_name TEXT NOT NULL,row_key TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(table_name,row_key));

CREATE TABLE _migration_capture_governance_phase(id INTEGER PRIMARY KEY,status TEXT NOT NULL);

CREATE TABLE _migration_user_state(table_name TEXT NOT NULL,row_key TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(table_name,row_key));

CREATE TABLE _migration_user_state_phase(id INTEGER PRIMARY KEY,status TEXT NOT NULL);

CREATE TABLE account_balances(
 ss58 TEXT NOT NULL,
 free_tao REAL NOT NULL,
 reserved_tao REAL NOT NULL,
 captured_at INTEGER NOT NULL,
 PRIMARY KEY (ss58)
) WITHOUT ROWID;

CREATE TABLE account_balances_passes(
 captured_at INTEGER NOT NULL,
 expected_rows INTEGER NOT NULL,
 received_rows INTEGER NOT NULL DEFAULT 0,
 completed_at INTEGER,
 scanned INTEGER,
 outcome TEXT,
 PRIMARY KEY (captured_at)
) WITHOUT ROWID;

CREATE TABLE account_identity(
 account TEXT NOT NULL,
 name TEXT,
 url TEXT,
 github TEXT,
 image TEXT,
 discord TEXT,
 description TEXT,
 additional TEXT,
 captured_at INTEGER NOT NULL,
 PRIMARY KEY (account)
) WITHOUT ROWID;

CREATE TABLE account_identity_history(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 account TEXT NOT NULL,
 observed_at INTEGER NOT NULL,
 name TEXT,
 url TEXT,
 github TEXT,
 image TEXT,
 discord TEXT,
 description TEXT,
 additional TEXT,
 identity_hash TEXT NOT NULL,
 UNIQUE (account, observed_at)
);

CREATE TABLE account_position_daily_documents (
 netuid INTEGER NOT NULL, day TEXT NOT NULL, shard INTEGER NOT NULL,
 stamp INTEGER NOT NULL CHECK(stamp >= 1000000000000),
 payload BLOB NOT NULL CHECK(length(payload) <= 524288 AND json_valid(payload,8)),
 PRIMARY KEY(netuid,day,shard)
) WITHOUT ROWID;

CREATE TABLE account_position_daily_members (account TEXT NOT NULL,netuid INTEGER NOT NULL,snapshot_date TEXT NOT NULL,shard INTEGER NOT NULL,PRIMARY KEY(account,netuid,snapshot_date)) WITHOUT ROWID;

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

CREATE TABLE api_key_usage_daily (
  account_id     INTEGER NOT NULL,
  day            TEXT    NOT NULL,
  route          TEXT    NOT NULL,
  request_count  INTEGER NOT NULL DEFAULT 0,
  rejected_count INTEGER NOT NULL DEFAULT 0,
  account_kind TEXT NOT NULL DEFAULT 'rpc' CHECK (account_kind IN ('rpc', 'github')),
  PRIMARY KEY (account_kind, account_id, day, route)
);

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

CREATE TABLE api_quota_daily (
  account_id  INTEGER NOT NULL,
  day         TEXT    NOT NULL,
  units_spent INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL,
  account_kind TEXT NOT NULL DEFAULT 'rpc' CHECK (account_kind IN ('rpc', 'github')),
  PRIMARY KEY (account_kind, account_id, day)
);

CREATE TABLE api_usage_rollup (
  day           TEXT    NOT NULL,
  route_family  TEXT    NOT NULL,
  cost_shape    TEXT    NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0,
  keyed_count   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, route_family, cost_shape)
);

CREATE TABLE archive_export_revisions (
 table_name TEXT PRIMARY KEY NOT NULL,
 revision INTEGER NOT NULL CHECK(revision >= 0)
) WITHOUT ROWID;

CREATE TABLE attribution_candidates (
  netuid INTEGER NOT NULL,
  ss58 TEXT NOT NULL,
  source_url TEXT NOT NULL,
  first_seen INTEGER NOT NULL CHECK (first_seen >= 1000000000000),
  last_seen INTEGER NOT NULL CHECK (last_seen >= 1000000000000),
  PRIMARY KEY (netuid, ss58, source_url)
);

CREATE TABLE attribution_sweeps (
  netuid INTEGER PRIMARY KEY NOT NULL,
  swept_at INTEGER NOT NULL CHECK (swept_at >= 1000000000000),
  sources_checked INTEGER NOT NULL,
  sources_read INTEGER NOT NULL,
  candidates INTEGER NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('none-published', 'candidates-found', 'unreachable', 'no-sources', 'listings-only')),
  CHECK (sources_checked >= 0 AND sources_read >= 0 AND sources_read <= sources_checked AND candidates >= 0)
);

CREATE TABLE blocks_head(
 block_number INTEGER NOT NULL,
 block_hash TEXT NOT NULL,
 parent_hash TEXT,
 extrinsic_count INTEGER,
 event_count INTEGER,
 author TEXT,
 observed_at INTEGER NOT NULL,
 PRIMARY KEY (block_number)
) WITHOUT ROWID;

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

CREATE TABLE chain_concentration_daily(
 day TEXT NOT NULL,
 neuron_count INTEGER NOT NULL,
 card TEXT NOT NULL,
 source_captured_at INTEGER,
 computed_at INTEGER NOT NULL,
 builder_version INTEGER NOT NULL,
 PRIMARY KEY (day)
) WITHOUT ROWID;

CREATE TABLE chain_detail_account_events(
 block_number INTEGER NOT NULL,
 event_index INTEGER NOT NULL,
 extrinsic_index INTEGER,
 event_kind TEXT NOT NULL,
 hotkey TEXT,
 coldkey TEXT,
 netuid INTEGER,
 uid INTEGER,
 amount_tao TEXT,
 alpha_amount TEXT,
 observed_at INTEGER NOT NULL,
 PRIMARY KEY (block_number, event_index)
) WITHOUT ROWID;

CREATE TABLE chain_detail_blocks(
 block_number INTEGER NOT NULL,
 block_hash TEXT NOT NULL,
 spec_version INTEGER,
 extrinsic_count INTEGER NOT NULL,
 chain_event_count INTEGER NOT NULL,
 account_event_count INTEGER NOT NULL,
 observed_at INTEGER NOT NULL,
 synced_at INTEGER NOT NULL,
 native_transfer_tao TEXT,
 stake_flow_tao TEXT,
 economic_activity_tao TEXT,
 fee_tao TEXT,
 tip_tao TEXT,
 issuance_tao TEXT,
 subnet_ids TEXT NOT NULL DEFAULT '[]',
 economics_complete INTEGER NOT NULL DEFAULT 0 CHECK(economics_complete IN(0,1)),
 PRIMARY KEY (block_number)
) WITHOUT ROWID;

CREATE TABLE chain_detail_chain_events(
 block_number INTEGER NOT NULL,
 event_index INTEGER NOT NULL,
 pallet TEXT NOT NULL,
 method TEXT NOT NULL,
 args TEXT,
 phase TEXT NOT NULL,
 extrinsic_index INTEGER,
 observed_at INTEGER NOT NULL,
 PRIMARY KEY (block_number, event_index)
) WITHOUT ROWID;

CREATE TABLE chain_detail_extrinsics(
 block_number INTEGER NOT NULL,
 extrinsic_index INTEGER NOT NULL,
 extrinsic_hash TEXT,
 signer TEXT,
 call_module TEXT,
 call_function TEXT,
 success INTEGER CHECK(success IN(0,1)),
 fee_tao TEXT,
 tip_tao TEXT,
 call_args TEXT,
 observed_at INTEGER NOT NULL,
 PRIMARY KEY (block_number, extrinsic_index)
) WITHOUT ROWID;

CREATE TABLE compute_declarations (
  netuid INTEGER NOT NULL,
  source_url TEXT NOT NULL,
  read_at_sha TEXT NOT NULL,
  observed_at INTEGER NOT NULL CHECK (observed_at >= 1000000000000),
  first_seen INTEGER NOT NULL CHECK (first_seen >= 1000000000000),
  found INTEGER NOT NULL CHECK (found IN (0, 1)),
  spec_version TEXT,
  miner TEXT CHECK (miner IS NULL OR (json_valid(miner) AND json_type(miner) = 'object')),
  validator TEXT CHECK (validator IS NULL OR (json_valid(validator) AND json_type(validator) = 'object')),
  unscoped TEXT CHECK (unscoped IS NULL OR (json_valid(unscoped) AND json_type(unscoped) = 'object')),
  PRIMARY KEY (netuid, source_url),
  CHECK (found = 0 OR miner IS NOT NULL OR validator IS NOT NULL OR unscoped IS NOT NULL),
  CHECK (found = 1 OR (miner IS NULL AND validator IS NULL AND unscoped IS NULL))
);

CREATE TABLE "d1_migrations"(
		id         INTEGER PRIMARY KEY AUTOINCREMENT,
		name       TEXT UNIQUE,
		applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE emission_flow_watch (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  item             TEXT    NOT NULL
    CHECK (item IN ('net_tao_flow_enabled', 'flow_norm_exponent',
                    'tao_flow_cutoff', 'flow_ema_smoothing_factor',
                    'subnet_ema_tao_flow')),
  netuid           INTEGER,
  is_set           INTEGER NOT NULL CHECK (is_set IN (0, 1)),
  ema_block        INTEGER,
  block_number     INTEGER,
  observed_at      INTEGER NOT NULL,
  predates_capture INTEGER NOT NULL DEFAULT 0 CHECK (predates_capture IN (0, 1)),
  CHECK (
    (item = 'subnet_ema_tao_flow' AND netuid IS NOT NULL AND ema_block IS NOT NULL)
    OR (item <> 'subnet_ema_tao_flow' AND netuid IS NULL AND ema_block IS NULL)
  )
);

CREATE TABLE emission_gate_param_history (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  param            TEXT    NOT NULL,
  value            REAL,
  previous_value   REAL,
  source           TEXT    NOT NULL
    CHECK (source IN ('governance', 'runtime_recomputed')),
  block_number     INTEGER,
  observed_at      INTEGER NOT NULL,
  predates_capture INTEGER NOT NULL DEFAULT 0 CHECK (predates_capture IN (0, 1))
);

CREATE TABLE github_accounts (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  github_user_id INTEGER NOT NULL UNIQUE,
  github_login   TEXT    NOT NULL,
  tier           TEXT    NOT NULL DEFAULT 'free',
  created_at     INTEGER NOT NULL,
  last_login_at  INTEGER
);

CREATE TABLE hotkey_alpha(
 hotkey TEXT NOT NULL,
 netuid INTEGER NOT NULL,
 total_alpha REAL NOT NULL,
 captured_at INTEGER NOT NULL,
 PRIMARY KEY (hotkey, netuid)
) WITHOUT ROWID;

CREATE TABLE hotkey_alpha_passes(
 captured_at INTEGER NOT NULL,
 expected_rows INTEGER NOT NULL,
 received_rows INTEGER NOT NULL DEFAULT 0,
 completed_at INTEGER,
 PRIMARY KEY (captured_at)
) WITHOUT ROWID;

CREATE TABLE lane_health (
    lane TEXT NOT NULL,
    verdict TEXT NOT NULL,
    age_ms INTEGER,
    detail TEXT,
    checked_at INTEGER NOT NULL,
    _source_tid TEXT UNIQUE
);

CREATE TABLE lane_health_clocks (
    lane TEXT NOT NULL,
    checked_at INTEGER NOT NULL,
    occurrences INTEGER NOT NULL,
    previous_at INTEGER,
    gap INTEGER GENERATED ALWAYS AS (checked_at - previous_at) STORED,
    PRIMARY KEY (lane, checked_at)
) WITHOUT ROWID;

CREATE TABLE lane_health_current (
    lane TEXT PRIMARY KEY,
    verdict TEXT NOT NULL,
    age_ms INTEGER,
    detail TEXT,
    checked_at INTEGER NOT NULL,
    _history_rowid INTEGER NOT NULL
);

CREATE TABLE lane_health_verdict_latest (
    lane TEXT NOT NULL, verdict TEXT NOT NULL, checked_at INTEGER NOT NULL,
    PRIMARY KEY (lane, verdict)
) WITHOUT ROWID;

CREATE TABLE neuron_daily_documents (
 netuid INTEGER NOT NULL, day TEXT NOT NULL, shard INTEGER NOT NULL,
 stamp INTEGER NOT NULL CHECK(stamp >= 1000000000000),
 payload BLOB NOT NULL CHECK(length(payload) <= 524288 AND json_valid(payload,8)),
 PRIMARY KEY(netuid,day,shard)
) WITHOUT ROWID;

CREATE TABLE neuron_daily_members (netuid INTEGER NOT NULL,uid INTEGER NOT NULL,snapshot_date TEXT NOT NULL,hotkey TEXT,coldkey TEXT,shard INTEGER NOT NULL, axon_index BLOB, axon_indexed INTEGER NOT NULL DEFAULT 0 CHECK(axon_indexed IN (0,1)),PRIMARY KEY(netuid,uid,snapshot_date)) WITHOUT ROWID;

CREATE TABLE neurons_documents (
 netuid INTEGER NOT NULL, day TEXT NOT NULL, shard INTEGER NOT NULL,
 stamp INTEGER NOT NULL CHECK(stamp >= 1000000000000),
 payload BLOB NOT NULL CHECK(length(payload) <= 524288 AND json_valid(payload,8)),
 PRIMARY KEY(netuid,day,shard)
) WITHOUT ROWID;

CREATE TABLE neurons_members (netuid INTEGER NOT NULL,uid INTEGER NOT NULL,hotkey TEXT,coldkey TEXT,shard INTEGER NOT NULL,PRIMARY KEY(netuid,uid)) WITHOUT ROWID;

CREATE TABLE neurons_passes(captured_at INTEGER PRIMARY KEY NOT NULL,expected_rows INTEGER NOT NULL,received_rows INTEGER NOT NULL DEFAULT 0,completed_at INTEGER);

CREATE TABLE nominator_positions(
 coldkey TEXT NOT NULL,
 hotkey TEXT NOT NULL,
 netuid INTEGER NOT NULL,
 share_fraction REAL,
 captured_at INTEGER NOT NULL,
 shares TEXT,
 source TEXT NOT NULL DEFAULT 'alpha',
 PRIMARY KEY (coldkey, hotkey, netuid)
) WITHOUT ROWID;

CREATE TABLE nominator_positions_passes(
 captured_at INTEGER NOT NULL,
 expected_rows INTEGER NOT NULL,
 received_rows INTEGER NOT NULL DEFAULT 0,
 completed_at INTEGER,
 PRIMARY KEY (captured_at)
) WITHOUT ROWID;

CREATE TABLE nominator_scan_receipts(
 captured_at INTEGER NOT NULL,
 coldkey TEXT NOT NULL,
 row_count INTEGER NOT NULL,
 PRIMARY KEY (captured_at, coldkey),
 CHECK ((row_count > 0))
) WITHOUT ROWID;

CREATE TABLE origin_reachability (
  origin TEXT PRIMARY KEY NOT NULL,
  checked_at INTEGER NOT NULL CHECK (checked_at >= 1000000000000),
  surface_count INTEGER NOT NULL CHECK (surface_count >= 0),
  samples INTEGER NOT NULL CHECK (samples >= 0),
  verdict TEXT NOT NULL CHECK (verdict IN ('serving', 'unreachable', 'not-routing', 'indeterminate'))
);

CREATE TABLE providers(
 id TEXT NOT NULL,
 overlay TEXT NOT NULL,
 source_commit TEXT NOT NULL,
 updated_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec')*1000 AS INTEGER)),
 PRIMARY KEY (id)
) WITHOUT ROWID;

CREATE TABLE raw_capture_state (
 network TEXT PRIMARY KEY NOT NULL,
 last_contiguous_block INTEGER NOT NULL,
 updated_at INTEGER NOT NULL,
 stopped_at INTEGER,
 last_error TEXT
);

CREATE TABLE revenue_observations(
 surface_id TEXT NOT NULL,
 netuid INTEGER NOT NULL,
 period TEXT NOT NULL,
 grain TEXT NOT NULL,
 amount REAL NOT NULL,
 currency TEXT NOT NULL,
 provenance TEXT NOT NULL,
 response_hash TEXT NOT NULL,
 observed_at INTEGER NOT NULL,
 CHECK ((observed_at >= 1000000000000)),
 PRIMARY KEY (surface_id, period),
 CHECK ((provenance IN ('probe-derived', 'chain-verified')))
) WITHOUT ROWID;

CREATE TABLE revenue_probe_failures(
 surface_id TEXT NOT NULL,
 netuid INTEGER NOT NULL,
 reason TEXT NOT NULL,
 observed_at INTEGER NOT NULL,
 CHECK ((observed_at >= 1000000000000)),
 PRIMARY KEY (surface_id, observed_at)
) WITHOUT ROWID;

CREATE TABLE root_basket_capture_completions (
  capture_id TEXT NOT NULL PRIMARY KEY REFERENCES root_basket_captures (capture_id) CHECK(length(capture_id) = 36),
  content_sha256 TEXT  NOT NULL CHECK(content_sha256 IS NULL OR (length(content_sha256) = 66 AND substr(content_sha256,1,2) = '0x' AND substr(content_sha256,3) NOT GLOB '*[^0-9a-f]*')),
  accepted_at_ms TEXT  NOT NULL CHECK(accepted_at_ms IS NULL OR (typeof(accepted_at_ms) = 'text' AND (accepted_at_ms = '0' OR (accepted_at_ms GLOB '[1-9]*' AND accepted_at_ms NOT GLOB '*[^0-9]*')) AND (length(accepted_at_ms), accepted_at_ms) <= (20, '18446744073709551615')))
);

CREATE TABLE root_basket_capture_pages (
  capture_id TEXT  NOT NULL REFERENCES root_basket_captures (capture_id) CHECK(length(capture_id) = 36),
  page_index INTEGER  NOT NULL CHECK(typeof(page_index) = 'integer' AND page_index BETWEEN 0 AND 4294967295),
  start_after TEXT  CHECK(start_after IS NULL OR (length(start_after) = 66 AND substr(start_after,1,2) = '0x' AND substr(start_after,3) NOT GLOB '*[^0-9a-f]*')),
  next_after TEXT  CHECK(next_after IS NULL OR (length(next_after) = 66 AND substr(next_after,1,2) = '0x' AND substr(next_after,3) NOT GLOB '*[^0-9a-f]*')),
  response_sha256 TEXT  NOT NULL CHECK(response_sha256 IS NULL OR (length(response_sha256) = 66 AND substr(response_sha256,1,2) = '0x' AND substr(response_sha256,3) NOT GLOB '*[^0-9a-f]*')),
  fund_count INTEGER  NOT NULL CHECK (fund_count <= 256) CHECK(typeof(fund_count) = 'integer' AND fund_count BETWEEN 0 AND 65535),
  PRIMARY KEY (capture_id, page_index),
  CHECK ((page_index = 0) = (start_after IS NULL)),
  CHECK (start_after IS NULL OR next_after IS NULL OR start_after <> next_after)
);

CREATE TABLE root_basket_captures (
  content_sha256 TEXT NOT NULL CHECK(length(content_sha256) = 66 AND substr(content_sha256,1,2) = '0x' AND substr(content_sha256,3) NOT GLOB '*[^0-9a-f]*'),
  capture_id TEXT NOT NULL PRIMARY KEY CHECK(length(capture_id) = 36),
  network TEXT NOT NULL CHECK (network IN ('finney', 'test', 'local')),
  network_genesis_hash TEXT  NOT NULL CHECK(network_genesis_hash IS NULL OR (length(network_genesis_hash) = 66 AND substr(network_genesis_hash,1,2) = '0x' AND substr(network_genesis_hash,3) NOT GLOB '*[^0-9a-f]*')),
  finalized_block_hash TEXT  NOT NULL CHECK(finalized_block_hash IS NULL OR (length(finalized_block_hash) = 66 AND substr(finalized_block_hash,1,2) = '0x' AND substr(finalized_block_hash,3) NOT GLOB '*[^0-9a-f]*')),
  finalized_block TEXT  NOT NULL CHECK(finalized_block IS NULL OR (typeof(finalized_block) = 'text' AND (finalized_block = '0' OR (finalized_block GLOB '[1-9]*' AND finalized_block NOT GLOB '*[^0-9]*')) AND (length(finalized_block), finalized_block) <= (20, '18446744073709551615'))),
  runtime_spec_version INTEGER  NOT NULL CHECK (runtime_spec_version = 454) CHECK(typeof(runtime_spec_version) = 'integer' AND runtime_spec_version BETWEEN 0 AND 4294967295),
  runtime_api_version INTEGER  NOT NULL CHECK (runtime_api_version = 3) CHECK(typeof(runtime_api_version) = 'integer' AND runtime_api_version BETWEEN 0 AND 65535),
  decoder_version TEXT NOT NULL CHECK (decoder_version = 'subtensor-v454-14cde641-v1'),
  metadata_sha256 TEXT  NOT NULL CHECK(metadata_sha256 IS NULL OR (length(metadata_sha256) = 66 AND substr(metadata_sha256,1,2) = '0x' AND substr(metadata_sha256,3) NOT GLOB '*[^0-9a-f]*')),
  started_at_ms TEXT  NOT NULL CHECK(started_at_ms IS NULL OR (typeof(started_at_ms) = 'text' AND (started_at_ms = '0' OR (started_at_ms GLOB '[1-9]*' AND started_at_ms NOT GLOB '*[^0-9]*')) AND (length(started_at_ms), started_at_ms) <= (20, '18446744073709551615'))),
  finished_at_ms TEXT  NOT NULL CHECK ((length(finished_at_ms), finished_at_ms) >= (length(started_at_ms), started_at_ms)) CHECK(finished_at_ms IS NULL OR (typeof(finished_at_ms) = 'text' AND (finished_at_ms = '0' OR (finished_at_ms GLOB '[1-9]*' AND finished_at_ms NOT GLOB '*[^0-9]*')) AND (length(finished_at_ms), finished_at_ms) <= (20, '18446744073709551615'))),
  expected_pages INTEGER  NOT NULL CHECK (expected_pages > 0) CHECK(typeof(expected_pages) = 'integer' AND expected_pages BETWEEN 0 AND 4294967295),
  expected_funds INTEGER  NOT NULL CHECK(typeof(expected_funds) = 'integer' AND expected_funds BETWEEN 0 AND 4294967295),
  index_status TEXT NOT NULL CHECK (index_status IN ('published', 'not_published')),
  index_completed_block TEXT  CHECK(index_completed_block IS NULL OR (typeof(index_completed_block) = 'text' AND (index_completed_block = '0' OR (index_completed_block GLOB '[1-9]*' AND index_completed_block NOT GLOB '*[^0-9]*')) AND (length(index_completed_block), index_completed_block) <= (20, '18446744073709551615'))),
  bag_index_q64_bits TEXT  NOT NULL CHECK(bag_index_q64_bits IS NULL OR (typeof(bag_index_q64_bits) = 'text' AND (bag_index_q64_bits = '0' OR (bag_index_q64_bits GLOB '[1-9]*' AND bag_index_q64_bits NOT GLOB '*[^0-9]*')) AND (length(bag_index_q64_bits), bag_index_q64_bits) <= (39, '340282366920938463463374607431768211455'))),
  stake_index_q64_bits TEXT  NOT NULL CHECK(stake_index_q64_bits IS NULL OR (typeof(stake_index_q64_bits) = 'text' AND (stake_index_q64_bits = '0' OR (stake_index_q64_bits GLOB '[1-9]*' AND stake_index_q64_bits NOT GLOB '*[^0-9]*')) AND (length(stake_index_q64_bits), stake_index_q64_bits) <= (39, '340282366920938463463374607431768211455'))),
  CHECK (
    (index_status = 'published' AND index_completed_block IS NOT NULL AND (length(index_completed_block), index_completed_block) <= (length(finalized_block), finalized_block))
    OR (index_status = 'not_published' AND index_completed_block IS NULL
      AND bag_index_q64_bits = '18446744073709551616' AND stake_index_q64_bits = '18446744073709551616')
  ),
  UNIQUE (network_genesis_hash, finalized_block_hash, decoder_version)
);

CREATE TABLE root_basket_current (
  network_genesis_hash TEXT  NOT NULL CHECK(network_genesis_hash IS NULL OR (length(network_genesis_hash) = 66 AND substr(network_genesis_hash,1,2) = '0x' AND substr(network_genesis_hash,3) NOT GLOB '*[^0-9a-f]*')),
  decoder_version TEXT NOT NULL,
  capture_id TEXT  NOT NULL REFERENCES root_basket_capture_completions (capture_id) CHECK(length(capture_id) = 36),
  PRIMARY KEY (network_genesis_hash, decoder_version)
);

CREATE TABLE root_basket_fund_snapshots (
  capture_id TEXT  NOT NULL CHECK(length(capture_id) = 36),
  hotkey TEXT  NOT NULL CHECK(hotkey IS NULL OR (length(hotkey) = 66 AND substr(hotkey,1,2) = '0x' AND substr(hotkey,3) NOT GLOB '*[^0-9a-f]*')),
  page_index INTEGER  NOT NULL CHECK(typeof(page_index) = 'integer' AND page_index BETWEEN 0 AND 4294967295),
  shares_atomic TEXT  NOT NULL CHECK (shares_atomic <> '0') CHECK(shares_atomic IS NULL OR (typeof(shares_atomic) = 'text' AND (shares_atomic = '0' OR (shares_atomic GLOB '[1-9]*' AND shares_atomic NOT GLOB '*[^0-9]*')) AND (length(shares_atomic), shares_atomic) <= (20, '18446744073709551615'))),
  spot_nav_rao TEXT  NOT NULL CHECK(spot_nav_rao IS NULL OR (typeof(spot_nav_rao) = 'text' AND (spot_nav_rao = '0' OR (spot_nav_rao GLOB '[1-9]*' AND spot_nav_rao NOT GLOB '*[^0-9]*')) AND (length(spot_nav_rao), spot_nav_rao) <= (20, '18446744073709551615'))),
  realizable_nav_rao TEXT  NOT NULL CHECK(realizable_nav_rao IS NULL OR (typeof(realizable_nav_rao) = 'text' AND (realizable_nav_rao = '0' OR (realizable_nav_rao GLOB '[1-9]*' AND realizable_nav_rao NOT GLOB '*[^0-9]*')) AND (length(realizable_nav_rao), realizable_nav_rao) <= (20, '18446744073709551615'))),
  deposited_rao TEXT  NOT NULL CHECK(deposited_rao IS NULL OR (typeof(deposited_rao) = 'text' AND (deposited_rao = '0' OR (deposited_rao GLOB '[1-9]*' AND deposited_rao NOT GLOB '*[^0-9]*')) AND (length(deposited_rao), deposited_rao) <= (20, '18446744073709551615'))),
  redeemed_rao TEXT  NOT NULL CHECK(redeemed_rao IS NULL OR (typeof(redeemed_rao) = 'text' AND (redeemed_rao = '0' OR (redeemed_rao GLOB '[1-9]*' AND redeemed_rao NOT GLOB '*[^0-9]*')) AND (length(redeemed_rao), redeemed_rao) <= (20, '18446744073709551615'))),
  raw_spot_price_q64_bits TEXT  NOT NULL CHECK(raw_spot_price_q64_bits IS NULL OR (typeof(raw_spot_price_q64_bits) = 'text' AND (raw_spot_price_q64_bits = '0' OR (raw_spot_price_q64_bits GLOB '[1-9]*' AND raw_spot_price_q64_bits NOT GLOB '*[^0-9]*')) AND (length(raw_spot_price_q64_bits), raw_spot_price_q64_bits) <= (39, '340282366920938463463374607431768211455'))),
  display_price_q64_bits TEXT  NOT NULL CHECK(display_price_q64_bits IS NULL OR (typeof(display_price_q64_bits) = 'text' AND (display_price_q64_bits = '0' OR (display_price_q64_bits GLOB '[1-9]*' AND display_price_q64_bits NOT GLOB '*[^0-9]*')) AND (length(display_price_q64_bits), display_price_q64_bits) <= (39, '340282366920938463463374607431768211455'))),
  display_shares_q64_bits TEXT  NOT NULL CHECK(display_shares_q64_bits IS NULL OR (typeof(display_shares_q64_bits) = 'text' AND (display_shares_q64_bits = '0' OR (display_shares_q64_bits GLOB '[1-9]*' AND display_shares_q64_bits NOT GLOB '*[^0-9]*')) AND (length(display_shares_q64_bits), display_shares_q64_bits) <= (39, '340282366920938463463374607431768211455'))),
  stake_price_q64_bits TEXT  NOT NULL CHECK(stake_price_q64_bits IS NULL OR (typeof(stake_price_q64_bits) = 'text' AND (stake_price_q64_bits = '0' OR (stake_price_q64_bits GLOB '[1-9]*' AND stake_price_q64_bits NOT GLOB '*[^0-9]*')) AND (length(stake_price_q64_bits), stake_price_q64_bits) <= (39, '340282366920938463463374607431768211455'))),
  staker_twr_q64_bits TEXT  NOT NULL CHECK(staker_twr_q64_bits IS NULL OR (typeof(staker_twr_q64_bits) = 'text' AND (staker_twr_q64_bits = '0' OR (staker_twr_q64_bits GLOB '[1-9]*' AND staker_twr_q64_bits NOT GLOB '*[^0-9]*')) AND (length(staker_twr_q64_bits), staker_twr_q64_bits) <= (39, '340282366920938463463374607431768211455'))),
  pending_entitlement_q64_bits TEXT  NOT NULL CHECK(pending_entitlement_q64_bits IS NULL OR (typeof(pending_entitlement_q64_bits) = 'text' AND (pending_entitlement_q64_bits = '0' OR (pending_entitlement_q64_bits GLOB '[1-9]*' AND pending_entitlement_q64_bits NOT GLOB '*[^0-9]*')) AND (length(pending_entitlement_q64_bits), pending_entitlement_q64_bits) <= (39, '340282366920938463463374607431768211455'))),
  provisional INTEGER  NOT NULL CHECK(provisional IN (0,1)),
  first_block TEXT  NOT NULL CHECK(first_block IS NULL OR (typeof(first_block) = 'text' AND (first_block = '0' OR (first_block GLOB '[1-9]*' AND first_block NOT GLOB '*[^0-9]*')) AND (length(first_block), first_block) <= (20, '18446744073709551615'))),
  price_divisor_q64_bits TEXT  CHECK(price_divisor_q64_bits IS NULL OR (typeof(price_divisor_q64_bits) = 'text' AND (price_divisor_q64_bits = '0' OR (price_divisor_q64_bits GLOB '[1-9]*' AND price_divisor_q64_bits NOT GLOB '*[^0-9]*')) AND (length(price_divisor_q64_bits), price_divisor_q64_bits) <= (39, '340282366920938463463374607431768211455'))),
  rate0_q32_bits TEXT  CHECK(rate0_q32_bits IS NULL OR (CASE WHEN substr(rate0_q32_bits,1,1) = '-' THEN substr(rate0_q32_bits,2) <> '0' AND (typeof(substr(rate0_q32_bits,2)) = 'text' AND (substr(rate0_q32_bits,2) = '0' OR (substr(rate0_q32_bits,2) GLOB '[1-9]*' AND substr(rate0_q32_bits,2) NOT GLOB '*[^0-9]*')) AND (length(substr(rate0_q32_bits,2)), substr(rate0_q32_bits,2)) <= (39, '170141183460469231731687303715884105728')) ELSE typeof(rate0_q32_bits) = 'text' AND (rate0_q32_bits = '0' OR (rate0_q32_bits GLOB '[1-9]*' AND rate0_q32_bits NOT GLOB '*[^0-9]*')) AND (length(rate0_q32_bits), rate0_q32_bits) <= (39, '170141183460469231731687303715884105727') END)),
  tr_splice_q64_bits TEXT  CHECK(tr_splice_q64_bits IS NULL OR (typeof(tr_splice_q64_bits) = 'text' AND (tr_splice_q64_bits = '0' OR (tr_splice_q64_bits GLOB '[1-9]*' AND tr_splice_q64_bits NOT GLOB '*[^0-9]*')) AND (length(tr_splice_q64_bits), tr_splice_q64_bits) <= (39, '340282366920938463463374607431768211455'))),
  holdings_count INTEGER  NOT NULL CHECK(typeof(holdings_count) = 'integer' AND holdings_count BETWEEN 0 AND 4294967295),
  targets_count INTEGER  NOT NULL CHECK(typeof(targets_count) = 'integer' AND targets_count BETWEEN 0 AND 4294967295),
  PRIMARY KEY (capture_id, hotkey),
  FOREIGN KEY (capture_id, page_index) REFERENCES root_basket_capture_pages (capture_id, page_index),
  CHECK (
    (provisional = 1 AND first_block = '0' AND price_divisor_q64_bits IS NULL AND rate0_q32_bits IS NULL AND tr_splice_q64_bits IS NULL)
    OR (provisional = 0 AND first_block <> '0' AND price_divisor_q64_bits IS NOT NULL AND price_divisor_q64_bits <> '0'
      AND rate0_q32_bits IS NOT NULL AND tr_splice_q64_bits IS NOT NULL AND tr_splice_q64_bits <> '0')
  )
);

CREATE TABLE root_basket_holdings (
  capture_id TEXT  NOT NULL CHECK(length(capture_id) = 36),
  hotkey TEXT  NOT NULL CHECK(hotkey IS NULL OR (length(hotkey) = 66 AND substr(hotkey,1,2) = '0x' AND substr(hotkey,3) NOT GLOB '*[^0-9a-f]*')),
  netuid INTEGER  NOT NULL CHECK(typeof(netuid) = 'integer' AND netuid BETWEEN 0 AND 65535),
  quantity_atomic TEXT  NOT NULL CHECK(quantity_atomic IS NULL OR (typeof(quantity_atomic) = 'text' AND (quantity_atomic = '0' OR (quantity_atomic GLOB '[1-9]*' AND quantity_atomic NOT GLOB '*[^0-9]*')) AND (length(quantity_atomic), quantity_atomic) <= (20, '18446744073709551615'))),
  quantity_unit TEXT NOT NULL,
  spot_value_rao TEXT  NOT NULL CHECK(spot_value_rao IS NULL OR (typeof(spot_value_rao) = 'text' AND (spot_value_rao = '0' OR (spot_value_rao GLOB '[1-9]*' AND spot_value_rao NOT GLOB '*[^0-9]*')) AND (length(spot_value_rao), spot_value_rao) <= (20, '18446744073709551615'))),
  realizable_value_rao TEXT  NOT NULL CHECK(realizable_value_rao IS NULL OR (typeof(realizable_value_rao) = 'text' AND (realizable_value_rao = '0' OR (realizable_value_rao GLOB '[1-9]*' AND realizable_value_rao NOT GLOB '*[^0-9]*')) AND (length(realizable_value_rao), realizable_value_rao) <= (20, '18446744073709551615'))),
  PRIMARY KEY (capture_id, hotkey, netuid),
  FOREIGN KEY (capture_id, hotkey) REFERENCES root_basket_fund_snapshots (capture_id, hotkey),
  CHECK ((netuid = 0 AND quantity_unit = 'rao') OR (netuid > 0 AND quantity_unit = 'alpha_atomic'))
);

CREATE TABLE root_basket_targets (
  capture_id TEXT  NOT NULL CHECK(length(capture_id) = 36),
  hotkey TEXT  NOT NULL CHECK(hotkey IS NULL OR (length(hotkey) = 66 AND substr(hotkey,1,2) = '0x' AND substr(hotkey,3) NOT GLOB '*[^0-9a-f]*')),
  netuid INTEGER  NOT NULL CHECK(typeof(netuid) = 'integer' AND netuid BETWEEN 0 AND 65535),
  weight INTEGER  NOT NULL CHECK(typeof(weight) = 'integer' AND weight BETWEEN 0 AND 65535),
  PRIMARY KEY (capture_id, hotkey, netuid),
  FOREIGN KEY (capture_id, hotkey) REFERENCES root_basket_fund_snapshots (capture_id, hotkey)
);

CREATE TABLE rpc_accounts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ss58          TEXT    NOT NULL UNIQUE,
  tier          TEXT    NOT NULL DEFAULT 'free',
  created_at    INTEGER NOT NULL,
  last_login_at INTEGER
);

CREATE TABLE self_health_checks(
 component TEXT NOT NULL,
 checked_at_ms INTEGER NOT NULL,
 ok INTEGER NOT NULL CHECK(ok IN (0,1)),
 http_status INTEGER,
 latency_ms INTEGER,
 PRIMARY KEY (component, checked_at_ms)
) WITHOUT ROWID;

CREATE TABLE self_health_daily(
 day TEXT NOT NULL,
 component TEXT NOT NULL,
 checks INTEGER NOT NULL,
 ok_count INTEGER NOT NULL,
 PRIMARY KEY (day, component)
) WITHOUT ROWID;

CREATE TABLE subnet_burn_history(
 netuid INTEGER NOT NULL,
 observed_at INTEGER NOT NULL,
 burn_tao REAL NOT NULL,
 PRIMARY KEY (netuid, observed_at)
) WITHOUT ROWID;

CREATE TABLE subnet_deregistration_daily (
 netuid INTEGER NOT NULL,
 snapshot_date TEXT NOT NULL,
 moving_price REAL,
 registered_at_block INTEGER,
 subnet_mechanism INTEGER,
 network_immunity_period INTEGER,
 pinned_block INTEGER,
 captured_at INTEGER NOT NULL CHECK(captured_at >= 1000000000000),
 PRIMARY KEY(netuid, snapshot_date)
);

CREATE TABLE subnet_emission_enabled_history (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  netuid           INTEGER NOT NULL,
  enabled          INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  previous_enabled INTEGER CHECK (previous_enabled IN (0, 1)),
  block_number     INTEGER,
  observed_at      INTEGER NOT NULL,
  predates_capture INTEGER NOT NULL DEFAULT 0 CHECK (predates_capture IN (0, 1))
);

CREATE TABLE subnet_hyperparams(
 netuid INTEGER NOT NULL,
 kappa_ratio REAL,
 immunity_period INTEGER,
 min_allowed_weights INTEGER,
 max_weight_limit_ratio REAL,
 tempo INTEGER,
 weights_version TEXT,
 weights_rate_limit REAL,
 activity_cutoff INTEGER,
 activity_cutoff_factor INTEGER,
 registration_allowed INTEGER CHECK (registration_allowed IN (0,1)),
 target_regs_per_interval INTEGER,
 min_burn_tao REAL,
 max_burn_tao REAL,
 burn_half_life INTEGER,
 burn_increase_mult REAL,
 bonds_moving_avg_raw TEXT,
 max_regs_per_block INTEGER,
 serving_rate_limit INTEGER,
 max_validators INTEGER,
 commit_reveal_period INTEGER,
 commit_reveal_enabled INTEGER CHECK (commit_reveal_enabled IN (0,1)),
 alpha_high_ratio REAL,
 alpha_low_ratio REAL,
 liquid_alpha_enabled INTEGER CHECK (liquid_alpha_enabled IN (0,1)),
 alpha_sigmoid_steepness REAL,
 yuma_version INTEGER,
 subnet_is_active INTEGER CHECK (subnet_is_active IN (0,1)),
 transfers_enabled INTEGER CHECK (transfers_enabled IN (0,1)),
 bonds_reset_enabled INTEGER CHECK (bonds_reset_enabled IN (0,1)),
 user_liquidity_enabled INTEGER CHECK (user_liquidity_enabled IN (0,1)),
 owner_cut_enabled INTEGER CHECK (owner_cut_enabled IN (0,1)),
 owner_cut_auto_lock_enabled INTEGER CHECK (owner_cut_auto_lock_enabled IN (0,1)),
 min_childkey_take_ratio REAL,
 block_number INTEGER,
 captured_at INTEGER NOT NULL,
 PRIMARY KEY (netuid)
) WITHOUT ROWID;

CREATE TABLE subnet_hyperparams_history(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 netuid INTEGER NOT NULL,
 block_number INTEGER,
 observed_at INTEGER NOT NULL,
 kappa_ratio REAL,
 immunity_period INTEGER,
 min_allowed_weights INTEGER,
 max_weight_limit_ratio REAL,
 tempo INTEGER,
 weights_version TEXT,
 weights_rate_limit REAL,
 activity_cutoff INTEGER,
 activity_cutoff_factor INTEGER,
 registration_allowed INTEGER CHECK (registration_allowed IN (0,1)),
 target_regs_per_interval INTEGER,
 min_burn_tao REAL,
 max_burn_tao REAL,
 burn_half_life INTEGER,
 burn_increase_mult REAL,
 bonds_moving_avg_raw TEXT,
 max_regs_per_block INTEGER,
 serving_rate_limit INTEGER,
 max_validators INTEGER,
 commit_reveal_period INTEGER,
 commit_reveal_enabled INTEGER CHECK (commit_reveal_enabled IN (0,1)),
 alpha_high_ratio REAL,
 alpha_low_ratio REAL,
 liquid_alpha_enabled INTEGER CHECK (liquid_alpha_enabled IN (0,1)),
 alpha_sigmoid_steepness REAL,
 yuma_version INTEGER,
 subnet_is_active INTEGER CHECK (subnet_is_active IN (0,1)),
 transfers_enabled INTEGER CHECK (transfers_enabled IN (0,1)),
 bonds_reset_enabled INTEGER CHECK (bonds_reset_enabled IN (0,1)),
 user_liquidity_enabled INTEGER CHECK (user_liquidity_enabled IN (0,1)),
 owner_cut_enabled INTEGER CHECK (owner_cut_enabled IN (0,1)),
 owner_cut_auto_lock_enabled INTEGER CHECK (owner_cut_auto_lock_enabled IN (0,1)),
 min_childkey_take_ratio REAL,
 hyperparams_hash TEXT NOT NULL,
 UNIQUE (netuid, observed_at)
);

CREATE TABLE subnet_identity(
 netuid INTEGER NOT NULL,
 block_number INTEGER NOT NULL,
 captured_at INTEGER NOT NULL,
 subnet_name TEXT,
 symbol TEXT,
 description TEXT,
 github_repo TEXT,
 subnet_url TEXT,
 discord TEXT,
 logo_url TEXT,
 identity_hash TEXT,
 PRIMARY KEY (netuid)
) WITHOUT ROWID;

CREATE TABLE subnet_identity_history(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 netuid INTEGER NOT NULL,
 block_number INTEGER NOT NULL,
 observed_at INTEGER NOT NULL,
 subnet_name TEXT,
 symbol TEXT,
 description TEXT,
 github_repo TEXT,
 subnet_url TEXT,
 discord TEXT,
 logo_url TEXT,
 identity_hash TEXT NOT NULL
);

CREATE TABLE subnet_lifecycle(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 netuid INTEGER NOT NULL,
 event TEXT NOT NULL,
 block_number INTEGER,
 observed_at INTEGER NOT NULL,
 predates_capture INTEGER NOT NULL DEFAULT 0 CHECK (predates_capture IN (0,1)), _invalidated_at INTEGER, _invalidation_reason TEXT,
 CHECK(event IN ('registered','deregistered')),
 CHECK(observed_at>=1000000000000)
);

CREATE TABLE subnet_ownership(
 netuid INTEGER NOT NULL,
 owner_hotkey TEXT NOT NULL,
 owner_coldkey TEXT NOT NULL,
 captured_at INTEGER NOT NULL,
 PRIMARY KEY (netuid)
) WITHOUT ROWID;

CREATE TABLE subnet_ownership_history(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 netuid INTEGER NOT NULL,
 owner_hotkey TEXT NOT NULL,
 owner_coldkey TEXT NOT NULL,
 captured_at INTEGER NOT NULL
);

CREATE TABLE subnet_snapshots(
 netuid INTEGER NOT NULL,
 snapshot_date TEXT NOT NULL,
 completeness_score INTEGER,
 surface_count INTEGER,
 endpoint_count INTEGER,
 monitored_count INTEGER,
 candidate_count INTEGER,
 captured_at INTEGER,
 validator_count INTEGER,
 miner_count INTEGER,
 total_stake_tao REAL,
 alpha_price_tao REAL,
 emission_share REAL,
 tao_in_pool_tao REAL,
 alpha_in_pool REAL,
 alpha_out_pool REAL,
 subnet_volume_tao REAL,
 tao_in_emission_tao REAL,
 excess_tao REAL,
 alpha_in_emission REAL,
 alpha_out_emission REAL,
 miner_burned_fraction REAL,
 emission_enabled INTEGER CHECK (emission_enabled IN (0,1)),
 subtoken_enabled INTEGER CHECK (subtoken_enabled IN (0,1)),
 first_emission_block INTEGER,
 pipeline_block INTEGER,
 pipeline_block_hash TEXT,
 PRIMARY KEY(netuid,snapshot_date)
) WITHOUT ROWID;

CREATE TABLE subnets(
 netuid INTEGER NOT NULL,
 slug TEXT NOT NULL,
 name TEXT NOT NULL,
 source TEXT NOT NULL DEFAULT 'community',
 overlay TEXT NOT NULL,
 source_commit TEXT NOT NULL,
 updated_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec')*1000 AS INTEGER)),
 PRIMARY KEY (netuid),
 UNIQUE (slug)
) WITHOUT ROWID;

CREATE TABLE surface_checks(
 surface_id TEXT NOT NULL,
 surface_key TEXT,
 netuid INTEGER,
 kind TEXT,
 status TEXT,
 classification TEXT,
 latency_ms INTEGER,
 status_code INTEGER,
 ok INTEGER CHECK (ok IN (0,1)),
 checked_at INTEGER NOT NULL,
 PRIMARY KEY(surface_id,checked_at)
) WITHOUT ROWID;

CREATE TABLE surface_failure_daily(
 day TEXT NOT NULL,
 netuid INTEGER,
 kind TEXT NOT NULL,
 classification TEXT NOT NULL,
 checks INTEGER NOT NULL,
 updated_at INTEGER NOT NULL
);

CREATE TABLE surface_history(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 surface_id TEXT,
 subnet_netuid INTEGER NOT NULL,
 action TEXT NOT NULL,
 overlay TEXT NOT NULL,
 source_commit TEXT NOT NULL,
 recorded_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec')*1000 AS INTEGER))
);

CREATE TABLE surface_status(
 surface_id TEXT NOT NULL,
 surface_key TEXT,
 netuid INTEGER,
 kind TEXT,
 url TEXT,
 provider TEXT,
 status TEXT,
 classification TEXT,
 latency_ms INTEGER,
 status_code INTEGER,
 last_checked INTEGER,
 last_ok INTEGER,
 consecutive_failures INTEGER NOT NULL DEFAULT 0,
 updated_at INTEGER,
 PRIMARY KEY(surface_id)
) WITHOUT ROWID;

CREATE TABLE surface_uptime_daily(
 surface_id TEXT NOT NULL,
 surface_key TEXT,
 netuid INTEGER,
 day TEXT NOT NULL,
 samples INTEGER NOT NULL,
 ok_count INTEGER NOT NULL,
 uptime_ratio REAL,
 avg_latency_ms INTEGER,
 status TEXT,
 latency_samples INTEGER,
 p50_latency_ms INTEGER,
 p95_latency_ms INTEGER,
 p99_latency_ms INTEGER,
 updated_at INTEGER,
 PRIMARY KEY(surface_id,day)
) WITHOUT ROWID;

CREATE TABLE surfaces(
 id TEXT NOT NULL,
 subnet_netuid INTEGER NOT NULL,
 provider_id TEXT,
 surface_key TEXT NOT NULL,
 kind TEXT NOT NULL,
 url TEXT NOT NULL,
 authority TEXT NOT NULL DEFAULT 'community',
 review_state TEXT NOT NULL DEFAULT 'community-submitted',
 probe_eligible INTEGER NOT NULL DEFAULT 0 CHECK(probe_eligible IN (0,1)),
 public_safe INTEGER NOT NULL DEFAULT 1 CHECK(public_safe IN (0,1)),
 overlay TEXT NOT NULL,
 source_commit TEXT NOT NULL,
 updated_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec')*1000 AS INTEGER)),
 PRIMARY KEY (id),
 UNIQUE (subnet_netuid, kind, url)
) WITHOUT ROWID;

CREATE TABLE tao_usd_index(
 block_number INTEGER NOT NULL,
 observed_at INTEGER NOT NULL,
 usd_per_tao REAL,
 price_basis TEXT NOT NULL,
 eth_usd REAL,
 pool_count INTEGER NOT NULL,
 pools TEXT NOT NULL DEFAULT '[]',
 CHECK ((((price_basis = 'insufficient_pools') AND (usd_per_tao IS NULL)) OR ((price_basis <> 'insufficient_pools') AND (usd_per_tao IS NOT NULL)))),
 PRIMARY KEY (block_number, observed_at),
 CHECK ((pool_count >= 0)),
 CHECK ((price_basis IN ('wrapped_onchain_median', 'insufficient_pools')))
) WITHOUT ROWID;

CREATE TABLE treasury_readings(
 netuid INTEGER NOT NULL,
 source_url TEXT NOT NULL,
 read_at_sha TEXT NOT NULL,
 observed_at INTEGER NOT NULL,
 first_seen INTEGER NOT NULL,
 found INTEGER NOT NULL CHECK (found IN (0,1)),
 declared_share REAL,
 treasury_address TEXT,
 applies_to TEXT,
 evidence_path TEXT,
 review_state TEXT NOT NULL DEFAULT 'candidate',
 reviewed_at INTEGER,
 CHECK (((found = false) OR (declared_share IS NOT NULL) OR (treasury_address IS NOT NULL))),
 CHECK ((first_seen >= 1000000000000)),
 CHECK (((found = true) OR ((declared_share IS NULL) AND (treasury_address IS NULL)))),
 CHECK ((observed_at >= 1000000000000)),
 PRIMARY KEY (netuid, source_url),
 CHECK ((review_state IN ('candidate', 'reviewed', 'rejected'))),
 CHECK (((declared_share IS NULL) OR ((declared_share >= (0)) AND (declared_share <= (1)))))
) WITHOUT ROWID;

CREATE TABLE validator_nominator_counts(
 hotkey TEXT NOT NULL,
 nominator_count INTEGER NOT NULL,
 captured_at INTEGER NOT NULL,
 PRIMARY KEY (hotkey)
) WITHOUT ROWID;

CREATE TABLE validator_nominator_counts_passes(
 captured_at INTEGER NOT NULL,
 expected_rows INTEGER NOT NULL,
 received_rows INTEGER NOT NULL DEFAULT 0,
 completed_at INTEGER,
 PRIMARY KEY (captured_at)
) WITHOUT ROWID;

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

CREATE TRIGGER lane_health_clocks_delete AFTER DELETE ON lane_health BEGIN
    UPDATE lane_health_clocks SET occurrences = occurrences - 1 WHERE lane = OLD.lane AND checked_at = OLD.checked_at;
    DELETE FROM lane_health_clocks WHERE lane = OLD.lane AND checked_at = OLD.checked_at AND occurrences = 0;
    UPDATE lane_health_clocks SET previous_at =
        (SELECT MAX(checked_at) FROM lane_health_clocks WHERE lane = OLD.lane AND checked_at < OLD.checked_at)
    WHERE lane = OLD.lane AND previous_at = OLD.checked_at
        AND NOT EXISTS (SELECT 1 FROM lane_health_clocks WHERE lane = OLD.lane AND checked_at = OLD.checked_at);

    DELETE FROM lane_health_verdict_latest WHERE lane = OLD.lane AND verdict = OLD.verdict AND checked_at = OLD.checked_at;
    INSERT INTO lane_health_verdict_latest (lane, verdict, checked_at)
    SELECT lane, verdict, MAX(checked_at) FROM lane_health WHERE lane = OLD.lane AND verdict = OLD.verdict GROUP BY lane, verdict
    ON CONFLICT(lane, verdict) DO UPDATE SET checked_at = excluded.checked_at
    WHERE excluded.checked_at > lane_health_verdict_latest.checked_at;
END;

CREATE TRIGGER lane_health_clocks_insert AFTER INSERT ON lane_health BEGIN
    INSERT INTO lane_health_clocks (lane, checked_at, occurrences, previous_at)
    VALUES (NEW.lane, NEW.checked_at, 1,
        (SELECT MAX(checked_at) FROM lane_health_clocks WHERE lane = NEW.lane AND checked_at < NEW.checked_at))
    ON CONFLICT(lane, checked_at) DO UPDATE SET occurrences = occurrences + 1;
    UPDATE lane_health_clocks SET previous_at = NEW.checked_at
    WHERE lane = NEW.lane AND checked_at = (SELECT MIN(checked_at) FROM lane_health_clocks WHERE lane = NEW.lane AND checked_at > NEW.checked_at)
        AND previous_at IS NOT NEW.checked_at;

    INSERT INTO lane_health_verdict_latest (lane, verdict, checked_at) VALUES (NEW.lane, NEW.verdict, NEW.checked_at)
    ON CONFLICT(lane, verdict) DO UPDATE SET checked_at = excluded.checked_at
    WHERE excluded.checked_at > lane_health_verdict_latest.checked_at;
END;

CREATE TRIGGER lane_health_clocks_update AFTER UPDATE OF lane, checked_at ON lane_health
WHEN OLD.lane IS NOT NEW.lane OR OLD.checked_at IS NOT NEW.checked_at BEGIN
    UPDATE lane_health_clocks SET occurrences = occurrences - 1 WHERE lane = OLD.lane AND checked_at = OLD.checked_at;
    DELETE FROM lane_health_clocks WHERE lane = OLD.lane AND checked_at = OLD.checked_at AND occurrences = 0;
    UPDATE lane_health_clocks SET previous_at =
        (SELECT MAX(checked_at) FROM lane_health_clocks WHERE lane = OLD.lane AND checked_at < OLD.checked_at)
    WHERE lane = OLD.lane AND previous_at = OLD.checked_at
        AND NOT EXISTS (SELECT 1 FROM lane_health_clocks WHERE lane = OLD.lane AND checked_at = OLD.checked_at);

    INSERT INTO lane_health_clocks (lane, checked_at, occurrences, previous_at)
    VALUES (NEW.lane, NEW.checked_at, 1,
        (SELECT MAX(checked_at) FROM lane_health_clocks WHERE lane = NEW.lane AND checked_at < NEW.checked_at))
    ON CONFLICT(lane, checked_at) DO UPDATE SET occurrences = occurrences + 1;
    UPDATE lane_health_clocks SET previous_at = NEW.checked_at
    WHERE lane = NEW.lane AND checked_at = (SELECT MIN(checked_at) FROM lane_health_clocks WHERE lane = NEW.lane AND checked_at > NEW.checked_at)
        AND previous_at IS NOT NEW.checked_at;
END;

CREATE TRIGGER lane_health_current_delete AFTER DELETE ON lane_health
WHEN EXISTS (SELECT 1 FROM lane_health_current WHERE _history_rowid = OLD.rowid AND lane = OLD.lane) BEGIN
    DELETE FROM lane_health_current WHERE lane = OLD.lane;
    INSERT INTO lane_health_current (lane, verdict, age_ms, detail, checked_at, _history_rowid)
    SELECT lane, verdict, age_ms, detail, checked_at, rowid FROM lane_health WHERE lane = OLD.lane
    ORDER BY checked_at DESC, CASE verdict WHEN 'stale' THEN 2 WHEN 'ok' THEN 0 ELSE 1 END DESC, rowid LIMIT 1;
END;

CREATE TRIGGER lane_health_current_insert AFTER INSERT ON lane_health BEGIN
    INSERT INTO lane_health_current (lane, verdict, age_ms, detail, checked_at, _history_rowid)
    VALUES (NEW.lane, NEW.verdict, NEW.age_ms, NEW.detail, NEW.checked_at, NEW.rowid)
    ON CONFLICT(lane) DO UPDATE SET verdict=excluded.verdict, age_ms=excluded.age_ms,
        detail=excluded.detail, checked_at=excluded.checked_at, _history_rowid=excluded._history_rowid
    WHERE excluded.checked_at > lane_health_current.checked_at OR
        (excluded.checked_at = lane_health_current.checked_at AND
            CASE excluded.verdict WHEN 'stale' THEN 2 WHEN 'ok' THEN 0 ELSE 1 END >
            CASE lane_health_current.verdict WHEN 'stale' THEN 2 WHEN 'ok' THEN 0 ELSE 1 END);
END;

CREATE TRIGGER lane_health_current_update AFTER UPDATE ON lane_health BEGIN
    DELETE FROM lane_health_current WHERE lane IN (OLD.lane, NEW.lane);
    INSERT INTO lane_health_current (lane, verdict, age_ms, detail, checked_at, _history_rowid)
    SELECT lane, verdict, age_ms, detail, checked_at, history_rowid FROM (
        SELECT lane, verdict, age_ms, detail, checked_at, rowid AS history_rowid,
               ROW_NUMBER() OVER (PARTITION BY lane ORDER BY checked_at DESC,
                   CASE verdict WHEN 'stale' THEN 2 WHEN 'ok' THEN 0 ELSE 1 END DESC, rowid) AS position
        FROM lane_health WHERE lane IN (OLD.lane, NEW.lane)
    ) WHERE position = 1;
END;

CREATE TRIGGER lane_health_verdict_update AFTER UPDATE OF lane, verdict, checked_at ON lane_health
WHEN OLD.lane IS NOT NEW.lane OR OLD.verdict IS NOT NEW.verdict OR OLD.checked_at IS NOT NEW.checked_at BEGIN
    DELETE FROM lane_health_verdict_latest WHERE lane = OLD.lane AND verdict = OLD.verdict AND checked_at = OLD.checked_at;
    INSERT INTO lane_health_verdict_latest (lane, verdict, checked_at)
    SELECT lane, verdict, MAX(checked_at) FROM lane_health WHERE lane = OLD.lane AND verdict = OLD.verdict GROUP BY lane, verdict
    ON CONFLICT(lane, verdict) DO UPDATE SET checked_at = excluded.checked_at
    WHERE excluded.checked_at > lane_health_verdict_latest.checked_at;

    INSERT INTO lane_health_verdict_latest (lane, verdict, checked_at) VALUES (NEW.lane, NEW.verdict, NEW.checked_at)
    ON CONFLICT(lane, verdict) DO UPDATE SET checked_at = excluded.checked_at
    WHERE excluded.checked_at > lane_health_verdict_latest.checked_at;
END;

CREATE TRIGGER neuron_daily_axon_document_insert AFTER INSERT ON neuron_daily_documents
BEGIN
 UPDATE neuron_daily_members SET axon_index=json_extract(NEW.payload,'$."'||uid||'".axon'),axon_indexed=1
 WHERE netuid=NEW.netuid AND snapshot_date=NEW.day AND shard=NEW.shard;
END;

CREATE TRIGGER neuron_daily_axon_document_update AFTER UPDATE OF payload ON neuron_daily_documents
BEGIN
 UPDATE neuron_daily_members SET axon_index=json_extract(NEW.payload,'$."'||uid||'".axon'),axon_indexed=1
 WHERE netuid=NEW.netuid AND snapshot_date=NEW.day AND shard=NEW.shard
 AND (axon_indexed=0 OR axon_index IS NOT json_extract(NEW.payload,'$."'||uid||'".axon'));
END;

CREATE TRIGGER neuron_daily_axon_member_insert AFTER INSERT ON neuron_daily_members
BEGIN
 UPDATE neuron_daily_members SET
 axon_index=(SELECT json_extract(d.payload,'$."'||NEW.uid||'".axon') FROM neuron_daily_documents d WHERE d.netuid=NEW.netuid AND d.day=NEW.snapshot_date AND d.shard=NEW.shard),
 axon_indexed=1
 WHERE netuid=NEW.netuid AND uid=NEW.uid AND snapshot_date=NEW.snapshot_date
 AND EXISTS(SELECT 1 FROM neuron_daily_documents d WHERE d.netuid=NEW.netuid AND d.day=NEW.snapshot_date AND d.shard=NEW.shard);
END;

CREATE TRIGGER neuron_daily_axon_member_move AFTER UPDATE OF netuid,uid,snapshot_date,shard ON neuron_daily_members
BEGIN
 UPDATE neuron_daily_members SET
 axon_index=(SELECT json_extract(d.payload,'$."'||NEW.uid||'".axon') FROM neuron_daily_documents d WHERE d.netuid=NEW.netuid AND d.day=NEW.snapshot_date AND d.shard=NEW.shard),
 axon_indexed=CASE WHEN EXISTS(SELECT 1 FROM neuron_daily_documents d WHERE d.netuid=NEW.netuid AND d.day=NEW.snapshot_date AND d.shard=NEW.shard) THEN 1 ELSE 0 END
 WHERE netuid=NEW.netuid AND uid=NEW.uid AND snapshot_date=NEW.snapshot_date;
END;

CREATE TRIGGER root_basket_capture_pages_immutable_delete BEFORE DELETE ON root_basket_capture_pages
 WHEN EXISTS (SELECT 1 FROM root_basket_capture_completions WHERE capture_id IN (OLD.capture_id))
 BEGIN SELECT RAISE(ABORT,'completed root basket observation is immutable'); END;

CREATE TRIGGER root_basket_capture_pages_immutable_insert BEFORE INSERT ON root_basket_capture_pages
 WHEN EXISTS (SELECT 1 FROM root_basket_capture_completions WHERE capture_id IN (NEW.capture_id))
 BEGIN SELECT RAISE(ABORT,'completed root basket observation is immutable'); END;

CREATE TRIGGER root_basket_capture_pages_immutable_update BEFORE UPDATE ON root_basket_capture_pages
 WHEN EXISTS (SELECT 1 FROM root_basket_capture_completions WHERE capture_id IN (OLD.capture_id,NEW.capture_id))
 BEGIN SELECT RAISE(ABORT,'completed root basket observation is immutable'); END;

CREATE TRIGGER root_basket_captures_immutable_delete BEFORE DELETE ON root_basket_captures
 WHEN EXISTS (SELECT 1 FROM root_basket_capture_completions WHERE capture_id IN (OLD.capture_id))
 BEGIN SELECT RAISE(ABORT,'completed root basket observation is immutable'); END;

CREATE TRIGGER root_basket_captures_immutable_update BEFORE UPDATE ON root_basket_captures
 WHEN EXISTS (SELECT 1 FROM root_basket_capture_completions WHERE capture_id IN (OLD.capture_id,NEW.capture_id))
 BEGIN SELECT RAISE(ABORT,'completed root basket observation is immutable'); END;

CREATE TRIGGER root_basket_check_completion BEFORE INSERT ON root_basket_capture_completions BEGIN
 SELECT RAISE(ABORT,'root basket persisted capture is incomplete') WHERE NOT EXISTS (SELECT 1 FROM root_basket_captures WHERE capture_id = NEW.capture_id AND content_sha256 = NEW.content_sha256)
 OR EXISTS (SELECT 1 FROM root_basket_captures m WHERE m.capture_id = NEW.capture_id AND (
   (SELECT count(*) FROM root_basket_capture_pages WHERE capture_id = m.capture_id) <> m.expected_pages
   OR (SELECT count(*) FROM root_basket_fund_snapshots WHERE capture_id = m.capture_id) <> m.expected_funds
   OR EXISTS (SELECT 1 FROM root_basket_capture_pages p LEFT JOIN root_basket_capture_pages previous ON previous.capture_id = p.capture_id AND previous.page_index = p.page_index - 1
     WHERE p.capture_id = m.capture_id AND (p.page_index >= m.expected_pages
       OR (p.page_index = m.expected_pages - 1) <> (p.next_after IS NULL)
       OR (p.page_index > 0 AND (previous.page_index IS NULL OR p.start_after IS NOT previous.next_after))
       OR p.fund_count <> (SELECT count(*) FROM root_basket_fund_snapshots f WHERE f.capture_id = m.capture_id AND f.page_index = p.page_index)))
   OR EXISTS (SELECT 1 FROM root_basket_fund_snapshots f WHERE f.capture_id = m.capture_id AND (
     (length(f.first_block), f.first_block) > (length(m.finalized_block), m.finalized_block)
     OR f.holdings_count <> (SELECT count(*) FROM root_basket_holdings h WHERE h.capture_id = m.capture_id AND h.hotkey = f.hotkey)
     OR f.targets_count <> (SELECT count(*) FROM root_basket_targets t WHERE t.capture_id = m.capture_id AND t.hotkey = f.hotkey)))));
END;

CREATE TRIGGER root_basket_check_replay BEFORE INSERT ON root_basket_captures BEGIN
 SELECT RAISE(ABORT,'ROOT_BASKET_CAPTURE_CONFLICT: attempt ID already belongs to another observation') WHERE EXISTS (SELECT 1 FROM root_basket_captures WHERE capture_id = NEW.capture_id
   AND (network_genesis_hash <> NEW.network_genesis_hash OR finalized_block_hash <> NEW.finalized_block_hash OR decoder_version <> NEW.decoder_version));
 SELECT RAISE(ABORT,'ROOT_BASKET_CAPTURE_CONFLICT: finalized height has a different hash') WHERE EXISTS (SELECT 1 FROM root_basket_captures WHERE network_genesis_hash = NEW.network_genesis_hash
   AND decoder_version = NEW.decoder_version AND finalized_block = NEW.finalized_block AND finalized_block_hash <> NEW.finalized_block_hash);
 SELECT RAISE(ABORT,'ROOT_BASKET_CAPTURE_CONFLICT: observation is incomplete or content differs') WHERE EXISTS (SELECT 1 FROM root_basket_captures c LEFT JOIN root_basket_capture_completions r ON r.capture_id = c.capture_id
   WHERE c.network_genesis_hash = NEW.network_genesis_hash AND c.finalized_block_hash = NEW.finalized_block_hash AND c.decoder_version = NEW.decoder_version
   AND (r.capture_id IS NULL OR r.content_sha256 <> NEW.content_sha256));
END;

CREATE TRIGGER root_basket_completion_immutable_delete BEFORE DELETE ON root_basket_capture_completions BEGIN SELECT RAISE(ABORT,'root basket completion is immutable'); END;

CREATE TRIGGER root_basket_completion_immutable_update BEFORE UPDATE ON root_basket_capture_completions BEGIN SELECT RAISE(ABORT,'root basket completion is immutable'); END;

CREATE TRIGGER root_basket_current_ordered_insert BEFORE INSERT ON root_basket_current BEGIN
 SELECT RAISE(ABORT,'root basket current scope mismatch') WHERE NOT EXISTS (SELECT 1 FROM root_basket_captures WHERE capture_id = NEW.capture_id AND network_genesis_hash = NEW.network_genesis_hash AND decoder_version = NEW.decoder_version);
END;

CREATE TRIGGER root_basket_current_ordered_update BEFORE UPDATE ON root_basket_current BEGIN
 SELECT RAISE(ABORT,'root basket current scope mismatch') WHERE NOT EXISTS (SELECT 1 FROM root_basket_captures WHERE capture_id = NEW.capture_id AND network_genesis_hash = NEW.network_genesis_hash AND decoder_version = NEW.decoder_version);
 SELECT RAISE(ABORT,'root basket current source order cannot regress') WHERE NEW.network_genesis_hash <> OLD.network_genesis_hash OR NEW.decoder_version <> OLD.decoder_version
  OR (SELECT length(finalized_block),finalized_block FROM root_basket_captures WHERE capture_id = NEW.capture_id)
   < (SELECT length(finalized_block),finalized_block FROM root_basket_captures WHERE capture_id = OLD.capture_id)
  OR (NEW.capture_id <> OLD.capture_id AND (SELECT finalized_block FROM root_basket_captures WHERE capture_id = NEW.capture_id) = (SELECT finalized_block FROM root_basket_captures WHERE capture_id = OLD.capture_id));
END;

CREATE TRIGGER root_basket_fund_snapshots_immutable_delete BEFORE DELETE ON root_basket_fund_snapshots
 WHEN EXISTS (SELECT 1 FROM root_basket_capture_completions WHERE capture_id IN (OLD.capture_id))
 BEGIN SELECT RAISE(ABORT,'completed root basket observation is immutable'); END;

CREATE TRIGGER root_basket_fund_snapshots_immutable_insert BEFORE INSERT ON root_basket_fund_snapshots
 WHEN EXISTS (SELECT 1 FROM root_basket_capture_completions WHERE capture_id IN (NEW.capture_id))
 BEGIN SELECT RAISE(ABORT,'completed root basket observation is immutable'); END;

CREATE TRIGGER root_basket_fund_snapshots_immutable_update BEFORE UPDATE ON root_basket_fund_snapshots
 WHEN EXISTS (SELECT 1 FROM root_basket_capture_completions WHERE capture_id IN (OLD.capture_id,NEW.capture_id))
 BEGIN SELECT RAISE(ABORT,'completed root basket observation is immutable'); END;

CREATE TRIGGER root_basket_holdings_immutable_delete BEFORE DELETE ON root_basket_holdings
 WHEN EXISTS (SELECT 1 FROM root_basket_capture_completions WHERE capture_id IN (OLD.capture_id))
 BEGIN SELECT RAISE(ABORT,'completed root basket observation is immutable'); END;

CREATE TRIGGER root_basket_holdings_immutable_insert BEFORE INSERT ON root_basket_holdings
 WHEN EXISTS (SELECT 1 FROM root_basket_capture_completions WHERE capture_id IN (NEW.capture_id))
 BEGIN SELECT RAISE(ABORT,'completed root basket observation is immutable'); END;

CREATE TRIGGER root_basket_holdings_immutable_update BEFORE UPDATE ON root_basket_holdings
 WHEN EXISTS (SELECT 1 FROM root_basket_capture_completions WHERE capture_id IN (OLD.capture_id,NEW.capture_id))
 BEGIN SELECT RAISE(ABORT,'completed root basket observation is immutable'); END;

CREATE TRIGGER root_basket_receipt_immutable BEFORE UPDATE ON root_basket_capture_pages BEGIN SELECT RAISE(ABORT,'root basket receipt is immutable'); END;

CREATE TRIGGER root_basket_targets_immutable_delete BEFORE DELETE ON root_basket_targets
 WHEN EXISTS (SELECT 1 FROM root_basket_capture_completions WHERE capture_id IN (OLD.capture_id))
 BEGIN SELECT RAISE(ABORT,'completed root basket observation is immutable'); END;

CREATE TRIGGER root_basket_targets_immutable_insert BEFORE INSERT ON root_basket_targets
 WHEN EXISTS (SELECT 1 FROM root_basket_capture_completions WHERE capture_id IN (NEW.capture_id))
 BEGIN SELECT RAISE(ABORT,'completed root basket observation is immutable'); END;

CREATE TRIGGER root_basket_targets_immutable_update BEFORE UPDATE ON root_basket_targets
 WHEN EXISTS (SELECT 1 FROM root_basket_capture_completions WHERE capture_id IN (OLD.capture_id,NEW.capture_id))
 BEGIN SELECT RAISE(ABORT,'completed root basket observation is immutable'); END;

CREATE TRIGGER surface_status_alias_insert BEFORE INSERT ON surface_status
WHEN NEW.surface_key IS NOT NULL AND NEW.surface_key <> ''
BEGIN
 SELECT RAISE(IGNORE) WHERE EXISTS(SELECT 1 FROM surface_status newer
   WHERE (newer.surface_key=NEW.surface_key OR (newer.surface_id=NEW.surface_id AND newer.surface_key IS NOT NEW.surface_key)) AND newer.last_checked > NEW.last_checked);
 UPDATE surface_status SET surface_id='history:'||surface_key
   WHERE surface_id=NEW.surface_id AND surface_key IS NOT NULL AND surface_key IS NOT NEW.surface_key
     AND COALESCE(last_checked,0)<=NEW.last_checked;
 DELETE FROM surface_status WHERE surface_id=NEW.surface_id AND surface_key IS NULL AND COALESCE(last_checked,0)<=NEW.last_checked;
END;

CREATE VIEW _audit_neurons_20260922 AS SELECT m.netuid AS netuid,m.uid AS uid,m.hotkey AS hotkey,m.coldkey AS coldkey,json_extract(d.payload,'$."'||m.uid||'".active') AS active,json_extract(d.payload,'$."'||m.uid||'".validator_permit') AS validator_permit,json_extract(d.payload,'$."'||m.uid||'".rank') AS rank,json_extract(d.payload,'$."'||m.uid||'".trust') AS trust,json_extract(d.payload,'$."'||m.uid||'".validator_trust') AS validator_trust,json_extract(d.payload,'$."'||m.uid||'".consensus') AS consensus,json_extract(d.payload,'$."'||m.uid||'".incentive') AS incentive,json_extract(d.payload,'$."'||m.uid||'".dividends') AS dividends,json_extract(d.payload,'$."'||m.uid||'".emission_tao') AS emission_tao,json_extract(d.payload,'$."'||m.uid||'".stake_tao') AS stake_tao,json_extract(d.payload,'$."'||m.uid||'".registered_at_block') AS registered_at_block,json_extract(d.payload,'$."'||m.uid||'".is_immunity_period') AS is_immunity_period,json_extract(d.payload,'$."'||m.uid||'".axon') AS axon,json_extract(d.payload,'$."'||m.uid||'".block_number') AS block_number,json_extract(d.payload,'$."'||m.uid||'".captured_at') AS captured_at,json_extract(d.payload,'$."'||m.uid||'".take') AS take FROM _audit_neuron_members_20260922 m JOIN _audit_neuron_docs_20260922 d ON d.netuid=m.netuid;

CREATE VIEW account_position_daily AS SELECT m.account AS account,m.netuid AS netuid,m.snapshot_date AS snapshot_date,json_extract(d.payload,'$."'||('k'||hex(m.account))||'".uid') AS uid,json_extract(d.payload,'$."'||('k'||hex(m.account))||'".coldkey') AS coldkey,json_extract(d.payload,'$."'||('k'||hex(m.account))||'".active') AS active,json_extract(d.payload,'$."'||('k'||hex(m.account))||'".validator_permit') AS validator_permit,json_extract(d.payload,'$."'||('k'||hex(m.account))||'".rank') AS rank,json_extract(d.payload,'$."'||('k'||hex(m.account))||'".trust') AS trust,json_extract(d.payload,'$."'||('k'||hex(m.account))||'".incentive') AS incentive,json_extract(d.payload,'$."'||('k'||hex(m.account))||'".dividends') AS dividends,json_extract(d.payload,'$."'||('k'||hex(m.account))||'".stake_tao') AS stake_tao,json_extract(d.payload,'$."'||('k'||hex(m.account))||'".emission_tao') AS emission_tao,json_extract(d.payload,'$."'||('k'||hex(m.account))||'".captured_at') AS captured_at,json_extract(d.payload,'$."'||('k'||hex(m.account))||'".updated_at') AS updated_at FROM account_position_daily_members m JOIN account_position_daily_documents d ON d.netuid=m.netuid AND d.day=m.snapshot_date AND d.shard=m.shard;

CREATE VIEW neuron_daily AS SELECT m.netuid AS netuid,m.uid AS uid,m.hotkey AS hotkey,m.coldkey AS coldkey,json_extract(d.payload,'$."'||m.uid||'".active') AS active,json_extract(d.payload,'$."'||m.uid||'".validator_permit') AS validator_permit,json_extract(d.payload,'$."'||m.uid||'".rank') AS rank,json_extract(d.payload,'$."'||m.uid||'".trust') AS trust,json_extract(d.payload,'$."'||m.uid||'".validator_trust') AS validator_trust,json_extract(d.payload,'$."'||m.uid||'".consensus') AS consensus,json_extract(d.payload,'$."'||m.uid||'".incentive') AS incentive,json_extract(d.payload,'$."'||m.uid||'".dividends') AS dividends,json_extract(d.payload,'$."'||m.uid||'".emission_tao') AS emission_tao,json_extract(d.payload,'$."'||m.uid||'".stake_tao') AS stake_tao,json_extract(d.payload,'$."'||m.uid||'".registered_at_block') AS registered_at_block,json_extract(d.payload,'$."'||m.uid||'".is_immunity_period') AS is_immunity_period,json_extract(d.payload,'$."'||m.uid||'".axon') AS axon,json_extract(d.payload,'$."'||m.uid||'".block_number') AS block_number,json_extract(d.payload,'$."'||m.uid||'".captured_at') AS captured_at,json_extract(d.payload,'$."'||m.uid||'".take') AS take,m.snapshot_date AS snapshot_date,json_extract(d.payload,'$."'||m.uid||'".updated_at') AS updated_at FROM neuron_daily_members m JOIN neuron_daily_documents d ON d.netuid=m.netuid AND d.day=m.snapshot_date AND d.shard=m.shard;

CREATE VIEW neurons AS SELECT m.netuid AS netuid,m.uid AS uid,m.hotkey AS hotkey,m.coldkey AS coldkey,json_extract(d.payload,'$."'||m.uid||'".active') AS active,json_extract(d.payload,'$."'||m.uid||'".validator_permit') AS validator_permit,json_extract(d.payload,'$."'||m.uid||'".rank') AS rank,json_extract(d.payload,'$."'||m.uid||'".trust') AS trust,json_extract(d.payload,'$."'||m.uid||'".validator_trust') AS validator_trust,json_extract(d.payload,'$."'||m.uid||'".consensus') AS consensus,json_extract(d.payload,'$."'||m.uid||'".incentive') AS incentive,json_extract(d.payload,'$."'||m.uid||'".dividends') AS dividends,json_extract(d.payload,'$."'||m.uid||'".emission_tao') AS emission_tao,json_extract(d.payload,'$."'||m.uid||'".stake_tao') AS stake_tao,json_extract(d.payload,'$."'||m.uid||'".registered_at_block') AS registered_at_block,json_extract(d.payload,'$."'||m.uid||'".is_immunity_period') AS is_immunity_period,json_extract(d.payload,'$."'||m.uid||'".axon') AS axon,json_extract(d.payload,'$."'||m.uid||'".block_number') AS block_number,json_extract(d.payload,'$."'||m.uid||'".captured_at') AS captured_at,json_extract(d.payload,'$."'||m.uid||'".take') AS take FROM neurons_members m JOIN neurons_documents d ON d.netuid=m.netuid AND d.day='' AND d.shard=m.shard;
