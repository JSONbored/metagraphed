-- Back the conjunctive /api/v1/blocks filters (#1991) so the new equality
-- predicates seek instead of scanning the retained 365-day blocks window
-- (BLOCK_RETENTION_MS, src/blocks.mjs). Additive + idempotent; the handler
-- already tolerates these indexes being absent (d1All scans, never throws),
-- so this can be applied out-of-band after the code ships.

-- ?author=<ss58>: equality over the full window.
CREATE INDEX IF NOT EXISTS idx_blocks_author ON blocks (author);

-- ?spec_version=<n> [+ newest-first]: seek the runtime era, then PK-order so the
-- common "this spec_version, latest blocks" read is index-ordered.
CREATE INDEX IF NOT EXISTS idx_blocks_spec_version
  ON blocks (spec_version, block_number DESC);

-- min_extrinsics / min_events are open-ended >= predicates with no selective
-- index in isolation (they pair with a range that already seeks) — deliberately
-- left unindexed, the same posture as the extrinsics `success` filter.
