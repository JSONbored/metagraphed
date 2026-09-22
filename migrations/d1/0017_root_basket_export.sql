-- Scope discovery before walking capture IDs, including empty/foreign scopes.
CREATE INDEX root_basket_captures_export ON root_basket_captures
  (network, network_genesis_hash, decoder_version, capture_id);
