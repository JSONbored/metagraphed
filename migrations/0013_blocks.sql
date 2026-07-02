-- Block explorer hot window (#1345 epic, first vertical slice): the D1 `blocks`
-- table — first-party per-block headers decoded DIRECTLY from finney by the same
-- chain-direct poller (scripts/fetch-events.py) that fills account_events, NOT
-- Taostats. The poller runs in CI over a rolling window of recent FINALIZED
-- blocks, emits a `blocks` sidecar alongside the events JSON, stages it to R2, and
-- the Worker loads it here via its D1 binding (loadStagedBlocks) with PARAMETERIZED
-- INSERT OR IGNORE keyed on block_number — so overlapping windows re-insert
-- harmlessly (idempotent). Powers /api/v1/blocks + /api/v1/blocks/{ref} (recent
-- feed + per-block detail).
--
-- Hot-window only: like account_events, rows older than the 90-day retention are
-- pruned. Deep block history is the optional archive-RPC upgrade (#1349).
--
-- Units: block_number/extrinsic_count/event_count as-is. observed_at = block
-- timestamp (epoch ms, matches account_events.observed_at). author/parent_hash are
-- best-effort (nullable) — a per-block extras failure in the poller never blocks
-- the core row.

CREATE TABLE IF NOT EXISTS blocks (
  block_number    INTEGER PRIMARY KEY,        -- finalized block height
  block_hash      TEXT    UNIQUE,             -- 0x… header hash
  parent_hash     TEXT,                       -- 0x… parent header hash
  author          TEXT,                       -- block author ss58, best-effort/null
  extrinsic_count INTEGER,                    -- extrinsics in the block, best-effort
  event_count     INTEGER,                    -- decoded System.Events in the block
  observed_at     INTEGER NOT NULL            -- block timestamp, epoch ms
);

-- Lookup by hash (the /api/v1/blocks/{ref} 0x path).
CREATE INDEX IF NOT EXISTS idx_blocks_hash ON blocks (block_hash);
-- Recent-feed ordering + the retention prune scan.
CREATE INDEX IF NOT EXISTS idx_blocks_observed ON blocks (observed_at);
