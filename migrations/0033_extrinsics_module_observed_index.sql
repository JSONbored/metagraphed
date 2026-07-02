-- Bounded call_module-scoped chain-fee median scans (#2492 follow-up).
-- The median query emits one observed_at day range per safe day.  Scoped
-- requests also filter by call_module, so give D1 a matching composite access
-- path instead of scanning the feed-oriented module/block index once per day.

CREATE INDEX IF NOT EXISTS idx_extrinsics_module_observed
  ON extrinsics (call_module, observed_at);
