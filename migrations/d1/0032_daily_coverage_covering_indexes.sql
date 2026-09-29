-- Daily coverage needs only date, subnet and shard. The prior date indexes
-- omitted shard, forcing a primary-table lookup for every historical member.
-- Account document date discovery also scanned the payload-bearing table.
-- Build replacements before removing the narrower indexes.
CREATE INDEX neuron_daily_members_date_shard_idx
ON neuron_daily_members(snapshot_date,netuid,shard);
-- statement-breakpoint
CREATE INDEX account_position_daily_members_date_shard_idx
ON account_position_daily_members(snapshot_date,netuid,shard);
-- statement-breakpoint
CREATE INDEX account_position_daily_documents_day_idx
ON account_position_daily_documents(day,netuid,shard);
-- statement-breakpoint
DROP INDEX neuron_daily_members_snapshot_date_netuid_idx;
-- statement-breakpoint
DROP INDEX account_position_daily_members_snapshot_date_netuid_idx;
