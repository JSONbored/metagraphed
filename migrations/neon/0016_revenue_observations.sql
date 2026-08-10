-- #10444: the revenue probe lane's store.
--
-- One row per (surface, period) per capture. The lane re-reads a feed that
-- restates history -- SN64 publishes a rolling window of daily rows, SN51 a
-- growing map of months -- so the same period is observed many times and the
-- newest observation wins. That is an UPSERT on (surface_id, period), not an
-- append: appending would grow ~30 rows per surface per tick and make the
-- serving query a per-period argmax over duplicates.
--
-- `response_hash` and `observed_at` are the retention #10444 asks for. An
-- operator can withdraw a feed once an unflattering ratio is published, and a
-- withdrawn feed that leaves nothing behind is indistinguishable from a subnet
-- that never had revenue. The hash lets a later reader prove the bytes a figure
-- came from without storing the bytes.
CREATE TABLE IF NOT EXISTS revenue_observations (
  surface_id     TEXT    NOT NULL,
  netuid         INTEGER NOT NULL,
  -- The period verbatim from the payload ('2026-08-08', '2026-07'). NULL is
  -- not allowed: a scalar total has no period of its own and is stored under
  -- the sentinel below, so a NULL here would mean the lane lost track of which
  -- row it was writing.
  period         TEXT    NOT NULL,
  grain          TEXT    NOT NULL,
  amount         DOUBLE PRECISION NOT NULL,
  currency       TEXT    NOT NULL,
  provenance     TEXT    NOT NULL,
  -- sha-256 of the exact response the figure was extracted from.
  response_hash  TEXT    NOT NULL,
  observed_at    BIGINT  NOT NULL,
  PRIMARY KEY (surface_id, period),
  -- The same epoch-milliseconds floor 0010 put on the daily tables: 1e12 is
  -- 2001-09-09 and a seconds-valued stamp this decade is ~1.79e9.
  CONSTRAINT revenue_observations_observed_at_is_millis
    CHECK (observed_at >= 1000000000000),
  -- Only the two readable provenances may be stored. operator-attested and
  -- third-party-reported carry no payload to probe, so a row claiming one of
  -- them means something wrote a figure it could not have read.
  CONSTRAINT revenue_observations_provenance_is_readable
    CHECK (provenance IN ('probe-derived', 'chain-verified'))
);

-- One subnet's series across its surfaces, newest period first: the per-netuid
-- serving read.
CREATE INDEX IF NOT EXISTS idx_revenue_obs_netuid_period
  ON revenue_observations (netuid, period DESC);

-- The network-wide coverage table reads every subnet's recent periods at once.
CREATE INDEX IF NOT EXISTS idx_revenue_obs_period
  ON revenue_observations (period DESC);

-- #10444: a fetch that failed is recorded as a failure, never as a zero. Kept
-- separate from the observations table on purpose -- a failure has no amount,
-- and giving it a nullable amount column would invite a reader to coalesce it
-- to 0, which is the exact confusion this lane exists to prevent.
CREATE TABLE IF NOT EXISTS revenue_probe_failures (
  surface_id   TEXT    NOT NULL,
  netuid       INTEGER NOT NULL,
  reason       TEXT    NOT NULL,
  observed_at  BIGINT  NOT NULL,
  PRIMARY KEY (surface_id, observed_at),
  CONSTRAINT revenue_probe_failures_observed_at_is_millis
    CHECK (observed_at >= 1000000000000)
);

CREATE INDEX IF NOT EXISTS idx_revenue_failures_netuid
  ON revenue_probe_failures (netuid, observed_at DESC);
