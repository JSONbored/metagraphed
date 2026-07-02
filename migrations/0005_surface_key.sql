-- Stable surface key on the live-health tables (#1005 PR2).
--
-- `surface.key` (srf-<hash of netuid|kind|url>) is invariant across display-name
-- / slug renames; the hand-authored `surface_id` is author-controlled, so a
-- rename changes it and ORPHANS the surface's D1 probe history (history is keyed
-- on surface_id). This adds `surface_key` as an additive column (+ indexes) on
-- all three live-health tables. The prober backfills it on every write
-- (surface_status' ON CONFLICT(surface_id) UPDATE SET surface_key=...); the
-- serving cutover to JOIN on surface_key (so renames preserve history) lands in
-- PR3.
--
-- ALTER TABLE ... ADD COLUMN is non-destructive in SQLite (no table rebuild, no
-- data loss, no default backfill cost). Apply to the prod metagraphed-health D1
-- BEFORE the prober code that writes the column deploys, so a missing column can
-- never make the (try/catch-wrapped) write path silently drop health rows.

ALTER TABLE surface_checks ADD COLUMN surface_key TEXT;
ALTER TABLE surface_status ADD COLUMN surface_key TEXT;
ALTER TABLE surface_uptime_daily ADD COLUMN surface_key TEXT;

CREATE INDEX IF NOT EXISTS idx_surface_checks_key_time
  ON surface_checks (surface_key, checked_at);
CREATE INDEX IF NOT EXISTS idx_surface_status_key
  ON surface_status (surface_key);
CREATE INDEX IF NOT EXISTS idx_surface_uptime_daily_key_day
  ON surface_uptime_daily (surface_key, day);
