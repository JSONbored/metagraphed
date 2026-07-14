-- Nominator (coldkey) positions across every hotkey/subnet it stakes to
-- (#5233): the coldkey-scoped counterpart to nominator_count (#2549,
-- migration 0043) -- same source scan, different question. Both are
-- populated by the SAME single SubtensorModule::Alpha full scan
-- (scripts/fetch-validator-nominator-counts.py), so this table lives next
-- to that migration rather than a fresh standalone one.
--
-- share_fraction, NOT stake_tao: Alpha's raw stored value is a fixed-point
-- pool-internal SHARE count, live-verified 2026-07-14 to be ~15,528x a real
-- hotkey's reported stake_tao for one cross-checked (hotkey, netuid) pair --
-- these are proportional shares in that hotkey's stake pool, not a TAO
-- amount. This table stores the normalized fraction (this coldkey's shares
-- / all coldkeys' shares for that hotkey+netuid, which by construction sum
-- to exactly 1.0 per hotkey+netuid) rather than a TAO figure, so it never
-- goes stale relative to the separately-refreshed neurons.stake_tao it's
-- joined against at serve time (src/account-nominator-positions.mjs) --
-- mirrors nominator_count/apy_estimate's own "derive from ingested data at
-- serve time, don't snapshot a derived TAO figure" pattern.
--
-- Root (netuid 0) is NOT covered: every observed root Alpha entry was
-- share=0 in the same live scan (root stake is TAO-denominated 1:1 with no
-- alpha pool, #2550) -- a coldkey that only holds root stake will show no
-- rows here, not zero rows meaning zero stake. See the fetch script's own
-- header comment for the full caveat.
--
-- Latest-only, REPLACE-on-conflict (like validator_nominator_counts) -- a
-- coldkey/hotkey/netuid combination missing from one pass hasn't
-- necessarily lost its position, but a stale captured_at is still visible
-- to callers via this table's own timestamp.
CREATE TABLE IF NOT EXISTS nominator_positions (
  coldkey        TEXT NOT NULL,
  hotkey         TEXT NOT NULL,
  netuid         INTEGER NOT NULL,
  share_fraction REAL NOT NULL,
  captured_at    BIGINT NOT NULL, -- epoch milliseconds
  PRIMARY KEY (coldkey, hotkey, netuid)
);

-- Per-coldkey lookup ("every position this account holds") is the primary
-- access pattern (GET /api/v1/accounts/{ss58}/positions); the primary key
-- itself already covers it as its leading column, so no extra index needed.
