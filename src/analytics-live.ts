// Shared live analytics loaders for MCP/GraphQL/REST parity (#1958).
//
// D1 fully eliminated (2026-07-17): these loaders no longer read D1 -- every
// route (REST/GraphQL/MCP) tries the Postgres tier first, and a miss falls
// through to the schema-stable empty shape built here. Pure orchestration
// over registry projections only now.

import {
  formatGlobalIncidents,
  formatIncidents,
  formatLeaderboards,
  formatPercentiles,
  formatTrajectory,
  formatTrends,
  INCIDENT_GAP_MS,
  MIN_INCIDENT_SAMPLES,
} from "./health-serving.ts";
import {
  dailyLatencyColumns,
  latencyStatColumns,
  OK_COUNT,
  rankedChecksCte,
  surfaceStatusAvgLatencySql,
} from "./health-sql.ts";
import {
  ANALYTICS_WINDOW_DAYS,
  DAY_MS,
  HEALTH_TREND_WINDOWS,
  MAX_GLOBAL_INCIDENT_SOURCE_ROWS,
  MAX_INCIDENT_ROWS,
  UPTIME_WINDOW_DAYS,
} from "../workers/config.ts";
import { composeCompareData } from "../workers/request-handlers/analytics-routes.ts";

export { composeCompareData };
export const COMPARE_DIMENSIONS = ["structure", "economics", "health"];
const COMPARE_NETUIDS_PATTERN = /^\d{1,5}(,\d{1,5}){0,127}$/;

import { storeAll, type ObservationsReadDb } from "./analytics-store-read.ts";
export { storeAll, currentStoreReadFailureGeneration, type ObservationsReadDb } from "./analytics-store-read.ts";

export interface SubnetMetaEntry {
  slug: string | null;
  name: string | null;
}

export function profilesProjectionFromRows(
  profiles: Array<Record<string, unknown>> | null | undefined,
): {
  subnetMeta: Map<number, SubnetMetaEntry>;
  mostComplete: Array<Record<string, unknown>>;
} {
  const subnetMeta = new Map<number, SubnetMetaEntry>();
  const mostComplete: Array<Record<string, unknown>> = [];
  for (const profile of profiles || []) {
    if (!Number.isInteger(profile.netuid)) continue;
    subnetMeta.set(profile.netuid as number, {
      slug: (profile.slug as string | null | undefined) ?? null,
      name: (profile.name as string | null | undefined) ?? null,
    });
    mostComplete.push({
      netuid: profile.netuid,
      slug: profile.slug ?? null,
      name: profile.name ?? null,
      completeness_score: profile.completeness_score ?? null,
      surface_count: profile.surface_count ?? 0,
      operational_interface_count: profile.operational_interface_count ?? 0,
    });
  }
  return { subnetMeta, mostComplete };
}

export function growthRowsFromSamples(
  growthSamples: Array<Record<string, unknown>> | null | undefined,
): Array<{ netuid: number; delta: number | null }> {
  const growthByNetuid = new Map<number, { first: unknown; last: unknown }>();
  for (const row of growthSamples || []) {
    // the store can hand the INTEGER netuid back as a numeric string on this GROUP BY
    // read path; the emitted netuid keys the integer-keyed subnetMeta map in
    // formatLeaderboards, so a raw string netuid drops the fastest-growing entry's
    // slug/name metadata. Accept only a real number or an all-digits string so a
    // blank/null/false cell is dropped, never read as subnet 0.
    const netuid =
      typeof row.netuid === "number"
        ? row.netuid
        : typeof row.netuid === "string" && /^\d+$/.test(row.netuid)
          ? Number(row.netuid)
          : null;
    if (netuid == null || !Number.isInteger(netuid) || netuid < 0) continue;
    const entry = growthByNetuid.get(netuid) || {
      first: null,
      last: null,
    };
    // Latch the window's first and last *non-null* completeness scores. Rows
    // arrive ordered by (netuid, snapshot_date), so a subnet whose earliest
    // in-window snapshot has no score yet (completeness_score is a nullable
    // INTEGER) must not have `first` pinned to null: the old `=== undefined`
    // guard fired on the first row regardless, so a leading NULL froze `first`
    // at null for the whole subnet, collapsing its delta to null. That silently
    // dropped a genuinely fast-growing subnet from the "fastest-growing"
    // leaderboard, which filters out null deltas. Skipping NULL scores here
    // makes `first`/`last` the first/last real scores (a trailing NULL no
    // longer poisons `last` either); an all-NULL subnet still yields null.
    const score = row.completeness_score ?? null;
    if (score != null) {
      if (entry.first == null) entry.first = score;
      entry.last = score;
    }
    growthByNetuid.set(netuid, entry);
  }
  return [...growthByNetuid.entries()].map(([netuid, entry]) => ({
    netuid,
    delta:
      entry.first != null && entry.last != null
        ? Number(entry.last) - Number(entry.first)
        : null,
  }));
}

