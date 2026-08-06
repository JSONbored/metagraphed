-- Network-wide concentration, one row per day (#9628).
--
-- WHY A ROLLUP AND NOT A LIVE READ. /subnets/{netuid}/concentration/history
-- pulls that subnet's raw per-UID rows out of `neuron_daily` and computes
-- Gini/HHI/Nakamoto/top-K in JS, because none of those are simple SQL
-- aggregates. A netuid slice is ~256 rows, so that works. Network-wide it is
-- not a slice: `neuron_daily` holds 816,803 rows across 27 days, about 30,100 a
-- day (measured 2026-08-06), so a 30-day series computed the same way would pull
-- ~900,000 rows into one request.
--
-- WHY A STORED CARD AND NOT SIXTY COLUMNS. The network card is five
-- scorecards -- stake, emission, entity_stake, entity_emission, validator_stake
-- -- each carrying holders/total/gini/hhi/hhi_normalized/nakamoto/top-K/entropy.
-- Flattening that is ~60 columns, and every future field the builder gains
-- becomes a migration. The computed card is stored verbatim instead, the way
-- `surface_history.overlay` stores a surface record, with only the scalars a
-- reader might scan on lifted out.
--
-- The writer runs `buildChainConcentration` -- the SAME function that serves
-- /chain/concentration -- over each day's rows. Gini and Nakamoto ARE
-- expressible in SQL with window functions, and writing them a second time here
-- would create two definitions of one metric that agree until they quietly do
-- not. Running the existing builder makes a historical point and the live card
-- the same computation by construction.
CREATE TABLE IF NOT EXISTS chain_concentration_daily (
  -- UTC day, 'YYYY-MM-DD', matching neuron_daily.snapshot_date.
  day                TEXT    NOT NULL PRIMARY KEY,
  -- The row count the card was computed from, lifted out so a reader can see
  -- the shape of the day without parsing the blob -- a point computed over half
  -- the network is not comparable to one computed over all of it. The writer
  -- takes it from the rows rather than reading it back out of the card, so this
  -- NOT NULL column is an integer by construction.
  --
  -- subnet_count and entity_count are deliberately NOT lifted out: they are
  -- already inside the card, and a second copy in a column is a second thing
  -- that can disagree with the first.
  neuron_count       INTEGER NOT NULL,
  -- The full buildChainConcentration payload as JSON.
  card               TEXT    NOT NULL,
  -- The newest captured_at among the rows this day was computed from: WHEN the
  -- network looked like this, as distinct from when we computed it.
  source_captured_at INTEGER,
  computed_at        INTEGER NOT NULL,
  -- The card's own schema_version at the time it was computed. A stored
  -- computation freezes the code that produced it, so if the builder changes,
  -- old points and new ones disagree BY CONSTRUCTION. Recording the version is
  -- what lets the reader say so rather than serving a series that silently
  -- changes definition partway along.
  builder_version    INTEGER NOT NULL
);

-- The serving read: a window of days, newest first.
CREATE INDEX IF NOT EXISTS idx_chain_concentration_daily_day
  ON chain_concentration_daily (day DESC);

-- NO BACKFILL STATEMENT HERE, deliberately. The 27 days already in
-- `neuron_daily` cannot be aggregated by SQL -- computing them requires the JS
-- builder, which is the whole point above. The rollup asks each tick which days
-- have no row yet and processes a bounded number of them, so it fills the
-- existing history within a few ticks, survives a gap in the cron, and needs no
-- separate recovery path that could itself drift from the writer.
