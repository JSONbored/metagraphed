-- Nominator counts per validator hotkey (#2549): distinct coldkeys currently
-- holding a nonzero alpha/root stake position on a hotkey, network-wide.
--
-- Deliberately a SEPARATE side table, not a column on `neurons` (unlike
-- `take`, migration 0042): a nominator count is derived from a full scan of
-- SubtensorModule::Alpha, a per-(hotkey, coldkey, netuid) NMap. Verified live
-- 2026-07-14 against the fullnode: 762,577 total Alpha rows, 112,552
-- distinct hotkeys with any stake, full scan in 249s (~4.2 min) at a
-- sustained ~3000 rows/sec. That's short enough to run daily, but still far
-- more than the fast refresh-metagraph cron's 30-60s budget (TimeoutStartSec
-- 600) can absorb alongside its existing work, so this is populated by its
-- own, separate lower-frequency job (scripts/fetch-validator-nominator-
-- counts.py) and joined into buildGlobalValidators/buildValidatorDetail at
-- serve time — mirrors the featured_validators side-table join pattern
-- (#5166), not neurons' own denormalized-column pattern.
--
-- Latest-only, REPLACE-on-conflict (like account_identity) -- a validator
-- missing from one pass hasn't necessarily lost its nominators, but a stale
-- captured_at is still visible to callers via this table's own timestamp.
CREATE TABLE IF NOT EXISTS validator_nominator_counts (
  hotkey           TEXT    NOT NULL,
  nominator_count  INTEGER NOT NULL,
  captured_at      BIGINT  NOT NULL, -- epoch milliseconds
  PRIMARY KEY (hotkey)
);
