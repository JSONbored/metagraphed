-- The freshness sweep reads MAX(observed_at) off three chain_detail tables and
-- gets a parallel sequential scan for it, 2026-08-11.
--
-- runTableFreshnessWatchdog (src/table-freshness-watchdog.ts) asks every
-- declared table for its newest stamp once an hour, and
-- chain-detail-staleness-watchdog asks again on `14,29,44,59`. Measured against
-- production:
--
--   SELECT MAX(observed_at) FROM chain_detail_chain_events
--     Parallel Seq Scan  134.347 ms  read=11666 buffers  (92 MB heap, 369k rows)
--
-- `chain_detail_account_events` (41 MB) and `chain_detail_extrinsics` (40 MB)
-- have the same shape and the same absent index. `chain_detail_blocks` is left
-- alone deliberately: the prune keeps it at ~1,829 rows, so its scan is a
-- handful of pages and an index would cost more to maintain than it saves.
--
-- ## WHY AN INDEX IS RIGHT HERE AND WRONG ON THE SIBLING TABLES
--
-- This is the whole reason the file stops at three tables. The same sweep also
-- scans `neuron_daily` (486 MB, 850 ms) and `account_position_daily` (497 MB,
-- 551 ms) for MAX(captured_at), and indexing THOSE would be a net loss.
--
-- `captured_at` is the freshness stamp: it changes on every upsert. An index on
-- a column that changes on every write means no update to that table can ever
-- be HOT again -- Postgres skips the HOT path whenever an indexed column
-- changes. account_position_daily takes ~10M updates per 3.5 days at a 33.6%
-- HOT rate today; indexing captured_at would drive that toward zero and add
-- ~10M index writes, to save roughly a hundred reads. Those two lanes get their
-- freshness from their tiny `*_passes` companion instead, which carries the
-- identical stamp in 88 kB.
--
-- These three are the opposite case. They are append-and-prune, not upsert:
--
--   chain_detail_chain_events    4,952,207 inserts   434 updates  (0.01%)
--   chain_detail_account_events  3,770,357 inserts   336 updates  (0.01%)
--   chain_detail_extrinsics        514,688 inserts    45 updates  (0.01%)
--
-- With effectively no updates there is no HOT to protect, so the index costs
-- only what every insert and delete already pays on the other indexes, and buys
-- a single descent in place of the scan.
--
-- BTREE, NOT BRIN, even though `observed_at` is well correlated with physical
-- order and BRIN would be a fraction of the size. PG 16 stopped summarizing
-- indexes from blocking HOT updates and this branch is PG 18, so BRIN would be
-- safe on an upsert table -- but the planner cannot answer a bare MAX() from
-- BRIN at all. It prunes ranges; it does not descend. The query here is
-- MAX(), so btree is the only shape that helps.
--
-- ## CONCURRENTLY: not in a transaction
--
-- As 0011 and 0012. Apply statement by statement; a failed build leaves an
-- INVALID index to drop before retrying (`SELECT indexrelid::regclass FROM
-- pg_index WHERE NOT indisvalid`). Every statement is IF NOT EXISTS, so a
-- half-applied run is re-runnable -- which is what pays for having no rollback.
-- neon:no-transaction

-- 1. 92 MB, the largest of the three and the one measured above.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_chain_detail_chain_events_observed
  ON chain_detail_chain_events (observed_at);

-- 2. 41 MB.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_chain_detail_account_events_observed
  ON chain_detail_account_events (observed_at);

-- 3. 40 MB. Fewer rows than the other two, but the same scan.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_chain_detail_extrinsics_observed
  ON chain_detail_extrinsics (observed_at);
