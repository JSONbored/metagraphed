-- Leave room on the page so an update can stay HOT (#10711).
--
-- WHAT A NON-HOT UPDATE COSTS. Postgres updates by writing a NEW tuple; when
-- the new version fits on the SAME page and no indexed column changed, that is
-- a HOT update and no index is touched. Otherwise every index on the table
-- gets a new entry pointing at the new location. Measured 2026-08-11:
--
--   account_position_daily   10,732,187 updates   33.0% HOT   497 MB
--   account_balances          7,944,683 updates   39.8% HOT   118 MB
--   neuron_daily             10,671,363 updates   50.6% HOT   487 MB
--   hotkey_alpha                301,626 updates    6.9% HOT    19 MB
--
-- account_position_daily alone is ~7.2M updates that each rewrote both its
-- 145 MB primary key and its 97 MB secondary index. That is the write
-- amplification behind two tables now carrying nearly as much index as heap.
--
-- `reloptions` was NULL on every table in this database -- fillfactor has never
-- been set here, so all four have been packing pages to 100% and guaranteeing
-- the next update leaves the page.
--
-- 85, NOT LOWER. Fillfactor trades space for HOT headroom, and 85 is Postgres'
-- own documented starting point for update-heavy tables: 15% of each page held
-- back is roughly one extra row-version for these row widths, which is what
-- these tables need -- they are upserted repeatedly with the same shape, not
-- grown. Going to 70 would reserve space these workloads cannot use and make
-- every sequential scan read ~18% more pages for it.
--
-- THIS ONLY AFFECTS PAGES WRITTEN FROM NOW ON, and that is deliberate. Existing
-- pages keep their current fill until they are rewritten, so this is a bound on
-- FUTURE bloat rather than a repair of past bloat. Reclaiming what is already
-- there needs a full rewrite (VACUUM FULL takes an ACCESS EXCLUSIVE lock, and
-- pg_repack is not installed), which is a heavier, separately-decided operation
-- against tables the API reads continuously -- not something to bundle into a
-- migration that is otherwise metadata-only and instant.
--
-- NOT api_usage_rollup, whose HOT rate is 0.0% and which fillfactor cannot fix:
-- idx_api_usage_rollup_day is on (day DESC, request_count DESC) and
-- request_count is the counter every upsert increments, so an indexed column
-- changes on every single update and HOT is structurally unreachable. That one
-- is an index-design question (#10712), not a page-fill question, and pretending
-- otherwise here would leave a fillfactor nobody can explain.

ALTER TABLE account_position_daily SET (fillfactor = 85);
ALTER TABLE account_balances SET (fillfactor = 85);
ALTER TABLE neuron_daily SET (fillfactor = 85);
ALTER TABLE hotkey_alpha SET (fillfactor = 85);
