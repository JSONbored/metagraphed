-- weights_version is a u64 on chain and was an int32 here (#10298).
--
-- SubtensorModule.WeightsVersionKey is a u64. Both columns storing it were
-- declared INTEGER -- migrations/neon/0001_side_tables.sql and
-- migrations/neon/0003_append_only_histories.sql -- which caps at 2,147,483,647.
--
-- THIS IS NOT A THEORETICAL RANGE. Measured 2026-08-09, the live maximum across
-- all 129 subnets was 1,778,428,951: working, and 83% of the way to the ceiling.
-- But three subnets have historically carried a value above it --
--
--   netuid 16  3,000,000,030
--   netuid 18  9,223,372,036,854,775,807
--   netuid 28  9,223,372,036,854,775,807
--
-- -- and that second value is i64::MAX, the sentinel a subnet sets to disable
-- version gating outright. Two subnets have used it. Found when 15 rows of the
-- #5597 historical replay failed with "value 3000000030 is out of range for
-- type integer".
--
-- The live hourly lane writes this column through the same shared column list,
-- one statement per row, so a subnet setting the key above 2^31-1 fails that
-- row -- and nothing in the write path clamps or reports it. This is one sudo
-- call away from being a live fault rather than a backfill one.
--
-- BIGINT is int64 and the chain type is u64, so the top half of the chain's
-- range is still not representable. That is deliberate rather than overlooked:
-- i64::MAX is the value actually used as the "never" sentinel and it fits,
-- while NUMERIC would cost every reader an arbitrary-precision decode for a
-- range the chain does not use.
--
-- Widening only -- every existing value is valid unchanged, and both tables are
-- small (129 and ~2,000 rows), so the rewrite is negligible.
ALTER TABLE subnet_hyperparams
  ALTER COLUMN weights_version TYPE BIGINT;

ALTER TABLE subnet_hyperparams_history
  ALTER COLUMN weights_version TYPE BIGINT;
