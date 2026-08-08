-- Pass completeness for the position ledger (metagraphed-infra#346).
--
-- WHY THIS LANE NEEDS ONE, and why its absence was not obvious. `account_balances`
-- got a pass table (0020) after a truncated load published a leaderboard missing
-- real top holders: 147,000 well-formed rows look exactly like 364,000 of them,
-- only fewer, so a count cannot prove completeness and only the PRODUCER knows
-- how big its scan was. `hotkey_alpha` got one (0021) for the same reason.
--
-- `nominator_positions` never did, and it feeds the same class of surface:
-- /accounts/{ss58}/positions, /subnets/{netuid}/holders, /chain/holders, the
-- positions basis of /validators/{hotkey}/nominators, and `delegated_tao` on the
-- top-holders leaderboard. Those already DECLINE while `hotkey_alpha` has no
-- complete pass -- `pool_totals_unproven` -- because a partial pool ledger
-- silently UNDERPRICES a holder. A partial POSITION ledger is worse in the same
-- direction: it silently DROPS them, and the ranking that results is plausible
-- and wrong.
--
-- It was invisible because the lane moved onto the queue with the gap it already
-- had on the HTTP path. Nothing regressed; it simply never had the gate, and
-- being routed alongside two lanes that do made it look like it did.
--
-- SAME SHAPE AS 0020/0021 deliberately, down to the column names: the producer
-- declares the pass size once, every request adds its own row count, and a pass
-- is complete when the two agree. Three tables with three shapes would be three
-- readers to write.
--
-- ONE ROW PER PASS, keyed on the pass's own captured_at -- stamped once at scan
-- start and repeated across every chunk (validator_nominators.rs). Rows
-- accumulate as requests land, so "in flight", "complete" and "abandoned" stay
-- three distinguishable states rather than one absence.
CREATE TABLE IF NOT EXISTS nominator_positions_passes (
  captured_at   INTEGER NOT NULL,
  expected_rows INTEGER NOT NULL,
  received_rows INTEGER NOT NULL DEFAULT 0,
  -- Epoch-ms of the request that closed the gap. Set exactly once, never
  -- cleared -- the at-least-once transport means received_rows can legitimately
  -- exceed expected_rows on a retry, and the gate asks "did everything arrive",
  -- not "how many times".
  completed_at  INTEGER,
  PRIMARY KEY (captured_at)
);

CREATE INDEX IF NOT EXISTS idx_nominator_positions_passes_completed
  ON nominator_positions_passes (completed_at DESC);

-- The counts lane's twin. It comes from the SAME Alpha scan but lands in a
-- different table behind a different secret, and the two are gated
-- independently by the producer -- so a scan that can refresh one of them is
-- worth running, and each needs to be able to say for itself whether it
-- arrived whole.
--
-- `validator_nominator_counts` feeds the nominator_count on
-- /validators/{hotkey}/nominators. A short pass there under-reports how many
-- delegators a validator has, which reads as a validator losing support rather
-- than as a load that did not finish.
CREATE TABLE IF NOT EXISTS validator_nominator_counts_passes (
  captured_at   INTEGER NOT NULL,
  expected_rows INTEGER NOT NULL,
  received_rows INTEGER NOT NULL DEFAULT 0,
  completed_at  INTEGER,
  PRIMARY KEY (captured_at)
);

CREATE INDEX IF NOT EXISTS idx_validator_nominator_counts_passes_completed
  ON validator_nominator_counts_passes (completed_at DESC);
