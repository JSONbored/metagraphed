-- Emission-gate parameter and per-subnet enablement history (#8748).
--
-- The switches steering the v440 emission pipeline change rarely, silently, and
-- consequentially. EmissionBarQuantile already moved from its 0.61 default to
-- 0.75 after the v440 deploy -- a change that materially reshaped the gate --
-- and that move is now unrecoverable from anything we hold. Same for the 47
-- subnets carrying SubnetEmissionEnabled = false: we can read the current
-- state, never when or in what order it was set.
--
-- Append-on-change, not overwrite-per-refresh: a row exists only where a value
-- actually moved, so the table IS the change log rather than a sampling of one.
--
-- THETA IS NOT A GOVERNANCE PARAMETER. EmissionGateBar is recomputed by the
-- runtime whenever block % 360 == 0, from the live demand distribution -- it
-- moves constantly and on its own. `source` separates that from a human-set
-- change to q or h, so a reader asking "what did governance do" is never
-- answered with 20 runtime recomputations a day.
CREATE TABLE IF NOT EXISTS emission_gate_param_history (
  id              BIGSERIAL PRIMARY KEY,
  -- 'emission_gate_bar' | 'emission_bar_quantile' | 'emission_gate_exponent'
  -- | 'block_emission_halvings'
  param           TEXT     NOT NULL,
  -- NULL is a real reading: an unset storage item means "use the runtime
  -- default", which is NOT zero (h unset means 3, and h = 0 would make the
  -- Hill gate 0.5 for every subnet).
  value           NUMERIC,
  previous_value  NUMERIC,
  -- 'governance' (q, h -- set by a root-origin extrinsic) or
  -- 'runtime_recomputed' (theta -- recomputed on the 360-block cadence).
  source          TEXT     NOT NULL,
  block_number    BIGINT,
  observed_at     BIGINT   NOT NULL,
  -- TRUE only on a param's FIRST row: the value was already in place when
  -- capture began, so its own change date is unrecoverable. This is how the
  -- historical 0.61 -> 0.75 quantile move is representable without inventing
  -- a date for it (#8748 acceptance).
  predates_capture BOOLEAN NOT NULL DEFAULT FALSE,
  CONSTRAINT emission_gate_param_history_source_check
    CHECK (source IN ('governance', 'runtime_recomputed'))
);

CREATE INDEX IF NOT EXISTS emission_gate_param_history_param_observed_idx
  ON emission_gate_param_history (param, observed_at DESC);

-- Per-subnet emission enablement. SubnetEmissionEnabled DEFAULTS TO TRUE:
-- absent storage is ENABLED and 0x00 is disabled, so a naive "is the key set"
-- check inverts the meaning. `enabled` is therefore the decoded boolean, never
-- key presence.
CREATE TABLE IF NOT EXISTS subnet_emission_enabled_history (
  id               BIGSERIAL PRIMARY KEY,
  netuid           INTEGER  NOT NULL,
  enabled          BOOLEAN  NOT NULL,
  previous_enabled BOOLEAN,
  block_number     BIGINT,
  observed_at      BIGINT   NOT NULL,
  predates_capture BOOLEAN  NOT NULL DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS subnet_emission_enabled_history_netuid_observed_idx
  ON subnet_emission_enabled_history (netuid, observed_at DESC);
