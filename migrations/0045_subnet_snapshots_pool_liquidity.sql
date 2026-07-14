-- Pool liquidity + volume time series on subnet_snapshots (#2552).
--
-- tao_in_pool_tao / alpha_in_pool / alpha_out_pool / subnet_volume_tao were
-- already live, point-in-time, on the /api/v1/economics artifact (the 3h KV
-- tier, sourced from MetagraphInfo's tao_in/alpha_in/alpha_out/subnet_volume
-- via scripts/fetch-native-subnets.py's normalize_economics) -- #2552's own
-- "GraphQL declares alpha_in_pool/alpha_out_pool with no backing indexer"
-- framing predates that build and is stale. What was actually missing was a
-- *history* of those same values: subnet_snapshots (#1307/#1302) already
-- rolls up validator_count/total_stake_tao/alpha_price_tao/emission_share
-- daily but never captured pool reserves or volume, so there was no way to
-- derive "net TAO/alpha flow" (a delta over time) even though the reserves
-- themselves were fresh. These four additive nullable columns close that --
-- no new chain indexer required, same source data the live economics tier
-- already ingests every 3h.
ALTER TABLE subnet_snapshots ADD COLUMN tao_in_pool_tao REAL;
ALTER TABLE subnet_snapshots ADD COLUMN alpha_in_pool REAL;
ALTER TABLE subnet_snapshots ADD COLUMN alpha_out_pool REAL;
ALTER TABLE subnet_snapshots ADD COLUMN subnet_volume_tao REAL;
