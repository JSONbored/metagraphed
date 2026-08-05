-- The account-balances lane on D1 (#9478), the LAST of the frozen
-- account-tier ledgers to get a Cloudflare-native sink.
--
-- WHY THIS LANE IS WORSE OFF THAN THE ONES 0011/0012 REVIVED. Those two had a
-- frozen export in the lakehouse to fall back on. `account_balances` never had
-- a D1 table AT ALL: it lived only in the decommissioned box's Postgres, so
-- when that box went the whole column went with it. /api/v1/accounts/top-holders
-- has answered from src/top-holders-artifact.ts's one-shot materialization of
-- the old query (taken 2026-08-02) ever since, with a `captured_at` that cannot
-- advance -- an account that has moved TAO since is misreported, and one first
-- funded since is absent entirely. This table is where the revived poller lane
-- lands instead.
--
-- The producer never went away and never stopped being correct. metagraphed-infra's
-- services/indexer-rs/src/bin/poller/jobs/account_balances.rs still scans
-- System::Account page by page, exactly as it always did; it was writing the
-- result into a `tokio_postgres` connection to an instance that no longer
-- exists. As with 0011/0012, only the write TARGET changes -- the scan itself
-- needs no rehosting.
--
-- SIZE: 542,618 System::Account entries at the producer's own last live
-- measurement (2026-07-19, against our own fullnode), of which only the ones
-- with a nonzero free or reserved balance are sent (see the NO PRUNE note
-- below). That is far past any single request body, so the producer chunks its
-- pass across ~22 requests at the sync route's 25,000-row cap.
--
-- NO PRUNE, and for account_identity's reason in 0009 rather than
-- validator_nominator_counts' in 0012. The producer deliberately SKIPS an
-- account whose free and reserved are both zero (existential-deposit-only and
-- reaped accounts carry a real System::Account entry full of zeros), so
-- "absent from the scan" here does not mean "has no balance" -- it means
-- "was not written". A prune would therefore delete exactly the accounts that
-- emptied their wallet, which is a fact worth keeping. This table has always
-- been "every account that has EVER held a balance", never "every account with
-- a balance right now", and both the producer's own header and the retired
-- Postgres handler said so.
--
-- Type translation follows 0007_neurons.sql / 0011_nominator_positions.sql:
--   ss58                    -> TEXT (SS58 address)
--   free_tao / reserved_tao -> REAL
--   captured_at             -> INTEGER epoch-ms
--
-- REAL, not TEXT, and the tradeoff is deliberate. The producer computes an
-- EXACT decimal string (backfill_rs::rao_to_tao_exact) because `rao as f64 /
-- 1e9` starts losing sub-rao precision above 2**53 rao (~9.007M TAO). Storing
-- that string verbatim would preserve it -- and make every ranking query sort
-- lexicographically, so "9" would outrank "10". The whole point of this column
-- is a leaderboard, and the serve path (src/top-holders.ts's `numberOrZero`)
-- already narrows to an f64 before anything is published, so TEXT would buy
-- precision no caller can observe at the cost of the one query shape that
-- matters.
--
-- HOW MUCH HEADROOM, MEASURED RATHER THAN ASSUMED. REAL holds every rao exactly
-- below 2**53 rao = 9,007,199.254740992 TAO. The largest free balance the served
-- leaderboard carries is 5,448,995.87 TAO (read 2026-08-05), so the margin is
-- ~1.65x -- not the order of magnitude a 21M total supply might suggest. It is
-- stated as the measurement because it is close enough that a future reader
-- should re-check it rather than trust this line: a single account past 9.007M
-- TAO would start losing sub-rao precision here, which is a reason to revisit
-- the column type, not a reason to panic (the loss is below one rao on a
-- multi-million-TAO figure, and the serve path narrows to the same f64 anyway).
--
-- Latest-only, upserted on (ss58) with the same `captured_at <=
-- excluded.captured_at` staleness guard every other D1 sync lane uses. The
-- guard is what makes a chunked pass safe: the producer re-sends on failure,
-- so a replayed or out-of-order request must be a no-op rather than a
-- regression to an older balance.
--
-- The column set is NOT transcribed by hand from the destroyed Postgres
-- schema: it is exactly the list the writer binds,
-- ACCOUNT_BALANCE_INSERT_COLUMNS (src/account-balances-d1-write.ts), and
-- tests/d1-schema-drift.test.ts asserts that correspondence -- the same
-- anti-drift guarantee as 0007's tests/neurons-d1-schema.test.ts and 0011/0012's
-- own.
CREATE TABLE IF NOT EXISTS account_balances (
  ss58         TEXT    NOT NULL,
  free_tao     REAL    NOT NULL,
  reserved_tao REAL    NOT NULL,
  captured_at  INTEGER NOT NULL,
  PRIMARY KEY (ss58)
);

-- The staleness watchdog asks for the ledger's own capture stamp
-- (MAX(captured_at) over the whole table) on every tick, which without an index
-- is a full scan of ~540k rows twice an hour. This index makes it a single seek
-- to the tail -- the same reason 0011 declares one on nominator_positions.
--
-- No ranking index is declared here. The leaderboard's read shape belongs to
-- the reader that composes it, and this repo already separates those concerns
-- deliberately: 0007_neurons.sql created the table and 0008_neurons_read_indexes.sql
-- added the indexes its queries turned out to want. Guessing at a `free_tao
-- DESC` index before a query exists to use it would put a second B-tree over
-- 540k rows on the chance that it helps.
CREATE INDEX IF NOT EXISTS idx_account_balances_captured_at
  ON account_balances (captured_at DESC);