export function parseCompareNetuids(netuidsRaw: unknown): number[] | null {
  if (
    typeof netuidsRaw !== "string" ||
    !netuidsRaw ||
    !COMPARE_NETUIDS_PATTERN.test(netuidsRaw)
  ) {
    return null;
  }
  const requestedNetuids: number[] = [];
  const seenNetuids = new Set<number>();
  for (const part of netuidsRaw.split(",")) {
    const netuid = Number(part);
    if (seenNetuids.has(netuid)) continue;
    seenNetuids.add(netuid);
    requestedNetuids.push(netuid);
  }
  return requestedNetuids;
}

export function parseCompareNetuidList(netuids: unknown): number[] | null {
  if (!Array.isArray(netuids) || netuids.length === 0) return null;
  const requestedNetuids: number[] = [];
  const seenNetuids = new Set<number>();
  for (const value of netuids) {
    if (!Number.isInteger(value) || value < 0) return null;
    if (seenNetuids.has(value)) continue;
    seenNetuids.add(value);
    requestedNetuids.push(value);
  }
  if (requestedNetuids.length > 128) return null;
  return requestedNetuids;
}

export { COMPARE_VALIDATORS_MAX, parseCompareHotkeys, parseCompareHotkeyList } from "./compare-validator-input.ts";

export function parseCompareDimensions(
  dimensionsRaw: unknown,
): string[] | null {
  if (dimensionsRaw === null || dimensionsRaw === undefined) {
    return COMPARE_DIMENSIONS;
  }
  return compareDimensionsFromTokens(String(dimensionsRaw).split(","));
}

export function parseCompareDimensionList(
  dimensions: unknown,
): string[] | null {
  if (dimensions === undefined || dimensions === null) {
    return COMPARE_DIMENSIONS;
  }
  if (!Array.isArray(dimensions) || dimensions.length === 0) return null;
  return compareDimensionsFromTokens(dimensions);
}

function compareDimensionsFromTokens(tokens: unknown[]): string[] | null {
  const requested: string[] = [];
  for (const token of tokens) {
    const trimmed = String(token).trim();
    if (trimmed === "") return null;
    requested.push(trimmed);
  }
  const unknownDimension = requested.find(
    (d) => !COMPARE_DIMENSIONS.includes(d),
  );
  if (unknownDimension !== undefined) return null;
  return COMPARE_DIMENSIONS.filter((d) => requested.includes(d));
}

// store reads resurrected (2026-08-02, box decommission): surface_uptime_daily
// is dual-written to D1, and this loader reads it there when a `db` binding
// is supplied — the pre-elimination query, unchanged. Without a binding it
// keeps the schema-stable empty shape a Postgres-tier miss has served since
// 2026-07-17.
export { loadSubnetUptime } from "./uptime-read.ts";

// One subnet's 7d/30d uptime + latency trend per operational surface, over the
// ranked-dedup CTE shared with the percentiles/incidents routes. The windows are
// independent reads, so they run in parallel rather than serializing an
// await-in-loop — same shape as REST's handleHealthTrends, which this mirrors.
// store reads resurrected (2026-08-02): surface_checks is dual-written to D1;
// with a `db` binding each window runs the pre-elimination query there,
// without one every window stays empty (the 2026-07-17 floor).
export async function loadSubnetHealthTrends(
  netuid: number,
  {
    observedAt = null,
    db = null,
  }: { observedAt?: unknown; db?: ObservationsReadDb | null } = {},
): Promise<Record<string, unknown>> {
  const nowMs = Date.now();
  const windowRows = await Promise.all(
    Object.entries(HEALTH_TREND_WINDOWS).map(
      async ([label, days]): Promise<[string, unknown[]]> => {
        const rows = await storeAll(
          db,
          `${rankedChecksCte("netuid = ? AND checked_at >= ?")}
           SELECT MAX(surface_id) AS surface_id,
                  surface_key,
                  COUNT(*) AS total,
                  ${OK_COUNT} AS ok_count,
                  ${latencyStatColumns({ includeMinMax: false })}
           FROM ranked
           GROUP BY surface_key`,
          [netuid, nowMs - (days as number) * DAY_MS],
        );
        return [label, rows];
      },
    ),
  );
  const windows: Record<string, unknown[]> = {};
  for (const [label, rows] of windowRows) {
    windows[label] = rows;
  }
  return formatTrends({ netuid, observedAt, windows });
}

