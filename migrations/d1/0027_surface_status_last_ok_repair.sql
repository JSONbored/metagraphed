-- Restore the last_ok values a degraded prior-status read wiped (#9634).
--
-- WHAT WAS LOST. `surface_status.last_ok` is a high-water mark: the last time a
-- surface was seen working. The prober computes it as `ok ? runAt :
-- (prior?.last_ok ?? null)`, and until #9522 the `prior` read resolved to
-- nothing on every run, so every surface that was not ok on a given run had its
-- history rewritten to NULL. #9522 fixed the read and src/observations-d1.ts
-- now COALESCEs on write, so no further rows can be wiped -- but neither
-- restores what was already gone.
--
-- Recovery only ever happened by a surface going ok again, which is precisely
-- what a persistently-degraded surface does not do. Measured 2026-08-06:
--
--   status    rows  with last_ok
--   degraded    94            9
--   failed       8            0
--   ok         533          533
--
-- and of the 93 null rows, 71 have successful probes still on record:
-- sn-62-ridges-perfectly-solved-over-time alone has 150, the most recent
-- 2026-08-05T20:15:10.427Z, while serving `last_ok: null` to every caller.
--
-- WHY surface_checks IS A SAFE SOURCE. It records one row per probe with an
-- `ok` flag, so MAX(checked_at) WHERE ok=1 is the most recent success still
-- retained. The raw table is pruned at 30 days (`pruneHealthHistory`), which
-- makes this a LOWER BOUND and never an overstatement: if the true last success
-- has aged out, every surviving ok row is older, so the value moves earlier or
-- the surface stays null. It cannot invent a success that did not happen, and
-- it cannot claim one more recent than the evidence.
--
-- IDEMPOTENT, in the same one-pass style as 0024/0025. `WHERE last_ok IS NULL`
-- makes a re-run a no-op rather than clobbering values the prober has since
-- written -- a live column must never be overwritten by a repair that reruns.
-- The inner `MAX(...) IS NOT NULL` guard keeps a surface with no ok probe on
-- record at NULL instead of writing NULL over NULL, so `changes()` reports the
-- rows genuinely repaired.
UPDATE surface_status
   SET last_ok = (
         SELECT MAX(c.checked_at)
           FROM surface_checks c
          WHERE c.surface_id = surface_status.surface_id
            AND c.ok = 1
       )
 WHERE last_ok IS NULL
   AND (
         SELECT MAX(c.checked_at)
           FROM surface_checks c
          WHERE c.surface_id = surface_status.surface_id
            AND c.ok = 1
       ) IS NOT NULL;
