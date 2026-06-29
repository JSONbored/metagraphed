-- Replace the redundant signer-only extrinsics index with a composite index
-- that matches the per-account feed order and supports the summary aggregates.
-- This migration is idempotent and can be applied directly to an existing DB.

DROP INDEX IF EXISTS idx_extrinsics_signer;
DROP INDEX IF EXISTS idx_extrinsics_signer_order;

CREATE INDEX IF NOT EXISTS idx_extrinsics_signer_block
  ON extrinsics (signer, block_number, extrinsic_index);
