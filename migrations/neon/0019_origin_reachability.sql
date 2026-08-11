-- #10548: whether each registered ORIGIN is still there.
--
-- WHY ORIGINS AND NOT SURFACES. `scripts/build-artifacts.ts` builds the prober's
-- target list from surfaces with `probe.enabled`, so a surface disabled there is
-- never in the list and its health is never measured -- forever. SN37 Aurelius
-- is the demonstration: ~60 surfaces on one Railway host, ~50 of them
-- probe-disabled, and the entire origin had been deleted without one incident
-- being raised.
--
-- The fact worth knowing is about the HOST. One row per origin condemns every
-- surface on it at once, including the ones no prober may touch, and costs one
-- check instead of sixty.
CREATE TABLE IF NOT EXISTS origin_reachability (
  origin        TEXT    NOT NULL,
  checked_at    BIGINT  NOT NULL,
  -- How many registered surfaces this verdict covers. The point of the row.
  surface_count INTEGER NOT NULL,
  -- How many distinct registered paths were sampled. Below two, `not-routing`
  -- is not decidable and the verdict must not claim it.
  samples       INTEGER NOT NULL,
  verdict       TEXT    NOT NULL,
  PRIMARY KEY (origin),
  CONSTRAINT origin_reachability_checked_at_is_millis
    CHECK (checked_at >= 1000000000000),
  CONSTRAINT origin_reachability_counts_are_sane
    CHECK (surface_count >= 0 AND samples >= 0),
  -- `serving` and `unreachable` are the ordinary two. `not-routing` is the
  -- SN37 shape: the host answers, with one identical error for every path we
  -- advertise. `indeterminate` means too few samples to say -- never a finding.
  CONSTRAINT origin_reachability_verdict_is_known
    CHECK (verdict IN ('serving', 'unreachable', 'not-routing', 'indeterminate'))
);

CREATE INDEX IF NOT EXISTS origin_reachability_by_verdict
  ON origin_reachability (verdict, checked_at DESC);