// p50/p95/p99 (+avg/min/max) request-latency percentiles per operational surface
// for one subnet over a 7d/30d window, from the live surface_checks history. The
// query + formatting live here so the REST handler (handleHealthPercentiles) and
// the get_subnet_health_percentiles MCP tool share one read path (mirrors
// loadSubnetHealthTrends, #2335). Defensively defaults an unknown window to 7d;
// cold/empty D1 → a schema-stable surfaces:[] payload.
// store reads resurrected (2026-08-02): with a `db` binding this runs the
// pre-elimination surface_checks percentile query; without one, rows stay
// empty (the 2026-07-17 floor).
export async function loadSubnetPercentiles(
  netuid: number,
  {
    window = "7d",
    observedAt = null,
    db = null,
  }: {
    window?: string;
    observedAt?: unknown;
    db?: ObservationsReadDb | null;
  } = {},
): Promise<Record<string, unknown>> {
  const windowParam = Object.hasOwn(ANALYTICS_WINDOW_DAYS, window)
    ? window
    : "7d";
  const days = ANALYTICS_WINDOW_DAYS[windowParam] as number;
  const rows = await storeAll(
    db,
    `${rankedChecksCte("netuid = ? AND checked_at >= ?")}
       SELECT MAX(surface_id) AS surface_id,
              surface_key,
              ${latencyStatColumns()}
       FROM ranked
       GROUP BY surface_key
       HAVING MAX(lat_cnt) > 0`,
    [netuid, Date.now() - days * DAY_MS],
  );
  return formatPercentiles({
    netuid,
    window: windowParam,
    observedAt,
    rows,
  });
}

// Per-surface SLA + reconstructed downtime incidents for one subnet over a 7d/30d
// window, from the live surface_checks history: an SLA rollup (samples + uptime
// ratio) joined with gap-island-grouped failure incidents (consecutive failures
// within the incident gap collapse into one, capped per surface). The query +
// formatting live here so the REST handler (handleHealthIncidents) and the
// get_subnet_health_incidents MCP tool share one read path (mirrors
// loadSubnetPercentiles). Unknown window → 7d; cold/empty D1 → surfaces:[].
// store reads resurrected (2026-08-02): with a `db` binding both row sets run
// the pre-elimination surface_checks queries (SLA rollup + gap-island
// incident grouping); without one both stay empty (the 2026-07-17 floor).
export async function loadSubnetIncidents(
  netuid: number,
  {
    window = "7d",
    observedAt = null,
    db = null,
  }: {
    window?: string;
    observedAt?: unknown;
    db?: ObservationsReadDb | null;
  } = {},
): Promise<Record<string, unknown>> {
  const windowParam = Object.hasOwn(ANALYTICS_WINDOW_DAYS, window)
    ? window
    : "7d";
  const since =
    Date.now() - (ANALYTICS_WINDOW_DAYS[windowParam] as number) * DAY_MS;
  const [slaRows, incidentRows] = await Promise.all([
    storeAll(
      db,
      `SELECT MAX(surface_id) AS surface_id,
              COALESCE(surface_key, surface_id) AS surface_key,
              COUNT(*) AS total,
              ${OK_COUNT} AS ok_count
       FROM surface_checks
       WHERE netuid = ? AND checked_at >= ?
       GROUP BY COALESCE(surface_key, surface_id)`,
      [netuid, since],
    ),
    // Gap-island grouping in SQL: collapse consecutive failures (gap <= the
    // incident threshold) into one incident row, then cap per surface_key so one
    // flappy endpoint cannot starve sibling surfaces in the same subnet.
    storeAll(
      db,
      `WITH checks AS (
         SELECT COALESCE(surface_key, surface_id) AS surface_key,
                surface_id,
                checked_at,
                ok,
                checked_at - LAG(checked_at)
                  OVER (
                    PARTITION BY COALESCE(surface_key, surface_id)
                    ORDER BY checked_at
                  ) AS gap
         FROM surface_checks
         WHERE netuid = ? AND checked_at >= ?
       ),
       grouped AS (
         SELECT surface_key, surface_id, checked_at, ok,
                SUM(CASE WHEN ok OR gap IS NULL OR gap > ? THEN 1 ELSE 0 END)
                  OVER (PARTITION BY surface_key ORDER BY checked_at) AS grp
         FROM checks
       ),
       incidents AS (
         SELECT MAX(surface_id) AS surface_id,
                surface_key,
                MIN(checked_at) AS started_at,
                MAX(checked_at) AS ended_at,
                COUNT(*) AS failed_samples
         FROM grouped
         WHERE NOT ok
         GROUP BY surface_key, grp
         HAVING COUNT(*) >= ?
       )
       SELECT surface_id,
              surface_key,
              started_at,
              ended_at,
              failed_samples
       FROM (
         SELECT surface_id,
                surface_key,
                started_at,
                ended_at,
                failed_samples,
                ROW_NUMBER() OVER (
                  PARTITION BY surface_key
                  ORDER BY started_at
                ) AS rn
         FROM incidents
       ) ranked
       WHERE rn <= ?
       ORDER BY surface_id, started_at`,
      [netuid, since, INCIDENT_GAP_MS, MIN_INCIDENT_SAMPLES, MAX_INCIDENT_ROWS],
    ),
  ]);
  return formatIncidents({
    netuid,
    window: windowParam,
    observedAt,
    slaRows,
    incidentRows,
    maxIncidents: MAX_INCIDENT_ROWS,
  });
}

