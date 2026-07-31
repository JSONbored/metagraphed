-- Gate the chain-firehose triggers to recent rows only.
--
-- enqueue_chain_firehose() runs FOR EACH ROW and, per row, does a
-- DELETE ... WHERE created_at < now() - 1 hour plus an
-- ORDER BY id DESC OFFSET 4999 ... DELETE over chain_firehose_outbox before
-- inserting. That is affordable at live rate (a few rows per 12s block); it
-- is ruinous for a historical backfill inserting millions of rows.
--
-- Measured on meta-indexer-01 2026-07-31 via EXPLAIN ANALYZE of the indexer's
-- own flush statement: inserting 500 rows into `blocks` took 63,242ms, of
-- which the insert itself was 13ms and trg_blocks_firehose was 63,228ms --
-- 99.98% of the runtime, ~126ms per row.
--
-- The firehose broadcasts LIVE chain activity to subscribers; replaying 2023
-- blocks through it has no consumer and is not wanted. A WHEN clause is
-- evaluated by the executor WITHOUT entering the function body, so historical
-- rows now cost nothing while live rows behave exactly as before.
--
-- 10 minutes of slack (600000 ms) rather than a tight bound: live-follow can
-- legitimately lag the chain head briefly (reconnects, restarts) and those
-- rows must still reach the firehose.
BEGIN;

DROP TRIGGER IF EXISTS trg_blocks_firehose ON blocks;
CREATE TRIGGER trg_blocks_firehose AFTER INSERT ON blocks
  FOR EACH ROW
  WHEN (NEW.observed_at > (extract(epoch from now()) * 1000)::bigint - 600000)
  EXECUTE FUNCTION enqueue_chain_firehose('blocks');

DROP TRIGGER IF EXISTS trg_extrinsics_firehose ON extrinsics;
CREATE TRIGGER trg_extrinsics_firehose AFTER INSERT ON extrinsics
  FOR EACH ROW
  WHEN (NEW.observed_at > (extract(epoch from now()) * 1000)::bigint - 600000)
  EXECUTE FUNCTION enqueue_chain_firehose('extrinsics');

DROP TRIGGER IF EXISTS trg_chain_events_firehose ON chain_events;
CREATE TRIGGER trg_chain_events_firehose AFTER INSERT ON chain_events
  FOR EACH ROW
  WHEN (NEW.observed_at > (extract(epoch from now()) * 1000)::bigint - 600000)
  EXECUTE FUNCTION enqueue_chain_firehose('chain_events');

DROP TRIGGER IF EXISTS trg_account_events_firehose ON account_events;
CREATE TRIGGER trg_account_events_firehose AFTER INSERT ON account_events
  FOR EACH ROW
  WHEN (NEW.observed_at > (extract(epoch from now()) * 1000)::bigint - 600000)
  EXECUTE FUNCTION enqueue_chain_firehose('account_events');

COMMIT;
