-- Widen the four chain hypertables' chunk interval from 1 day to 30 days.
--
-- These tables hold the full backfilled chain history (~3.2 years and
-- growing), so a 1-day interval accumulates ~1,180 chunks each. That is a
-- WRITE-PATH problem, not a storage one: the indexer's flush() does
-- INSERT ... SELECT FROM a temp table, and the planner cannot chunk-prune
-- runtime values, so every flush takes locks proportional to the chunk count.
--
-- Measured live 2026-07-31 on meta-indexer-01: with 1-day chunks, concurrent
-- backfill flushes sat 7-13 minutes on LockManager/relation locks and
-- aggregate throughput collapsed to ~0. After this change the same workload
-- runs with zero ungranted locks at 22.9 blk/s. See metagraphed#8791.
--
-- set_chunk_time_interval() affects only chunks created AFTER it runs --
-- existing chunks keep their 1-day span, which is correct and needs no
-- rewrite. deploy/postgres/schema.sql's TimescaleDB companion carries the
-- same 30-day value for fresh deployments (a change applied in only one of
-- those two places is the #5348/#5353 incident shape).
--
-- Idempotent: set_chunk_time_interval() is a no-op when the value already
-- matches, so re-running this is safe.
--
-- Guarded for non-TimescaleDB deployments: plain Postgres (e.g. Railway) has
-- no hypertables and must skip this rather than fail on an unknown function.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') THEN
    PERFORM set_chunk_time_interval('blocks', 2592000000);
    PERFORM set_chunk_time_interval('extrinsics', 2592000000);
    PERFORM set_chunk_time_interval('account_events', 2592000000);
    PERFORM set_chunk_time_interval('chain_events', 2592000000);
  END IF;
END
$$;
