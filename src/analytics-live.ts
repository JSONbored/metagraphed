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
  formatTrends,
  formatUptime,
  INCIDENT_GAP_MS,
  MIN_INCIDENT_SAMPLES,
} from "./health-serving.ts";
import {
  dailyLatencyColumns,
  latencyStatColumns,
  rankedChecksCte,
} from "./health-sql.ts";
import {
  ANALYTICS_WINDOWS,
  DAY_MS,
  HEALTH_TREND_WINDOWS,
  MAX_GLOBAL_INCIDENT_SOURCE_ROWS,
  MAX_INCIDENT_ROWS,
  MAX_UPTIME_ROWS,
  SS58_ADDRESS_PATTERN,
  UPTIME_WINDOWS,
} from "../workers/config.ts";
import { composeCompareData } from "../workers/request-handlers/analytics-routes.ts";
import { registerModuleStateReset } from "./module-state-registry.ts";

export { composeCompareData };
export const COMPARE_DIMENSIONS = ["structure", "economics", "health"];
const COMPARE_NETUIDS_PATTERN = /^\d{1,5}(,\d{1,5}){0,127}$/;

// --- D1 read tier (box decommission, the read half of #9036's dual-write) ----
//
// D1 reads resurrected 2026-08-02: the 2026-07-17 elimination that emptied
// these loaders assumed the self-hosted Postgres would keep serving; that box
// is now gone, and the observation tables live in D1 again (backfilled to
// exact parity + dual-written since #9036). Each health loader takes an
// optional `db` — the METAGRAPH_HEALTH_DB binding — and runs the exact
// pre-elimination SQL against it; with no binding (tests, self-hosters) the
// loader keeps its schema-stable empty behavior, byte-identical to before
// this change. The Postgres tier stays first in every route for now; when
// it misses (or its flag is off), the D1 read replaces what used to be a
// guaranteed-empty payload.
//
// The read slice of the D1 API these loaders use — structural (mirroring
// ObservationsDb, the write slice in observations-d1.ts) so tests can hand
// in node:sqlite-backed fakes and the real binding both.
export interface ObservationsReadDb {
  prepare(sql: string): {
    bind(...values: unknown[]): {
      all(): Promise<{ results?: unknown[] } | unknown>;
    };
  };
}

// A failed D1 read degrades to zero rows, and the payload built from those
// zero rows must never be edge-cached as fresh — the same contract the
// Postgres tier enforces via its own fallback generation
// (workers/postgres-tier.ts). Handlers snapshot this before a loader call
// and treat a changed generation as a fallback.
let d1ReadFailureGeneration = 0;

registerModuleStateReset("src/analytics-live.ts", () => {
  d1ReadFailureGeneration = 0;
});

export function currentD1ReadFailureGeneration(): number {
  return d1ReadFailureGeneration;
}

// Contained D1 read: any failure (no binding, bad SQL against a drifted
// schema, a D1 outage) degrades to zero rows — these are serving paths, and
// the schema-stable empty payload has been their floor since 2026-07-17.
// console.error keeps the failure diagnosable in the tail without making a
// read failure a route failure.
async function d1All(
  db: ObservationsReadDb | null | undefined,
  sql: string,
  params: unknown[],
): Promise<Record<string, unknown>[]> {
  if (!db?.prepare) return [];
  try {
    const outcome = await db
      .prepare(sql)
      .bind(...params)
      .all();
    // D1 wraps rows in { results }; a node:sqlite-backed test fake returns
    // the array directly. Accept both, and anything else is zero rows.
    const rows = Array.isArray(outcome)
      ? outcome
      : (outcome as { results?: unknown[] })?.results;
    return (Array.isArray(rows) ? rows : []) as Record<string, unknown>[];
  } catch (error) {
    d1ReadFailureGeneration += 1;
    console.error("[analytics-d1]", String((error as Error)?.message));
    return [];
  }
}

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
    // D1 can hand the INTEGER netuid back as a numeric string on this GROUP BY
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

// compare_validators/compare-validators (#6035/#6325) share this same cap and
// SS58 validation with parseCompareNetuids/parseCompareNetuidList above --
// one hotkey-list contract for both the REST query string and the MCP array.
export const COMPARE_VALIDATORS_MAX = 16;
const COMPARE_HOTKEYS_PATTERN =
  /^[1-9A-HJ-NP-Za-km-z]{47,48}(,[1-9A-HJ-NP-Za-km-z]{47,48}){0,15}$/;

