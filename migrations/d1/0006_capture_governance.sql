-- Native capture cursor and append-on-change governance state (#12165).
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
-- statement-breakpoint
CREATE INDEX emission_gate_param_history_param_observed_idx
  ON emission_gate_param_history (param, observed_at DESC);
-- statement-breakpoint
CREATE UNIQUE INDEX emission_gate_param_history_param_observed_at_key ON emission_gate_param_history(param, observed_at);
-- statement-breakpoint

CREATE TABLE subnet_emission_enabled_history (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  netuid           INTEGER NOT NULL,
  enabled          INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  previous_enabled INTEGER CHECK (previous_enabled IN (0, 1)),
  block_number     INTEGER,
  observed_at      INTEGER NOT NULL,
  predates_capture INTEGER NOT NULL DEFAULT 0 CHECK (predates_capture IN (0, 1))
);
-- statement-breakpoint
CREATE INDEX subnet_emission_enabled_history_netuid_observed_idx
  ON subnet_emission_enabled_history (netuid, observed_at DESC);
-- statement-breakpoint
CREATE UNIQUE INDEX subnet_emission_enabled_history_netuid_observed_at_key ON subnet_emission_enabled_history(netuid, observed_at);
-- statement-breakpoint

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
-- statement-breakpoint
CREATE INDEX emission_flow_watch_item_observed_idx
  ON emission_flow_watch (item, observed_at DESC);
-- statement-breakpoint

CREATE TABLE raw_capture_state (
 network TEXT PRIMARY KEY NOT NULL,
 last_contiguous_block INTEGER NOT NULL,
 updated_at INTEGER NOT NULL,
 stopped_at INTEGER,
 last_error TEXT
);
-- statement-breakpoint
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
-- statement-breakpoint
CREATE INDEX idx_subnet_dereg_daily_netuid_date ON subnet_deregistration_daily(netuid,snapshot_date DESC);
-- statement-breakpoint
CREATE INDEX idx_subnet_dereg_daily_date ON subnet_deregistration_daily(snapshot_date DESC);
-- statement-breakpoint
CREATE INDEX emission_gate_param_history_observed_idx ON emission_gate_param_history(observed_at DESC);
-- statement-breakpoint
CREATE INDEX subnet_emission_enabled_history_observed_idx ON subnet_emission_enabled_history(observed_at DESC);
-- statement-breakpoint
CREATE INDEX emission_flow_watch_observed_idx ON emission_flow_watch(observed_at DESC);
-- statement-breakpoint
