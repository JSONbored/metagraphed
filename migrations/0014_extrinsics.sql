-- Block explorer hot window (#1345 epic, second vertical slice): the D1
-- `extrinsics` table — first-party per-extrinsic (transaction) records decoded
-- DIRECTLY from finney by the same chain-direct poller (scripts/fetch-events.py)
-- that fills account_events + blocks, NOT Taostats. The poller runs in CI over a
-- rolling window of recent FINALIZED blocks, decodes each block's extrinsics,
-- emits an `extrinsics` sidecar alongside the events/blocks JSON, stages it to R2,
-- and the Worker loads it here via its D1 binding (loadStagedExtrinsics) with
-- PARAMETERIZED INSERT OR IGNORE keyed on (block_number, extrinsic_index) — so
-- overlapping windows re-insert harmlessly (idempotent). Powers /api/v1/extrinsics
-- + /api/v1/extrinsics/{hash} (recent feed + per-extrinsic detail).
--
-- Hot-window only: like account_events + blocks, rows older than the 90-day
-- retention are pruned. Deep extrinsic history is the optional archive-RPC upgrade
-- (#1349).
--
-- Units: block_number/extrinsic_index as-is. observed_at = block timestamp (epoch
-- ms, matches account_events.observed_at + blocks.observed_at). extrinsic_hash is
-- the blake2b extrinsic hash (best-effort/null). signer is the ss58 of the signed
-- extrinsic's address (null for inherents/unsigned). call_module/call_function are
-- the decoded pallet call (best-effort/null). success correlates with the block's
-- System.ExtrinsicSuccess/ExtrinsicFailed event for this extrinsic_idx (1/0; null
-- when undeterminable). A per-extrinsic decode failure in the poller skips that
-- row only — it never blocks the core block/event rows.
--
-- v1 deliberately keeps fee/nonce/tip OUT: their nullable decode is fiddly across
-- runtime upgrades and not needed for the first browsing slice. They can be added
-- later as an idempotent ALTER (nullable columns) without re-keying the table.

CREATE TABLE IF NOT EXISTS extrinsics (
  block_number    INTEGER NOT NULL,           -- finalized block height
  extrinsic_index INTEGER NOT NULL,           -- position within the block
  extrinsic_hash  TEXT,                        -- 0x… blake2b extrinsic hash, best-effort/null
  signer          TEXT,                        -- signed extrinsic address ss58, null for inherents
  call_module     TEXT,                        -- pallet name (decoded call), best-effort/null
  call_function   TEXT,                        -- call name (decoded call), best-effort/null
  success         INTEGER,                     -- 1/0 from ExtrinsicSuccess/Failed, null if undeterminable
  observed_at     INTEGER NOT NULL,            -- block timestamp, epoch ms
  PRIMARY KEY (block_number, extrinsic_index)
);

-- Lookup by hash (the /api/v1/extrinsics/{hash} 0x path).
CREATE INDEX IF NOT EXISTS idx_extrinsics_hash ON extrinsics (extrinsic_hash);
-- Filter the feed by signer (account activity).
CREATE INDEX IF NOT EXISTS idx_extrinsics_signer ON extrinsics (signer);
-- Recent-feed ordering + the retention prune scan.
CREATE INDEX IF NOT EXISTS idx_extrinsics_observed ON extrinsics (observed_at);
