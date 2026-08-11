-- Drop the two indexes that make api_usage_rollup's updates non-HOT (#10712).
--
-- MEASURED, NOT ASSUMED. 2026-08-11 against production:
--
--   api_usage_rollup_pkey         1,298,861 scans   272 kB
--   idx_api_usage_rollup_day              4 scans   504 kB
--   idx_api_usage_rollup_shape            0 scans    88 kB
--
-- and the table has taken 1,280,244 updates with EXACTLY ZERO of them HOT.
--
-- WHY ZERO, AND WHY THAT IS THIS INDEX'S FAULT. A HOT update requires that no
-- INDEXED column changed. `idx_api_usage_rollup_day` is on
-- (day DESC, request_count DESC), and request_count is the counter every upsert
-- increments (`request_count = api_usage_rollup.request_count +
-- EXCLUDED.request_count`, workers/data-api.ts). So an indexed column changes on
-- every single update and HOT is unreachable by construction -- 1.28M updates
-- that each wrote a new tuple and touched all three indexes. Indexing the column
-- you increment is the trap here, and fillfactor cannot fix it, which is why
-- #10711 deliberately left this table out.
--
-- WHY THE READS DO NOT NEED THEM. Both queries in workers/data-api.ts filter
-- `WHERE day >= $1` and then aggregate:
--
--   ... GROUP BY cost_shape ORDER BY SUM(request_count) DESC
--   ... GROUP BY route_family, cost_shape ORDER BY SUM(request_count) DESC LIMIT 500
--
-- `day` is the LEADING column of the primary key (day, route_family,
-- cost_shape), so the range scan is served by the pkey. The ORDER BY is over an
-- AGGREGATE, which no index can satisfy in any case -- it is a sort either way.
-- That is why the day index has four scans in the table's lifetime and the shape
-- index has none: they were never the path.
--
-- AFTER THIS, HOT BECOMES POSSIBLE. The remaining index is the primary key, on
-- (day, route_family, cost_shape) -- and an upsert changes only request_count
-- and keyed_count, neither of which is indexed. With fillfactor room on the page
-- the update can stay on it and touch no index at all.
--
-- The table is 1,352 kB, so this is not a storage win: it is ~1.28M avoidable
-- index writes, and a counter-in-an-index pattern that would otherwise get
-- copied to the next rollup table someone adds.

DROP INDEX IF EXISTS idx_api_usage_rollup_day;
DROP INDEX IF EXISTS idx_api_usage_rollup_shape;

-- Same reasoning as #10711's four tables: leave room on the page so the update
-- that is now HOT-ELIGIBLE can actually stay put.
ALTER TABLE api_usage_rollup SET (fillfactor = 85);
