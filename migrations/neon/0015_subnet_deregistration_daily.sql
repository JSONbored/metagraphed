-- A daily record of what the deregistration ranking was computed FROM (#10296).
--
-- #10285 ships the current ranking: "how close is this subnet to being pruned",
-- answered with the pallet's own rule. It is computed per request and stored
-- nowhere, so a caller can see today's answer and nothing else -- and a single
-- day's rank is noise. `rank: 94` tells a subnet owner almost nothing; "94, was
-- 71 a month ago, and the gap to the bar has halved" tells them exactly what
-- they need.
--
-- ## THIS TABLE STORES THE INPUTS, NOT THE RANK
--
-- That is the whole design decision, and it is not a preference.
--
-- `src/subnet-deregistration-ranking.ts` already splits its fields two ways.
-- Four are MEASURED -- `SubnetMovingPrice`, `NetworkRegisteredAt`,
-- `SubnetMechanism`, `NetworkImmunityPeriod` -- and everything a caller reads
-- off the card (`rank`, `comparison_price`, `immune`, `blocks_until_prunable`,
-- `next_to_deregister`) is declared `kind: "reconstructed", storage: null`.
-- They are derived by a RULE, and #10285 exists because that rule is subtle
-- enough to get wrong: a price-only order puts netuid 86 at position one when
-- the chain's answer is netuid 70, because immunity and the Stable-mechanism
-- substitution both bite.
--
-- Persisting `rank` would freeze one version of that rule into history. If the
-- rule is ever corrected, a stored-rank series becomes a permanent record of
-- the old answers, indistinguishable from the new ones. Persisting the inputs
-- means the same fix corrects every past day for free, and every row stays
-- auditable against the chain: it states what was read, at which block, and
-- `projectDeregistrationRanking` replays it unchanged.
--
-- ## Why a table of its own rather than columns on subnet_snapshots
--
-- #10296 asked whether this belongs on the existing daily rollup. It does not.
-- That rollup does NOT already carry the moving price -- measured 2026-08-10,
-- its 27 columns hold `alpha_price_tao` (the spot price) and the only
-- `%moving%` columns in the database are `subnet_hyperparams.bonds_moving_avg_raw`
-- and its history twin, an unrelated hyperparameter. So every input here is a
-- new column either way, and `pipeline_block` is the only real overlap.
--
-- Coupling them would also tie this write to that rollup's completeness: a
-- partial read here would either block the daily snapshot or land NULLs in it.
--
-- ## Carried-forward days are visible, not guessed at
--
-- The economics sweep pins one block; a day on which no fresh sweep landed
-- repeats the previous observation. `/subnets/{netuid}/emission-pipeline/history`
-- documents that trap and this series inherits it exactly -- two consecutive
-- points can be the SAME observation, and a rank that was simply not
-- re-measured must not read as a rank that held steady.
--
-- `pinned_block` is what makes that answerable without a heuristic: distinct
-- observations are distinct `pinned_block` values over the window, so a reader
-- publishes `distinct_observations` beside `point_count` by counting, never by
-- comparing ranks for equality.
--
-- ## Accrues forward only
--
-- Unlike the hyperparameters backfill (#5597) the inputs cannot be
-- reconstructed cheaply: reproducing a past day means reading all four storages
-- for every netuid at that day's block, one archive sweep per day. Possible,
-- but a backfill project rather than a lane.

CREATE TABLE IF NOT EXISTS subnet_deregistration_daily (
  netuid                  INTEGER NOT NULL,
  -- ISO date, the same daily key subnet_snapshots uses.
  snapshot_date           TEXT    NOT NULL,
  -- `SubnetMovingPrice`, decoded. NULL when the sweep could not read it --
  -- a subnet with no price is not a subnet priced at zero, and the ranking
  -- treats the two differently.
  moving_price            DOUBLE PRECISION,
  -- `NetworkRegisteredAt`, in blocks. Half of the immunity window.
  registered_at_block     BIGINT,
  -- `SubnetMechanism`; 0 is Stable and forces the comparison price to a flat
  -- 1.0 regardless of moving_price. Every mainnet subnet reads 1 today, so the
  -- clause is invisible until one sudo call makes it decisive -- which is
  -- exactly why the raw value is stored rather than the price it implies.
  subnet_mechanism        INTEGER,
  -- `NetworkImmunityPeriod`, in blocks. Network-wide rather than per-subnet,
  -- and stored per row anyway so a row replays on its own without a join to
  -- whatever the period happened to be that day.
  network_immunity_period BIGINT,
  -- The block the economics sweep pinned every read to. The whole row is one
  -- observation at one block, which is what makes it auditable -- and repeated
  -- values are how a carried-forward day is detected.
  pinned_block            BIGINT,
  captured_at             BIGINT  NOT NULL,
  PRIMARY KEY (netuid, snapshot_date),
  -- The same epoch-milliseconds floor 0010 put on the daily tables: 1e12 is
  -- 2001-09-09 and a seconds-valued stamp this decade is ~1.79e9. #9782 is what
  -- this prevents -- a stamp missing three digits produced a row dated 1970
  -- that no later pass could revise.
  CONSTRAINT subnet_deregistration_daily_captured_at_is_millis
    CHECK (captured_at >= 1000000000000)
);

-- One subnet's trajectory, newest first: the per-netuid history read.
CREATE INDEX IF NOT EXISTS idx_subnet_dereg_daily_netuid_date
  ON subnet_deregistration_daily (netuid, snapshot_date DESC);

-- A whole day across every subnet, which is what a ranking replay needs: the
-- rank is relative, so reconstructing one subnet's rank requires every other
-- subnet's row for that date.
CREATE INDEX IF NOT EXISTS idx_subnet_dereg_daily_date
  ON subnet_deregistration_daily (snapshot_date DESC);
