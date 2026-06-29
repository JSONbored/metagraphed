-- Track a feed-oriented module index by the stable naming used by issue #2082.
-- Keep the leading columns aligned to the hottest filter + newest-first ordering.

DROP INDEX IF EXISTS idx_extrinsics_call_module_order;

CREATE INDEX IF NOT EXISTS idx_extrinsics_module_block
  ON extrinsics (call_module, block_number DESC, extrinsic_index DESC);
