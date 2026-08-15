-- A sweep that read a bulk listing found addresses, and none of them are the
-- subnet's (metagraphed#11227).
--
-- The sweep now caps how many DISTINCT addresses one page may yield before it
-- is treated as a listing rather than an attribution. Measured on production
-- 2026-08-15: 17 source URLs produced 4,741 of 4,902 candidate rows, every one
-- of them a metagraph or miner dump -- `/allHolders`, `/api/miners`,
-- `/snap/metagraph`. Those are other people's hotkeys, published by them, which
-- is the false positive src/attribution-sweep.ts's own header names.
--
-- Dropping them needs a verdict to say so. `none-published` would claim we
-- found no address when we found twelve hundred, and `candidates-found` would
-- put strangers' keys in a human's review queue -- so the state gets its own
-- name.
--
-- WIDENING ONLY, and that is what makes it safe to apply before the code that
-- writes the new value. The constraint accepts strictly more than it did, so a
-- Worker still running the old sweep keeps passing it; a Worker running the new
-- one would be rejected until this lands. Migrations here are applied by hand,
-- so the order is: this first, the deploy second.
ALTER TABLE attribution_sweeps
  DROP CONSTRAINT IF EXISTS attribution_sweeps_verdict_is_known;

ALTER TABLE attribution_sweeps
  ADD CONSTRAINT attribution_sweeps_verdict_is_known
  CHECK (
    verdict IN (
      'none-published',
      'candidates-found',
      'unreachable',
      'no-sources',
      'listings-only'
    )
  );
