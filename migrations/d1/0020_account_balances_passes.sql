-- Completeness marker for the account-balances lane (#9511).
--
-- WHY A SEPARATE TABLE RATHER THAN A COLUMN. "Is this load complete?" is not
-- observable in `account_balances` itself, and that is the entire problem
-- #9511 reports: 147,000 well-formed rows look exactly like 542,618
-- well-formed rows, only fewer. A reader ranking `ORDER BY free_tao DESC`
-- over a partial table returns the largest balances PRESENT rather than the
-- largest that EXIST -- a well-formed leaderboard quietly missing its #2, which
-- is what production served after the truncated pass on 2026-08-05.
--
-- The emptiness check the serving side has today (`results.length === 0`)
-- cannot close this. 147,000 rows clear it.
--
-- WHAT THE PRODUCER'S OWN GATE DOES AND DOES NOT COVER. metagraphed-infra#316
-- made the poller buffer its whole walk before posting anything, so a
-- TRUNCATED SCAN now publishes nothing at all -- the failure that actually
-- happened cannot recur. Two holes survive that fix, and this table is for
-- them:
--
--   1. A FAILED POST MID-SEQUENCE. A full pass is ~15 requests. If request 7
--      fails, requests 1-6 are already committed under a fresh captured_at and
--      the job returns Err -- leaving exactly the partial-load-that-looks-fresh
--      shape, from a scan that was complete.
--   2. THE FLOOR IS 80%. A pass covering 80-99% of the keyspace clears
--      MIN_ACCOUNT_SCAN_ROWS and publishes legitimately. That is the right
--      call for a network that grew (an absolute floor would need editing every
--      time it did), but "cleared the floor" is not "covers everything".
--
-- So the producer declares, in its FIRST request of a pass, how many rows that
-- pass will deliver -- a number it knows because it buffers before posting --
-- and every request adds its own row count. A pass is complete when the two
-- agree. Nothing infers completeness; the writer states it and the arithmetic
-- checks it.
--
-- ONE ROW PER PASS, keyed on the pass's own captured_at, which the producer
-- stamps once at scan start and repeats across every chunk (see
-- account_balances.rs). Rows accumulate as requests land, so a reader can tell
-- "in flight" from "complete" from "abandoned" -- all three are different
-- things, and the middle one is the one that used to be invisible.
--
-- NO PRUNE here either, matching the ledger it describes. A handful of rows a
-- day is nothing, and the history is what makes "how long has this lane been
-- landing partial passes?" answerable at all.
CREATE TABLE IF NOT EXISTS account_balances_passes (
  captured_at   INTEGER NOT NULL,
  expected_rows INTEGER NOT NULL,
  received_rows INTEGER NOT NULL DEFAULT 0,
  -- Epoch-ms of the request that completed the pass, NULL while it is still in
  -- flight or if it never finished. This is the column a reader keys on: it is
  -- set exactly once, by the request that brings received_rows up to
  -- expected_rows.
  completed_at  INTEGER,
  PRIMARY KEY (captured_at)
);

-- The reader's only query shape: "the newest COMPLETE pass". A partial index
-- would be tighter, but D1/SQLite serves this fine from a small table and the
-- ledger it guards is the thing with half a million rows, not this.
CREATE INDEX IF NOT EXISTS idx_account_balances_passes_completed
  ON account_balances_passes (completed_at DESC);
