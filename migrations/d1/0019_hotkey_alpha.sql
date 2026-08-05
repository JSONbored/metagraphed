-- The (hotkey, netuid) alpha-pool ledger (#9502) -- the input `delegated_tao`
-- needs and neither store has.
--
-- WHY THIS TABLE HAS TO EXIST. `nominator_positions.share_fraction` is
-- dimensionless: a coldkey's slice of a (hotkey, netuid) alpha POOL. Valuing a
-- position needs that pool's total, and the only stake figure in D1 is
-- `neurons.stake_tao`, which exists solely for hotkeys holding a UID on that
-- exact subnet. A delegate accrues alpha on every subnet it is staked to,
-- registered there or not, so the join misses most of the ledger. Measured
-- against production 2026-08-05 (#9502):
--
--   distinct hotkeys in nominator_positions        13,724
--   ...present in neurons at all                      979
--   ...present on the matching (hotkey, netuid)        512
--   position rows that price                28,902/126,508  (22.8%)
--   coldkeys that price                       6,673/24,121  (27.7%)
--
-- `validator_nominator_counts` -- the sibling output of the same Alpha scan --
-- holds 112,250 hotkeys against `neurons`' 21,635, which is the same fact seen
-- from the other side.
--
-- WHY A LABEL WAS NOT ENOUGH. The per-account route already reports the gap
-- honestly (`degraded.reason: positions_unpriceable`,
-- src/account-nominator-positions.ts). A per-row label cannot rescue a
-- RANKING, though: recomputing the leaderboard from those three tables puts an
-- account the frozen snapshot ranks at 81,185 TAO at 0 and drops another out of
-- the payload entirely. A leaderboard confidently wrong about who the top
-- holders are is worse than the frozen one it would replace, which is why
-- #9492 left the column alone rather than shipping it.
--
-- THE INPUT IS ON CHAIN. `SubtensorModule::TotalHotkeyAlpha(hotkey, netuid)
-- -> u64` (alpha in rao), probed live 2026-08-05 and populated;
-- `TotalHotkeyShares` sits alongside it as the denominator share_fraction is
-- already computed against. Neither D1 nor the lakehouse carries either --
-- `chain.total_hotkey_alpha` / `chain.hotkey_alpha` do not exist, and
-- `chain.neurons` has the same registered-only hole.
--
-- SHAPE MIRRORS 0017_account_balances.sql, including its prune posture: the
-- producer skips a zero pool rather than writing a zero row, so "absent from
-- the batch" says nothing about a pool's size and a prune would delete exactly
-- the hotkeys that emptied. Upsert-only on (hotkey, netuid), never deleting.
--
-- `total_alpha` is REAL and holds ALPHA, not TAO: converting to TAO needs the
-- subnet's alpha price, which lives in `subnet_snapshots` on a daily cadence
-- and is the reader's business, not the writer's. Storing the served unit the
-- producer measured keeps this column one hop from the chain -- the same rule
-- 0015_subnet_burn_history.sql's `burn_tao` follows.
--
-- A genuine zero is a real pool size, so this column is NOT NULL and a missing
-- read is an absent ROW, never a zero one -- the distinction #9414 and the
-- burn-history migration both turn on.
CREATE TABLE IF NOT EXISTS hotkey_alpha (
  hotkey      TEXT    NOT NULL,
  netuid      INTEGER NOT NULL,
  total_alpha REAL    NOT NULL,
  -- Epoch MILLISECONDS, like every other captured_at in this database. #9382 is
  -- the standing reminder of what a seconds value does here: read as ms it
  -- lands in 1970, and a staleness guard then pins the row permanently.
  captured_at INTEGER NOT NULL,
  PRIMARY KEY (hotkey, netuid)
);

-- The serving read: price one coldkey's positions, which are looked up by the
-- (hotkey, netuid) pairs those positions name.
CREATE INDEX IF NOT EXISTS idx_hotkey_alpha_netuid
  ON hotkey_alpha (netuid, hotkey);

-- The staleness watchdog scans by capture time across every hotkey.
CREATE INDEX IF NOT EXISTS idx_hotkey_alpha_captured
  ON hotkey_alpha (captured_at);
