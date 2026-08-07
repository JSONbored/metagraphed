-- Date-leading keyset indexes on the two accumulating daily tables (infra#336).
--
-- The D1 -> Neon reconciler (src/neon-backfill.ts) walks one snapshot_date at a
-- time, paging on that table's primary key minus the date:
--
--     WHERE snapshot_date = ? AND (netuid > ? OR (netuid = ? AND uid > ?))
--     ORDER BY netuid, uid LIMIT ?
--
-- Both halves of that -- the seek and the ordering -- have to come from one
-- index, or the query degrades in a way that scales with the whole table rather
-- than with one day of it.
--
-- ## account_position_daily had NO date-leading index at all
--
-- PRIMARY KEY (account, netuid, snapshot_date) and
-- idx_account_position_daily_account_date (account, snapshot_date) both lead
-- with `account`, so `WHERE snapshot_date = ?` is not a prefix of either and
-- falls back to a full scan -- 834,081 rows measured 2026-08-07, per page. The
-- reconciler reads ~167 pages per date, so without this index one date costs
-- ~139M rows read. With it, one date costs one date.
--
-- ## neuron_daily's existing index stops one column short
--
-- idx_neuron_daily_date_netuid (snapshot_date, netuid) seeks the date and
-- orders by netuid, but not by `uid` within a netuid -- so SQLite either sorts
-- each page or walks the PRIMARY KEY across every date to get the order for
-- free. Adding `uid` as a third column removes that choice.
--
-- The narrower index is then DROPPED rather than kept: (snapshot_date, netuid)
-- is a strict prefix of (snapshot_date, netuid, uid), so every lookup it served
-- the wider one serves identically. Keeping both would cost a second index
-- write on all ~32,000 rows this table gains each day, in exchange for nothing.
--
-- Purely additive to the schema otherwise: no column, constraint or table
-- changes, so the reads that exist today keep working through the migration.
CREATE INDEX IF NOT EXISTS idx_neuron_daily_date_netuid_uid
  ON neuron_daily (snapshot_date, netuid, uid);

DROP INDEX IF EXISTS idx_neuron_daily_date_netuid;

CREATE INDEX IF NOT EXISTS idx_account_position_daily_date_account
  ON account_position_daily (snapshot_date, account, netuid);
