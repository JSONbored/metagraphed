-- Index hygiene: one index that cannot serve its query, two that serve none.
--
-- Measured on production Neon 2026-08-08. `pg_stat_user_indexes.stats_reset` is
-- NULL, so `idx_scan = 0` means never used in the database's lifetime, not
-- "not used lately" -- which is what makes these safe to act on.
--
-- 21 non-unique indexes had never been scanned, totalling 148 MB against a
-- 1,866 MB database. Three of them are essentially all of it; the other
-- eighteen are 16-48 kB each and not worth the churn.
--
-- ## 1. chain_detail_extrinsics: the index does not match the query
--
-- THIS ONE IS NOT DEAD WEIGHT, IT IS A MISS. src/chain-detail-hot-tier.ts
-- looks an extrinsic up case-insensitively:
--
--     SELECT ... FROM chain_detail_extrinsics WHERE lower(extrinsic_hash) = ?
--
-- and the index is on the RAW column. A btree on `extrinsic_hash` cannot serve
-- `lower(extrinsic_hash) = ?`, so the planner ignores it and scans the table:
--
--     Seq Scan on chain_detail_extrinsics (actual time=24.634..24.634)
--       Filter: (lower(extrinsic_hash) = '0xabc'::text)
--       Rows Removed by Filter: 36980
--       Buffers: shared hit=6724
--
-- 24.6 ms and 6,724 buffers for a single-row lookup. Replaced with an
-- expression index on `lower(extrinsic_hash)`, which is what the query asks
-- for. The zero scan count was the symptom; the cost was paid on every
-- extrinsic-by-hash request.
--
-- Swept for the same shape elsewhere -- `(lower|upper)(col) = ?` across src/
-- and workers/ -- and this is the only one.
--
-- ## 2. surface_checks(surface_key, checked_at DESC): 119 MB, no reader
--
-- The table's other two indexes are used (`_netuid_time` 637 scans,
-- `_time` 543) and its primary key 1.45M. Nothing filters or orders by
-- `surface_key`: the analytics loaders partition and GROUP BY it, which needs
-- no index, and their WHERE clauses are on `netuid`/`checked_at`.
--
-- Worth stating because it was nearly a wrong call: those loaders were THROWING
-- until 2026-08-08 (#10200), so "no scans" could have meant "its query never
-- ran". It does not -- the fixed queries filter on netuid and time, so this
-- index would still be unused. Checked after the fix, not before.
--
-- ## 3. account_balances(free_tao DESC): 20 MB, and the predicate is total
--
-- src/top-holders-holdings.ts filters `WHERE free_tao > 0`. Every row in the
-- table satisfies it -- 365,482 of 365,482 -- so a sequential scan is the
-- correct plan and always will be. An index that can only ever return the whole
-- table is not selective enough to be chosen.
--
-- ## CONCURRENTLY, and why this file is not idempotent-by-transaction
--
-- Every statement is CONCURRENTLY so a live table is never locked against
-- writes. That means none of them may run inside a transaction block -- apply
-- this file statement by statement (psql does this by default), NOT wrapped in
-- BEGIN/COMMIT. A CONCURRENTLY build that fails leaves an INVALID index behind
-- that must be dropped before retrying; check with
--   SELECT indexrelid::regclass FROM pg_index WHERE NOT indisvalid;
--
-- The line below is that instruction in a form the runner can read. It was
-- prose only, and scripts/neon-migrate.ts wrapped this file in BEGIN/COMMIT
-- anyway -- so it failed on every push for two days and blocked 0012-0015
-- behind it (#10365). Every statement here is IF NOT EXISTS / IF EXISTS, which
-- is what makes giving up atomicity safe: a half-applied run is re-runnable.
-- neon:no-transaction

-- 1. The miss: replace the raw-column index with the expression the query uses.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_chain_detail_extrinsics_hash_lower
  ON chain_detail_extrinsics (lower(extrinsic_hash));

DROP INDEX CONCURRENTLY IF EXISTS idx_chain_detail_extrinsics_hash;

-- 2. No reader.
DROP INDEX CONCURRENTLY IF EXISTS idx_surface_checks_key_time;

-- 3. Predicate matches every row.
DROP INDEX CONCURRENTLY IF EXISTS idx_account_balances_free;
