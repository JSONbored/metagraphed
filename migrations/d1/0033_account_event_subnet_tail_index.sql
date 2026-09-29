-- Subnet event feeds must not read every subnet's unindexed tail. Keep block
-- bounds after subnet so an IN selection can perform bounded range seeks.
CREATE INDEX idx_chain_detail_account_events_netuid_block
ON chain_detail_account_events(netuid,block_number,event_kind);
