-- The three shapes `pg_stat_statements` says cost the most, 2026-08-08.
--
-- Read off production by total execution time, excluding catalog queries:
--
--   857s  39,671 calls  21.6ms  SELECT ... FROM chain_detail_extrinsics ...
--   515s     875 calls 589.0ms  WITH daily AS (SELECT nd.hotkey, nd.snapshot_date, SUM(...
--   496s   1,000 calls 496.1ms  (the same aggregate, second shape)
--   491s  39,452 calls  12.4ms  SELECT b.block_number ... FROM blocks_head b LEFT JOIN ...
--   152s     439 calls 345.2ms  SELECT ... FROM neuron_daily WHERE validator_permit ...
--   114s     420 calls 272.0ms  SELECT MIN(snapshot_date) FROM neuron_daily WHERE snapshot_date >= $1
--   107s     367 calls 290.3ms  SELECT MAX(snapshot_date) FROM neuron_daily
--
-- The first is already fixed (0011). This file is the rest.
--
-- ## 1. blocks_head: the same expression miss as chain_detail_extrinsics
--
-- src/blocks-cold-tier.ts:428 resolves a block by hash case-insensitively:
--
--     ... FROM blocks_head b LEFT JOIN chain_detail_blocks c ... WHERE lower(b.block_hash) = ?
--
-- and `blocks_head` is indexed on `block_number` and `observed_at`. Nothing can
-- serve `lower(block_hash)`, so every block-by-hash request scans the table:
--
--     Seq Scan on blocks_head b  (actual time=12.624..12.624)  Buffers: shared hit=1322
--
-- 39,452 calls at 12.4ms = 491 seconds of database time.
--
-- WORTH RECORDING HOW THIS WAS NEARLY MISSED. Fixing the identical bug in 0011
-- I swept for `(lower|upper)(col) = ?` and concluded it was "the only one". The
-- regex was `[a-z_]+` inside the parentheses, which does not match a
-- table-qualified `b.block_hash` -- so the sweep reported one hit when there
-- were two, and the second was the fourth-largest consumer of database time in
-- the whole system. Re-run allowing qualified names, the answer is exactly
-- these two and no more.
--
-- ## 2 & 3. neuron_daily has no index leading with snapshot_date
--
-- Its two indexes are `(netuid, uid, snapshot_date)` and `(hotkey,
-- snapshot_date)`. In both, snapshot_date TRAILS, so neither can serve a
-- predicate or an aggregate on it alone. `SELECT MAX(snapshot_date)` -- which
-- should be a single index descent -- is a parallel sequential scan of a 387 MB
-- table:
--
--     Finalize Aggregate  (actual time=335.875..341.693)
--       Buffers: shared hit=2608 read=32770
--
-- `(snapshot_date)` alone fixes the MIN/MAX pair and gives the range scans
-- somewhere to start. `(validator_permit, snapshot_date)` is added for the
-- aggregate, which is equality-then-range -- the textbook composite -- and is
-- the single most expensive statement in the system at 1,011 seconds across
-- 1,875 calls.
--
-- Two indexes rather than one because they answer different questions: a bare
-- MAX cannot use a composite whose leading column it does not constrain.
--
-- ## CONCURRENTLY: not in a transaction
--
-- As 0011. Apply statement by statement; a failed build leaves an INVALID index
-- to drop before retrying (`SELECT indexrelid::regclass FROM pg_index WHERE NOT
-- indisvalid`).
--
-- Machine-readable, as in 0011: the prose above was addressed to a human and
-- scripts/neon-migrate.ts wrapped the file in BEGIN/COMMIT regardless (#10365).
-- Every statement is IF NOT EXISTS, so a half-applied run is re-runnable --
-- which is what pays for having no rollback.
-- neon:no-transaction

-- 1. Block-by-hash, case-insensitively.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_blocks_head_hash_lower
  ON blocks_head (lower(block_hash));

-- 2. MIN/MAX and bare range scans over the day axis.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_neuron_daily_snapshot_date
  ON neuron_daily (snapshot_date);

-- 3. The validator-history aggregate: equality on the flag, range on the day.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_neuron_daily_permit_date
  ON neuron_daily (validator_permit, snapshot_date);