// store reads resurrected (2026-08-02): with a `db` binding this runs the
// pre-elimination cross-subnet incident query over surface_checks; without
// one incidentRows stays empty (the 2026-07-17 floor).
export async function loadGlobalIncidents({
  windowLabel = "7d",
  windowDays = 7,
  observedAt = null,
  db = null,
}: {
  windowLabel?: string;
  windowDays?: number;
  observedAt?: unknown;
  db?: ObservationsReadDb | null;
} = {}): Promise<unknown> {
  const incidentRows = await loadGlobalIncidentRows(db, windowDays);
  return formatGlobalIncidents({
    window: windowLabel,
    observedAt,
    incidentRows,
    maxIncidents: MAX_INCIDENT_ROWS,
  });
}

// The raw cross-subnet incident rows behind loadGlobalIncidents — exported
// separately because the REST/feeds incident ledger
// (workers/request-handlers/analytics.ts's loadGlobalIncidentsLedger) needs
// the rows alongside the formatted payload, not just the payload.
export async function loadGlobalIncidentRows(
  db: ObservationsReadDb | null | undefined,
  windowDays = 7,
): Promise<Record<string, unknown>[]> {
  const since = Date.now() - windowDays * DAY_MS;
  return storeAll(
    db,
    `WITH recent_checks AS (
       SELECT netuid, COALESCE(surface_key, surface_id) AS surface_key, surface_id, checked_at, ok
       FROM surface_checks
       WHERE checked_at >= ?
       ORDER BY checked_at DESC
       LIMIT ?
     ),
     checks AS (
       SELECT netuid, surface_key, surface_id, checked_at, ok,
              checked_at - LAG(checked_at)
                OVER (
                  PARTITION BY netuid, surface_key
                  ORDER BY checked_at
                ) AS gap
       FROM recent_checks
     ),
     grouped AS (
       SELECT netuid, surface_key, surface_id, checked_at, ok,
              SUM(CASE WHEN ok OR gap IS NULL OR gap > ? THEN 1 ELSE 0 END)
                OVER (PARTITION BY netuid, surface_key ORDER BY checked_at) AS grp
       FROM checks
     )
     SELECT netuid,
            MAX(surface_id) AS surface_id,
            surface_key,
            MIN(checked_at) AS started_at,
            MAX(checked_at) AS ended_at,
            COUNT(*) AS failed_samples
     FROM grouped
     WHERE NOT ok
     GROUP BY netuid, surface_key, grp
     HAVING COUNT(*) >= ?
     ORDER BY started_at DESC
     LIMIT ?`,
    [
      since,
      MAX_GLOBAL_INCIDENT_SOURCE_ROWS,
      INCIDENT_GAP_MS,
      MIN_INCIDENT_SAMPLES,
      MAX_INCIDENT_ROWS,
    ],
  );
}

