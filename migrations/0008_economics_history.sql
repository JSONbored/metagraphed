-- Time-series economics (#1307, epic #1302): capture per-subnet economic metrics
-- into the existing daily subnet_snapshots rollup so the trajectory time series
-- (/api/v1/subnets/{netuid}/trajectory) carries economic trends (alpha price,
-- stake, validator/miner counts, emission share) alongside the structural ones.
-- Additive nullable columns — existing rows and the structural trajectory are
-- unaffected; history accrues from the first daily snapshot after this lands.
ALTER TABLE subnet_snapshots ADD COLUMN validator_count INTEGER;
ALTER TABLE subnet_snapshots ADD COLUMN miner_count INTEGER;
ALTER TABLE subnet_snapshots ADD COLUMN total_stake_tao REAL;
ALTER TABLE subnet_snapshots ADD COLUMN alpha_price_tao REAL;
ALTER TABLE subnet_snapshots ADD COLUMN emission_share REAL;
