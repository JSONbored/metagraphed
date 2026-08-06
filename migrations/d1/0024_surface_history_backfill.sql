-- Make the surface audit trail identifiable and queryable (#9612).
--
-- WHAT WAS BROKEN. `surface_history` records every insert/update/delete of a
-- registry surface, stamped with the source commit -- an audit trail whose whole
-- job is answering "which surface changed, when, and in which commit". The
-- upsert path in workers/registry-sync-api.ts omitted `surface_id` from its
-- INSERT column list entirely, so only the DELETE path ever recorded one.
-- Measured 2026-08-06: 61 of 8,892 rows carried an id. The other 8,831 could say
-- a subnet changed and not which of its surfaces.
--
-- WHY THIS IS RECOVERABLE RATHER THAN LOST. The `overlay` blob each row stores
-- is the full surface record, and it carries the surface's own `id`. Measured
-- across the whole table, `json_extract(overlay, '$.id')` is non-null for
-- 8,892 of 8,892 rows -- every row, including all 8,831 with a null column. So
-- the identity was written the whole time, just not where it could be queried.
--
-- The backfill is therefore a copy, not a guess. It touches only rows whose
-- column is null, and only where the overlay actually yields an id, so it can
-- neither overwrite a recorded id nor invent one.
UPDATE surface_history
   SET surface_id = json_extract(overlay, '$.id')
 WHERE surface_id IS NULL
   AND json_extract(overlay, '$.id') IS NOT NULL;

-- The serving read: one subnet's trail, newest first
-- (src/surface-history.ts). Without this it is a full scan of the table on
-- every request, and the table only grows -- it never prunes, because the
-- history outliving the surface it describes is the entire point.
CREATE INDEX IF NOT EXISTS idx_surface_history_subnet_recorded
  ON surface_history (subnet_netuid, recorded_at DESC);

-- The secondary read: one surface's own trail across subnets, which the
-- backfill above is what makes possible at all.
CREATE INDEX IF NOT EXISTS idx_surface_history_surface
  ON surface_history (surface_id, recorded_at DESC);
