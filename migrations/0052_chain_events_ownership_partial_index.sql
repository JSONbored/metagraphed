-- #8970: the SubnetOwnerChanged history routes cannot be time-bounded.
--
-- /api/v1/subnets/{netuid}/ownership-history, /api/v1/accounts/{coldkey}/entities,
-- and the conviction / lease-history routes built on the same stream all query
-- ALL history by design -- an ownership timeline that starts three days ago is
-- not an ownership timeline. So unlike chain-events/stats (fixed by translating
-- its block window onto the observed_at partition column), these have no
-- correct time predicate to add.
--
-- What they do have is extreme selectivity: SubnetOwnerChanged is a few
-- thousand rows out of ~723M. idx_ce_pallet_method leads on (pallet, method)
-- and does serve the lookup, but it indexes every row in the table, so each
-- chunk's index must still be descended and the JSONB netuid filter is applied
-- afterwards. A PARTIAL index over just this event stream is a rounding error
-- in size and lets the planner read only matching rows.
--
-- Idempotent, like every migration here. Safe to re-run.
CREATE INDEX IF NOT EXISTS idx_ce_owner_changed
  ON chain_events (block_number ASC)
  WHERE pallet = 'SubtensorModule' AND method = 'SubnetOwnerChanged';