export function parseCompareHotkeys(hotkeysRaw: unknown): string[] | null {
  if (
    typeof hotkeysRaw !== "string" ||
    !hotkeysRaw ||
    !COMPARE_HOTKEYS_PATTERN.test(hotkeysRaw)
  ) {
    return null;
  }
  const hotkeys: string[] = [];
  const seen = new Set<string>();
  for (const part of hotkeysRaw.split(",")) {
    if (seen.has(part)) continue;
    seen.add(part);
    hotkeys.push(part);
  }
  return hotkeys;
}

export function parseCompareHotkeyList(hotkeys: unknown): string[] | null {
  if (!Array.isArray(hotkeys) || hotkeys.length === 0) return null;
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of hotkeys) {
    if (typeof value !== "string" || !SS58_ADDRESS_PATTERN.test(value)) {
      return null;
    }
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  if (result.length > COMPARE_VALIDATORS_MAX) return null;
  return result;
}

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

// D1 reads resurrected (2026-08-02, box decommission): surface_uptime_daily
// is dual-written to D1, and this loader reads it there when a `db` binding
// is supplied — the pre-elimination query, unchanged. Without a binding it
// keeps the schema-stable empty shape a Postgres-tier miss has served since
// 2026-07-17.
export async function loadSubnetUptime(
  netuid: number,
  {
    window = "90d",
    observedAt = null,
    now = null,
    minSamples = null,
    db = null,
  }: {
    window?: string;
    observedAt?: unknown;
    now?: string | null;
    minSamples?: number | null;
    db?: ObservationsReadDb | null;
  } = {},
): Promise<unknown> {
  const windowParam = Object.hasOwn(UPTIME_WINDOWS, window) ? window : "90d";
  // Optional min_samples floor: drop low-sample day rows (daily probe count
  // below the threshold, incl. zero-sample "unknown" days) via HAVING,
  // mirroring the REST /uptime route (#2700). Null → no filter.
  const sampleFloor =
    Number.isInteger(minSamples) && (minSamples as number) >= 0
      ? minSamples
      : null;
  const days = UPTIME_WINDOWS[windowParam] as number;
  const cutoff = new Date(Date.now() - days * DAY_MS)
    .toISOString()
    .slice(0, 10);
  const rows = await d1All(
    db,
    `SELECT MAX(surface_id) AS surface_id,
            COALESCE(surface_key, surface_id) AS surface_key,
            day,
            SUM(samples) AS samples,
            SUM(ok_count) AS ok_count,
            CASE
              WHEN SUM(samples) > 0 THEN ROUND(CAST(SUM(ok_count) AS REAL) / SUM(samples), 4)
              ELSE NULL
            END AS uptime_ratio,
            ${dailyLatencyColumns({ roundedAvg: true })},
            MAX(p50_latency_ms) AS p50,
            MAX(p95_latency_ms) AS p95,
            MAX(p99_latency_ms) AS p99,
            CASE
              WHEN SUM(samples) = 0 THEN 'unknown'
              WHEN SUM(ok_count) = SUM(samples) THEN 'ok'
              WHEN SUM(ok_count) = 0 THEN 'failed'
              ELSE 'degraded'
            END AS status
     FROM surface_uptime_daily
     WHERE netuid = ? AND day >= ?
     GROUP BY COALESCE(surface_key, surface_id), day
     ${sampleFloor !== null ? "HAVING SUM(samples) >= ?\n     " : ""}ORDER BY day DESC
     LIMIT ?`,
    sampleFloor !== null
      ? [netuid, cutoff, sampleFloor, MAX_UPTIME_ROWS]
      : [netuid, cutoff, MAX_UPTIME_ROWS],
  );
  // formatUptime (health-serving.ts, not yet converted) infers its
  // observedAt/now default-param types as exactly `null` from their `= null`
  // defaults -- the untyped-default-parameter inference gap.
  return formatUptime({
    netuid,
    window: windowParam,
    observedAt,
    rows,
    now: now || new Date().toISOString(),
  } as unknown as Parameters<typeof formatUptime>[0]);
}

