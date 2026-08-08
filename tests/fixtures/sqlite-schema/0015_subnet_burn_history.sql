-- Registration-cost series, one row per subnet per capture tick (#9402).
--
-- SubtensorModule.Burn is re-priced by the registration auction, so the operator
-- question is usually not "what does it cost" but "is this getting more expensive".
-- Nothing recorded it: subnet_hyperparams stores the BOUNDS (min_burn_tao,
-- max_burn_tao, burn_half_life, burn_increase_mult) and not the live value, and
-- subnet_hyperparams_history holds roughly one snapshot per subnet, which is a
-- capture rather than a series.
--
-- WHY PER-TICK AND NOT A DAILY ROLLUP. Burn moves within minutes during a
-- registration burst -- that is the whole reason the live route caches for only 120s
-- -- so a daily min/max/avg would flatten precisely the events worth seeing. The row
-- is tiny and the write is one batch per tick, so the honest shape is cheap.
CREATE TABLE IF NOT EXISTS subnet_burn_history (
  netuid      INTEGER NOT NULL,
  -- Epoch MILLISECONDS, like every other captured_at in this database. #9382 is the
  -- standing reminder of what a seconds value does here: read as ms it lands in 1970,
  -- and a staleness guard then pins the row permanently.
  observed_at INTEGER NOT NULL,
  -- TAO, not rao. Stored as the served unit so a reader never re-derives it and no
  -- consumer has to know which one this column holds. A genuine 0 is a real price --
  -- netuid 76 reads a true zero and is the cheapest registration on the network -- so
  -- this column is NOT NULL and a missing read is an absent ROW, never a zero one.
  burn_tao    REAL    NOT NULL,
  PRIMARY KEY (netuid, observed_at)
);

-- The serving read: one subnet's series, newest first, within a window.
CREATE INDEX IF NOT EXISTS idx_subnet_burn_history_netuid_observed
  ON subnet_burn_history (netuid, observed_at DESC);

-- The retention sweep, which scans by age across every subnet.
CREATE INDEX IF NOT EXISTS idx_subnet_burn_history_observed
  ON subnet_burn_history (observed_at);
