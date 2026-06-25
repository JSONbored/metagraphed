-- Bound account-summary signing activity by efficiently reading the newest rows
-- for one signer before aggregating modules/fees (#1847 DoS hardening).
CREATE INDEX IF NOT EXISTS idx_extrinsics_signer_recent
  ON extrinsics (signer, block_number DESC, extrinsic_index DESC);
