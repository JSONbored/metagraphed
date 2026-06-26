-- Harden the public /api/v1/extrinsics feed filters (#1846) against D1
-- scan amplification. The route ANDs optional equality/range predicates with a
-- fixed newest-first ORDER BY on (block_number, extrinsic_index); without
-- filter+order indexes, no-match calls such as call_module=__never__ can walk
-- the retained hot-window table before returning an empty page.

-- Equality filters aligned with the feed order.
CREATE INDEX IF NOT EXISTS idx_extrinsics_signer_order
  ON extrinsics (signer, block_number DESC, extrinsic_index DESC);
CREATE INDEX IF NOT EXISTS idx_extrinsics_call_module_order
  ON extrinsics (call_module, block_number DESC, extrinsic_index DESC);
CREATE INDEX IF NOT EXISTS idx_extrinsics_call_function_order
  ON extrinsics (call_function, block_number DESC, extrinsic_index DESC);
CREATE INDEX IF NOT EXISTS idx_extrinsics_success_order
  ON extrinsics (success, block_number DESC, extrinsic_index DESC);

-- Observed-at ranges are public filters too. Include the feed order columns so
-- impossible/highly selective ranges can seek the timestamp index instead of
-- scanning the primary-key order to satisfy ORDER BY/LIMIT.
CREATE INDEX IF NOT EXISTS idx_extrinsics_observed_order
  ON extrinsics (observed_at, block_number DESC, extrinsic_index DESC);