// One subnet's trajectory from the daily snapshots (shared by the REST route,
// the MCP tool, and GraphQL — moved here from health-serving.ts when its D1
// read was resurrected, 2026-08-02, because the read helper lives in this
// module and health-serving is this module's own import). With a `db` binding
// this runs the pre-elimination subnet_snapshots query; without one it keeps
// the schema-stable empty trajectory (the 2026-07-17 floor).
export async function loadSubnetTrajectory(
  netuid: unknown,
  { db = null }: { db?: ObservationsReadDb | null } = {},
): Promise<Record<string, unknown>> {
  const rows = await storeAll(
    db,
    `SELECT snapshot_date, completeness_score, surface_count, endpoint_count,
            validator_count, miner_count, total_stake_tao, alpha_price_tao,
            emission_share, tao_in_pool_tao, alpha_in_pool, alpha_out_pool,
            subnet_volume_tao
     FROM subnet_snapshots
     WHERE netuid = ?
     ORDER BY snapshot_date DESC
     LIMIT 400`,
    [netuid],
  );
  return formatTrajectory({ netuid, rows });
}

/**
 * The four store row sets behind the operational leaderboards, read together.
 *
 * Exported because two callers need exactly these reads:
 * loadRegistryLeaderboards below (MCP) and composeLeaderboardsData in
 * analytics-routes.ts (REST + GraphQL), which supplies its own
 * subnetMeta/mostComplete projection and so cannot go through the loader.
 * Sharing the reads is what keeps the three surfaces from composing different
 * boards.
 *
 * Without a `db` binding every set is empty -- the schema-stable floor that
 * has held since 2026-07-17.
 */
export async function loadLeaderboardStoreRows(
  db: ObservationsReadDb | null | undefined,
): Promise<{
  healthRows: Record<string, unknown>[];
  rpcRows: Record<string, unknown>[];
  growthSamples: Record<string, unknown>[];
  reliabilityRows: Record<string, unknown>[];
}> {
  const sevenDaysAgo = new Date(Date.now() - 7 * DAY_MS)
    .toISOString()
    .slice(0, 10);
  // `fastest-growing` uses a short completeness window; `most-reliable` is
  // deliberately more durable and ranks the last 30d of uptime history.
  const thirtyDaysAgo = new Date(Date.now() - 30 * DAY_MS)
    .toISOString()
    .slice(0, 10);
  const [healthRows, rpcRows, growthSamples, reliabilityRows] =
    await Promise.all([
      storeAll(
        db,
        `SELECT netuid,
                COUNT(*) AS total,
                SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END) AS ok_count,
                ${surfaceStatusAvgLatencySql()} AS avg_latency_ms
         FROM surface_status
         GROUP BY netuid`,
        [],
      ),
      storeAll(
        db,
        `SELECT netuid, MIN(latency_ms) AS min_latency_ms
         FROM surface_status
         WHERE kind IN ('subtensor-rpc', 'subtensor-wss')
           AND status = 'ok' AND latency_ms IS NOT NULL
         GROUP BY netuid`,
        [],
      ),
      storeAll(
        db,
        `SELECT netuid, snapshot_date, completeness_score
         FROM subnet_snapshots
         WHERE snapshot_date >= ?
         ORDER BY netuid, snapshot_date`,
        [sevenDaysAgo],
      ),
      storeAll(
        db,
        `SELECT netuid,
                SUM(samples) AS samples,
                SUM(ok_count) AS ok_count,
                ${dailyLatencyColumns({ roundedAvg: true })}
         FROM surface_uptime_daily
         WHERE day >= ?
         GROUP BY netuid`,
        [thirtyDaysAgo],
      ),
    ]);
  return { healthRows, rpcRows, growthSamples, reliabilityRows };
}

