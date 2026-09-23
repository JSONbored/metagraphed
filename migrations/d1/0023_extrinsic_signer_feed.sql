-- Account feeds seek one signer in their existing deterministic page order.
CREATE INDEX IF NOT EXISTS idx_chain_detail_extrinsics_signer_feed
ON chain_detail_extrinsics (signer, observed_at DESC, block_number DESC, extrinsic_index DESC)
WHERE signer IS NOT NULL;
