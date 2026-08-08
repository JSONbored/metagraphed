-- Raw-capture watermark: the one durable fact behind the no-gap guarantee.
--
-- Exactly one row (id = 1). `last_contiguous_block` means "every block at or
-- below this height is durably written to R2" -- see src/raw-chain-capture.ts
-- for why that phrasing is load-bearing: the watermark advances ONLY across a
-- prefix that was actually written, so it can never claim a block that is not
-- in the store, and capture always resumes at watermark+1.
--
-- Bounded by construction (one row), which is why this belongs in D1 while the
-- captured bytes themselves go to R2 -- chain-scale data never goes to D1.
--
-- Lag is a QUERY, not a hope: compare last_contiguous_block against the chain
-- head. `last_error` / `stopped_at` record why a tick stopped short, so a lane
-- that is quietly failing looks different from one that is merely behind.
CREATE TABLE IF NOT EXISTS raw_capture_state (
  id                    INTEGER PRIMARY KEY CHECK (id = 1),
  last_contiguous_block INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL,
  stopped_at            INTEGER,
  last_error            TEXT
);
