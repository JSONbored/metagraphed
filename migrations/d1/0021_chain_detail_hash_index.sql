-- Hash absence checks must include mixed-case payloads without scanning hot history.
CREATE INDEX idx_chain_detail_blocks_hash_lower
 ON chain_detail_blocks(lower(block_hash));
