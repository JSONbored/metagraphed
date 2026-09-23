-- Module-filtered recent history must not scan all retained extrinsics.
CREATE INDEX idx_chain_detail_extrinsics_module_observed
 ON chain_detail_extrinsics(call_module, observed_at DESC, block_number DESC, extrinsic_index DESC);
