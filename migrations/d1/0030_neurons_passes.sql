-- Pass completeness for the metagraph snapshot (#9812).
--
-- WHY THIS LANE NEEDS ONE, and why it looked like it did not. The three lanes
-- that already have a pass table (0020 account_balances, 0021 hotkey_alpha,
-- 0029 the two nominator tables) are flat keyspace scans, and the argument for
-- gating them was that a short load and a small one are indistinguishable.
-- `neurons` was left out on the reasoning -- written down in
-- src/sync-batch-queue.ts -- that "its producer NEVER chunks", so the whole
-- snapshot arrives in one POST or none of it does.
--
-- THAT IS NO LONGER TRUE. metagraph.rs packs its snapshot into ~7+ requests
-- grouped by netuid (its own test asserts `chunks.len() >= 7`), and the posting
-- loop CONTINUES past a failed chunk before bailing at the end:
--
--     Ok(())  => posted += 1,
--     Err(e)  => failures.push(...)
--
-- So the netuids in the chunks that succeeded are already written with
-- captured_at advanced, while the rest keep an older stamp. The lane reports
-- failure; the table does not.
--
-- NOT HYPOTHETICAL. The comment directly above that loop records it happening:
-- "pass stopped there. The 108 subnets behind it kept a stamp that was by then
-- 30 hours old."
--
-- MAX(captured_at) CANNOT SUBSTITUTE, and this is the specific trap: it
-- reflects only the netuids that DID land, so a pass covering 21 of 129 subnets
-- leaves a perfectly fresh-looking stamp behind it. That is the same shape as
-- the 147,000-row account_balances incident this whole mechanism came from.
--
-- ROWS, NOT NETUIDS, and the reason is that the producer BUFFERS the whole
-- snapshot before packing it. It therefore knows the exact row total in advance
-- -- there is no estimate involved -- and an exact total detects a missing
-- netuid just as surely as a netuid count would (30,110 expected against 29,854
-- received never completes), while keeping all five pass tables one shape for
-- one reader (src/pass-completeness.ts).
--
-- SAME COLUMNS AS 0020/0021/0029 deliberately, down to the names, because
-- `latestCompletePass` and `passTallyStatement` interpolate the table name into
-- otherwise identical SQL. Five tables with five shapes would be five readers.
CREATE TABLE IF NOT EXISTS neurons_passes (
  captured_at   INTEGER NOT NULL,
  expected_rows INTEGER NOT NULL,
  received_rows INTEGER NOT NULL DEFAULT 0,
  -- Epoch-ms of the request that closed the gap. Set exactly once, never
  -- cleared -- the at-least-once transport means received_rows can legitimately
  -- exceed expected_rows on a retry, and the gate asks "did everything arrive",
  -- not "how many times". Observed live on 2026-08-07: an account_balances pass
  -- recorded 372,569 received against 364,819 expected and is correctly
  -- COMPLETE.
  completed_at  INTEGER,
  PRIMARY KEY (captured_at)
);

CREATE INDEX IF NOT EXISTS idx_neurons_passes_completed
  ON neurons_passes (completed_at DESC);
