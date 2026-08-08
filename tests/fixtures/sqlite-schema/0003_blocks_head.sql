-- Live head capture (#204): one row per block the firehose head poller
-- observes, written by ChainFirehoseHub's alarm alongside the broadcast so
-- head data is DURABLE from the moment it is seen, not only streamed.
--
-- This is deliberately NOT the historical `blocks` table (that history lives
-- in R2/Iceberg, frozen and verified at quiesce). It is the small rolling
-- record of "what the poller has seen since the box died", the exact range the
-- Containers indexer's reconciling backfill (#209) will later overwrite into
-- the lakehouse -- per the standing rule, a backfill reconciles against chain
-- truth and never trusts an observer's copy, so this table is evidence and a
-- serving stopgap, not an archive.
--
-- ~7,200 rows/day at the chain's 12s cadence; tiny rows, no prune needed
-- before the reconciliation exists.
CREATE TABLE IF NOT EXISTS blocks_head (
  block_number    INTEGER NOT NULL PRIMARY KEY,
  block_hash      TEXT    NOT NULL,
  parent_hash     TEXT,
  extrinsic_count INTEGER,
  observed_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_blocks_head_observed
  ON blocks_head (observed_at DESC);
