-- Index the public /api/v1/subnets/{netuid}/events ?kind= filter (#2081) so a
-- kind-scoped query is index-satisfiable instead of a residual post-filter.
-- handleSubnetEvents ANDs an optional event_kind equality onto the per-subnet
-- account_events stream with a fixed newest-first ORDER BY on
-- (block_number, event_index); the only prior usable index
-- (idx_account_events_netuid: netuid, block_number) seeks netuid then tests
-- event_kind row by row, so a rare or absent kind can walk a large share of that
-- subnet's one-year-retained entries before satisfying LIMIT. This composite lets
-- SQLite seek (netuid, event_kind) and read block_number in feed order; the
-- unfiltered netuid-only path keeps using idx_account_events_netuid.
CREATE INDEX IF NOT EXISTS idx_account_events_netuid_kind
  ON account_events (netuid, event_kind, block_number);
