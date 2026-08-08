-- captured_at must be MILLISECONDS, enforced by the store (#9782).
--
-- One account_position_daily row carried 1785715160 where every other row
-- carried 1785715160521 -- the same instant with its last three digits gone.
-- `snapshot_date` is derived from `captured_at`, so the row landed under
-- 1970-01-21: outside every served window, inside every COUNT(*), and in an
-- APPEND-ONLY table, so nothing was ever going to revise it. It put that
-- table's date range at `1970-01-21 .. 2026-08-07`.
--
-- The row was deleted after confirming its content was byte-identical to the
-- correctly-stamped 2026-08-02 row for the same (account, netuid) -- it was the
-- same day's later capture, not unique data. The range now reads
-- `2026-07-11 .. 2026-08-08`.
--
-- WHY A CONSTRAINT AS WELL AS THE CODE GUARD. src/neurons-neon-write.ts now
-- drops a row whose stamp is not milliseconds, which stops this at the writer
-- that produced it. A constraint stops it at every OTHER writer, including ones
-- not written yet, and turns a silent wrong date into a failed statement --
-- which is the difference between finding this in two days and finding it in
-- the same second.
--
-- 1e12 is 2001-09-09. A seconds-valued stamp this decade is ~1.79e9, three
-- orders of magnitude below, so nothing legitimate sits near the bound. The
-- same number is EPOCH_MS_FLOOR in src/neurons-neon-write.ts, and
-- tests/epoch-millis-guard.test.ts pins the pair.
--
-- NOT VALID is deliberate and is the reason this is safe to apply to a live
-- table: it takes only a SHARE UPDATE EXCLUSIVE lock, enforces the check on
-- every new row immediately, and does not scan the existing ones. Both tables
-- were verified to hold zero violating rows before this was written, so the
-- VALIDATE below is expected to be a formality -- it is separate so that a
-- surprise there fails on its own line rather than taking the ALTER with it.

ALTER TABLE account_position_daily
  ADD CONSTRAINT account_position_daily_captured_at_is_millis
  CHECK (captured_at >= 1000000000000) NOT VALID;

ALTER TABLE neuron_daily
  ADD CONSTRAINT neuron_daily_captured_at_is_millis
  CHECK (captured_at >= 1000000000000) NOT VALID;

-- Promotes each constraint to fully validated. Takes only a SHARE UPDATE
-- EXCLUSIVE lock, so writes continue while it scans.
ALTER TABLE account_position_daily
  VALIDATE CONSTRAINT account_position_daily_captured_at_is_millis;

ALTER TABLE neuron_daily
  VALIDATE CONSTRAINT neuron_daily_captured_at_is_millis;
