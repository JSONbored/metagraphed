-- Back the public /api/v1/blocks count-floor filters so high/no-match
-- ?min_extrinsics and ?min_events predicates seek instead of scanning the
-- retained blocks window. Additive + idempotent; handler-side no-match guards
-- remain the first line of defense for impossible values.

CREATE INDEX IF NOT EXISTS idx_blocks_extrinsic_count
  ON blocks (extrinsic_count, block_number DESC);

CREATE INDEX IF NOT EXISTS idx_blocks_event_count
  ON blocks (event_count, block_number DESC);
