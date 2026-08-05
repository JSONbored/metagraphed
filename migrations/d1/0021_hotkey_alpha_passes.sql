-- Completeness marker for the hotkey-alpha lane (#9502), the twin of
-- 0020_account_balances_passes.sql.
--
-- WHY THIS LANE NEEDS ONE MORE THAN THE BALANCE LEDGER DID, not less.
--
-- 0020 exists because "is this load complete?" is not observable in
-- `account_balances`: 147,000 well-formed rows look exactly like 542,618 of
-- them, only fewer. `hotkey_alpha` is worse in two ways.
--
--   1. THE SHORTFALL IS SILENT RATHER THAN VISIBLE. A missing account is
--      absent from a leaderboard, which is at least a hole someone can notice.
--      A missing POOL total is not absent from anything -- it prices the
--      positions that name it against nothing, so those coldkeys' delegated_tao
--      comes out merely too LOW. Underpricing looks like data. The ranking is
--      well-formed, plausible, and wrong, and nothing about the row says so.
--
--   2. ABSENCE IS AMBIGUOUS BY DESIGN, so a reader cannot recover completeness
--      by counting even in principle. 0019's producer SKIPS a genuine zero pool
--      rather than writing a zero row, so "no row for this (hotkey, netuid)"
--      means either "scanned, and the pool is empty" or "never scanned". Those
--      demand opposite treatments -- the first is a true zero contribution, the
--      second must decline the whole ranking -- and no query can tell them
--      apart. For `account_balances` a coverage ratio against a known keyspace
--      was at least conceivable; here it is not. Only the writer knows.
--
-- WHAT THE PRODUCER'S OWN FLOOR DOES AND DOES NOT COVER. The job buffers its
-- whole walk before posting (metagraphed-infra#318, inheriting #316's shape), so
-- a truncated SCAN publishes nothing. The same two holes 0020 names survive it
-- here, and the second is wider:
--
--   1. A FAILED POST MID-SEQUENCE leaves the earlier chunks committed under a
--      fresh captured_at while the job returns Err.
--   2. THE FLOOR IS 10% of the sibling `Alpha` count (762,577), not 80%.
--      `TotalHotkeyAlpha` is keyed by a SUBSET of `Alpha`'s key --
--      (hotkey, netuid) against (coldkey, hotkey, netuid) -- so its true size is
--      a fraction of that and an 80% floor would reject every healthy pass. The
--      choice is right and the consequence is a wide band: anything above ~10%
--      of 762,577 publishes legitimately, and "cleared the floor" is a long way
--      from "covers everything".
--
-- So the producer declares, on every request of a pass, how many rows that pass
-- will deliver -- knowable because it buffers -- and every request adds its own
-- count. A pass is complete when the two agree. Nothing infers completeness;
-- the writer states it and the arithmetic checks it.
--
-- ONE ROW PER PASS, keyed on the pass's own captured_at, which the producer
-- stamps once at scan start and repeats across every chunk. Rows accumulate as
-- requests land, so "in flight", "complete" and "abandoned" stay three
-- distinguishable states rather than one.
--
-- NO PRUNE, matching the ledger it describes. A few rows a day is nothing, and
-- the history is what makes "how long has this lane been landing partial
-- passes?" answerable at all.
CREATE TABLE IF NOT EXISTS hotkey_alpha_passes (
  captured_at   INTEGER NOT NULL,
  expected_rows INTEGER NOT NULL,
  received_rows INTEGER NOT NULL DEFAULT 0,
  -- Epoch-ms of the request that completed the pass, NULL while it is still in
  -- flight or if it never finished. This is the column a reader keys on: it is
  -- set exactly once, by the request that brings received_rows up to
  -- expected_rows, and is never cleared afterwards.
  completed_at  INTEGER,
  PRIMARY KEY (captured_at)
);

-- The reader's only query shape: newest COMPLETE pass. Without this the lookup
-- is a full scan of the pass history on every daily lane run -- small today and
-- unbounded by design, since this table never prunes.
CREATE INDEX IF NOT EXISTS idx_hotkey_alpha_passes_completed
  ON hotkey_alpha_passes (completed_at DESC);
