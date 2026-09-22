-- Join each bounded daily document to its own members, rather than rescanning
-- the subnet's entire membership history for every day/shard (#12175).
CREATE INDEX neuron_daily_members_subnet_day_shard_idx
ON neuron_daily_members(netuid,snapshot_date DESC,shard,uid,hotkey,coldkey);
