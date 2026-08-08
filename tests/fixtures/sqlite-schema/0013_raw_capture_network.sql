-- Give the raw-capture watermark a network dimension (#8700).
--
-- 0006 declared this table as EXACTLY one row -- `id INTEGER PRIMARY KEY CHECK
-- (id = 1)` -- which was right when one chain was captured and is now the thing
-- blocking a second. The check is not decoration: it is enforced by SQLite, so
-- a testnet watermark cannot be inserted at all until the shape changes.
--
-- Rebuild rather than ALTER, because SQLite cannot change a primary key in
-- place. The existing row becomes 'mainnet' -- it IS the mainnet watermark, so
-- relabelling it is exact, not an assumption. Its `last_contiguous_block` is
-- carried over unchanged, which is the part that must not be lost: resetting it
-- would make the lane re-capture from the floor and, worse, briefly report a
-- gap that does not exist.
--
-- Ordering matters. The INSERT..SELECT runs BEFORE the DROP, so if this
-- migration is interrupted the original table is still intact and the lane
-- keeps running against it.

CREATE TABLE IF NOT EXISTS raw_capture_state_v2 (
  -- The chain these bytes came from. TEXT rather than an integer id so the
  -- value is self-describing in a query result -- 'mainnet' / 'testnet', the
  -- same identifiers src/chain-network.ts uses, so one vocabulary spans the
  -- capture lane, the KV keys and the API's /{network}/ prefix.
  network               TEXT PRIMARY KEY,
  last_contiguous_block INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL,
  stopped_at            INTEGER,
  last_error            TEXT
);

INSERT OR IGNORE INTO raw_capture_state_v2
  (network, last_contiguous_block, updated_at, stopped_at, last_error)
SELECT 'mainnet', last_contiguous_block, updated_at, stopped_at, last_error
FROM raw_capture_state
WHERE id = 1;

DROP TABLE IF EXISTS raw_capture_state;

ALTER TABLE raw_capture_state_v2 RENAME TO raw_capture_state;