// One subnet's 7d/30d uptime + latency trend per operational surface, over the
// ranked-dedup CTE shared with the percentiles/incidents routes. The windows are
// independent reads, so they run in parallel rather than serializing an
// await-in-loop — same shape as REST's handleHealthTrends, which this mirrors.
// D1 reads resurrected (2026-08-02): surface_checks is dual-written to D1;
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
        const rows = await d1All(
          db,
          `${rankedChecksCte("netuid = ? AND checked_at >= ?")}
           SELECT MAX(surface_id) AS surface_id,
                  surface_key,
                  COUNT(*) AS total,
                  SUM(ok) AS ok_count,
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
// D1 reads resurrected (2026-08-02): with a `db` binding this runs the
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
  const windowParam = Object.hasOwn(ANALYTICS_WINDOWS, window) ? window : "7d";
  const days = ANALYTICS_WINDOWS[windowParam] as number;
  const rows = await d1All(
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
// D1 reads resurrected (2026-08-02): with a `db` binding both row sets run
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
  const windowParam = Object.hasOwn(ANALYTICS_WINDOWS, window) ? window : "7d";
  const since =
    Date.now() - (ANALYTICS_WINDOWS[windowParam] as number) * DAY_MS;
  const [slaRows, incidentRows] = await Promise.all([
    d1All(
      db,
      `SELECT MAX(surface_id) AS surface_id,
              COALESCE(surface_key, surface_id) AS surface_key,
              COUNT(*) AS total,
              SUM(ok) AS ok_count
       FROM surface_checks
       WHERE netuid = ? AND checked_at >= ?
       GROUP BY COALESCE(surface_key, surface_id)`,
      [netuid, since],
    ),
    // Gap-island grouping in SQL: collapse consecutive failures (gap <= the
    // incident threshold) into one incident row, then cap per surface_key so one
    // flappy endpoint cannot starve sibling surfaces in the same subnet.
    d1All(
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
                SUM(CASE WHEN ok = 1 OR gap IS NULL OR gap > ? THEN 1 ELSE 0 END)
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
         WHERE ok = 0
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

// D1 reads resurrected (2026-08-02): with a `db` binding this runs the
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
  return d1All(
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
              SUM(CASE WHEN ok = 1 OR gap IS NULL OR gap > ? THEN 1 ELSE 0 END)
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
     WHERE ok = 0
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

// D1 fully eliminated (2026-07-17): surface_status/subnet_snapshots/
// surface_uptime_daily are Postgres-only now; the health/rpc/growth/
// reliability row sets are always empty here. `profiles`/`economicsRows`
// aren't D1 -- they come from the registry artifact + the economics tier --
// so those inputs are unchanged.
export async function loadRegistryLeaderboards({
  profiles = [],
  economicsRows = [],
  board = null,
  limit = null,
  observedAt = null,
}: {
  profiles?: Array<Record<string, unknown>>;
  economicsRows?: Array<Record<string, unknown>>;
  board?: unknown;
  limit?: unknown;
  observedAt?: unknown;
} = {}): Promise<unknown> {
  const { subnetMeta, mostComplete } = profilesProjectionFromRows(profiles);
  return formatLeaderboards({
    board,
    limit,
    observedAt,
    healthRows: [],
    rpcRows: [],
    mostComplete,
    growthRows: growthRowsFromSamples([]),
    reliabilityRows: [],
    economicsRows,
    subnetMeta,
  });
}

// D1 fully eliminated (2026-07-17): surface_status is Postgres-only now, so
// the health dimension is always empty here. `profiles`/`economicsRows`
// aren't D1, so those inputs are unchanged.
export async function loadCompareSubnets({
  profiles = [],
  economicsRows = [],
  netuids,
  dimensions = COMPARE_DIMENSIONS,
  observedAt = null,
}: {
  profiles?: Array<Record<string, unknown>>;
  economicsRows?: Array<Record<string, unknown>>;
  netuids: number[] | null | undefined;
  dimensions?: string[];
  observedAt?: unknown;
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
  return composeCompareData({
    requestedNetuids: netuids,
    dimensions,
    subnetMeta,
    structureRows: mostComplete,
    economicsRows: dimensions.includes("economics") ? economicsRows : null,
    healthRows: dimensions.includes("health") ? [] : null,
    observedAt,
  });
}

// #4909/#4772 D1 retirement: loadChainCalls, loadChainFees, and loadNetworkActivity (all read
// the extrinsics/blocks D1 tables) were removed here — that D1 write path is
// retired and the tables are dropped in production, so a live D1 query would
// always miss. Serving now goes tryPostgresTier -> buildChainCalls([...]) /
// buildChainFees([...]) / buildChainActivity([...]) (all still exported from
// ./chain-analytics.ts), never D1. See workers/request-handlers/analytics.ts's
// handleChainCalls / handleChainFees / handleChainActivity and
// src/mcp-server.ts's get_chain_calls tool for the call sites.

export function parseAnalyticsWindow(
  window: unknown,
): { label: string; days: number } | null {
  if (window === null || window === undefined) {
    return { label: "7d", days: ANALYTICS_WINDOWS["7d"] };
  }
  if (typeof window !== "string" || !Object.hasOwn(ANALYTICS_WINDOWS, window)) {
    return null;
  }
  return { label: window, days: ANALYTICS_WINDOWS[window] };
}

export function parseUptimeWindow(window: unknown): string | null {
  if (window === null || window === undefined) {
    return "90d";
  }
  return typeof window === "string" && Object.hasOwn(UPTIME_WINDOWS, window)
    ? window
    : null;
}