// store reads resurrected (2026-08-03, box decommission) -- the same move #9061
// made for the health analytics loaders, which this one and loadCompareSubnets
// below were left out of. surface_status, subnet_snapshots and
// surface_uptime_daily are all written to the store and populated there (635 /
// 50,375 / 12,028 rows verified live), so four of the six operational boards
// no longer have to be empty. `profiles`/`economicsRows` were never D1 -- they
// come from the registry artifact and the economics tier -- so those inputs
// are unchanged either way.
//
// Without a `db` binding every D1-derived board stays empty, which is the
// schema-stable floor that has held since 2026-07-17.
export async function loadRegistryLeaderboards({
  profiles = [],
  economicsRows = [],
  board = null,
  limit = null,
  observedAt = null,
  db = null,
}: {
  profiles?: Array<Record<string, unknown>>;
  economicsRows?: Array<Record<string, unknown>>;
  board?: unknown;
  limit?: unknown;
  observedAt?: unknown;
  db?: ObservationsReadDb | null;
} = {}): Promise<unknown> {
  const { subnetMeta, mostComplete } = profilesProjectionFromRows(profiles);
  const { healthRows, rpcRows, growthSamples, reliabilityRows } =
    await loadLeaderboardStoreRows(db);
  return formatLeaderboards({
    board,
    limit,
    observedAt,
    healthRows,
    rpcRows,
    mostComplete,
    growthRows: growthRowsFromSamples(growthSamples),
    reliabilityRows,
    economicsRows,
    subnetMeta,
  });
}

export async function loadCompareSubnets({
  profiles = [],
  economicsRows = [],
  netuids,
  dimensions = COMPARE_DIMENSIONS,
  observedAt = null,
  db = null,
}: {
  profiles?: Array<Record<string, unknown>>;
  economicsRows?: Array<Record<string, unknown>>;
  netuids: number[] | null | undefined;
  dimensions?: string[];
  observedAt?: unknown;
  db?: ObservationsReadDb | null;
}): Promise<unknown> {
  if (!Array.isArray(netuids) || netuids.length === 0) {
    return composeCompareData({
      requestedNetuids: [],
      dimensions,
      subnetMeta: new Map(),
      structureRows: [],
      economicsRows: dimensions.includes("economics") ? economicsRows : null,
      healthRows: [],
      observedAt,
    });
  }
  const { subnetMeta, mostComplete } = profilesProjectionFromRows(profiles);
  let healthRows: Record<string, unknown>[] | null = null;
  if (dimensions.includes("health")) {
    const wanted = new Set(netuids.map((netuid) => Number(netuid)));
    const grouped = await storeAll(
      db,
      `SELECT netuid,
              COUNT(*) AS surface_count,
              SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END) AS ok_count,
              ${surfaceStatusAvgLatencySql({ rounded: true })} AS avg_latency_ms
       FROM surface_status
       GROUP BY netuid`,
      [],
    );
    healthRows = grouped.filter((row) => wanted.has(Number(row.netuid)));
  }
  return composeCompareData({
    requestedNetuids: netuids,
    dimensions,
    subnetMeta,
    structureRows: mostComplete,
    economicsRows: dimensions.includes("economics") ? economicsRows : null,
    healthRows,
    observedAt,
  });
}

// #4909/#4772 D1 retirement: loadChainCalls, loadChainFees, and loadNetworkActivity (all read
// the extrinsics/blocks D1 tables) were removed here — that D1 write path is
// retired and the tables are dropped in production, so a live D1 query would
// always miss. Serving now goes tryDataApiTier -> buildChainCalls([...]) /
// buildChainFees([...]) / buildChainActivity([...]) (all still exported from
// ./chain-analytics.ts), never the store. See workers/request-handlers/analytics.ts's
// handleChainCalls / handleChainFees / handleChainActivity and
// src/mcp-server.ts's get_chain_calls tool for the call sites.

export function parseAnalyticsWindow(
  window: unknown,
): { label: string; days: number } | null {
  if (window === null || window === undefined) {
    return { label: "7d", days: ANALYTICS_WINDOW_DAYS["7d"] };
  }
  if (
    typeof window !== "string" ||
    !Object.hasOwn(ANALYTICS_WINDOW_DAYS, window)
  ) {
    return null;
  }
  return { label: window, days: ANALYTICS_WINDOW_DAYS[window] };
}

export function parseUptimeWindow(window: unknown): string | null {
  if (window === null || window === undefined) {
    return "90d";
  }
  return typeof window === "string" && Object.hasOwn(UPTIME_WINDOW_DAYS, window)
    ? window
    : null;
}
